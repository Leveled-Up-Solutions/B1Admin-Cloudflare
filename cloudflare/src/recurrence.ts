import { RRule } from 'rrule';
import { HttpError } from './http';

export type CalendarRow = Record<string, any>;
const DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
export const MAX_INSTANCES = 1000;
const MAX_CANDIDATES = 20_000;
export function civilDate(value: string, field = 'date'): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value + 'T00:00:00Z')) ||
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value
  )
    throw new HttpError(400, `${field} must be a valid YYYY-MM-DD date`);
  return value;
}
function localTime(instant: number, zone: string): number {
  let formatter = formatters.get(zone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      throw new HttpError(400, 'Invalid IANA timeZone');
    }
    if (formatters.size > 100) formatters.clear();
    formatters.set(zone, formatter);
  }
  const fields = Object.fromEntries(formatter.formatToParts(instant).map((p) => [p.type, p.value]));
  return (
    Date.parse(`${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}:${fields.second}Z`) +
    (((instant % 1000) + 1000) % 1000)
  );
}
// Find actual instants matching a civil time. Gaps have none; folds choose the earlier instant.
function instantForLocal(civil: number, zone: string): number | undefined {
  const offsets = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const sample = civil + delta * 3_600_000;
    offsets.add(localTime(sample, zone) - sample);
  }
  const matches = [...offsets].map((offset) => civil - offset).filter((instant) => localTime(instant, zone) === civil);
  return matches.length ? Math.min(...matches) : undefined;
}
export function localDate(value: string, zone: string): string {
  return value.length === 10
    ? civilDate(value)
    : new Date(localTime(Date.parse(value), zone)).toISOString().slice(0, 10);
}
function dateBound(value: string): number {
  if (value.length === 10) return Date.parse(civilDate(value) + 'T00:00:00Z');
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new HttpError(400, 'Calendar window must use civil dates or ISO timestamps with an offset');
  civilDate(value.slice(0, 10));
  return Date.parse(value);
}
export function validateWindow(start: string, end: string): void {
  const from = dateBound(start),
    to = dateBound(end);
  if ((start.length === 10) !== (end.length === 10))
    throw new HttpError(400, 'Use the same date format for both calendar window bounds');
  if (to <= from || to - from > 366 * DAY)
    throw new HttpError(400, 'Calendar window must be positive and at most 366 days');
  if (from < Date.parse('1900-01-01') || to > Date.parse('2201-01-01'))
    throw new HttpError(400, 'Calendar window must be within 1900–2200');
}
function parseRule(value: unknown) {
  if (typeof value !== 'string' || value.length > 1000 || !/^[A-Z0-9=,;:+-]+$/.test(value))
    throw new HttpError(400, 'Invalid recurrenceRule');
  const rule = value.startsWith('RRULE:') ? value.slice(6) : value;
  const parts: Record<string, string> = {};
  for (const part of rule.split(';')) {
    const [key, val, extra] = part.split('=');
    if (!key || !val || extra || parts[key]) throw new HttpError(400, 'Invalid or duplicate recurrence field');
    parts[key] = val;
  }
  const allowed = ['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'WKST', 'COUNT', 'UNTIL'];
  if (
    Object.keys(parts).some((key) => !allowed.includes(key)) ||
    !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(parts.FREQ)
  )
    throw new HttpError(400, 'Only daily, weekly, monthly, and yearly recurrence rules are supported');
  function integers(key: string, max: number, negative = false, multiple = true) {
    if (!parts[key]) return;
    const values = parts[key].split(',');
    if (
      (!multiple && values.length !== 1) ||
      values.length > 31 ||
      new Set(values).size !== values.length ||
      values.some((v) => !/^-?\d+$/.test(v) || Number(v) === 0 || Number(v) > max || Number(v) < (negative ? -max : 1))
    )
      throw new HttpError(400, `Invalid recurrence ${key}`);
  }
  integers('INTERVAL', 366, false, false);
  integers('COUNT', 1000, false, false);
  integers('BYMONTH', 12);
  integers('BYMONTHDAY', 31, true);
  integers('BYSETPOS', 31, true);
  if (parts.BYDAY) {
    const days = parts.BYDAY.split(',');
    if (
      days.length > 31 ||
      new Set(days).size !== days.length ||
      days.some(
        (day) =>
          !/^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/.test(day) ||
          (/^[+-]?\d/.test(day) && !['MONTHLY', 'YEARLY'].includes(parts.FREQ)),
      )
    )
      throw new HttpError(400, 'Invalid recurrence BYDAY');
  }
  if (parts.WKST && !/^(MO|TU|WE|TH|FR|SA|SU)$/.test(parts.WKST)) throw new HttpError(400, 'Invalid recurrence WKST');
  if (parts.COUNT && parts.UNTIL) throw new HttpError(400, 'Use COUNT or UNTIL, not both');
  if (parts.BYSETPOS && !parts.BYDAY && !parts.BYMONTHDAY && !parts.BYMONTH)
    throw new HttpError(400, 'BYSETPOS requires another BY field');
  if (parts.FREQ === 'WEEKLY' && parts.BYMONTHDAY) throw new HttpError(400, 'BYMONTHDAY cannot be used with WEEKLY');
  let until: number | undefined, untilDate: string | undefined;
  if (parts.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/.exec(parts.UNTIL);
    if (!m) throw new HttpError(400, 'UNTIL must be YYYYMMDD or UTC YYYYMMDDTHHmmssZ');
    const date = civilDate(`${m[1]}-${m[2]}-${m[3]}`, 'UNTIL');
    if (m[4]) {
      if (+m[4] > 23 || +m[5] > 59 || +m[6] > 59) throw new HttpError(400, 'Invalid UNTIL time');
      until = Date.parse(`${date}T${m[4]}:${m[5]}:${m[6]}Z`);
    } else untilDate = date;
  }
  try {
    const options = RRule.parseString(
      Object.entries(parts)
        .filter(([key]) => key !== 'COUNT' && key !== 'UNTIL')
        .map(([key, val]) => `${key}=${val}`)
        .join(';'),
    );
    return {
      rule,
      options,
      count: parts.COUNT ? Number(parts.COUNT) : undefined,
      until,
      untilDate,
    };
  } catch {
    throw new HttpError(400, 'Invalid recurrenceRule');
  }
}
export function validateRecurrence(value: unknown, event: CalendarRow): string | null {
  if (value == null || value === '') return null;
  const parsed = parseRule(value);
  const start = Date.parse(event.start);
  if (start < Date.parse('1900-01-01') || start >= Date.parse('2201-01-01'))
    throw new HttpError(400, 'Recurring event start must be within 1900–2200');
  const civilStart = event.allDay ? start : localTime(start, event.timeZone);
  const civilEnd = event.allDay ? Date.parse(event.end) : localTime(Date.parse(event.end), event.timeZone);
  if (civilEnd <= civilStart || civilEnd - civilStart > 366 * DAY)
    throw new HttpError(400, 'Recurring event civil duration must be positive and at most 366 days');
  if (
    (parsed.until !== undefined && parsed.until < start) ||
    (parsed.untilDate && parsed.untilDate < localDate(event.start, event.timeZone))
  )
    throw new HttpError(400, 'Recurrence UNTIL cannot precede the event start');
  return parsed.rule;
}
export function expandCalendarEvents(events: CalendarRow[], windowStart: string, windowEnd: string): CalendarRow[] {
  validateWindow(windowStart, windowEnd);
  const output: CalendarRow[] = [];
  let candidates = 0,
    estimatedIterations = 0;
  function append(row: CalendarRow) {
    if (output.length >= MAX_INSTANCES)
      throw new HttpError(400, 'Calendar exceeds 1000 occurrences; request a smaller window');
    output.push(row);
  }
  for (const event of events) {
    const allDay = Boolean(event.allDay),
      zone = event.timeZone;
    const from = allDay
      ? windowStart.slice(0, 10)
      : windowStart.length === 10
        ? instantForLocal(Date.parse(windowStart), zone)
        : Date.parse(windowStart);
    const to = allDay
      ? windowEnd.slice(0, 10)
      : windowEnd.length === 10
        ? instantForLocal(Date.parse(windowEnd), zone)
        : Date.parse(windowEnd);
    if (from === undefined || to === undefined)
      throw new HttpError(400, 'Window boundary does not exist in the event time zone; use offset timestamps');
    const overlaps = (start: string, end: string) => {
      if (allDay && windowStart.length === 10) return end > String(from) && start < String(to);
      const eventStart = allDay ? instantForLocal(Date.parse(start), zone) : Date.parse(start);
      const eventEnd = allDay ? instantForLocal(Date.parse(end), zone) : Date.parse(end);
      if (eventStart === undefined || eventEnd === undefined)
        throw new HttpError(400, 'All-day boundary does not exist in the event time zone');
      return (
        eventEnd > (allDay ? dateBound(windowStart) : Number(from)) &&
        eventStart < (allDay ? dateBound(windowEnd) : Number(to))
      );
    };
    if (!event.recurrenceRule) {
      if (overlaps(event.start, event.end))
        append({
          ...event,
          allDay,
          occurrenceId: event.id,
          seriesId: event.recurrenceParentId || null,
          occurrenceDate: event.recurrenceOriginalDate || null,
        });
      continue;
    }
    const parsed = parseRule(event.recurrenceRule);
    const anchor = Date.parse(event.start);
    const civilStart = allDay ? anchor : localTime(anchor, zone);
    const civilEnd = allDay ? Date.parse(event.end) : localTime(Date.parse(event.end), zone);
    const duration = civilEnd - civilStart;
    const endLimit = dateBound(windowEnd) + 3 * DAY;
    if (endLimit < civilStart) continue;
    // A finite engine UNTIL bounds even rules whose filters never produce a candidate.
    if (endLimit - civilStart > 50 * 366 * DAY)
      throw new HttpError(400, 'Recurring calendar queries are limited to 50 years after the series start');
    const until = new Date(
      Math.min(
        endLimit,
        parsed.untilDate
          ? Date.parse(parsed.untilDate) + 2 * DAY
          : parsed.until === undefined
            ? endLimit
            : parsed.until + 2 * DAY,
      ),
    );
    const cycleDays = [365, 28, 7, 1][parsed.options.freq!] || 1;
    let scannedUntil = civilStart,
      completed = false;
    function chargeScan(to: number) {
      estimatedIterations += Math.max(0, (to - scannedUntil) / DAY / cycleDays / (parsed.options.interval || 1));
      scannedUntil = to;
      if (estimatedIterations > MAX_CANDIDATES)
        throw new HttpError(
          400,
          'Calendar recurrence computation limit reached; narrow the calendar or split old series',
        );
    }
    const rrule = new RRule({ ...parsed.options, dtstart: new Date(civilStart), until }, true);
    const exceptions = new Set<string>(event.exceptionDates || []);
    let validCount = 0;
    rrule.all((civil) => {
      chargeScan(civil.getTime());
      if (++candidates > MAX_CANDIDATES)
        throw new HttpError(400, 'Calendar recurrence expansion limit reached; shorten or split old series');
      const date = civil.toISOString().slice(0, 10);
      const startInstant = allDay
        ? civil.getTime()
        : civil.getTime() === civilStart
          ? anchor
          : instantForLocal(civil.getTime(), zone);
      const endInstant = allDay
        ? civil.getTime() + duration
        : civil.getTime() === civilStart
          ? Date.parse(event.end)
          : instantForLocal(civil.getTime() + duration, zone);
      if (startInstant === undefined || endInstant === undefined || endInstant <= startInstant) return true;
      if (
        (parsed.untilDate && date > parsed.untilDate) ||
        (parsed.until !== undefined && startInstant > parsed.until)
      ) {
        completed = true;
        return false;
      }
      validCount++;
      const start = new Date(startInstant).toISOString(),
        end = new Date(endInstant).toISOString();
      const actualStart = allDay ? start.slice(0, 10) : start,
        actualEnd = allDay ? end.slice(0, 10) : end;
      if (!exceptions.has(date) && overlaps(actualStart, actualEnd))
        append({
          ...event,
          allDay,
          start: actualStart,
          end: actualEnd,
          occurrenceId: `${event.id}:${date}`,
          seriesId: event.id,
          occurrenceDate: date,
          recurrenceIndex: validCount,
          originalStart: event.start,
        });
      if (parsed.count && validCount >= parsed.count) {
        completed = true;
        return false;
      }
      return true;
    });
    if (!completed) chargeScan(until.getTime());
  }
  return output.sort((a, b) => a.start.localeCompare(b.start) || a.occurrenceId.localeCompare(b.occurrenceId));
}

// Call only after tenant/group visibility filtering. Chunked binds stay below D1 parameter limits.
export async function attachEventExceptions(
  db: D1Database,
  churchId: string,
  events: CalendarRow[],
): Promise<CalendarRow[]> {
  const dates = new Map<string, string[]>();
  const ids = events.filter((event) => event.recurrenceRule).map((event) => event.id);
  let loaded = 0;
  for (let offset = 0; offset < ids.length; offset += 90) {
    const chunk = ids.slice(offset, offset + 90);
    const result = await db
      .prepare(
        `SELECT eventId,exceptionDate FROM calendar_event_exceptions WHERE churchId=? AND eventId IN (${chunk.map(() => '?').join(',')}) LIMIT 10001`,
      )
      .bind(churchId, ...chunk)
      .all<{ eventId: string; exceptionDate: string }>();
    loaded += result.results.length;
    if (loaded > 10000)
      throw new HttpError(400, 'Calendar has too many exceptions; filter by calendar or split old series');
    for (const row of result.results) {
      if (!dates.has(row.eventId)) dates.set(row.eventId, []);
      dates.get(row.eventId)!.push(row.exceptionDate);
    }
  }
  return events.map((event) => ({
    ...event,
    allDay: Boolean(event.allDay),
    exceptionDates: (dates.get(event.id) || []).sort(),
  }));
}
