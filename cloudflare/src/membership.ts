import type { Context } from './types';
import { allowed } from './permissions';
import { advancedPeopleSearch } from './directory-search';
import { validTimeZone } from './plan-time';
import { groupWriteGuard } from './group-write';
import { doingWriteGuard } from './doing-permissions';
import { approvalGroup } from './member-profile';
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
  return {
    ...row,
    trackAttendance: !!row.trackAttendance,
    archived: !!row.archived,
  };
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
  const order = new Map(ids.map((value, index) => [value, index]));
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
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
function groupReadable(ctx: Context, groupId?: string): boolean {
  return ['View', 'Edit'].some(
    (action) =>
      allowed(ctx, 'MembershipApi', 'Groups', action, groupId) ||
      allowed(ctx, 'MembershipApi', 'Group Members', action, groupId) ||
      allowed(ctx, 'MembershipApi', 'People', action),
  );
}
function groupMembersAllowed(ctx: Context, action: 'View' | 'Edit', groupId?: string): boolean {
  return (
    allowed(ctx, 'MembershipApi', 'Group Members', action, groupId) ||
    allowed(ctx, 'MembershipApi', 'Groups', 'Edit', groupId) ||
    (action === 'View' && allowed(ctx, 'MembershipApi', 'Group Members', 'Edit', groupId))
  );
}
function hasGroupScope(ctx: Context, members = false): boolean {
  return (ctx.principal.permissions || []).some((key) =>
    ['Groups', 'Group Members'].some(
      (content) =>
        key.startsWith(`MembershipApi_${content}_`) &&
        (key.endsWith('_Edit') || ((!members || content === 'Group Members') && key.endsWith('_View'))),
    ),
  );
}
function requireGroupRead(ctx: Context) {
  if (!groupReadable(ctx) && !hasGroupScope(ctx)) throw new HttpError(403, 'Group view permission required');
}
function requireGroupEdit(ctx: Context, groupId?: string) {
  if (!allowed(ctx, 'MembershipApi', 'Groups', 'Edit', groupId))
    throw new HttpError(403, 'Group edit permission required');
}
function requireMemberEdit(ctx: Context, groupId: string) {
  if (!groupMembersAllowed(ctx, 'Edit', groupId)) throw new HttpError(403, 'Group member edit permission required');
}
function withDirectoryReviewGroup(settings: string, groupId: string): string {
  const parsed = JSON.parse(settings);
  if (Array.isArray(parsed)) {
    let replaced = false;
    const result = parsed.flatMap((entry) => {
      if (entry?.keyName !== 'directoryApprovalGroupId') return [entry];
      if (replaced) return [];
      replaced = true;
      return [{ ...entry, value: groupId }];
    });
    if (!replaced && groupId) result.push({ keyName: 'directoryApprovalGroupId', value: groupId });
    return JSON.stringify(result);
  }
  if (parsed && typeof parsed === 'object') return JSON.stringify({ ...parsed, directoryApprovalGroupId: groupId });
  throw new HttpError(409, 'The stored church settings format needs staff repair before changing review policy');
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
    const church = await first(ctx, 'SELECT id,name,subDomain,settings,timeZone FROM churches WHERE id=?', cid);
    return json({
      ...church,
      settings: JSON.parse(church!.settings),
      directoryApprovalGroupId: approvalGroup(church!.settings) || '',
    });
  }
  if (path === '/membership/churches/directoryreviewgroups' && method === 'GET') {
    if (!allowed(ctx, 'MembershipApi', 'Settings', 'Edit'))
      throw new HttpError(403, 'Settings edit permission required');
    const groups = await all(
      ctx,
      'SELECT id,name FROM groups WHERE churchId=? AND archived=0 ORDER BY name,id LIMIT 1001',
      cid,
    );
    if (groups.length > 1000) throw new HttpError(413, 'Too many groups for the directory review selector');
    return json(groups);
  }
  if (path === '/membership/churches' && method === 'POST') {
    if (!allowed(ctx, 'MembershipApi', 'Settings', 'Edit'))
      throw new HttpError(403, 'Settings edit permission required');
    const input = await records(request);
    if (input.length !== 1 || input[0].id !== cid) throw new HttpError(403, 'Only the current church can be edited');
    const existing = await first(ctx, 'SELECT * FROM churches WHERE id=?', cid);
    const row = input[0];
    // Installation and public-host settings have separate operational boundaries.
    if (
      Object.keys(row).some(
        (key) =>
          !['id', 'churchId', 'name', 'timeZone', 'directoryApprovalGroupId', 'subDomain', 'settings'].includes(key),
      )
    )
      throw new HttpError(400, 'This church field is not yet supported');
    tenant(ctx, row);
    if ((row.subDomain !== undefined && row.subDomain !== existing!.subDomain) || row.settings !== undefined)
      throw new HttpError(400, 'Only church name, timeZone and directoryApprovalGroupId can be changed here');
    const name = requiredString(row.name ?? existing!.name, 'church name');
    const zone = validTimeZone(row.timeZone ?? existing!.timeZone);
    let settings = existing!.settings as string;
    const checks: { sql: string; values: (string | number | null)[] }[] = [
      {
        sql: `EXISTS(SELECT 1 FROM user_churches uc WHERE uc.churchId=? AND uc.userId=? AND uc.personId=? AND
        (uc.role='admin' OR EXISTS(SELECT 1 FROM role_members rm JOIN role_permissions rp ON rp.churchId=rm.churchId AND rp.roleId=rm.roleId
        WHERE rm.churchId=uc.churchId AND rm.userId=uc.userId AND rp.apiName='MembershipApi' AND rp.contentType='Settings' AND rp.contentId='' AND rp.action='Edit')))`,
        values: [cid, principal.userId, principal.personId],
      },
      {
        sql: 'EXISTS(SELECT 1 FROM churches WHERE id=? AND settings=? AND name=? AND timeZone=?)',
        values: [cid, existing!.settings, existing!.name, existing!.timeZone],
      },
    ];
    if (row.directoryApprovalGroupId !== undefined) {
      if (
        typeof row.directoryApprovalGroupId !== 'string' ||
        row.directoryApprovalGroupId.length > 128 ||
        /[\x00-\x1f\x7f]/.test(row.directoryApprovalGroupId)
      )
        throw new HttpError(400, 'Invalid directory approval group');
      const groupId = row.directoryApprovalGroupId.trim();
      if (groupId) {
        if (!(await first(ctx, 'SELECT id FROM groups WHERE churchId=? AND id=? AND archived=0', cid, groupId)))
          throw new HttpError(400, 'Choose an active group in this church');
        checks.push({
          sql: 'EXISTS(SELECT 1 FROM groups WHERE churchId=? AND id=? AND archived=0)',
          values: [cid, groupId],
        });
      }
      settings = withDirectoryReviewGroup(settings, groupId);
    }
    await env.DB.batch([
      ...doingWriteGuard(ctx, { checks }),
      env.DB.prepare('UPDATE churches SET name=?,timeZone=?,settings=? WHERE id=?').bind(name, zone, settings, cid),
      auditStatement(ctx, 'churches.save', cid),
    ]);
    return json([
      {
        id: cid,
        name,
        subDomain: existing!.subDomain,
        timeZone: zone,
        directoryApprovalGroupId: approvalGroup(settings) || '',
      },
    ]);
  }
  if (path === '/membership/people/advancedsearch' && method === 'POST')
    return json((await advancedPeopleSearch(ctx, await body(request))).map(serialize));
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
    return json(
      (
        await all(
          ctx,
          "SELECT * FROM people WHERE churchId=? AND removed=0 AND (instr(lower(firstName||' '||lastName),lower(?))>0 OR (?=0 AND instr(lower(email),lower(?))>0)) ORDER BY lastName,firstName LIMIT 200",
          cid,
          term,
          onlyNames ? 1 : 0,
          term,
        )
      ).map(serialize),
    );
  }
  if (path === '/membership/people/ids' && method === 'GET') {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 100);
    return json((await peopleByIds(ctx, ids)).map(serialize));
  }
  if (/^\/membership\/people\/household\/[^/]+$/.test(path) && method === 'POST') {
    requireAdmin(ctx);
    const householdId = ctx.path.split('/').pop()!;
    if (!(await first(ctx, 'SELECT id FROM households WHERE churchId=? AND id=?', cid, householdId)))
      throw new HttpError(404, 'Household not found');
    const input = await body<unknown>(request);
    if (
      !Array.isArray(input) ||
      input.length > 100 ||
      input.some((p) => !p || typeof p !== 'object' || Array.isArray(p))
    )
      throw new HttpError(400, 'Expected an array of up to 100 household members');
    const submittedIds: string[] = [];
    const sourceHouseholds = new Set<string>([householdId]);
    const updates: D1PreparedStatement[] = [];
    for (const p of input) {
      tenant(ctx, p);
      const personId = requiredString(p.id, 'person id');
      if (submittedIds.includes(personId)) throw new HttpError(400, 'Duplicate household member');
      if (p.householdId && p.householdId !== householdId) throw new HttpError(400, 'Household mismatch');
      const role = p.householdRole || 'Other';
      if (!['Head', 'Spouse', 'Child', 'Other'].includes(role)) throw new HttpError(400, 'Invalid household role');
      const person = await first(
        ctx,
        'SELECT householdId FROM people WHERE churchId=? AND id=? AND removed=0',
        cid,
        personId,
      );
      if (!person) throw new HttpError(404, 'Person not found');
      submittedIds.push(personId);
      if (person.householdId) sourceHouseholds.add(person.householdId);
      updates.push(
        env.DB.prepare('UPDATE people SET householdId=?,householdRole=? WHERE churchId=? AND id=? AND removed=0').bind(
          householdId,
          role,
          cid,
          personId,
        ),
      );
    }
    // Evaluate omitted members inside the same D1 batch as the moves. A stale pre-read must
    // not split a person who has already moved to another household in a concurrent save.
    const splitPrefix = id() + '-';
    const selected = JSON.stringify(submittedIds);
    const omitted = 'churchId=? AND householdId=? AND removed=0 AND id NOT IN (SELECT value FROM json_each(?))';
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO households(id,churchId,name) SELECT ?||id,churchId,coalesce(nullif(lastName,''),firstName) FROM people WHERE ${omitted}`,
      ).bind(splitPrefix, cid, householdId, selected),
      env.DB.prepare(`UPDATE people SET householdId=?||id,householdRole='Head' WHERE ${omitted}`).bind(
        splitPrefix,
        cid,
        householdId,
        selected,
      ),
      ...updates,
      auditStatement(ctx, 'households.members', householdId),
      env.DB.prepare(
        'DELETE FROM households WHERE churchId=? AND id IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM people WHERE people.churchId=households.churchId AND people.householdId=households.id)',
      ).bind(cid, JSON.stringify([...sourceHouseholds])),
    ]);
    return json((await peopleByIds(ctx, submittedIds)).map(serialize));
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
  if (/^\/membership\/households\/[^/]+$/.test(path) && ['GET', 'DELETE'].includes(method)) {
    const row = await first(ctx, 'SELECT * FROM households WHERE churchId=? AND id=?', cid, ctx.path.split('/').pop());
    if (!row) throw new HttpError(404, 'Household not found');
    if (method === 'DELETE') {
      requireAdmin(ctx);
      // The FK also enforces this if a person joins after this preflight check.
      if (await first(ctx, 'SELECT id FROM people WHERE churchId=? AND householdId=? LIMIT 1', cid, row.id))
        throw new HttpError(409, 'Move household members before deleting the household');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM households WHERE churchId=? AND id=?').bind(cid, row.id),
        auditStatement(ctx, 'households.delete', row.id),
      ]);
      return json({});
    }
    return json(row);
  }
  if ((path === '/membership/groups/my' || path.startsWith('/membership/groups/my/')) && method === 'GET') {
    requireGroupRead(ctx);
    const tag = path.startsWith('/membership/groups/my/') ? ctx.path.split('/').pop() : null;
    return json(
      (
        await all(
          ctx,
          `SELECT g.*,gm.leader FROM groups g JOIN group_members gm ON gm.groupId=g.id AND gm.churchId=g.churchId WHERE gm.churchId=? AND gm.personId=? ${tag ? "AND instr(','||g.tags||',',','||?||',')>0" : ''} ORDER BY g.name,g.id`,
          cid,
          principal.personId,
          ...(tag ? [tag] : []),
        )
      )
        .filter((row) => groupReadable(ctx, row.id))
        .map(groupJson),
    );
  }
  if (path === '/membership/groups/ids' && method === 'GET') {
    requireGroupRead(ctx);
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
      )
        .filter((row) => groupReadable(ctx, row.id))
        .map(groupJson),
    );
  }
  if (path.startsWith('/membership/groups/categories/') && method === 'GET') {
    requireGroupRead(ctx);
    const rows = await all(
      ctx,
      "SELECT id,categoryName FROM groups WHERE churchId=? AND instr(','||tags||',',','||?||',')>0 ORDER BY categoryName",
      cid,
      ctx.path.split('/').pop(),
    );
    return json(
      [...new Set(rows.filter((row) => groupReadable(ctx, row.id)).map((row) => row.categoryName))].map(
        (categoryName) => ({ categoryName }),
      ),
    );
  }
  if ((path === '/membership/groups' || path.startsWith('/membership/groups/tag/')) && method === 'GET') {
    requireGroupRead(ctx);
    const tag = path.includes('/tag/') ? ctx.path.split('/').pop() : null;
    const archived = url.searchParams.get('archived');
    if (archived !== null && !['0', '1', 'false', 'true'].includes(archived))
      throw new HttpError(400, 'Invalid archived filter');
    const archiveFlag = ['1', 'true'].includes(archived || '') ? 1 : 0;
    return json(
      (
        await all(
          ctx,
          `SELECT g.*, (SELECT count(*) FROM group_members gm WHERE gm.churchId=g.churchId AND gm.groupId=g.id) memberCount FROM groups g WHERE g.churchId=? AND g.archived=? ${tag ? "AND instr(','||g.tags||',',','||?||',')>0" : ''} ORDER BY g.name`,
          cid,
          archiveFlag,
          ...(tag ? [tag] : []),
        )
      )
        .filter((row) => groupReadable(ctx, row.id))
        .map(groupJson),
    );
  }
  if (path === '/membership/groups' && method === 'POST') {
    const rows = await records(request),
      result = [],
      statements = [];
    for (const row of rows) {
      tenant(ctx, row);
      const gid = clean(row.id) || id();
      await ensureOwn(ctx, 'groups', gid);
      const existing = await first(ctx, 'SELECT * FROM groups WHERE churchId=? AND id=?', cid, gid);
      requireGroupEdit(ctx, existing ? gid : undefined);
      const g = { ...existing, ...row };
      const name = requiredString(g.name, 'group name');
      const category = clean(g.categoryName) || '';
      const tags = clean(g.tags) || 'standard';
      const about = clean(g.about, 5000);
      const attendance = g.trackAttendance ? 1 : 0;
      const joinPolicy = g.joinPolicy || 'closed';
      const parentId = clean(g.parentId);
      if ((existing?.parentId || null) !== parentId) requireGroupEdit(ctx);
      if (parentId === gid) throw new HttpError(400, 'A group cannot be its own parent');
      if (parentId && !(await first(ctx, 'SELECT id FROM groups WHERE churchId=? AND id=?', cid, parentId)))
        throw new HttpError(400, 'Unknown parent group');
      const meetingTime = clean(g.meetingTime, 255);
      const meetingLocation = clean(g.meetingLocation, 500);
      if (g.archived !== undefined && g.archived !== null && ![true, false, 0, 1].includes(g.archived))
        throw new HttpError(400, 'Invalid archived flag');
      const archived = g.archived ? 1 : 0;
      if (!['open', 'request', 'closed'].includes(joinPolicy)) throw new HttpError(400, 'Invalid joinPolicy');
      statements.push(
        ...groupWriteGuard(ctx, { kind: 'group', id: gid, existing, parentId }),
        env.DB.prepare(
          'INSERT INTO groups(id,churchId,name,categoryName,tags,about,trackAttendance,joinPolicy,parentId,meetingTime,meetingLocation,archived) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,categoryName=excluded.categoryName,tags=excluded.tags,about=excluded.about,trackAttendance=excluded.trackAttendance,joinPolicy=excluded.joinPolicy,parentId=excluded.parentId,meetingTime=excluded.meetingTime,meetingLocation=excluded.meetingLocation,archived=excluded.archived WHERE groups.churchId=excluded.churchId',
        ).bind(
          gid,
          cid,
          name,
          category,
          tags,
          about,
          attendance,
          joinPolicy,
          parentId,
          meetingTime,
          meetingLocation,
          archived,
        ),
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
        parentId,
        meetingTime,
        meetingLocation,
        archived: !!archived,
      });
    }
    await env.DB.batch(statements);
    return json(result);
  }
  if (/^\/membership\/groups\/[^/]+$/.test(path) && (method === 'GET' || method === 'DELETE')) {
    const gid = ctx.path.split('/').pop();
    const row = await first(ctx, 'SELECT * FROM groups WHERE churchId=? AND id=?', cid, gid);
    if (!row) throw new HttpError(404, 'Group not found');
    if (method === 'GET') {
      if (!groupReadable(ctx, row.id)) throw new HttpError(403, 'Group view permission required');
      return json(groupJson(row));
    }
    requireGroupEdit(ctx, row.id);
    if (await first(ctx, 'SELECT id FROM groups WHERE churchId=? AND parentId=? LIMIT 1', cid, row.id))
      requireGroupEdit(ctx);
    await env.DB.batch([
      ...groupWriteGuard(ctx, {
        kind: 'group',
        id: row.id,
        existing: row,
        remove: true,
      }),
      env.DB.prepare('DELETE FROM groups WHERE churchId=? AND id=?').bind(cid, gid),
      auditStatement(ctx, 'groups.delete', gid!),
    ]);
    return json({ success: true });
  }
  if (path === '/membership/groupmembers' && method === 'GET') {
    if (!groupMembersAllowed(ctx, 'View') && !hasGroupScope(ctx, true))
      throw new HttpError(403, 'Group member view permission required');
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
      if (!groupMembersAllowed(ctx, 'View', row.groupId)) continue;
      const person = await first(
        ctx,
        'SELECT * FROM people WHERE churchId=? AND id=? AND removed=0',
        cid,
        row.personId,
      );
      if (!person) continue;
      const group = await first(ctx, 'SELECT * FROM groups WHERE churchId=? AND id=?', cid, row.groupId);
      results.push({
        ...row,
        leader: !!row.leader,
        person: serialize(person),
        group: groupJson(group),
      });
    }
    return json(results);
  }
  if (path === '/membership/groupmembers' && method === 'POST') {
    const rows = await records(request),
      statements = [],
      result = [];
    for (const row of rows) {
      tenant(ctx, row);
      const mid = clean(row.id) || id();
      await ensureOwn(ctx, 'group_members', mid);
      const personId = requiredString(row.personId, 'personId');
      const groupId = requiredString(row.groupId, 'groupId');
      requireMemberEdit(ctx, groupId);
      const existing = await first(ctx, 'SELECT groupId FROM group_members WHERE churchId=? AND id=?', cid, mid);
      if (existing) requireMemberEdit(ctx, existing.groupId);
      if (
        !(await first(ctx, 'SELECT id FROM people WHERE churchId=? AND id=? AND removed=0', cid, personId)) ||
        !(await first(ctx, 'SELECT id FROM groups WHERE churchId=? AND id=?', cid, groupId))
      )
        throw new HttpError(400, 'Unknown person or group');
      statements.push(
        ...groupWriteGuard(ctx, {
          kind: 'member',
          id: mid,
          existing,
          groupId,
          personId,
        }),
        env.DB.prepare(
          'INSERT INTO group_members(id,churchId,groupId,personId,leader) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET groupId=excluded.groupId,personId=excluded.personId,leader=excluded.leader WHERE group_members.churchId=excluded.churchId',
        ).bind(mid, cid, groupId, personId, row.leader ? 1 : 0),
        auditStatement(ctx, 'groupmembers.save', mid),
      );
      result.push({
        id: mid,
        churchId: cid,
        groupId,
        personId,
        leader: !!row.leader,
      });
    }
    await env.DB.batch(statements);
    return json(result);
  }
  if (/^\/membership\/groupmembers\/[^/]+$/.test(path) && method === 'DELETE') {
    const mid = ctx.path.split('/').pop();
    const row = await first(ctx, 'SELECT id,groupId FROM group_members WHERE churchId=? AND id=?', cid, mid);
    if (!row) throw new HttpError(404, 'Group membership not found');
    requireMemberEdit(ctx, row.groupId);
    await env.DB.batch([
      ...groupWriteGuard(ctx, {
        kind: 'member',
        id: row.id,
        existing: row,
        remove: true,
      }),
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
