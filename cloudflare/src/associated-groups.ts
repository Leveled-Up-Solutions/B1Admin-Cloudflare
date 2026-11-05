import type { Context } from './types';
import { all, first, HttpError, id, json, now, records, requiredString } from './http';
import { allowed } from './permissions';

type Row = Record<string, any>;
function access(ctx: Context, action: 'View' | 'Edit', planTypeId?: string): void {
  if (
    !allowed(ctx, 'DoingApi', 'Plans', action, planTypeId) &&
    !(action === 'View' && allowed(ctx, 'DoingApi', 'Plans', 'Edit', planTypeId))
  )
    throw new HttpError(403, `Plans ${action.toLowerCase()} permission required`);
}
function contentType(value: unknown): 'planType' {
  if (value !== 'planType') throw new HttpError(501, 'Only planType group associations are implemented');
  return 'planType';
}
async function planType(ctx: Context, planTypeId: string): Promise<void> {
  if (
    !(await first(ctx, 'SELECT id FROM doing_plan_types WHERE churchId=? AND id=?', ctx.principal.churchId, planTypeId))
  )
    throw new HttpError(404, 'Plan type not found');
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
    access(ctx, 'View', contentId);
    await planType(ctx, contentId);
    return json(
      await all(
        ctx,
        'SELECT * FROM associated_groups WHERE churchId=? AND contentType=? AND contentId=? ORDER BY groupId,id',
        cid,
        'planType',
        contentId,
      ),
    );
  }
  if (ctx.request.method === 'GET' && parts[0]?.toLowerCase() === 'group' && parts.length === 2) {
    // A group read can span several plan types, so it requires a module-wide grant.
    access(ctx, 'View');
    const groupId = requiredString(parts[1], 'groupId', 100);
    const type = ctx.url.searchParams.get('contentType');
    if (type !== null) contentType(type);
    await group(ctx, groupId);
    return json(
      await all(
        ctx,
        'SELECT * FROM associated_groups WHERE churchId=? AND groupId=? ORDER BY contentId,id',
        cid,
        groupId,
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
      if (previous) access(ctx, 'Edit', previous.contentId);
      const merged = { ...previous, ...input };
      const type = contentType(merged.contentType);
      const contentId = requiredString(merged.contentId, 'contentId', 100);
      const groupId = requiredString(merged.groupId, 'groupId', 100);
      const settings = merged.settings ?? 'both';
      if (!['past', 'future', 'both'].includes(settings))
        throw new HttpError(400, 'Settings must be past, future, or both');
      access(ctx, 'Edit', contentId);
      await planType(ctx, contentId);
      await group(ctx, groupId);
      const row = { id: entityId, churchId: cid, contentType: type, contentId, groupId, settings };
      statements.push(
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
    access(ctx, 'Edit', row.contentId);
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('DELETE FROM associated_groups WHERE churchId=? AND id=?').bind(cid, row.id),
      audit(ctx, 'associatedGroups.delete', row.id),
    ]);
    return json({});
  }
  throw new HttpError(404, 'Association route not found');
}
