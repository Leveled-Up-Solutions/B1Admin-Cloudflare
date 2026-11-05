import type { Context } from './types';
import { all, first, HttpError, id, json, now, records, requiredString, requireAdmin } from './http';

type Row = Record<string, any>;
function text(value: unknown, field: string, max = 2000): string {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `Invalid ${field}`);
  return value;
}
function timeZone(value: unknown): string {
  const zone = requiredString(value || 'UTC', 'timeZone', 100);
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format();
  } catch {
    throw new HttpError(400, 'Invalid IANA timeZone');
  }
  return zone;
}
function civilDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, `${field} must be YYYY-MM-DD`);
  const parsed = Date.parse(value + 'T00:00:00.000Z');
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value)
    throw new HttpError(400, `Invalid ${field}`);
  return value;
}
function eventDate(value: unknown, field: string, allDay: boolean): string {
  const input = requiredString(value, field, 40);
  if (allDay) return civilDate(input, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input))
    throw new HttpError(400, `${field} must include a UTC Z or numeric offset`);
  civilDate(input.slice(0, 10), field);
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed)) throw new HttpError(400, `Invalid ${field}`);
  return new Date(parsed).toISOString();
}
async function group(ctx: Context, value: unknown): Promise<string | null> {
  if (value == null || value === '') return null;
  const groupId = requiredString(value, 'groupId', 100);
  if (!(await first(ctx, 'SELECT id FROM groups WHERE churchId=? AND id=?', ctx.principal.churchId, groupId)))
    throw new HttpError(404, 'Group not found');
  return groupId;
}
function audit(ctx: Context, action: string, entityId: string): D1PreparedStatement {
  return ctx.env.DB.prepare(
    'INSERT INTO audit_log (id,churchId,userId,action,entityId,createdAt) VALUES (?,?,?,?,?,?)',
  ).bind(id(), ctx.principal.churchId, ctx.principal.userId, action, entityId, now());
}
function serialized(row: Row): Row {
  return { ...row, allDay: Boolean(row.allDay) };
}

async function calendars(ctx: Context, calendarId?: string): Promise<Response | undefined> {
  const churchId = ctx.principal.churchId;
  if (ctx.request.method === 'GET') {
    if (calendarId) {
      const row = await first(ctx, 'SELECT * FROM calendars WHERE churchId=? AND id=?', churchId, calendarId);
      if (!row) throw new HttpError(404, 'Calendar not found');
      return json(row);
    }
    return json(await all(ctx, 'SELECT * FROM calendars WHERE churchId=? ORDER BY name,id LIMIT 500', churchId));
  }
  if (ctx.request.method === 'POST' && !calendarId) {
    requireAdmin(ctx);
    const inputs = await records(ctx.request);
    const statements: D1PreparedStatement[] = [];
    const result: Row[] = [];
    const seen = new Set<string>();
    for (const input of inputs) {
      if (input.churchId && input.churchId !== churchId) throw new HttpError(403, 'Church mismatch');
      const entityId = input.id ? requiredString(input.id, 'id', 100) : id();
      if (seen.has(entityId)) throw new HttpError(400, 'Duplicate calendar id');
      seen.add(entityId);
      const previous = input.id
        ? await first(ctx, 'SELECT * FROM calendars WHERE churchId=? AND id=?', churchId, entityId)
        : null;
      if (input.id && !previous) throw new HttpError(404, 'Calendar not found');
      const merged = { ...previous, ...input };
      const groupId = await group(ctx, merged.groupId);
      const color = text(merged.color || '#2563eb', 'color', 7);
      if (!/^#[a-fA-F0-9]{6}$/.test(color)) throw new HttpError(400, 'Color must be six-digit hexadecimal');
      if (
        previous &&
        groupId !== previous.groupId &&
        (await first(
          ctx,
          'SELECT id FROM calendar_events WHERE churchId=? AND calendarId=? LIMIT 1',
          churchId,
          entityId,
        ))
      )
        throw new HttpError(409, 'Move or delete events before changing the calendar group');
      const row = {
        id: entityId,
        churchId,
        name: requiredString(merged.name, 'name'),
        description: text(merged.description, 'description'),
        color,
        timeZone: timeZone(merged.timeZone),
        groupId,
        updatedAt: now(),
      };
      const columns = ['name', 'description', 'color', 'timeZone', 'groupId', 'updatedAt'];
      statements.push(
        previous
          ? ctx.env.DB.prepare(
              `UPDATE calendars SET ${columns.map((c) => `${c}=?`).join(',')} WHERE churchId=? AND id=?`,
            ).bind(...columns.map((c) => row[c as keyof typeof row]), churchId, entityId)
          : ctx.env.DB.prepare(
              'INSERT INTO calendars (id,churchId,name,description,color,timeZone,groupId,updatedAt) VALUES (?,?,?,?,?,?,?,?)',
            ).bind(...Object.values(row)),
      );
      statements.push(audit(ctx, 'calendar.save', entityId));
      result.push(row);
    }
    await ctx.env.DB.batch(statements);
    return json(result);
  }
  if (ctx.request.method === 'DELETE' && calendarId) {
    requireAdmin(ctx);
    if (!(await first(ctx, 'SELECT id FROM calendars WHERE churchId=? AND id=?', churchId, calendarId)))
      throw new HttpError(404, 'Calendar not found');
    if (
      await first(ctx, 'SELECT id FROM calendar_events WHERE churchId=? AND calendarId=? LIMIT 1', churchId, calendarId)
    )
      throw new HttpError(409, 'Delete or move calendar events first');
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('DELETE FROM calendars WHERE churchId=? AND id=?').bind(churchId, calendarId),
      audit(ctx, 'calendar.delete', calendarId),
    ]);
    return json({});
  }
  return undefined;
}

