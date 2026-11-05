import type { Context } from './types';
import { allowed } from './permissions';
import { all, first, HttpError } from './http';

const textColumns: Record<string, string> = {
  id: 'p.id',
  firstName: 'p.firstName',
  lastName: 'p.lastName',
  middleName: 'p.middleName',
  nickName: 'p.nickName',
  email: 'p.email',
  gender: 'p.gender',
  maritalStatus: 'p.maritalStatus',
  membershipStatus: 'p.membershipStatus',
  householdId: 'p.householdId',
  householdRole: 'p.householdRole',
  campusId: 'p.campusId',
  grade: 'p.grade',
  school: 'p.school',
  address: "json_extract(p.contactInfo,'$.address1')",
  address1: "json_extract(p.contactInfo,'$.address1')",
  address2: "json_extract(p.contactInfo,'$.address2')",
  city: "json_extract(p.contactInfo,'$.city')",
  state: "json_extract(p.contactInfo,'$.state')",
  zip: "json_extract(p.contactInfo,'$.zip')",
  homePhone: "json_extract(p.contactInfo,'$.homePhone')",
  mobilePhone: "json_extract(p.contactInfo,'$.mobilePhone')",
  workPhone: "json_extract(p.contactInfo,'$.workPhone')",
};
const dates: Record<string, string> = {
  birthDate: 'p.birthDate',
  anniversary: 'p.anniversary',
  dateAdded: 'substr(p.dateAdded,1,10)',
};
const comparisons: Record<string, string> = {
  equals: '=',
  equal: '=',
  notEquals: '<>',
  notEqual: '<>',
  greaterThan: '>',
  greaterThanEqual: '>=',
  lessThan: '<',
  lessThanEqual: '<=',
};
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function civilToday(zone: string): string {
  const fields = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return `${fields.year}-${fields.month}-${fields.day}`;
}
function civilDayStart(day: string, zone: string): string {
  const center = Date.parse(day + 'T00:00:00Z');
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localDate = (time: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(time).map((p) => [p.type, p.value]));
    return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
  };
  // Find the first instant of a civil day, including zones whose DST shift skips midnight.
  let low = center - 2 * 86400000,
    high = center + 2 * 86400000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDate(middle) < day) low = middle + 1;
    else high = middle;
  }
  if (localDate(low) !== day) throw new HttpError(400, 'This civil date does not exist in the church time zone');
  return new Date(low).toISOString();
}
const shiftDay = (day: string, offset: number) =>
  new Date(Date.parse(day + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
/** Parameterized translation of selected upstream SearchCondition fields; unsupported fields fail explicitly. */
export async function advancedPeopleSearch(ctx: Context, input: unknown): Promise<Record<string, any>[]> {
  if (!allowed(ctx, 'MembershipApi', 'People', 'View') && !allowed(ctx, 'MembershipApi', 'People', 'Edit'))
    throw new HttpError(403, 'People view permission required');
  if (!Array.isArray(input) || input.length > 40) throw new HttpError(400, 'Expected up to 40 search conditions');
  const church = await first(ctx, 'SELECT * FROM churches WHERE id=?', ctx.principal.churchId);
  const zone = church?.timeZone || 'UTC';
  const today = civilToday(zone);
  const starts = new Map<string, string>();
  const dayStart = (day: string) => {
    if (!starts.has(day)) starts.set(day, civilDayStart(day, zone));
    return starts.get(day)!;
  };
  const clauses: string[] = ['p.churchId=?', 'p.removed=0'];
  const params: (string | number)[] = [today, ctx.principal.churchId];
  for (const c of input) {
    if (
      !c ||
      typeof c !== 'object' ||
      typeof c.field !== 'string' ||
      typeof c.operator !== 'string' ||
      typeof c.value !== 'string' ||
      c.value.length > (c.field === 'id' ? 256000 : 10000)
    )
      throw new HttpError(400, 'Invalid search condition');
    const { field, operator, value } = c;
    if (field === 'id' && ['in', 'notIn'].includes(operator)) {
      const ids = value.split(',').filter(Boolean);
      if (ids.length > 1000 || ids.some((x: string) => x.length > 255)) throw new HttpError(400, 'Too many person IDs');
      clauses.push(`p.id ${operator === 'notIn' ? 'NOT IN' : 'IN'} (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(ids));
      continue;
    }
    if (field === 'dateAdded') {
      if (operator === 'lastDays') {
        if (!/^\d+$/.test(value) || Number(value) > 36600) throw new HttpError(400, 'Invalid day count');
        clauses.push('p.dateAdded>=? AND p.dateAdded<?');
        params.push(dayStart(shiftDay(today, -Number(value))), dayStart(shiftDay(today, 1)));
      } else {
        if (!validDate(value) || value < '1000-01-01' || value >= '9999-12-31')
          throw new HttpError(400, 'Invalid search date');
        const start = dayStart(value),
          end = dayStart(shiftDay(value, 1));
        if (['equals', 'equal'].includes(operator)) {
          clauses.push('(p.dateAdded>=? AND p.dateAdded<?)');
          params.push(start, end);
        } else if (['notEquals', 'notEqual'].includes(operator)) {
          clauses.push('(p.dateAdded<? OR p.dateAdded>=?)');
          params.push(start, end);
        } else if (operator === 'greaterThan') {
          clauses.push('p.dateAdded>=?');
          params.push(end);
        } else if (operator === 'greaterThanEqual') {
          clauses.push('p.dateAdded>=?');
          params.push(start);
        } else if (operator === 'lessThan') {
          clauses.push('p.dateAdded<?');
          params.push(start);
        } else if (operator === 'lessThanEqual') {
          clauses.push('p.dateAdded<?');
          params.push(end);
        } else throw new HttpError(400, 'Unsupported search operator');
      }
      continue;
    }
    const dateColumn = Object.hasOwn(dates, field) ? dates[field] : undefined;
    if (dateColumn && operator === 'lastDays') {
      if (!/^\d+$/.test(value) || Number(value) > 36600) throw new HttpError(400, 'Invalid day count');
      clauses.push(`${dateColumn} BETWEEN date(today.value,?) AND today.value`);
      params.push('-' + Number(value) + ' days');
      continue;
    }
    let columns: string[];
    let numeric = false;
    if (['age', 'yearsMarried'].includes(field)) {
      const source = field === 'age' ? 'p.birthDate' : 'p.anniversary';
      columns = [
        `(CAST(strftime('%Y',today.value) AS INTEGER)-CAST(strftime('%Y',${source}) AS INTEGER)-(strftime('%m-%d',today.value)<strftime('%m-%d',${source})))`,
      ];
      numeric = true;
    } else if (['birthMonth', 'anniversaryMonth'].includes(field)) {
      columns = [`CAST(strftime('%m',${field === 'birthMonth' ? 'p.birthDate' : 'p.anniversary'}) AS INTEGER)`];
      numeric = true;
    } else if (field === 'phone') columns = [textColumns.homePhone, textColumns.mobilePhone, textColumns.workPhone];
    else if (dateColumn) columns = [dateColumn];
    else if (Object.hasOwn(textColumns, field)) columns = [textColumns[field]];
    else throw new HttpError(400, 'Unsupported search field');
    if (numeric && (!/^\d+$/.test(value) || Number(value) > 200))
      throw new HttpError(400, 'Invalid numeric search value');
    if (dateColumn && !validDate(value)) throw new HttpError(400, 'Invalid search date');
    const compare = Object.hasOwn(comparisons, operator) ? comparisons[operator] : undefined;
    const patterns = ['contains', 'startsWith', 'endsWith'];
    if (!compare && (!patterns.includes(operator) || numeric || dateColumn))
      throw new HttpError(400, 'Unsupported search operator');
    const expression = columns.map((column) => {
      if (compare) {
        params.push(numeric ? Number(value) : value);
        return `${column} ${compare} ?${numeric || dateColumn ? '' : ' COLLATE NOCASE'}`;
      }
      const escaped = value.replace(/[\\%_]/g, '\\$&');
      params.push((operator !== 'startsWith' ? '%' : '') + escaped + (operator !== 'endsWith' ? '%' : ''));
      return `${column} LIKE ? ESCAPE '\\'`;
    });
    clauses.push('(' + expression.join(' OR ') + ')');
  }
  // <=40 conditions and the three-phone expansion stay under D1's 100-bind limit.
  if (params.length > 100) throw new HttpError(400, 'Too many search parameters');
  return all(
    ctx,
    `WITH today(value) AS (SELECT ?) SELECT p.* FROM people p,today WHERE ${clauses.join(' AND ')} ORDER BY p.lastName,p.firstName,p.id LIMIT 1000`,
    ...params,
  );
}
