import type { Context } from './types';
import { allowed } from './permissions';
import { HttpError, id } from './http';

export type DoingContent = 'Plans' | 'Tasks';
export type DoingAction = 'View' | 'Edit';
export function doingAllowed(ctx: Context, content: DoingContent, action: DoingAction, scope?: string | null): boolean {
  return (
    allowed(ctx, 'DoingApi', content, action, scope || undefined) ||
    (action === 'View' && allowed(ctx, 'DoingApi', content, 'Edit', scope || undefined))
  );
}
export function doingScopes(ctx: Context, content: DoingContent, action: DoingAction): string[] {
  const prefix = `DoingApi_${content}_`;
  const actions = action === 'View' ? ['View', 'Edit'] : ['Edit'];
  const scopes = new Set<string>();
  for (const permission of ctx.principal.permissions || [])
    for (const a of actions) {
      const suffix = '_' + a;
      if (permission.startsWith(prefix) && permission.endsWith(suffix)) {
        const scope = permission.slice(prefix.length, -suffix.length);
        if (scope) scopes.add(scope);
      }
    }
  return [...scopes];
}
export function hasDoingAccess(ctx: Context, content: DoingContent, action: DoingAction): boolean {
  return doingAllowed(ctx, content, action) || doingScopes(ctx, content, action).length > 0;
}
export function requireDoing(ctx: Context, content: DoingContent, action: DoingAction, scope?: string | null): void {
  if (!doingAllowed(ctx, content, action, scope))
    throw new HttpError(403, `${content} ${action.toLowerCase()} permission required for this scope`);
}
export function doingScopeSql(
  ctx: Context,
  content: DoingContent,
  expression: string,
  action: DoingAction = 'View',
): { sql: string; values: string[] } {
  return doingAllowed(ctx, content, action)
    ? { sql: '1', values: [] }
    : {
        sql: `${expression} IN (SELECT value FROM json_each(?))`,
        values: [JSON.stringify(doingScopes(ctx, content, action))],
      };
}
const columns: Record<string, string[]> = {
  doing_plans: ['ministryId', 'planTypeId', 'prepared', 'serviceDate', 'signupDeadlineHours'],
  doing_plan_types: ['ministryId'],
  doing_positions: ['planId', 'groupId', 'allowSelfSignup'],
  doing_times: ['planId'],
  doing_assignments: ['positionId', 'personId'],
  doing_plan_items: ['planId', 'parentId', 'positionId'],
  doing_plan_item_times: ['planItemId', 'timeId', 'positionId'],
  doing_blockout_dates: ['personId'],
  doing_scheduling_preferences: ['personId'],
  associated_groups: ['contentType', 'contentId', 'groupId'],
  tasks: ['assignedPersonId', 'assignedGroupId'],
};
export interface DoingSnapshot {
  table: string;
  id: string;
  fields?: Record<string, string | number | null>;
  absent?: boolean;
}
export function doingSnapshot(table: string, row: Record<string, any>): DoingSnapshot {
  if (!columns[table]) throw new Error('Unsupported Doing snapshot table');
  return { table, id: row.id, fields: Object.fromEntries(columns[table].map((key) => [key, row[key] ?? null])) };
}
export function doingWriteGuard(
  ctx: Context,
  input: {
    grants?: { content: DoingContent; scope?: string | null; action?: DoingAction }[];
    snapshots?: DoingSnapshot[];
    checks?: { sql: string; values: (string | number | null)[] }[];
  },
): D1PreparedStatement[] {
  const cid = ctx.principal.churchId;
  const permissionValues: (string | number | null)[] = [];
  const grants = (input.grants || []).map((grant) => {
    permissionValues.push(grant.content, JSON.stringify(grant.action === 'View' ? ['View', 'Edit'] : ['Edit']));
    if (grant.scope) permissionValues.push(grant.scope);
    return `(uc.role='admin' OR ${grant.action === 'View' ? "uc.role='viewer' OR " : ''}EXISTS(SELECT 1 FROM role_members rm JOIN role_permissions rp ON rp.churchId=rm.churchId AND rp.roleId=rm.roleId
      WHERE rm.churchId=uc.churchId AND rm.userId=uc.userId AND rp.apiName='DoingApi' AND rp.contentType=? AND rp.action IN(SELECT value FROM json_each(?))
      AND ${grant.scope ? "rp.contentId IN ('',?)" : "rp.contentId=''"}))`;
  });
  const checks = [
    `EXISTS(SELECT 1 FROM user_churches uc JOIN users u ON u.id=uc.userId JOIN sessions s ON s.userId=u.id
    JOIN people actor ON actor.churchId=uc.churchId AND actor.id=uc.personId AND actor.removed=0
    WHERE uc.churchId=? AND uc.userId=? AND uc.personId=? AND s.id=? AND s.expiresAt>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND u.disabled=0 AND u.passwordState='active' AND s.passwordVersion=u.passwordVersion${grants.length ? ' AND ' + grants.join(' AND ') : ''})`,
  ];
  const values: (string | number | null)[] = [
    cid,
    ctx.principal.userId,
    ctx.principal.personId,
    ctx.principal.sessionId,
    ...permissionValues,
  ];
  for (const snapshot of input.snapshots || []) {
    if (!columns[snapshot.table]) throw new Error('Unsupported Doing snapshot table');
    if (snapshot.absent) {
      checks.push(`NOT EXISTS(SELECT 1 FROM ${snapshot.table} snapshot WHERE snapshot.id=?)`);
      values.push(snapshot.id);
    } else {
      const fields = Object.entries(snapshot.fields || {});
      if (fields.some(([key]) => !columns[snapshot.table].includes(key)))
        throw new Error('Unsupported Doing snapshot field');
      checks.push(
        `EXISTS(SELECT 1 FROM ${snapshot.table} snapshot WHERE snapshot.churchId=? AND snapshot.id=?${fields.map(([key]) => ` AND snapshot.${key} IS ?`).join('')})`,
      );
      values.push(cid, snapshot.id, ...fields.map(([, value]) => value));
    }
  }
  for (const check of input.checks || []) {
    checks.push(check.sql);
    values.push(...check.values);
  }
  if (values.length > 99) throw new HttpError(413, 'Too many authority references in one operation');
  const guardId = id();
  return [
    ctx.env.DB.prepare(
      `INSERT INTO write_guards(id,valid) VALUES(?,CASE WHEN ${checks.join(' AND ')} THEN 1 ELSE 0 END)`,
    ).bind(guardId, ...values),
    ctx.env.DB.prepare('DELETE FROM write_guards WHERE id=?').bind(guardId),
  ];
}
