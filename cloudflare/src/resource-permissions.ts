import type { Context } from './types';
import { allowed, type Grant } from './permissions';
import { first, HttpError, id } from './http';
export type ResourceKind = 'Calendars' | 'Sermons' | 'Playlists';
export type ResourceAction = 'View' | 'Edit';
type Row = Record<string, any>;
export interface ResourceRequirement {
  resource: ResourceKind;
  action?: ResourceAction;
  row?: Row | null;
}
/** Explicit fork resource scopes. Content and StreamingServices remain global compatibility grants. */
export function resourceGrants(resource: ResourceKind, action: ResourceAction, row?: Row | null): Grant[] {
  const actions = action === 'View' ? ['View', 'Edit'] : ['Edit'];
  const grants: Grant[] = [];
  const add = (contentType: string, contentId: string, values = actions) =>
    values.forEach((a) => grants.push({ apiName: 'ContentApi', contentType, contentId, action: a }));
  add('Content', '');
  add(resource, '');
  if (row?.id) add(resource, row.id);
  if (resource === 'Calendars') add('Calendars', '', ['Admin']);
  else add('StreamingServices', '', ['Edit']);
  if (resource === 'Sermons' && row?.playlistId) {
    add('Playlists', '');
    add('Playlists', row.playlistId);
  }
  return grants;
}
export function resourceAllowed(
  ctx: Context,
  resource: ResourceKind,
  action: ResourceAction,
  row?: Row | null,
): boolean {
  return resourceGrants(resource, action, row).some((g) =>
    allowed(ctx, g.apiName, g.contentType, g.action, g.contentId),
  );
}
export function requireResource(ctx: Context, resource: ResourceKind, action: ResourceAction, row?: Row | null): void {
  if (!resourceAllowed(ctx, resource, action, row))
    throw new HttpError(403, `${resource} ${action.toLowerCase()} permission required for this resource`);
}
export function resourceScopes(ctx: Context, resource: ResourceKind, action: ResourceAction): string[] {
  const prefix = `ContentApi_${resource}_`,
    suffixes = action === 'View' ? ['_View', '_Edit'] : ['_Edit'];
  return [
    ...new Set(
      (ctx.principal.permissions || []).flatMap((key) => {
        const suffix = suffixes.find((s) => key.startsWith(prefix) && key.endsWith(s));
        const scope = suffix ? key.slice(prefix.length, -suffix.length) : '';
        return scope ? [scope] : [];
      }),
    ),
  ];
}
/** Aliases are application constants, never request strings. */
export function resourceReadSql(
  ctx: Context,
  resource: ResourceKind,
  alias: string,
): { sql: string; values: string[] } {
  if (resourceAllowed(ctx, resource, 'View')) return { sql: '1', values: [] };
  const terms = [`${alias}.id IN(SELECT value FROM json_each(?))`],
    values = [JSON.stringify(resourceScopes(ctx, resource, 'View'))];
  if (resource === 'Sermons') {
    if (resourceAllowed(ctx, 'Playlists', 'View')) terms.push(`${alias}.playlistId IS NOT NULL`);
    else {
      terms.push(`${alias}.playlistId IN(SELECT value FROM json_each(?))`);
      values.push(JSON.stringify(resourceScopes(ctx, 'Playlists', 'View')));
    }
  }
  return { sql: '(' + terms.join(' OR ') + ')', values };
}
export async function requireSermonAccess(ctx: Context, sermonId: string, action: ResourceAction): Promise<Row> {
  const row = await first(
    ctx,
    'SELECT * FROM content_sermons WHERE churchId=? AND id=?',
    ctx.principal.churchId,
    sermonId,
  );
  if (!row) throw new HttpError(404, 'Sermon not found');
  requireResource(ctx, 'Sermons', action, row);
  return row;
}
const columns: Record<string, string[]> = {
  calendars: ['groupId', 'timeZone'],
  calendar_events: [
    'calendarId',
    'groupId',
    'recurrenceParentId',
    'recurrenceOriginalDate',
    'start',
    'end',
    'allDay',
    'timeZone',
    'recurrenceRule',
  ],
  calendar_event_exceptions: ['eventId', 'exceptionDate'],
  content_sermons: ['playlistId', 'visibility', 'publishedAt'],
  content_playlists: [],
  content_files: ['contentId', 'state'],
};
export interface ResourceSnapshot {
  table: string;
  id: string;
  fields?: Record<string, string | number | null>;
  absent?: boolean;
}
export function resourceSnapshot(table: string, row: Row): ResourceSnapshot {
  if (!columns[table]) throw new Error('Unsupported resource snapshot table');
  return { table, id: row.id, fields: Object.fromEntries(columns[table].map((key) => [key, row[key] ?? null])) };
}
/** Every requirement is ANDed, with its effective grants ORed. Guards and audit share the mutation batch. */
export function resourceWriteGuard(
  ctx: Context,
  input: {
    requirements: ResourceRequirement[];
    snapshots?: ResourceSnapshot[];
    checks?: { sql: string; values: (string | number | null)[] }[];
  },
): D1PreparedStatement[] {
  input.requirements.forEach((r) => requireResource(ctx, r.resource, r.action || 'Edit', r.row));
  const values: (string | number | null)[] = [
    ctx.principal.churchId,
    ctx.principal.userId,
    ctx.principal.personId,
    ctx.principal.sessionId,
  ];
  const grants = input.requirements.map((r) => {
    values.push(JSON.stringify(resourceGrants(r.resource, r.action || 'Edit', r.row)));
    return `(uc.role='admin' OR ${r.action === 'View' ? "uc.role='viewer' OR " : ''}EXISTS(SELECT 1 FROM role_members rm JOIN role_permissions rp ON rp.churchId=rm.churchId AND rp.roleId=rm.roleId
      JOIN json_each(?) expected ON rp.apiName=json_extract(expected.value,'$.apiName') AND rp.contentType=json_extract(expected.value,'$.contentType') AND rp.contentId=json_extract(expected.value,'$.contentId') AND rp.action=json_extract(expected.value,'$.action') WHERE rm.churchId=uc.churchId AND rm.userId=uc.userId))`;
  });
  const terms = [
    `EXISTS(SELECT 1 FROM user_churches uc JOIN users u ON u.id=uc.userId JOIN people p ON p.churchId=uc.churchId AND p.id=uc.personId AND p.removed=0 JOIN sessions s ON s.userId=u.id
    WHERE uc.churchId=? AND uc.userId=? AND uc.personId=? AND s.id=? AND u.disabled=0 AND u.passwordState='active' AND s.passwordVersion=u.passwordVersion AND s.expiresAt>strftime('%Y-%m-%dT%H:%M:%fZ','now')${grants.length ? ' AND ' + grants.join(' AND ') : ''})`,
  ];
  for (const snapshot of input.snapshots || []) {
    if (!columns[snapshot.table]) throw new Error('Unsupported resource snapshot table');
    if (snapshot.absent) {
      terms.push(`NOT EXISTS(SELECT 1 FROM ${snapshot.table} old WHERE old.id=?)`);
      values.push(snapshot.id);
    } else {
      const fields = Object.entries(snapshot.fields || {});
      if (fields.some(([key]) => !columns[snapshot.table].includes(key)))
        throw new Error('Unsupported resource snapshot field');
      terms.push(
        `EXISTS(SELECT 1 FROM ${snapshot.table} old WHERE old.churchId=? AND old.id=?${fields.map(([key]) => ` AND old.${key} IS ?`).join('')})`,
      );
      values.push(ctx.principal.churchId, snapshot.id, ...fields.map(([, value]) => value));
    }
  }
  for (const check of input.checks || []) {
    terms.push(check.sql);
    values.push(...check.values);
  }
  if (values.length > 99) throw new HttpError(413, 'Too many authority references');
  const guardId = id();
  return [
    ctx.env.DB.prepare(
      `INSERT INTO write_guards(id,valid) VALUES(?,CASE WHEN ${terms.join(' AND ')} THEN 1 ELSE 0 END)`,
    ).bind(guardId, ...values),
    ctx.env.DB.prepare('DELETE FROM write_guards WHERE id=?').bind(guardId),
  ];
}
