import type { Context } from './types';
import { allowed } from './permissions';
import { validatePermissionScope } from './permission-scopes';
import { roleWriteGuard } from './role-write';
import { all, first, body, json, HttpError, requiredString, id, now } from './http';

const catalog: Record<string, Record<string, string[]>> = {
  MembershipApi: {
    People: ['View', 'View Names', 'Edit'],
    Groups: ['View', 'Edit'],
    'Group Members': ['View', 'Edit'],
    Roles: ['View', 'Edit'],
    Settings: ['Edit'],
  },
  ContentApi: {
    Content: ['View', 'Edit'],
    StreamingServices: ['Edit'],
    Calendars: ['View', 'Edit', 'Admin'],
    Sermons: ['View', 'Edit'],
    Playlists: ['View', 'Edit'],
  },
  DoingApi: { Plans: ['View', 'Edit'], Tasks: ['View', 'Edit'] },
};
export const permissionCatalog = Object.entries(catalog).flatMap(([apiName, sections]) =>
  Object.entries(sections).flatMap(([section, actions]) =>
    actions.map((action) => ({
      apiName,
      section,
      action,
      displaySection: section,
      displayAction: action,
    })),
  ),
);
const builtinId = 'builtin-administrators';
function permissions(ctx: Context): string[] {
  return (ctx.principal as typeof ctx.principal & { permissions?: string[] }).permissions || [];
}
function has(ctx: Context, key: string): boolean {
  return ctx.principal.role === 'admin' || permissions(ctx).includes(key);
}
function scopeMetadataFilter(ctx: Context, kinds: { apiName: string; contentType: string }[]) {
  const values: string[] = [];
  const clauses = kinds.map(({ apiName, contentType }) => {
    const ministry = contentType === 'Plans' ? " AND instr(','||tags||',',',ministry,')>0" : '';
    if (['View', 'Edit'].some((action) => allowed(ctx, apiName, contentType, action))) return `(1${ministry})`;
    const prefix = `${apiName}_${contentType}_`;
    const ids = permissions(ctx).flatMap((permission) =>
      ['View', 'Edit'].flatMap((action) => {
        const suffix = `_${action}`;
        return permission.startsWith(prefix) && permission.endsWith(suffix)
          ? [permission.slice(prefix.length, -suffix.length)].filter(Boolean)
          : [];
      }),
    );
    values.push(JSON.stringify(ids));
    return `(id IN (SELECT value FROM json_each(?))${ministry})`;
  });
  return { sql: clauses.join(' OR '), values };
}
function access(ctx: Context, action: 'View' | 'Edit') {
  if (!has(ctx, `MembershipApi_Roles__${action}`)) throw new HttpError(403, 'Role management permission required');
}
function tenant(ctx: Context, row: any) {
  if (row.churchId && row.churchId !== ctx.principal.churchId) throw new HttpError(403, 'Church mismatch');
}
function audit(ctx: Context, action: string, entityId: string) {
  return ctx.env.DB.prepare(
    'INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) VALUES(?,?,?,?,?,?)',
  ).bind(id(), ctx.principal.churchId, ctx.principal.userId, action, entityId, now());
}
async function inputRecords(ctx: Context) {
  const data = await body<unknown>(ctx.request);
  const rows = Array.isArray(data) ? data : [data];
  if (!rows.length || rows.length > 100 || rows.some((x) => !x || typeof x !== 'object' || Array.isArray(x)))
    throw new HttpError(400, 'Expected 1 to 100 records');
  return rows as Record<string, any>[];
}
async function ownId(ctx: Context, table: string, rowId: string) {
  const row = await first(ctx, `SELECT churchId FROM ${table} WHERE id=?`, rowId);
  if (row && row.churchId !== ctx.principal.churchId) throw new HttpError(404, 'Record not found');
}
async function role(ctx: Context, roleId: string) {
  if (roleId === builtinId) {
    const count = await first(
      ctx,
      "SELECT count(*) n FROM user_churches WHERE churchId=? AND role='admin'",
      ctx.principal.churchId,
    );
    return {
      id: builtinId,
      churchId: ctx.principal.churchId,
      name: 'Domain Admins',
      memberCount: count?.n || 0,
      protected: true,
    };
  }
  const found = await first(
    ctx,
    'SELECT r.*, (SELECT count(*) FROM role_members rm WHERE rm.churchId=r.churchId AND rm.roleId=r.id) memberCount FROM roles r WHERE r.churchId=? AND r.id=?',
    ctx.principal.churchId,
    roleId,
  );
  if (!found) throw new HttpError(404, 'Role not found');
  return found;
}
async function editableRole(ctx: Context, roleId: string) {
  if (roleId === builtinId)
    throw new HttpError(
      409,
      'Bootstrap administrators are protected; these endpoints cannot remove the last administrator',
    );
  const found = await role(ctx, roleId);
  if (
    ctx.principal.role !== 'admin' &&
    (await first(
      ctx,
      'SELECT id FROM role_members WHERE churchId=? AND roleId=? AND userId=?',
      ctx.principal.churchId,
      roleId,
      ctx.principal.userId,
    ))
  )
    throw new HttpError(403, 'You cannot change a role assigned to yourself');
  return found;
}
async function validatePermission(ctx: Context, row: Record<string, any>) {
  const apiName = requiredString(row.apiName, 'apiName'),
    contentType = requiredString(row.contentType, 'contentType'),
    action = requiredString(row.action, 'action');
  if (!catalog[apiName]?.[contentType]?.includes(action))
    throw new HttpError(400, 'Permission is not supported by this instance');
  if (row.contentId !== undefined && row.contentId !== null && typeof row.contentId !== 'string')
    throw new HttpError(400, 'contentId must be a resource ID or an empty string');
  const contentId = row.contentId ? requiredString(row.contentId, 'contentId') : '';
  await validatePermissionScope(ctx, { apiName, contentType, contentId, action });
  if (
    ctx.principal.role !== 'admin' &&
    (contentType === 'Roles' || !allowed(ctx, apiName, contentType, action, contentId))
  )
    throw new HttpError(
      403,
      'You may only delegate permissions you already hold; role administration requires a bootstrap administrator',
    );
  return { apiName, contentType, contentId, action };
}
async function delegatableRole(ctx: Context, roleId: string) {
  if (ctx.principal.role === 'admin') return;
  for (const row of await all(
    ctx,
    'SELECT apiName,contentType,contentId,action FROM role_permissions WHERE churchId=? AND roleId=?',
    ctx.principal.churchId,
    roleId,
  ))
    await validatePermission(ctx, row);
}

