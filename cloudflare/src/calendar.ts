import type { Context } from './types';
import {
  requireResource,
  resourceAllowed,
  resourceReadSql,
  resourceSnapshot,
  resourceWriteGuard,
  type ResourceSnapshot,
} from './resource-permissions';
import { all, body, first, HttpError, id, json, now, records, requiredString } from './http';

import {
  attachEventExceptions,
  expandCalendarEvents,
  localDate,
  validateRecurrence,
  validateWindow,
} from './recurrence';

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
  if (+input.slice(11, 13) > 23 || +input.slice(14, 16) > 59 || (input[16] === ':' && +input.slice(17, 19) > 59))
    throw new HttpError(400, `Invalid ${field} time`);
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

async function calendarRecord(ctx: Context, calendarId: string, action: 'View' | 'Edit') {
  const row = await first(ctx, 'SELECT * FROM calendars WHERE churchId=? AND id=?', ctx.principal.churchId, calendarId);
  if (!row) throw new HttpError(404, 'Calendar not found');
  requireResource(ctx, 'Calendars', action, row);
  return row;
}
async function eventRecord(ctx: Context, eventId: string, action: 'View' | 'Edit') {
  const row = await first(
    ctx,
    'SELECT * FROM calendar_events WHERE churchId=? AND id=?',
    ctx.principal.churchId,
    eventId,
  );
  if (!row) throw new HttpError(404, 'Event not found');
  await calendarRecord(ctx, row.calendarId, action);
  return row;
}
async function eventGuard(ctx: Context, row: Row, previous: Row | null, extra: ResourceSnapshot[] = []) {
  const calendarIds = [...new Set([row.calendarId, ...(previous ? [previous.calendarId] : [])])];
  const parents = await Promise.all(calendarIds.map((calendarId) => calendarRecord(ctx, calendarId, 'Edit')));
  return resourceWriteGuard(ctx, {
    requirements: parents.map((parent) => ({ resource: 'Calendars', row: parent })),
    snapshots: [
      previous ? resourceSnapshot('calendar_events', previous) : { table: 'calendar_events', id: row.id, absent: true },
      ...parents.map((parent) => resourceSnapshot('calendars', parent)),
      ...extra,
    ],
  });
}
async function calendars(ctx: Context, calendarId?: string): Promise<Response | undefined> {
  const churchId = ctx.principal.churchId;
  if (ctx.request.method === 'GET') {
    if (calendarId) {
      const row = await first(ctx, 'SELECT * FROM calendars WHERE churchId=? AND id=?', churchId, calendarId);
      if (!row) throw new HttpError(404, 'Calendar not found');
      requireResource(ctx, 'Calendars', 'View', row);
      row.groupName = row.groupId
        ? (await first(ctx, 'SELECT name FROM groups WHERE churchId=? AND id=?', churchId, row.groupId))?.name
        : null;
      return json({
        ...row,
        canEdit: resourceAllowed(ctx, 'Calendars', 'Edit', row),
        canCreate: resourceAllowed(ctx, 'Calendars', 'Edit'),
      });
    }
    const scope = resourceReadSql(ctx, 'Calendars', 'c');
    return json(
      (
        await all(
          ctx,
          `SELECT c.*,g.name groupName FROM calendars c LEFT JOIN groups g ON g.churchId=c.churchId AND g.id=c.groupId WHERE c.churchId=? AND ${scope.sql} ORDER BY c.name,c.id LIMIT 500`,
          churchId,
          ...scope.values,
        )
      ).map((row) => ({
        ...row,
        canEdit: resourceAllowed(ctx, 'Calendars', 'Edit', row),
        canCreate: resourceAllowed(ctx, 'Calendars', 'Edit'),
      })),
    );
  }
  if (ctx.request.method === 'POST' && !calendarId) {
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
      statements.push(
        ...resourceWriteGuard(ctx, {
          requirements: [{ resource: 'Calendars', row: previous }],
          snapshots: [
            previous ? resourceSnapshot('calendars', previous) : { table: 'calendars', id: entityId, absent: true },
          ],
        }),
      );
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
    const previous = await calendarRecord(ctx, calendarId, 'Edit');
    if (
      await first(ctx, 'SELECT id FROM calendar_events WHERE churchId=? AND calendarId=? LIMIT 1', churchId, calendarId)
    )
      throw new HttpError(409, 'Delete or move calendar events first');
    await ctx.env.DB.batch([
      ...resourceWriteGuard(ctx, {
        requirements: [{ resource: 'Calendars', row: previous }],
        snapshots: [resourceSnapshot('calendars', previous)],
      }),
      ctx.env.DB.prepare('DELETE FROM calendars WHERE churchId=? AND id=?').bind(churchId, calendarId),
      audit(ctx, 'calendar.delete', calendarId),
    ]);
    return json({});
  }
  return undefined;
}

