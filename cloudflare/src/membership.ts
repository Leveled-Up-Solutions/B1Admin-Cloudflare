import type { Context } from './types';
import { allowed } from './permissions';
import { all, first, json, body, records, requireAdmin, requiredString, HttpError, id, now } from './http';
export function personJson(row: any): any {
  if (!row) return null;
  return {
    id: row.id,
    churchId: row.churchId,
    name: {
      first: row.firstName,
      last: row.lastName,
      middle: row.middleName || '',
      nick: row.nickName || '',
      display: [row.nickName || row.firstName, row.lastName].filter(Boolean).join(' '),
    },
    contactInfo: { ...JSON.parse(row.contactInfo || '{}'), email: row.email },
    birthDate: row.birthDate,
    gender: row.gender,
    maritalStatus: row.maritalStatus,
    anniversary: row.anniversary,
    membershipStatus: row.membershipStatus,
    grade: row.grade,
    school: row.school,
    householdId: row.householdId,
    householdRole: row.householdRole,
    campusId: row.campusId,
    photo: row.photo,
    dateAdded: row.dateAdded,
    removed: !!row.removed,
  };
}
function groupJson(row: any) {
  return { ...row, trackAttendance: !!row.trackAttendance };
}
function clean(value: any, max = 255): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, 'Invalid field value');
  return value;
}
function date(value: any): string | null {
  const s = clean(value, 40);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(s)) throw new HttpError(400, 'Invalid date');
  const day = s.slice(0, 10),
    parsed = new Date(day + 'T00:00:00.000Z');
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== day ||
    (s.length > 10 && !Number.isFinite(Date.parse(s)))
  )
    throw new HttpError(400, 'Invalid date');
  return day;
}
async function peopleByIds(ctx: Context, ids: string[], includeRemoved = false): Promise<any[]> {
  const rows: any[] = [];
  // One binding is reserved for churchId. D1 allows at most 100 per statement.
  for (let start = 0; start < ids.length; start += 99) {
    const chunk = ids.slice(start, start + 99);
    rows.push(
      ...(await all(
        ctx,
        `SELECT * FROM people WHERE churchId=? ${includeRemoved ? '' : 'AND removed=0'} AND id IN (${chunk.map(() => '?').join(',')})`,
        ctx.principal.churchId,
        ...chunk,
      )),
    );
  }
  return rows;
}
function tenant(ctx: Context, row: any) {
  if (row.churchId && row.churchId !== ctx.principal.churchId) throw new HttpError(403, 'Church mismatch');
}
async function ensureOwn(ctx: Context, table: string, recordId: string) {
  const row = await first(ctx, `SELECT churchId FROM ${table} WHERE id=?`, recordId);
  if (row && row.churchId !== ctx.principal.churchId) throw new HttpError(404, 'Record not found');
}
function auditStatement(ctx: Context, action: string, entityId: string) {
  return ctx.env.DB.prepare(
    'INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) VALUES(?,?,?,?,?,?)',
  ).bind(id(), ctx.principal.churchId, ctx.principal.userId, action, entityId, now());
}
export async function membership(ctx: Context): Promise<Response | undefined> {
  const { request, url, principal, env } = ctx;
  const path = ctx.path.replace(/\/$/, '').toLowerCase();
  const method = request.method;
  const cid = principal.churchId;
  if (!path.startsWith('/membership/')) return undefined;
  const onlyNames =
    !allowed(ctx, 'MembershipApi', 'People', 'View') && !allowed(ctx, 'MembershipApi', 'People', 'Edit');
  const serialize = (row: any) => {
    const p = personJson(row);
    return onlyNames && p ? { id: p.id, churchId: p.churchId, name: p.name, photo: p.photo } : p;
  };
  if ((path === '/membership/churches/current' || ctx.path === '/membership/churches/' + cid) && method === 'GET') {
    const church = await first(ctx, 'SELECT id,name,subDomain,settings FROM churches WHERE id=?', cid);
    return json({ ...church, settings: JSON.parse(church!.settings) });
  }
  if (path === '/membership/people/duplicates' && method === 'POST') {
    const input = await body(request);
    const list = await all(
      ctx,
      "SELECT * FROM people WHERE churchId=? AND removed=0 AND ((lower(firstName)=lower(?) AND lower(lastName)=lower(?)) OR (?<>'' AND lower(email)=lower(?))) LIMIT 50",
      cid,
      clean(input.firstName) || '',
      clean(input.lastName) || '',
      onlyNames ? '' : clean(input.email) || '',
      onlyNames ? '' : clean(input.email) || '',
    );
    return json(list.map(serialize));
  }
  if (path === '/membership/people/search' && (method === 'GET' || method === 'POST')) {
    const input = method === 'POST' ? await body(request) : {};
    const term = String(input.term || url.searchParams.get('term') || '')
      .trim()
      .slice(0, 100);
    const pattern = '%' + term.replace(/[\\%_]/g, '\\$&') + '%';
    return json(
      (
        await all(
          ctx,
          "SELECT * FROM people WHERE churchId=? AND removed=0 AND (firstName||' '||lastName LIKE ? ESCAPE '\\' OR (?=0 AND email LIKE ? ESCAPE '\\')) ORDER BY lastName,firstName LIMIT 200",
          cid,
          pattern,
          onlyNames ? 1 : 0,
          pattern,
        )
      ).map(serialize),
    );
  }
  if (path === '/membership/people/ids' && method === 'GET') {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 100);
    return json((await peopleByIds(ctx, ids)).map(serialize));
  }
  if (onlyNames && path.startsWith('/membership/people/household/'))
    throw new HttpError(403, 'People view permission required');
  if (path.startsWith('/membership/people/household/') && method === 'GET')
    return json(
      (
        await all(
          ctx,
          'SELECT * FROM people WHERE churchId=? AND householdId=? AND removed=0 ORDER BY lastName,firstName',
          cid,
          ctx.path.split('/').pop(),
        )
      ).map(serialize),
    );
  if (
    ['/membership/people', '/membership/people/list', '/membership/people/recent'].includes(path) &&
    method === 'GET'
  ) {
    const rawLimit = url.searchParams.get('pageSize') || '1000';
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 1000)
      throw new HttpError(400, 'Invalid pageSize');
    const limit = Number(rawLimit);
    const order = path.endsWith('/recent') ? 'dateAdded DESC' : 'lastName,firstName';
    return json(
      (await all(ctx, `SELECT * FROM people WHERE churchId=? AND removed=0 ORDER BY ${order} LIMIT ?`, cid, limit)).map(
        serialize,
      ),
    );
  }
  if (path === '/membership/people' && method === 'POST') {
    requireAdmin(ctx);
    const input = await records(request);
    const statements: D1PreparedStatement[] = [];
    const ids: string[] = [];
    for (const p of input) {
      tenant(ctx, p);
      for (const field of ['name', 'contactInfo'])
        if (p[field] !== undefined && (!p[field] || typeof p[field] !== 'object' || Array.isArray(p[field])))
          throw new HttpError(400, 'Invalid ' + field);
      const pid = clean(p.id) || id();
      await ensureOwn(ctx, 'people', pid);
      ids.push(pid);
      const existing = await first(ctx, 'SELECT * FROM people WHERE id=? AND churchId=?', pid, cid);
      const original = personJson(existing) || {};
      const merged = { ...original, ...p };
      const name = { ...original.name, ...p.name };
      const contact = { ...original.contactInfo, ...p.contactInfo };
      const allowedContact: any = {};
      for (const field of [
        'email',
        'mobilePhone',
        'homePhone',
        'workPhone',
        'address1',
        'address2',
        'city',
        'state',
        'zip',
        'country',
      ]) {
        const v = clean(contact[field]);
        if (v !== null) allowedContact[field] = v;
      }
      const fn = requiredString(name.first, 'first name', 100),
        ln = clean(name.last, 100) || '';
      const household = clean(merged.householdId);
      if (household && !(await first(ctx, 'SELECT id FROM households WHERE churchId=? AND id=?', cid, household)))
        throw new HttpError(400, 'Unknown household');
      if (merged.photo && !String(merged.photo).startsWith('/api/content/files/'))
        throw new HttpError(400, 'Use a local uploaded photo');
      const values = [
        pid,
        cid,
        fn,
        ln,
        clean(name.middle, 100) || '',
        clean(name.nick, 100) || '',
        allowedContact.email || '',
        JSON.stringify(allowedContact),
        date(merged.birthDate),
        clean(merged.gender),
        clean(merged.maritalStatus),
        date(merged.anniversary),
        clean(merged.membershipStatus) || 'Visitor',
        clean(merged.grade),
        clean(merged.school),
        household,
        clean(merged.householdRole),
        clean(merged.campusId),
        clean(merged.photo, 500),
        existing?.dateAdded || now(),
      ];
      statements.push(
        env.DB.prepare(
          'INSERT INTO people(id,churchId,firstName,lastName,middleName,nickName,email,contactInfo,birthDate,gender,maritalStatus,anniversary,membershipStatus,grade,school,householdId,householdRole,campusId,photo,dateAdded) VALUES(' +
            values.map(() => '?').join(',') +
            ') ON CONFLICT(id) DO UPDATE SET firstName=excluded.firstName,lastName=excluded.lastName,middleName=excluded.middleName,nickName=excluded.nickName,email=excluded.email,contactInfo=excluded.contactInfo,birthDate=excluded.birthDate,gender=excluded.gender,maritalStatus=excluded.maritalStatus,anniversary=excluded.anniversary,membershipStatus=excluded.membershipStatus,grade=excluded.grade,school=excluded.school,householdId=excluded.householdId,householdRole=excluded.householdRole,campusId=excluded.campusId,photo=excluded.photo WHERE people.churchId=excluded.churchId',
        ).bind(...values),
        auditStatement(ctx, 'people.save', pid),
      );
    }
    await env.DB.batch(statements);
    return json((await peopleByIds(ctx, ids, true)).map(serialize));
  }
  const personMatch = path.match(/^\/membership\/people\/([^/]+)$/);
  if (personMatch && (method === 'GET' || method === 'DELETE')) {
    const pid = ctx.path.split('/').pop()!;
    const row = await first(ctx, 'SELECT * FROM people WHERE churchId=? AND id=? AND removed=0', cid, pid);
    if (!row) throw new HttpError(404, 'Person not found');
    if (method === 'DELETE') {
      requireAdmin(ctx);
      if (await first(ctx, 'SELECT userId FROM user_churches WHERE churchId=? AND personId=?', cid, pid))
        throw new HttpError(409, 'Cannot remove a linked login');
      await env.DB.batch([
        env.DB.prepare('UPDATE people SET removed=1 WHERE churchId=? AND id=?').bind(cid, pid),
        auditStatement(ctx, 'people.remove', pid),
      ]);
      return json({ success: true });
    }
    return json(serialize(row));
  }
  if (path === '/membership/households' && method === 'GET')
    return json(await all(ctx, 'SELECT * FROM households WHERE churchId=? ORDER BY name', cid));
  if (path === '/membership/households' && method === 'POST') {
    requireAdmin(ctx);
    const rows = await records(request);
    const result = [];
    const statements = [];
    for (const row of rows) {
      tenant(ctx, row);
      const hid = clean(row.id) || id();
      await ensureOwn(ctx, 'households', hid);
      const name = requiredString(row.name, 'household name');
      statements.push(
        env.DB.prepare(
          'INSERT INTO households(id,churchId,name) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name WHERE households.churchId=excluded.churchId',
        ).bind(hid, cid, name),
        auditStatement(ctx, 'households.save', hid),
      );
      result.push({ id: hid, churchId: cid, name });
    }
    await env.DB.batch(statements);
    return json(result);
  }
  if (/^\/membership\/households\/[^/]+$/.test(path) && method === 'GET') {
    const row = await first(ctx, 'SELECT * FROM households WHERE churchId=? AND id=?', cid, ctx.path.split('/').pop());
    if (!row) throw new HttpError(404, 'Household not found');
    return json(row);
  }
  if ((path === '/membership/groups/my' || path.startsWith('/membership/groups/my/')) && method === 'GET') {
    const tag = path.startsWith('/membership/groups/my/') ? ctx.path.split('/').pop() : null;
    return json(
      (
        await all(
          ctx,
          `SELECT g.*,gm.leader FROM groups g JOIN group_members gm ON gm.groupId=g.id AND gm.churchId=g.churchId WHERE gm.churchId=? AND gm.personId=? ${tag ? 'AND g.tags LIKE ?' : ''} ORDER BY g.name,g.id`,
          cid,
          principal.personId,
          ...(tag ? ['%' + tag + '%'] : []),
        )
      ).map(groupJson),
    );
  }
  if (path === '/membership/groups/ids' && method === 'GET') {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
    if (ids.length > 100) throw new HttpError(400, 'At most 100 group IDs');
    return json(
      (
        await all(
          ctx,
          'SELECT * FROM groups WHERE churchId=? AND id IN (SELECT value FROM json_each(?))',
          cid,
          JSON.stringify(ids),
        )
      ).map(groupJson),
    );
  }
  if (path.startsWith('/membership/groups/categories/') && method === 'GET')
    return json(
      await all(
        ctx,
        'SELECT DISTINCT categoryName FROM groups WHERE churchId=? AND tags LIKE ? ORDER BY categoryName',
        cid,
        '%' + ctx.path.split('/').pop() + '%',
      ),
    );
  if ((path === '/membership/groups' || path.startsWith('/membership/groups/tag/')) && method === 'GET') {
    const tag = path.includes('/tag/') ? ctx.path.split('/').pop() : null;
    return json(
      (
        await all(
          ctx,
          `SELECT g.*, (SELECT count(*) FROM group_members gm WHERE gm.churchId=g.churchId AND gm.groupId=g.id) memberCount FROM groups g WHERE g.churchId=? ${tag ? 'AND g.tags LIKE ?' : ''} ORDER BY g.name`,
          cid,
          ...(tag ? ['%' + tag + '%'] : []),
        )
      ).map(groupJson),
    );
  }
  if (path === '/membership/groups' && method === 'POST') {
    requireAdmin(ctx);
    const rows = await records(request),
      result = [],
      statements = [];
    for (const row of rows) {
      tenant(ctx, row);
      const gid = clean(row.id) || id();
      await ensureOwn(ctx, 'groups', gid);
      const existing = await first(ctx, 'SELECT * FROM groups WHERE churchId=? AND id=?', cid, gid);
      const g = { ...existing, ...row };
      const name = requiredString(g.name, 'group name');
      const category = clean(g.categoryName) || '';
      const tags = clean(g.tags) || 'standard';
      const about = clean(g.about, 5000);
      const attendance = g.trackAttendance ? 1 : 0;
      const joinPolicy = g.joinPolicy || 'closed';
      if (!['open', 'request', 'closed'].includes(joinPolicy)) throw new HttpError(400, 'Invalid joinPolicy');
      statements.push(
        env.DB.prepare(
          'INSERT INTO groups(id,churchId,name,categoryName,tags,about,trackAttendance,joinPolicy) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,categoryName=excluded.categoryName,tags=excluded.tags,about=excluded.about,trackAttendance=excluded.trackAttendance,joinPolicy=excluded.joinPolicy WHERE groups.churchId=excluded.churchId',
        ).bind(gid, cid, name, category, tags, about, attendance, joinPolicy),
        auditStatement(ctx, 'groups.save', gid),
      );
      result.push({
        id: gid,
        churchId: cid,
        name,
        categoryName: category,
        tags,
        about,
        trackAttendance: !!attendance,
        joinPolicy,
      });
    }
    await env.DB.batch(statements);
    return json(result);
  }
  if (/^\/membership\/groups\/[^/]+$/.test(path) && (method === 'GET' || method === 'DELETE')) {
    const gid = ctx.path.split('/').pop();
    const row = await first(ctx, 'SELECT * FROM groups WHERE churchId=? AND id=?', cid, gid);
    if (!row) throw new HttpError(404, 'Group not found');
    if (method === 'GET') return json(groupJson(row));
    requireAdmin(ctx);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM groups WHERE churchId=? AND id=?').bind(cid, gid),
      auditStatement(ctx, 'groups.delete', gid!),
    ]);
    return json({ success: true });
  }
  if (path === '/membership/groupmembers' && method === 'GET') {
    const personId = url.searchParams.get('personId'),
      groupId = url.searchParams.get('groupId');
    let sql = 'SELECT * FROM group_members WHERE churchId=?';
    const args: any[] = [cid];
    if (personId) {
      sql += ' AND personId=?';
      args.push(personId);
    }
    if (groupId) {
      sql += ' AND groupId=?';
      args.push(groupId);
    }
    if (url.searchParams.has('groupIds')) {
      const groupIds = (url.searchParams.get('groupIds') || '').split(',').filter(Boolean);
      if (groupIds.length > 100 || groupIds.some((value) => value.length > 255))
        throw new HttpError(400, 'Invalid groupIds');
      sql += ' AND groupId IN (SELECT value FROM json_each(?))';
      args.push(JSON.stringify(groupIds));
    }
    const rows = await all(ctx, sql, ...args);
    const results = [];
    for (const row of rows) {
      const person = await first(
        ctx,
        'SELECT * FROM people WHERE churchId=? AND id=? AND removed=0',
        cid,
        row.personId,
      );
      if (!person) continue;
      const group = await first(ctx, 'SELECT * FROM groups WHERE churchId=? AND id=?', cid, row.groupId);
      results.push({ ...row, leader: !!row.leader, person: personJson(person), group: groupJson(group) });
    }
    return json(results);
  }
  if (path === '/membership/groupmembers' && method === 'POST') {
    requireAdmin(ctx);
    const rows = await records(request),
      statements = [],
      result = [];
    for (const row of rows) {
      tenant(ctx, row);
      const mid = clean(row.id) || id();
      await ensureOwn(ctx, 'group_members', mid);
      const personId = requiredString(row.personId, 'personId');
      const groupId = requiredString(row.groupId, 'groupId');
      if (
        !(await first(ctx, 'SELECT id FROM people WHERE churchId=? AND id=? AND removed=0', cid, personId)) ||
        !(await first(ctx, 'SELECT id FROM groups WHERE churchId=? AND id=?', cid, groupId))
      )
        throw new HttpError(400, 'Unknown person or group');
      statements.push(
        env.DB.prepare(
          'INSERT INTO group_members(id,churchId,groupId,personId,leader) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET groupId=excluded.groupId,personId=excluded.personId,leader=excluded.leader WHERE group_members.churchId=excluded.churchId',
        ).bind(mid, cid, groupId, personId, row.leader ? 1 : 0),
        auditStatement(ctx, 'groupmembers.save', mid),
      );
      result.push({ id: mid, churchId: cid, groupId, personId, leader: !!row.leader });
    }
    await env.DB.batch(statements);
    return json(result);
  }
  if (/^\/membership\/groupmembers\/[^/]+$/.test(path) && method === 'DELETE') {
    requireAdmin(ctx);
    const mid = ctx.path.split('/').pop();
    const row = await first(ctx, 'SELECT id FROM group_members WHERE churchId=? AND id=?', cid, mid);
    if (!row) throw new HttpError(404, 'Group membership not found');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM group_members WHERE churchId=? AND id=?').bind(cid, mid),
      auditStatement(ctx, 'groupmembers.delete', mid!),
    ]);
    return json({ success: true });
  }
  if ((path === '/membership/auditlogs' || path === '/membership/auditlog') && method === 'GET') {
    if (principal.role !== 'admin' && !principal.permissions?.includes('MembershipApi_Settings__Edit'))
      throw new HttpError(403, 'Settings edit permission required');
    const rawLimit = url.searchParams.get('limit') || '50',
      rawOffset = url.searchParams.get('offset') || '0';
    if (
      !/^\d+$/.test(rawLimit) ||
      !/^\d+$/.test(rawOffset) ||
      Number(rawLimit) < 1 ||
      Number(rawLimit) > 200 ||
      Number(rawOffset) > 100000
    )
      throw new HttpError(400, 'Invalid pagination');
    const limit = Number(rawLimit),
      offset = Number(rawOffset);
    let where = 'churchId=?';
    const args: any[] = [cid];
    for (const field of ['category', 'module', 'entityType', 'entityId', 'userId']) {
      const value = url.searchParams.get(field);
      if (value) {
        where += ` AND ${field}=?`;
        args.push(requiredString(value, field));
      }
    }
    for (const [param, column, operator] of [
      ['startDate', 'created', '>='],
      ['endDate', 'created', '<='],
    ]) {
      const value = url.searchParams.get(param);
      if (value) {
        const day = date(value);
        where += ` AND ${column}${operator}?`;
        args.push(day + (param === 'startDate' ? 'T00:00:00.000Z' : 'T23:59:59.999Z'));
      }
    }
    const count = await first(ctx, `SELECT count(*) count FROM audit_log_read WHERE ${where}`, ...args);
    const logs = await all(
      ctx,
      `SELECT * FROM audit_log_read WHERE ${where} ORDER BY created DESC,id DESC LIMIT ? OFFSET ?`,
      ...args,
      limit,
      offset,
    );
    return json({ logs, count: count?.count || 0, limit, offset });
  }
  return undefined;
}