export async function roles(ctx: Context): Promise<Response | undefined> {
  const path = ctx.path.toLowerCase(),
    method = ctx.request.method,
    cid = ctx.principal.churchId;
  if (path === '/membership/users/loadorcreate' && method === 'POST') {
    access(ctx, 'Edit');
    const input = await body(ctx.request);
    const userId = input.userId ? requiredString(input.userId, 'userId') : null;
    const email = input.userEmail ? requiredString(input.userEmail, 'userEmail') : null;
    if (!userId && !email) throw new HttpError(400, 'Existing user ID or email required');
    const user = await first(
      ctx,
      `SELECT u.id,u.email,u.firstName,u.lastName FROM users u JOIN user_churches uc ON uc.userId=u.id WHERE uc.churchId=? AND ${userId ? 'u.id=?' : 'u.email=? COLLATE NOCASE'}`,
      cid,
      userId || email,
    );
    if (!user)
      throw new HttpError(
        404,
        'No existing account in this church; use an administrator-issued invitation to create or link an account',
      );
    return json({ ...user, isNewUser: false });
  }
  if (path === '/membership/userchurch' && method === 'POST') {
    access(ctx, 'Edit');
    const userId = requiredString(ctx.url.searchParams.get('userId'), 'userId'),
      input = await body(ctx.request);
    const personId = requiredString(input.personId, 'personId');
    const link = await first(
      ctx,
      'SELECT userId,churchId,personId,role FROM user_churches WHERE churchId=? AND userId=?',
      cid,
      userId,
    );
    if (!link || link.personId !== personId)
      throw new HttpError(
        409,
        'Only the existing account-to-person link is supported; relinking requires a separate reviewed workflow',
      );
    return json(link);
  }
  if (path.startsWith('/membership/userchurch/userid/') && method === 'GET') {
    access(ctx, 'View');
    const link = await first(
      ctx,
      'SELECT userId,churchId,personId FROM user_churches WHERE churchId=? AND userId=?',
      cid,
      ctx.path.split('/').pop(),
    );
    if (!link) throw new HttpError(404, 'User church link not found');
    return json(link);
  }
  if (path === '/membership/permissions' && method === 'GET') {
    access(ctx, 'View');
    return json(permissionCatalog);
  }
  if (path === '/membership/permissionscopes' && method === 'GET') {
    access(ctx, 'View');
    const candidates = [
      { apiName: 'MembershipApi', contentType: 'Groups' },
      { apiName: 'MembershipApi', contentType: 'Group Members' },
      { apiName: 'DoingApi', contentType: 'Plans' },
      { apiName: 'DoingApi', contentType: 'Tasks' },
    ];
    const groupFilter = scopeMetadataFilter(ctx, candidates);
    const groups = await all(
      ctx,
      `SELECT id,name,tags FROM groups WHERE churchId=? AND (${groupFilter.sql}) ORDER BY name,id LIMIT 1000`,
      cid,
      ...groupFilter.values,
    );
    const result = groups
      .map((group) => ({
        id: group.id,
        name: group.name,
        scopeType: 'group',
        permissions: candidates
          .filter(
            (permission) => permission.contentType !== 'Plans' || (group.tags || '').split(',').includes('ministry'),
          )
          .map((permission) => ({
            ...permission,
            actions: ['View', 'Edit'].filter((action) =>
              allowed(ctx, permission.apiName, permission.contentType, action, group.id),
            ),
          }))
          .filter((permission) => permission.actions.length),
      }))
      .filter((group) => group.permissions.length);
    for (const [contentType, table, nameColumn] of [
      ['Calendars', 'calendars', 'name'],
      ['Sermons', 'content_sermons', 'title'],
      ['Playlists', 'content_playlists', 'title'],
    ]) {
      const filter = scopeMetadataFilter(ctx, [{ apiName: 'ContentApi', contentType }]);
      const rows = await all(
        ctx,
        `SELECT id,${nameColumn} name FROM ${table} WHERE churchId=? AND (${filter.sql}) ORDER BY ${nameColumn},id LIMIT 1000`,
        cid,
        ...filter.values,
      );
      for (const row of rows) {
        const actions = ['View', 'Edit'].filter((action) => allowed(ctx, 'ContentApi', contentType, action, row.id));
        if (actions.length)
          result.push({
            id: row.id,
            name: row.name,
            scopeType: contentType.toLowerCase(),
            permissions: [{ apiName: 'ContentApi', contentType, actions }],
          });
      }
    }
    return json(result);
  }
  if (!/^\/membership\/(roles|rolepermissions|rolemembers)(?:\/|$)/.test(path)) return undefined;
  access(ctx, method === 'GET' ? 'View' : 'Edit');
  if ((path === '/membership/roles' || path.startsWith('/membership/roles/church/')) && method === 'GET') {
    if (path.includes('/church/') && ctx.path.split('/').pop() !== cid) throw new HttpError(403, 'Church mismatch');
    const rows = await all(
      ctx,
      'SELECT r.*, (SELECT count(*) FROM role_members rm WHERE rm.churchId=r.churchId AND rm.roleId=r.id) memberCount FROM roles r WHERE churchId=? ORDER BY name,id',
      cid,
    );
    return json([await role(ctx, builtinId), ...rows]);
  }
  if (path === '/membership/roles' && method === 'POST') {
    const rows = await inputRecords(ctx),
      statements = [],
      result = [];
    for (const row of rows) {
      tenant(ctx, row);
      const rid = row.id ? requiredString(row.id, 'id') : id();
      if (rid === builtinId) throw new HttpError(409, 'Bootstrap administrator role is protected');
      await ownId(ctx, 'roles', rid);
      const existing = await first(ctx, 'SELECT id FROM roles WHERE churchId=? AND id=?', cid, rid);
      if (existing) await editableRole(ctx, rid);
      const name = requiredString(row.name, 'role name', 100);
      if (name.toLowerCase() === 'domain admins') throw new HttpError(400, 'Domain Admins is a reserved role name');
      statements.push(
        ...roleWriteGuard(ctx, { roleIds: existing ? [rid] : [], table: 'roles', id: rid, existing }),
        ctx.env.DB.prepare(
          'INSERT INTO roles(id,churchId,name) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name WHERE roles.churchId=excluded.churchId',
        ).bind(rid, cid, name),
        audit(ctx, 'permission.role.save', rid),
      );
      result.push({ id: rid, churchId: cid, name });
    }
    await ctx.env.DB.batch(statements);
    return json(result);
  }
  const roleMatch = /^\/membership\/roles\/([^/]+)$/.exec(ctx.path);
  if (roleMatch && (method === 'GET' || method === 'DELETE')) {
    const rid = roleMatch[1];
    if (method === 'GET') return json(await role(ctx, rid));
    const existing = await editableRole(ctx, rid);
    await ctx.env.DB.batch([
      ...roleWriteGuard(ctx, { roleIds: [rid], table: 'roles', id: rid, existing }),
      ctx.env.DB.prepare('DELETE FROM roles WHERE churchId=? AND id=?').bind(cid, rid),
      audit(ctx, 'permission.role.delete', rid),
    ]);
    return json([]);
  }
  const roleChild = /^\/membership\/(rolepermissions|rolemembers)\/roles\/([^/]+)$/.exec(ctx.path);
  if (roleChild && method === 'GET') {
    const [, _resource, rid] = roleChild;
    const resource = _resource.toLowerCase();
    if (rid === 'null' && resource === 'rolepermissions') return json([]);
    await role(ctx, rid);
    if (resource === 'rolepermissions') {
      if (rid === builtinId)
        return json(
          permissionCatalog.map((p, index) => ({
            id: `builtin-permission-${index}`,
            churchId: cid,
            roleId: rid,
            apiName: p.apiName,
            contentType: p.section,
            contentId: '',
            action: p.action,
            protected: true,
          })),
        );
      return json(
        await all(
          ctx,
          'SELECT * FROM role_permissions WHERE churchId=? AND roleId=? ORDER BY apiName,contentType,action',
          cid,
          rid,
        ),
      );
    }
    const rows =
      rid === builtinId
        ? await all(
            ctx,
            "SELECT 'builtin-member-'||uc.userId id,uc.churchId,? roleId,uc.userId,uc.personId,u.email,u.firstName,u.lastName FROM user_churches uc JOIN users u ON u.id=uc.userId WHERE uc.churchId=? AND uc.role='admin'",
            rid,
            cid,
          )
        : await all(
            ctx,
            'SELECT rm.*,uc.personId,u.email,u.firstName,u.lastName FROM role_members rm JOIN users u ON u.id=rm.userId JOIN user_churches uc ON uc.userId=rm.userId AND uc.churchId=rm.churchId WHERE rm.churchId=? AND rm.roleId=?',
            cid,
            rid,
          );
    const includeUsers = (ctx.url.searchParams.get('include') || '').split(',').includes('users');
    return json(
      rows.map((row) => {
        const { email, firstName, lastName, ...record } = row;
        return {
          ...record,
          ...(rid === builtinId ? { protected: true } : {}),
          ...(includeUsers ? { user: { id: row.userId, email, firstName, lastName } } : {}),
        };
      }),
    );
  }
  if (path === '/membership/rolepermissions' && method === 'POST') {
    const rows = await inputRecords(ctx),
      statements = [],
      result = [];
    for (const row of rows) {
      tenant(ctx, row);
      if (!row.roleId || row.roleId === 'null') throw new HttpError(501, 'Everyone grants are not supported');
      const rid = requiredString(row.roleId, 'roleId');
      await editableRole(ctx, rid);
      const permission = await validatePermission(ctx, row);
      const pid = row.id ? requiredString(row.id, 'id') : id();
      await ownId(ctx, 'role_permissions', pid);
      const existing = await first(ctx, 'SELECT * FROM role_permissions WHERE churchId=? AND id=?', cid, pid);
      if (existing) await editableRole(ctx, existing.roleId);
      statements.push(
        ...roleWriteGuard(ctx, {
          roleIds: existing ? [rid, existing.roleId] : [rid],
          table: 'role_permissions',
          id: pid,
          existing,
          grant: permission,
        }),
        ctx.env.DB.prepare(
          'INSERT INTO role_permissions(id,churchId,roleId,apiName,contentType,contentId,action) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET roleId=excluded.roleId,apiName=excluded.apiName,contentType=excluded.contentType,contentId=excluded.contentId,action=excluded.action WHERE role_permissions.churchId=excluded.churchId',
        ).bind(pid, cid, rid, permission.apiName, permission.contentType, permission.contentId, permission.action),
        audit(ctx, 'permission.grant.save', pid),
      );
      result.push({ id: pid, churchId: cid, roleId: rid, ...permission });
    }
    await ctx.env.DB.batch(statements);
    return json(result);
  }
  if (path === '/membership/rolemembers' && method === 'POST') {
    const rows = await inputRecords(ctx),
      statements = [],
      result = [];
    for (const row of rows) {
      tenant(ctx, row);
      const rid = requiredString(row.roleId, 'roleId');
      await editableRole(ctx, rid);
      await delegatableRole(ctx, rid);
      let userId = row.userId;
      if (!userId && row.personId) {
        const candidates = await all(
          ctx,
          'SELECT userId FROM user_churches WHERE churchId=? AND personId=?',
          cid,
          requiredString(row.personId, 'personId'),
        );
        if (candidates.length !== 1)
          throw new HttpError(409, 'The selected person must have exactly one existing account in this church');
        userId = candidates[0].userId;
      }
      if (!userId && row.user?.email) {
        const user = await first(
          ctx,
          'SELECT u.id FROM users u JOIN user_churches uc ON uc.userId=u.id WHERE uc.churchId=? AND u.email=? COLLATE NOCASE',
          cid,
          requiredString(row.user.email, 'email'),
        );
        userId = user?.id;
      }
      if (!userId) throw new HttpError(400, 'An existing user in this church is required');
      userId = requiredString(userId, 'userId');
      if (!(await first(ctx, 'SELECT userId FROM user_churches WHERE churchId=? AND userId=?', cid, userId)))
        throw new HttpError(400, 'An existing user in this church is required');
      if (ctx.principal.role !== 'admin' && userId === ctx.principal.userId)
        throw new HttpError(403, 'You cannot assign yourself a role');
      const mid = row.id ? requiredString(row.id, 'id') : id();
      await ownId(ctx, 'role_members', mid);
      const existing = await first(
        ctx,
        'SELECT roleId,userId,dateAdded,addedBy FROM role_members WHERE churchId=? AND id=?',
        cid,
        mid,
      );
      if (existing) {
        await editableRole(ctx, existing.roleId);
        if (ctx.principal.role !== 'admin' && existing.userId === ctx.principal.userId)
          throw new HttpError(403, 'You cannot change your own role membership');
      }
      const dateAdded = existing?.dateAdded || now(),
        addedBy = existing?.addedBy || ctx.principal.userId;
      statements.push(
        ...roleWriteGuard(ctx, {
          roleIds: existing ? [rid, existing.roleId] : [rid],
          table: 'role_members',
          id: mid,
          existing,
          assignUserId: userId,
          delegateRoleId: rid,
        }),
        ctx.env.DB.prepare(
          'INSERT INTO role_members(id,churchId,roleId,userId,addedBy,dateAdded) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET roleId=excluded.roleId,userId=excluded.userId WHERE role_members.churchId=excluded.churchId',
        ).bind(mid, cid, rid, userId, addedBy, dateAdded),
        audit(ctx, 'permission.member.save', mid),
      );
      result.push({
        id: mid,
        churchId: cid,
        roleId: rid,
        userId,
        addedBy,
        dateAdded,
      });
    }
    await ctx.env.DB.batch(statements);
    return json(result);
  }
  const childDelete = /^\/membership\/(rolepermissions|rolemembers)\/([^/]+)$/.exec(ctx.path);
  if (childDelete && method === 'DELETE') {
    const resource = childDelete[1],
      recordId = childDelete[2];
    if (recordId.startsWith('builtin-'))
      throw new HttpError(409, 'Bootstrap administrators and permissions are protected');
    const table = resource === 'rolepermissions' ? 'role_permissions' : 'role_members';
    const row = await first(ctx, `SELECT * FROM ${table} WHERE churchId=? AND id=?`, cid, recordId);
    if (!row) throw new HttpError(404, 'Record not found');
    await editableRole(ctx, row.roleId);
    if (resource === 'rolemembers' && ctx.principal.role !== 'admin' && row.userId === ctx.principal.userId)
      throw new HttpError(403, 'You cannot change your own role membership');
    await ctx.env.DB.batch([
      ...roleWriteGuard(ctx, { roleIds: [row.roleId], table, id: recordId, existing: row }),
      ctx.env.DB.prepare(`DELETE FROM ${table} WHERE churchId=? AND id=?`).bind(cid, recordId),
      audit(ctx, `permission.${resource}.delete`, recordId),
    ]);
    return json([]);
  }
  throw new HttpError(501, 'This role management route is not implemented');
}