async function eventRow(ctx: Context, merged: Row, entityId: string): Promise<Row> {
  const churchId = ctx.principal.churchId;
  if (merged.churchId && merged.churchId !== churchId) throw new HttpError(403, 'Church mismatch');
  const calendarId = requiredString(merged.calendarId, 'calendarId', 100);
  const parent = await first(ctx, 'SELECT * FROM calendars WHERE churchId=? AND id=?', churchId, calendarId);
  if (!parent) throw new HttpError(404, 'Calendar not found');
  const groupId = await group(ctx, merged.groupId === undefined ? parent.groupId : merged.groupId);
  if (parent.groupId && groupId !== parent.groupId)
    throw new HttpError(400, 'Event group must match its group calendar');
  if (merged.allDay !== undefined && typeof merged.allDay !== 'boolean' && merged.allDay !== 0 && merged.allDay !== 1)
    throw new HttpError(400, 'Invalid allDay');
  const allDay = Boolean(merged.allDay);
  const start = eventDate(merged.start, 'start', allDay),
    end = eventDate(merged.end, 'end', allDay);
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
  row.recurrenceRule = validateRecurrence(merged.recurrenceRule, row);
  return row;
}
function clearExceptions(ctx: Context, eventId: string, from = ''): D1PreparedStatement[] {
  return [
    ctx.env.DB.prepare(
      'DELETE FROM calendar_events WHERE churchId=? AND recurrenceParentId=? AND recurrenceOriginalDate>=?',
    ).bind(ctx.principal.churchId, eventId, from),
    ctx.env.DB.prepare(
      'DELETE FROM calendar_event_exceptions WHERE churchId=? AND eventId=? AND exceptionDate>=?',
    ).bind(ctx.principal.churchId, eventId, from),
  ];
}
function insertEvent(ctx: Context, row: Row): D1PreparedStatement {
  return ctx.env.DB.prepare(
    `INSERT INTO calendar_events (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
      .map(() => '?')
      .join(',')})`,
  ).bind(...Object.values(row));
}
async function seriesOccurrence(
  ctx: Context,
  eventId: string,
  date: string,
): Promise<{ series: Row; occurrence: Row }> {
  civilDate(date, 'occurrenceDate');
  const series = await first(
    ctx,
    'SELECT * FROM calendar_events WHERE churchId=? AND id=?',
    ctx.principal.churchId,
    eventId,
  );
  if (!series) throw new HttpError(404, 'Event not found');
  await calendarRecord(ctx, series.calendarId, ctx.request.method === 'GET' ? 'View' : 'Edit');
  if (!series.recurrenceRule) throw new HttpError(400, 'Event is not a recurring series');
  const next = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
  const occurrence = expandCalendarEvents([series], date, next).find((row) => row.occurrenceDate === date);
  if (!occurrence) throw new HttpError(404, 'Occurrence not found in this series');
  return { series, occurrence };
}
async function instances(ctx: Context): Promise<Response | undefined> {
  if (ctx.request.method !== 'GET') return undefined;
  const start = ctx.url.searchParams.get('start') || new Date().toISOString().slice(0, 10);
  if (
    !Number.isFinite(Date.parse(start)) ||
    Date.parse(start) < Date.parse('1900-01-01') ||
    Date.parse(start) > Date.parse('2201-01-01')
  )
    throw new HttpError(400, 'Invalid calendar window start');
  const defaultEnd = new Date(Date.parse(start) + 90 * 86400000).toISOString();
  const end = ctx.url.searchParams.get('end') || (start.length === 10 ? defaultEnd.slice(0, 10) : defaultEnd);
  validateWindow(start, end);
  // A civil all-day boundary can be on a different UTC date. Fetch a safe superset, then expand exactly.
  const url = new URL(ctx.url);
  url.searchParams.set('start', new Date(Date.parse(start) - 2 * 86400000).toISOString());
  url.searchParams.set('end', new Date(Date.parse(end) + 2 * 86400000).toISOString());
  const raw = await events({ ...ctx, url });
  const rows = (await raw!.json()) as Row[];
  return json(expandCalendarEvents(rows, start, end));
}
async function occurrenceRoute(ctx: Context, eventId: string, date: string): Promise<Response | undefined> {
  if (!['GET', 'POST', 'DELETE'].includes(ctx.request.method)) return undefined;
  const { series, occurrence } = await seriesOccurrence(ctx, eventId, date);
  if (ctx.request.method === 'GET') return json(occurrence);
  const churchId = ctx.principal.churchId;
  const statements = [
    ...(await eventGuard(ctx, series, series)),
    ctx.env.DB.prepare(
      'DELETE FROM calendar_events WHERE churchId=? AND recurrenceParentId=? AND recurrenceOriginalDate=?',
    ).bind(churchId, eventId, date),
    ctx.env.DB.prepare('DELETE FROM calendar_event_exceptions WHERE churchId=? AND eventId=? AND exceptionDate=?').bind(
      churchId,
      eventId,
      date,
    ),
  ];
  statements.push(
    ctx.env.DB.prepare(
      'INSERT INTO calendar_event_exceptions (id,churchId,eventId,exceptionDate,createdAt) VALUES (?,?,?,?,?)',
    ).bind(id(), churchId, eventId, date, now()),
  );
  let row: Row | undefined;
  if (ctx.request.method === 'POST') {
    const input = await body(ctx.request);
    if (Array.isArray(input)) throw new HttpError(400, 'Expected one occurrence object');
    if (
      input.recurrenceRule ||
      (input.calendarId && input.calendarId !== series.calendarId) ||
      (input.groupId !== undefined && input.groupId !== series.groupId)
    )
      throw new HttpError(400, 'An occurrence cannot change the series calendar, group, or recurrence');
    row = await eventRow(ctx, { ...occurrence, ...input, recurrenceRule: null }, id());
    row.recurrenceParentId = eventId;
    row.recurrenceOriginalDate = date;
    statements.push(insertEvent(ctx, row));
  }
  statements.push(
    audit(ctx, ctx.request.method === 'POST' ? 'event.occurrence.save' : 'event.occurrence.skip', eventId),
  );
  await ctx.env.DB.batch(statements);
  return json(row ? serialized(row) : {});
}
async function futureRoute(ctx: Context, eventId: string, date: string): Promise<Response | undefined> {
  if (!['POST', 'DELETE'].includes(ctx.request.method)) return undefined;
  const { series, occurrence } = await seriesOccurrence(ctx, eventId, date);
  const churchId = ctx.principal.churchId;
  const statements: D1PreparedStatement[] = [];
  let row: Row | undefined;
  if (ctx.request.method === 'POST') {
    const input = await body(ctx.request);
    if (Array.isArray(input)) throw new HttpError(400, 'Expected one event object');
    const originalCount = /(?:^|;)COUNT=(\d+)/.exec(series.recurrenceRule)?.[1];
    const remainingRule = originalCount
      ? series.recurrenceRule.replace(/COUNT=\d+/, `COUNT=${Number(originalCount) - occurrence.recurrenceIndex + 1}`)
      : series.recurrenceRule;
    row = await eventRow(ctx, { ...occurrence, recurrenceRule: remainingRule, ...input }, id());
    if (
      input.resetExceptions !== true &&
      (await first(
        ctx,
        'SELECT id FROM calendar_event_exceptions WHERE churchId=? AND eventId=? AND exceptionDate>=? LIMIT 1',
        churchId,
        eventId,
        date,
      ))
    )
      throw new HttpError(409, 'Future occurrence edits exist; use resetExceptions=true to replace them');
  }
  statements.push(...(await eventGuard(ctx, row || series, series)), ...clearExceptions(ctx, eventId, date));
  if (occurrence.recurrenceIndex === 1) {
    statements.push(
      ctx.env.DB.prepare('DELETE FROM calendar_events WHERE churchId=? AND id=?').bind(churchId, eventId),
    );
  } else {
    const previousDate = new Date(Date.parse(date) - 86400000).toISOString().slice(0, 10).replaceAll('-', '');
    const rule =
      series.recurrenceRule
        .split(';')
        .filter((part: string) => !part.startsWith('COUNT=') && !part.startsWith('UNTIL='))
        .join(';') + `;UNTIL=${previousDate}`;
    statements.push(
      ctx.env.DB.prepare('UPDATE calendar_events SET recurrenceRule=?,updatedAt=? WHERE churchId=? AND id=?').bind(
        rule,
        now(),
        churchId,
        eventId,
      ),
    );
  }
  if (row) statements.push(insertEvent(ctx, row));
  statements.push(audit(ctx, ctx.request.method === 'POST' ? 'event.series.split' : 'event.series.truncate', eventId));
  await ctx.env.DB.batch(statements);
  return json(row ? serialized(row) : {});
}