async function events(ctx: Context, eventId?: string, groupIdFilter?: string): Promise<Response | undefined> {
  const churchId = ctx.principal.churchId;
  if (ctx.request.method === 'GET') {
    if (eventId) {
      const row = await first(ctx, 'SELECT * FROM calendar_events WHERE churchId=? AND id=?', churchId, eventId);
      if (!row) throw new HttpError(404, 'Event not found');
      return json(serialized(row));
    }
    const terms = ['e.churchId=?'];
    const args: any[] = [churchId];
    const calendarId = ctx.url.searchParams.get('calendarId');
    const groupId = groupIdFilter || ctx.url.searchParams.get('groupId');
    if (calendarId) {
      terms.push('e.calendarId=?');
      args.push(calendarId);
    }
    if (groupId) {
      terms.push('e.groupId=?');
      args.push(groupId);
    }
    const start = ctx.url.searchParams.get('start');
    const end = ctx.url.searchParams.get('end');
    if (start) {
      terms.push('e.end>?');
      args.push(eventDate(start, 'start', start.length === 10));
    }
    if (end) {
      terms.push('e.start<?');
      args.push(eventDate(end, 'end', end.length === 10));
    }
    if (start && end && Date.parse(start) >= Date.parse(end)) throw new HttpError(400, 'Window end must follow start');
    const rows = await all(
      ctx,
      `SELECT e.*,c.name AS calendarName,g.name AS groupName FROM calendar_events e
      JOIN calendars c ON c.churchId=e.churchId AND c.id=e.calendarId
      LEFT JOIN groups g ON g.churchId=e.churchId AND g.id=e.groupId
      WHERE ${terms.join(' AND ')} ORDER BY e.start,e.id LIMIT 500`,
      ...args,
    );
    return json(rows.map(serialized));
  }
  if (ctx.request.method === 'POST' && !eventId && !groupIdFilter) {
    requireAdmin(ctx);
    const inputs = await records(ctx.request);
    const statements: D1PreparedStatement[] = [];
    const result: Row[] = [];
    const seen = new Set<string>();
    for (const input of inputs) {
      if (input.churchId && input.churchId !== churchId) throw new HttpError(403, 'Church mismatch');
      if (input.recurrenceRule || input.registrationEnabled || input.roomIds || input.resources)
        throw new HttpError(501, 'Recurring events, registration, and resource booking are not implemented');
      const entityId = input.id ? requiredString(input.id, 'id', 100) : id();
      if (seen.has(entityId)) throw new HttpError(400, 'Duplicate event id');
      seen.add(entityId);
      const previous = input.id
        ? await first(ctx, 'SELECT * FROM calendar_events WHERE churchId=? AND id=?', churchId, entityId)
        : null;
      if (input.id && !previous) throw new HttpError(404, 'Event not found');
      const merged = { ...previous, ...input };
      const calendarId = requiredString(merged.calendarId, 'calendarId', 100);
      const parent = await first(ctx, 'SELECT * FROM calendars WHERE churchId=? AND id=?', churchId, calendarId);
      if (!parent) throw new HttpError(404, 'Calendar not found');
      const groupId = await group(ctx, merged.groupId === undefined ? parent.groupId : merged.groupId);
      if (parent.groupId && groupId !== parent.groupId)
        throw new HttpError(400, 'Event group must match its group calendar');
      if (
        merged.allDay !== undefined &&
        typeof merged.allDay !== 'boolean' &&
        merged.allDay !== 0 &&
        merged.allDay !== 1
      )
        throw new HttpError(400, 'Invalid allDay');
      const allDay = Boolean(merged.allDay);
      const start = eventDate(merged.start, 'start', allDay);
      const end = eventDate(merged.end, 'end', allDay);
      if (end <= start) throw new HttpError(400, 'Event end must follow start; all-day end is exclusive');
      const row: Row = {
        id: entityId,
        churchId,
        calendarId,
        groupId,
        title: requiredString(merged.title, 'title'),
        description: text(merged.description, 'description', 20000),
        start,
        end,
        allDay: allDay ? 1 : 0,
        location: text(merged.location, 'location', 500),
        timeZone: timeZone(merged.timeZone || parent.timeZone),
        updatedAt: now(),
      };
      const columns = Object.keys(row).filter((column) => column !== 'id' && column !== 'churchId');
      statements.push(
        previous
          ? ctx.env.DB.prepare(
              `UPDATE calendar_events SET ${columns.map((c) => `${c}=?`).join(',')} WHERE churchId=? AND id=?`,
            ).bind(...columns.map((c) => row[c]), churchId, entityId)
          : ctx.env.DB.prepare(
              `INSERT INTO calendar_events (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
                .map(() => '?')
                .join(',')})`,
            ).bind(...Object.values(row)),
      );
      statements.push(audit(ctx, 'event.save', entityId));
      result.push(serialized(row));
    }
    await ctx.env.DB.batch(statements);
    return json(result);
  }
  if (ctx.request.method === 'DELETE' && eventId) {
    requireAdmin(ctx);
    if (!(await first(ctx, 'SELECT id FROM calendar_events WHERE churchId=? AND id=?', churchId, eventId)))
      throw new HttpError(404, 'Event not found');
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('DELETE FROM calendar_events WHERE churchId=? AND id=?').bind(churchId, eventId),
      audit(ctx, 'event.delete', eventId),
    ]);
    return json({});
  }
  return undefined;
}

export async function calendar(ctx: Context): Promise<Response | undefined> {
  if (
    ctx.principal.role === 'member' &&
    (ctx.path.startsWith('/content/calendars') || ctx.path.startsWith('/content/events'))
  )
    throw new HttpError(403, 'Use the member calendar API');
  const calendarRoute = /^\/content\/calendars(?:\/([^/]+))?\/?$/.exec(ctx.path);
  if (calendarRoute) return calendars(ctx, calendarRoute[1]);
  const groupRoute = /^\/content\/events\/group\/([^/]+)\/?$/.exec(ctx.path);
  if (groupRoute) return events(ctx, undefined, groupRoute[1]);
  const eventRoute = /^\/content\/events(?:\/([^/]+))?\/?$/.exec(ctx.path);
  if (eventRoute) return events(ctx, eventRoute[1]);
  return undefined;
}
