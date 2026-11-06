import type { Context } from './types';
import { all, first, json, HttpError, id, now } from './http';
import { content } from './content';
import { memberProfile } from './member-profile';
import { attachEventExceptions, expandCalendarEvents, validateWindow } from './recurrence';
import { memberPageOptions, memberPageResult, memberSearch } from './member-pagination';

function name(row: Record<string, any>) {
  return {
    first: row.firstName,
    last: row.lastName,
    display: [row.nickName || row.firstName, row.lastName].filter(Boolean).join(' '),
  };
}
/** Member-only wire surface: it never returns the staff person/household representation. */
export async function member(ctx: Context): Promise<Response | undefined> {
  const { request, principal } = ctx;
  if (!ctx.path.startsWith('/member/')) return undefined;
  const profileResponse = await memberProfile(ctx);
  if (profileResponse) return profileResponse;
  const groupAction = /^\/member\/v1\/groups\/([^/]+)\/(join|leave)$/.exec(ctx.path);
  if (groupAction) {
    const [, groupId, action] = groupAction;
    if (request.method !== (action === 'join' ? 'POST' : 'DELETE')) throw new HttpError(405, 'Method not allowed');
    const group = await first(
      ctx,
      'SELECT id,joinPolicy,archived FROM groups WHERE churchId=? AND id=?',
      principal.churchId,
      groupId,
    );
    if (!group) throw new HttpError(404, 'Group not found');
    if (action === 'join') {
      if (group.archived || group.joinPolicy !== 'open')
        throw new HttpError(409, 'This group is not open for self-service joining');
      const membershipId = id();
      await ctx.env.DB.batch([
        ctx.env.DB.prepare(
          "INSERT INTO group_members(id,churchId,groupId,personId,leader) SELECT ?,churchId,id,?,0 FROM groups WHERE churchId=? AND id=? AND joinPolicy='open' AND archived=0 ON CONFLICT(churchId,groupId,personId) DO NOTHING",
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
  const archiveDownload = /^\/member\/v1\/files\/([^/]+)\/download$/.exec(ctx.path);
  if (archiveDownload) {
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed');
    // Deliberately reduce access even for staff using this member URL: unpublished files stay hidden.
    const response = await content({
      ...ctx,
      path: `/content/files/download/${archiveDownload[1]}`,
      principal: { ...principal, role: 'member' },
    });
    if (!response) throw new HttpError(404, 'Archive file not found');
    return response;
  }
  if (request.method !== 'GET') throw new HttpError(405, 'Member resources are read-only');
  if (ctx.path === '/member/v1/groups/available') {
    const options = memberPageOptions(ctx),
      { query } = memberSearch(ctx);
    return memberPageResult(
      await all(
        ctx,
        "SELECT g.id,g.name,g.categoryName,g.about,g.joinPolicy FROM groups g WHERE g.churchId=? AND g.joinPolicy IN ('open','request') AND g.archived=0 AND NOT EXISTS(SELECT 1 FROM group_members gm WHERE gm.churchId=g.churchId AND gm.groupId=g.id AND gm.personId=?) AND (?='' OR instr(lower(g.name),lower(?))>0) ORDER BY g.name,g.id LIMIT ? OFFSET ?",
        principal.churchId,
        principal.personId,
        query,
        query,
        options.limit + 1,
        options.offset,
      ),
      options,
    );
  }

  if (ctx.path === '/member/v1/directory') {
    const options = memberPageOptions(ctx),
      { query } = memberSearch(ctx);
    const rows = await all(
      ctx,
      "SELECT id,firstName,lastName,nickName,email,shareEmail FROM people WHERE churchId=? AND removed=0 AND directoryVisible=1 AND (?='' OR instr(lower(firstName||' '||lastName||' '||COALESCE(nickName,'')||' '||lastName),lower(?))>0) ORDER BY lastName,firstName,id LIMIT ? OFFSET ?",
      principal.churchId,
      query,
      query,
      options.limit + 1,
      options.offset,
    );
    return memberPageResult(
      rows.map((row) => ({
        id: row.id,
        name: name(row),
        contactInfo: row.shareEmail ? { email: row.email } : {},
      })),
      options,
    );
  }
  if (ctx.path === '/member/v1/groups') {
    const options = memberPageOptions(ctx),
      { query } = memberSearch(ctx);
    const rows = await all(
      ctx,
      "SELECT g.id,g.name,g.categoryName,g.about,g.meetingTime,g.meetingLocation,gm.leader FROM groups g JOIN group_members gm ON gm.churchId=g.churchId AND gm.groupId=g.id WHERE gm.churchId=? AND gm.personId=? AND (?='' OR instr(lower(g.name),lower(?))>0) ORDER BY g.name,g.id LIMIT ? OFFSET ?",
      principal.churchId,
      principal.personId,
      query,
      query,
      options.limit + 1,
      options.offset,
    );
    return memberPageResult(
      rows.map((row) => ({ ...row, leader: !!row.leader })),
      options,
    );
  }
  if (ctx.path === '/member/v1/calendar') {
    const options = memberPageOptions(ctx, 200);
    const suppliedFrom = ctx.url.searchParams.get('from'),
      suppliedTo = ctx.url.searchParams.get('to');
    for (const value of [suppliedFrom, suppliedTo]) {
      if (
        value !== null &&
        (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
      )
        throw new HttpError(400, 'Calendar range requires an ISO timestamp with timezone');
    }
    const from = suppliedFrom || now();
    const to = suppliedTo || new Date(Date.parse(from) + 90 * 86400000).toISOString();
    validateWindow(from, to);
    const rows = await all(
      ctx,
      `SELECT e.id,e.title,e.description,e.start,e.end,e.allDay,e.timeZone,e.location,e.calendarId,c.name calendarName,e.groupId,
        e.recurrenceRule,e.recurrenceParentId,e.recurrenceOriginalDate
       FROM calendar_events e JOIN calendars c ON c.churchId=e.churchId AND c.id=e.calendarId
       WHERE e.churchId=?
       AND (c.groupId IS NULL OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.churchId=c.churchId AND gm.groupId=c.groupId AND gm.personId=?))
       AND (e.groupId IS NULL OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.churchId=e.churchId AND gm.groupId=e.groupId AND gm.personId=?))
       AND (e.recurrenceRule IS NOT NULL OR (e.end>? AND e.start<?)) ORDER BY e.start,e.id LIMIT 501`,
      principal.churchId,
      principal.personId,
      principal.personId,
      new Date(Date.parse(from) - 2 * 86400000).toISOString(),
      new Date(Date.parse(to) + 2 * 86400000).toISOString(),
    );
    if (rows.length > 500) throw new HttpError(400, 'Calendar has too many series; request a smaller window');
    // Tenant and both group-visibility checks happen before exceptions or recurrence are loaded.
    const events = await attachEventExceptions(ctx.env.DB, principal.churchId, rows);
    return memberPageResult(
      expandCalendarEvents(events, from, to).slice(options.offset, options.offset + options.limit + 1),
      options,
    );
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
      files.map((file) => ({
        ...file,
        downloadUrl: `/api/member/v1/files/${encodeURIComponent(file.id)}/download`,
      })),
    );
  }
  if (ctx.path === '/member/v1/sermons') {
    const options = memberPageOptions(ctx),
      { query } = memberSearch(ctx);
    return memberPageResult(
      await all(
        ctx,
        "SELECT id,title,description,speaker,publishDate,videoUrl,audioUrl,thumbnail,publishedAt FROM content_sermons WHERE churchId=? AND visibility='public' AND publishedAt IS NOT NULL AND publishDate<=? AND (?='' OR instr(lower(title||' '||COALESCE(description,'')||' '||COALESCE(speaker,'')),lower(?))>0) ORDER BY publishDate DESC,id LIMIT ? OFFSET ?",
        principal.churchId,
        now(),
        query,
        query,
        options.limit + 1,
        options.offset,
      ),
      options,
    );
  }
  throw new HttpError(404, 'Member API route not found');
}
