import type { Context } from './types';
import { all, first, body, json, HttpError, id, now } from './http';
import { content } from './content';

function name(row: Record<string, any>) {
  return {
    first: row.firstName,
    last: row.lastName,
    display: [row.nickName || row.firstName, row.lastName].filter(Boolean).join(' '),
  };
}
function ownPerson(row: Record<string, any>) {
  const contact = JSON.parse(row.contactInfo || '{}');
  return {
    id: row.id,
    name: name(row),
    contactInfo: { email: row.email, mobilePhone: contact.mobilePhone || '' },
    directoryVisible: !!row.directoryVisible,
    shareEmail: !!row.shareEmail,
  };
}
function page(ctx: Context, max = 100) {
  const limit = ctx.url.searchParams.get('limit') || String(max),
    offset = ctx.url.searchParams.get('offset') || '0';
  if (
    !/^\d+$/.test(limit) ||
    !/^\d+$/.test(offset) ||
    Number(limit) < 1 ||
    Number(limit) > max ||
    Number(offset) > 10000
  )
    throw new HttpError(400, 'Invalid pagination');
  return { limit: Number(limit), offset: Number(offset) };
}
async function profile(ctx: Context) {
  const person = await first(
    ctx,
    'SELECT * FROM people WHERE churchId=? AND id=? AND removed=0',
    ctx.principal.churchId,
    ctx.principal.personId,
  );
  if (!person) throw new HttpError(404, 'Member profile not found');
  const church = await first(ctx, 'SELECT id,name,subDomain FROM churches WHERE id=?', ctx.principal.churchId);
  return { person: ownPerson(person), church };
}
/** Member-only wire surface: it never returns the staff person/household representation. */
export async function member(ctx: Context): Promise<Response | undefined> {
  const { request, principal } = ctx;
  if (!ctx.path.startsWith('/member/')) return undefined;
  if (ctx.path === '/member/v1/me') {
    if (request.method === 'GET') return json(await profile(ctx));
    if (request.method === 'POST') {
      const input = await body(ctx.request);
      if (
        Array.isArray(input) ||
        Object.keys(input).some((key) => !['mobilePhone', 'directoryVisible', 'shareEmail'].includes(key))
      )
        throw new HttpError(400, 'Only mobilePhone and directory preferences may be changed');
      for (const field of ['directoryVisible', 'shareEmail'])
        if (input[field] !== undefined && typeof input[field] !== 'boolean')
          throw new HttpError(400, 'Directory preferences must be booleans');
      if (
        input.mobilePhone !== undefined &&
        (typeof input.mobilePhone !== 'string' ||
          input.mobilePhone.length > 40 ||
          /[\x00-\x1f]/.test(input.mobilePhone))
      )
        throw new HttpError(400, 'Invalid mobile phone');
      await profile(ctx);
      const hasPhone = input.mobilePhone !== undefined;
      await ctx.env.DB.batch([
        ctx.env.DB.prepare(
          "UPDATE people SET contactInfo=CASE WHEN ? THEN json_set(contactInfo,'$.mobilePhone',?) ELSE contactInfo END, directoryVisible=COALESCE(?,directoryVisible), shareEmail=COALESCE(?,shareEmail) WHERE churchId=? AND id=? AND removed=0",
        ).bind(
          hasPhone ? 1 : 0,
          hasPhone ? input.mobilePhone.trim() : '',
          input.directoryVisible === undefined ? null : input.directoryVisible ? 1 : 0,
          input.shareEmail === undefined ? null : input.shareEmail ? 1 : 0,
          principal.churchId,
          principal.personId,
        ),
        ctx.env.DB.prepare(
          'INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) VALUES(?,?,?,?,?,?)',
        ).bind(id(), principal.churchId, principal.userId, 'member.profile.update', principal.personId, now()),
      ]);
      return json(await profile(ctx));
    }
    throw new HttpError(405, 'Method not allowed');
  }
  const groupAction = /^\/member\/v1\/groups\/([^/]+)\/(join|leave)$/.exec(ctx.path);
  if (groupAction) {
    const [, groupId, action] = groupAction;
    if (request.method !== (action === 'join' ? 'POST' : 'DELETE')) throw new HttpError(405, 'Method not allowed');
    const group = await first(
      ctx,
      'SELECT id,joinPolicy FROM groups WHERE churchId=? AND id=?',
      principal.churchId,
      groupId,
    );
    if (!group) throw new HttpError(404, 'Group not found');
    if (action === 'join') {
      if (group.joinPolicy !== 'open') throw new HttpError(409, 'This group is not open for self-service joining');
      const membershipId = id();
      await ctx.env.DB.batch([
        ctx.env.DB.prepare(
          "INSERT INTO group_members(id,churchId,groupId,personId,leader) SELECT ?,churchId,id,?,0 FROM groups WHERE churchId=? AND id=? AND joinPolicy='open' ON CONFLICT(churchId,groupId,personId) DO NOTHING",
        ).bind(membershipId, principal.personId, principal.churchId, groupId),
        ctx.env.DB.prepare(
          'INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) SELECT ?,churchId,?,?,groupId,? FROM group_members WHERE id=? AND churchId=?',
        ).bind(id(), principal.userId, 'member.group.join', now(), membershipId, principal.churchId),
      ]);
      const membership = await first(
        ctx,
        'SELECT id FROM group_members WHERE churchId=? AND groupId=? AND personId=?',
        principal.churchId,
        groupId,
        principal.personId,
      );
      if (!membership) throw new HttpError(409, 'The group is no longer open for joining');
      return json({ success: true, groupId, joined: true });
    }
    const current = await first(
      ctx,
      'SELECT id,leader FROM group_members WHERE churchId=? AND groupId=? AND personId=?',
      principal.churchId,
      groupId,
      principal.personId,
    );
    if (!current) return json({ success: true, groupId, joined: false });
    if (current.leader) throw new HttpError(409, 'Ask an administrator to transfer leadership before leaving');
    const results = await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        'INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) SELECT ?,churchId,?,?,groupId,? FROM group_members WHERE id=? AND churchId=? AND personId=? AND leader=0',
      ).bind(id(), principal.userId, 'member.group.leave', now(), current.id, principal.churchId, principal.personId),
      ctx.env.DB.prepare('DELETE FROM group_members WHERE id=? AND churchId=? AND personId=? AND leader=0').bind(
        current.id,
        principal.churchId,
        principal.personId,
      ),
    ]);
    if (!results[1].meta.changes) throw new HttpError(409, 'Group membership changed; refresh before leaving');
    return json({ success: true, groupId, joined: false });
  }
  if (request.method !== 'GET') throw new HttpError(405, 'Member resources are read-only');
  if (ctx.path === '/member/v1/groups/available') {
    const { limit, offset } = page(ctx);
    return json(
      await all(
        ctx,
        "SELECT g.id,g.name,g.categoryName,g.about FROM groups g WHERE g.churchId=? AND g.joinPolicy='open' AND NOT EXISTS(SELECT 1 FROM group_members gm WHERE gm.churchId=g.churchId AND gm.groupId=g.id AND gm.personId=?) ORDER BY g.name,g.id LIMIT ? OFFSET ?",
        principal.churchId,
        principal.personId,
        limit,
        offset,
      ),
    );
  }

  if (ctx.path === '/member/v1/directory') {
    const { limit, offset } = page(ctx);
    const rows = await all(
      ctx,
      'SELECT id,firstName,lastName,nickName,email,shareEmail FROM people WHERE churchId=? AND removed=0 AND directoryVisible=1 ORDER BY lastName,firstName,id LIMIT ? OFFSET ?',
      principal.churchId,
      limit,
      offset,
    );
    return json(
      rows.map((row) => ({ id: row.id, name: name(row), contactInfo: row.shareEmail ? { email: row.email } : {} })),
    );
  }
  if (ctx.path === '/member/v1/groups') {
    const { limit, offset } = page(ctx);
    const rows = await all(
      ctx,
      'SELECT g.id,g.name,g.categoryName,g.about,gm.leader FROM groups g JOIN group_members gm ON gm.churchId=g.churchId AND gm.groupId=g.id WHERE gm.churchId=? AND gm.personId=? ORDER BY g.name,g.id LIMIT ? OFFSET ?',
      principal.churchId,
      principal.personId,
      limit,
      offset,
    );
    return json(rows.map((row) => ({ ...row, leader: !!row.leader })));
  }
  if (ctx.path === '/member/v1/calendar') {
    const { limit, offset } = page(ctx, 200);
    let range = '';
    const rangeArgs: string[] = [];
    for (const [key, column, operator] of [
      ['from', 'e.end', '>='],
      ['to', 'e.start', '<='],
    ]) {
      const value = ctx.url.searchParams.get(key);
      if (value) {
        if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
          throw new HttpError(400, 'Calendar range requires an ISO timestamp with timezone');
        range += ` AND ${column}${operator}?`;
        rangeArgs.push(new Date(value).toISOString());
      }
    }
    const rows = await all(
      ctx,
      `SELECT e.id,e.title,e.description,e.start,e.end,e.allDay,e.timeZone,e.location,e.calendarId,c.name calendarName,e.groupId
   FROM calendar_events e JOIN calendars c ON c.churchId=e.churchId AND c.id=e.calendarId
   WHERE e.churchId=?
   AND (c.groupId IS NULL OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.churchId=c.churchId AND gm.groupId=c.groupId AND gm.personId=?))
   AND (e.groupId IS NULL OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.churchId=e.churchId AND gm.groupId=e.groupId AND gm.personId=?))
   ${range} ORDER BY e.start,e.id LIMIT ? OFFSET ?`,
      principal.churchId,
      principal.personId,
      principal.personId,
      ...rangeArgs,
      limit,
      offset,
    );
    return json(rows.map((row) => ({ ...row, allDay: !!row.allDay })));
  }
  const archiveList = /^\/member\/v1\/sermons\/([^/]+)\/files$/.exec(ctx.path);
  if (archiveList) {
    const sermon = await first(
      ctx,
      "SELECT id FROM content_sermons WHERE churchId=? AND id=? AND visibility='public' AND publishedAt IS NOT NULL AND publishDate<=?",
      principal.churchId,
      archiveList[1],
      now(),
    );
    if (!sermon) throw new HttpError(404, 'Published sermon not found');
    const files = await all(
      ctx,
      "SELECT id,fileName,fileType,size,dateModified FROM content_files WHERE churchId=? AND contentId=? AND state='ready' ORDER BY dateModified,id LIMIT 100",
      principal.churchId,
      archiveList[1],
    );
    return json(
      files.map((file) => ({ ...file, downloadUrl: `/api/member/v1/files/${encodeURIComponent(file.id)}/download` })),
    );
  }
  const archiveDownload = /^\/member\/v1\/files\/([^/]+)\/download$/.exec(ctx.path);
  if (archiveDownload) {
    // Deliberately reduce access even for staff using this member URL: unpublished files stay hidden.
    const response = await content({
      ...ctx,
      path: `/content/files/download/${archiveDownload[1]}`,
      principal: { ...principal, role: 'member' },
    });
    if (!response) throw new HttpError(404, 'Archive file not found');
    return response;
  }
  if (ctx.path === '/member/v1/sermons') {
    const { limit, offset } = page(ctx);
    return json(
      await all(
        ctx,
        "SELECT id,title,description,speaker,publishDate,videoUrl,audioUrl,thumbnail,publishedAt FROM content_sermons WHERE churchId=? AND visibility='public' AND publishedAt IS NOT NULL AND publishDate<=? ORDER BY publishDate DESC,id LIMIT ? OFFSET ?",
        principal.churchId,
        now(),
        limit,
        offset,
      ),
    );
  }
  throw new HttpError(404, 'Member API route not found');
}