async function exceptions(ctx: Context, exceptionId?: string): Promise<Response | undefined> {
  const churchId = ctx.principal.churchId;
  if (ctx.request.method === 'GET') {
    if (exceptionId) {
      const row = await first(
        ctx,
        'SELECT * FROM calendar_event_exceptions WHERE churchId=? AND id=?',
        churchId,
        exceptionId,
      );
      if (!row) throw new HttpError(404, 'Event exception not found');
      await eventRecord(ctx, row.eventId, 'View');
      return json(row);
    }
    const eventId = requiredString(ctx.url.searchParams.get('eventId'), 'eventId', 100);
    await eventRecord(ctx, eventId, 'View');
    const rows = await all(
      ctx,
      'SELECT * FROM calendar_event_exceptions WHERE churchId=? AND eventId=? ORDER BY exceptionDate LIMIT 10001',
      churchId,
      eventId,
    );
    if (rows.length > 10000) throw new HttpError(400, 'Too many exceptions; split the old series');
    return json(rows);
  }
  if (ctx.request.method === 'POST' && !exceptionId) {
    const result: Row[] = [],
      statements: D1PreparedStatement[] = [];
    for (const input of await records(ctx.request)) {
      if (input.churchId && input.churchId !== churchId) throw new HttpError(403, 'Church mismatch');
      if (input.id) throw new HttpError(400, 'Exceptions are immutable; delete to restore an occurrence');
      const eventId = requiredString(input.eventId, 'eventId', 100);
      const series = await first(ctx, 'SELECT * FROM calendar_events WHERE churchId=? AND id=?', churchId, eventId);
      if (!series) throw new HttpError(404, 'Event not found');
      const supplied = eventDate(
        input.exceptionDate,
        'exceptionDate',
        typeof input.exceptionDate === 'string' && input.exceptionDate.length === 10,
      );
      const date = localDate(supplied, series.timeZone);
      await seriesOccurrence(ctx, eventId, date);
      const existing = await first(
        ctx,
        'SELECT * FROM calendar_event_exceptions WHERE churchId=? AND eventId=? AND exceptionDate=?',
        churchId,
        eventId,
        date,
      );
      const row = existing || {
        id: id(),
        churchId,
        eventId,
        exceptionDate: date,
        createdAt: now(),
      };
      statements.push(
        ...(await eventGuard(
          ctx,
          series,
          series,
          existing ? [resourceSnapshot('calendar_event_exceptions', existing)] : [],
        )),
      );
      if (!existing)
        statements.push(
          ctx.env.DB.prepare(
            'INSERT INTO calendar_event_exceptions (id,churchId,eventId,exceptionDate,createdAt) VALUES (?,?,?,?,?)',
          ).bind(...Object.values(row)),
        );
      statements.push(audit(ctx, 'event.exception.save', eventId));
      result.push(row);
    }
    await ctx.env.DB.batch(statements);
    return json(result);
  }
  if (ctx.request.method === 'DELETE' && exceptionId) {
    const row = await first(
      ctx,
      'SELECT * FROM calendar_event_exceptions WHERE churchId=? AND id=?',
      churchId,
      exceptionId,
    );
    if (!row) throw new HttpError(404, 'Event exception not found');
    const series = await eventRecord(ctx, row.eventId, 'Edit');
    await ctx.env.DB.batch([
      ...(await eventGuard(ctx, series, series, [resourceSnapshot('calendar_event_exceptions', row)])),
      ctx.env.DB.prepare(
        'DELETE FROM calendar_events WHERE churchId=? AND recurrenceParentId=? AND recurrenceOriginalDate=?',
      ).bind(churchId, row.eventId, row.exceptionDate),
      ctx.env.DB.prepare('DELETE FROM calendar_event_exceptions WHERE churchId=? AND id=?').bind(churchId, exceptionId),
      audit(ctx, 'event.exception.restore', row.eventId),
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
      await calendarRecord(ctx, row.calendarId, 'View');
      return json((await attachEventExceptions(ctx.env.DB, churchId, [row]))[0]);
    }
    const scope = resourceReadSql(ctx, 'Calendars', 'c');
    const terms = ['e.churchId=?', scope.sql];
    const args: any[] = [churchId, ...scope.values];
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
      terms.push('(e.recurrenceRule IS NOT NULL OR e.end>?)');
      args.push(eventDate(start, 'start', start.length === 10));
    }
    if (end) {
      terms.push('(e.recurrenceRule IS NOT NULL OR e.start<?)');
      args.push(eventDate(end, 'end', end.length === 10));
    }
    if (start && end && Date.parse(start) >= Date.parse(end)) throw new HttpError(400, 'Window end must follow start');
    const rows = await all(
      ctx,
      `SELECT e.*,c.name AS calendarName,g.name AS groupName FROM calendar_events e
      JOIN calendars c ON c.churchId=e.churchId AND c.id=e.calendarId
      LEFT JOIN groups g ON g.churchId=e.churchId AND g.id=e.groupId
      WHERE ${terms.join(' AND ')} ORDER BY e.start,e.id LIMIT 501`,
      ...args,
    );
    if (rows.length > 500) throw new HttpError(400, 'Calendar exceeds 500 stored events; filter by calendar or group');
    return json(await attachEventExceptions(ctx.env.DB, churchId, rows));
  }
  if (ctx.request.method === 'POST' && !eventId && !groupIdFilter) {
    const inputs = await records(ctx.request);
    const statements: D1PreparedStatement[] = [];
    const result: Row[] = [];
    const seen = new Set<string>();
    for (const input of inputs) {
      if (input.churchId && input.churchId !== churchId) throw new HttpError(403, 'Church mismatch');
      if (input.registrationEnabled || input.roomIds || input.resources)
        throw new HttpError(501, 'Registration and resource booking are not implemented');
      if (input.recurrenceParentId || input.recurrenceOriginalDate)
        throw new HttpError(400, 'Use the occurrence endpoint to edit a recurring occurrence');
      const entityId = input.id ? requiredString(input.id, 'id', 100) : id();
      if (seen.has(entityId)) throw new HttpError(400, 'Duplicate event id');
      seen.add(entityId);
      const previous = input.id
        ? await first(ctx, 'SELECT * FROM calendar_events WHERE churchId=? AND id=?', churchId, entityId)
        : null;
      if (input.id && !previous) throw new HttpError(404, 'Event not found');
      if (previous?.recurrenceParentId)
        throw new HttpError(409, 'Edit replacements through their series occurrence endpoint');
      const row = await eventRow(ctx, { ...previous, ...input }, entityId);
      statements.push(...(await eventGuard(ctx, row, previous)));
      const scheduleChanged =
        previous &&
        ['start', 'end', 'allDay', 'timeZone', 'recurrenceRule', 'calendarId', 'groupId'].some(
          (key) => row[key] !== previous[key],
        );
      if (
        scheduleChanged &&
        (await first(
          ctx,
          'SELECT id FROM calendar_event_exceptions WHERE churchId=? AND eventId=? LIMIT 1',
          churchId,
          entityId,
        ))
      ) {
        if (input.resetExceptions !== true)
          throw new HttpError(
            409,
            'Changing this series schedule requires resetExceptions=true; its occurrence edits and skipped dates will be removed',
          );
        statements.push(...clearExceptions(ctx, entityId));
      }
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
    const previous = await eventRecord(ctx, eventId, 'Edit');
    await ctx.env.DB.batch([
      ...(await eventGuard(ctx, previous, previous)),
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
    (ctx.path.startsWith('/content/calendars') ||
      ctx.path.startsWith('/content/events') ||
      ctx.path.startsWith('/content/eventExceptions'))
  )
    throw new HttpError(403, 'Use the member calendar API');
  if (ctx.path === '/content/events/instances') return instances(ctx);
  const future = /^\/content\/events\/([^/]+)\/future\/(\d{4}-\d{2}-\d{2})$/.exec(ctx.path);
  if (future) return futureRoute(ctx, future[1], future[2]);
  const occurrence = /^\/content\/events\/([^/]+)\/occurrences\/(\d{4}-\d{2}-\d{2})$/.exec(ctx.path);
  if (occurrence) return occurrenceRoute(ctx, occurrence[1], occurrence[2]);
  const exception = /^\/content\/eventExceptions(?:\/([^/]+))?\/?$/.exec(ctx.path);
  if (exception) return exceptions(ctx, exception[1]);
  const calendarRoute = /^\/content\/calendars(?:\/([^/]+))?\/?$/.exec(ctx.path);
  if (calendarRoute) return calendars(ctx, calendarRoute[1]);
  const groupRoute = /^\/content\/events\/group\/([^/]+)\/?$/.exec(ctx.path);
  if (groupRoute) return events(ctx, undefined, groupRoute[1]);
  const eventRoute = /^\/content\/events(?:\/([^/]+))?\/?$/.exec(ctx.path);
  if (eventRoute) return events(ctx, eventRoute[1]);
  return undefined;
}
