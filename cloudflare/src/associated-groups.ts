import type { Context } from './types';
import { all, first, HttpError, id, json, now, records, requiredString } from './http';
import { requireDoing, hasDoingAccess, doingScopeSql, doingSnapshot, doingWriteGuard } from './doing-permissions';

type Row = Record<string, any>;
function contentType(value: unknown): 'planType' {
  if (value !== 'planType') throw new HttpError(501, 'Only planType group associations are implemented');
  return 'planType';
}
async function planType(ctx: Context, planTypeId: string, action: 'View' | 'Edit'): Promise<Row> {
  const row = await first(
    ctx,
    'SELECT * FROM doing_plan_types WHERE churchId=? AND id=?',
    ctx.principal.churchId,
    planTypeId,
  );
  if (!row) throw new HttpError(404, 'Plan type not found');
  requireDoing(ctx, 'Plans', action, row.ministryId);
  return row;
}
async function group(ctx: Context, groupId: string): Promise<void> {
  if (!(await first(ctx, 'SELECT id FROM groups WHERE churchId=? AND id=?', ctx.principal.churchId, groupId)))
    throw new HttpError(404, 'Group not found');
}
function audit(ctx: Context, action: string, entityId: string): D1PreparedStatement {
  return ctx.env.DB.prepare(
    'INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) VALUES(?,?,?,?,?,?)',
  ).bind(id(), ctx.principal.churchId, ctx.principal.userId, action, entityId, now());
}

/** Deliberately limited to the original PlanTypeGroups workflow; no generic cross-module link store. */
export async function associatedGroups(ctx: Context): Promise<Response | undefined> {
  const route = /^\/membership\/associatedGroups(?:\/(.*))?$/i.exec(ctx.path);
  if (!route) return undefined;
  const parts = (route[1] || '').split('/').filter(Boolean);
  const cid = ctx.principal.churchId;
  if (ctx.request.method === 'GET' && parts[0]?.toLowerCase() === 'content' && parts.length === 3) {
    contentType(parts[1]);
    const contentId = requiredString(parts[2], 'contentId', 100);
    await planType(ctx, contentId, 'View');
    return json(
      await all(
        ctx,
        'SELECT ag.*,g.name groupName FROM associated_groups ag JOIN groups g ON g.churchId=ag.churchId AND g.id=ag.groupId WHERE ag.churchId=? AND ag.contentType=? AND ag.contentId=? ORDER BY ag.groupId,ag.id',
        cid,
        'planType',
        contentId,
      ),
    );
  }
  if (ctx.request.method === 'GET' && parts[0]?.toLowerCase() === 'group' && parts.length === 2) {
    if (!hasDoingAccess(ctx, 'Plans', 'View')) throw new HttpError(403, 'Plans view permission required');
    const groupId = requiredString(parts[1], 'groupId', 100);
    const type = ctx.url.searchParams.get('contentType');
    if (type !== null) contentType(type);
    await group(ctx, groupId);
    const scope = doingScopeSql(ctx, 'Plans', 'pt.ministryId');
    return json(
      await all(
        ctx,
        `SELECT ag.*,g.name groupName FROM associated_groups ag JOIN groups g ON g.churchId=ag.churchId AND g.id=ag.groupId JOIN doing_plan_types pt ON pt.churchId=ag.churchId AND pt.id=ag.contentId WHERE ag.churchId=? AND ag.groupId=? AND ${scope.sql} ORDER BY ag.contentId,ag.id`,
        cid,
        groupId,
        ...scope.values,
      ),
    );
  }
  if (ctx.request.method === 'POST' && !parts.length) {
    const inputs = await records(ctx.request);
    const statements: D1PreparedStatement[] = [];
    const output: Row[] = [];
    const seen = new Set<string>();
    for (const input of inputs) {
      if (input.churchId && input.churchId !== cid) throw new HttpError(403, 'Church mismatch');
      const entityId = input.id ? requiredString(input.id, 'id', 100) : id();
      if (seen.has(entityId)) throw new HttpError(400, 'Duplicate association id');
      seen.add(entityId);
      const previous = input.id
        ? await first(ctx, 'SELECT * FROM associated_groups WHERE churchId=? AND id=?', cid, entityId)
        : null;
      if (input.id && !previous) throw new HttpError(404, 'Association not found');
      const source = previous ? await planType(ctx, previous.contentId, 'Edit') : null;
      const merged = { ...previous, ...input };
      const type = contentType(merged.contentType);
      const contentId = requiredString(merged.contentId, 'contentId', 100);
      const groupId = requiredString(merged.groupId, 'groupId', 100);
      const settings = merged.settings ?? 'both';
      if (!['past', 'future', 'both'].includes(settings))
        throw new HttpError(400, 'Settings must be past, future, or both');
      const target = await planType(ctx, contentId, 'Edit');
      await group(ctx, groupId);
      const row = {
        id: entityId,
        churchId: cid,
        contentType: type,
        contentId,
        groupId,
        settings,
      };
      statements.push(
        ...doingWriteGuard(ctx, {
          grants: [target, ...(source ? [source] : [])].map((type) => ({ content: 'Plans', scope: type.ministryId })),
          snapshots: [
            doingSnapshot('doing_plan_types', target),
            ...(source ? [doingSnapshot('doing_plan_types', source)] : []),
            previous
              ? doingSnapshot('associated_groups', previous)
              : { table: 'associated_groups', id: entityId, absent: true },
          ],
          checks: [{ sql: 'EXISTS(SELECT 1 FROM groups WHERE churchId=? AND id=?)', values: [cid, groupId] }],
        }),
        previous
          ? ctx.env.DB.prepare(
              'UPDATE associated_groups SET contentType=?,contentId=?,groupId=?,settings=? WHERE churchId=? AND id=?',
            ).bind(type, contentId, groupId, settings, cid, entityId)
          : ctx.env.DB.prepare(
              'INSERT INTO associated_groups(id,churchId,contentType,contentId,groupId,settings) VALUES(?,?,?,?,?,?)',
            ).bind(entityId, cid, type, contentId, groupId, settings),
      );
      statements.push(audit(ctx, 'associatedGroups.save', entityId));
      output.push(row);
    }
    await ctx.env.DB.batch(statements);
    return json(output);
  }
  if (ctx.request.method === 'DELETE' && parts.length === 1) {
    const row = await first(ctx, 'SELECT * FROM associated_groups WHERE churchId=? AND id=?', cid, parts[0]);
    if (!row) throw new HttpError(404, 'Association not found');
    const type = await planType(ctx, row.contentId, 'Edit');
    await ctx.env.DB.batch([
      ...doingWriteGuard(ctx, {
        grants: [{ content: 'Plans', scope: type.ministryId }],
        snapshots: [doingSnapshot('doing_plan_types', type), doingSnapshot('associated_groups', row)],
      }),
      ctx.env.DB.prepare('DELETE FROM associated_groups WHERE churchId=? AND id=?').bind(cid, row.id),
      audit(ctx, 'associatedGroups.delete', row.id),
    ]);
    return json({});
  }
  throw new HttpError(404, 'Association route not found');
}
