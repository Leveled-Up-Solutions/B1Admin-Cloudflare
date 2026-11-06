import type { Context } from './types';
import { all, body, first, HttpError, id, json, now } from './http';

export function memberName(row: Record<string, any>) {
  return {
    first: row.firstName,
    last: row.lastName,
    middle: row.middleName || '',
    nick: row.nickName || '',
    display: [row.nickName || row.firstName, row.lastName].filter(Boolean).join(' '),
  };
}

export const contactFields = ['mobilePhone', 'homePhone', 'address1', 'address2', 'city', 'state', 'zip'];
export const nameFields = ['firstName', 'lastName', 'middleName', 'nickName'];
const consentFields = ['directoryVisible', 'shareEmail'];
export function approvalGroup(settings: string): string | null {
  const parsed = JSON.parse(settings);
  // Both ChurchApps' stored settings array and an object representation are recognized.
  if (Array.isArray(parsed)) {
    const entries = parsed.filter((item) => item?.keyName === 'directoryApprovalGroupId');
    if (!entries.length) return null;
    // A malformed duplicate must not be hidden by an earlier empty/valid entry.
    if (entries.some((item) => typeof item.value !== 'string')) return '__invalid_review_group__';
    return entries.find((item) => item.value !== '')?.value || null;
  }
  if (parsed && typeof parsed === 'object') {
    if (!Object.prototype.hasOwnProperty.call(parsed, 'directoryApprovalGroupId')) return null;
    const value = parsed.directoryApprovalGroupId;
    return typeof value === 'string' ? value || null : '__invalid_review_group__';
  }
  // Only absence or an explicit empty string disables review. Malformed stored
  // values, including false/0/null, must never silently permit direct writes.
  return '__invalid_review_group__';
}
function hasApproval(settings: string) {
  return !!approvalGroup(settings);
}
export async function self(ctx: Context) {
  const row = await first(
    ctx,
    `SELECT p.*,c.name churchName,c.subDomain,c.settings churchSettings FROM people p
     JOIN churches c ON c.id=p.churchId JOIN user_churches uc ON uc.churchId=p.churchId AND uc.personId=p.id
     WHERE p.churchId=? AND p.id=? AND p.removed=0 AND uc.userId=?`,
    ctx.principal.churchId,
    ctx.principal.personId,
    ctx.principal.userId,
  );
  if (!row) throw new HttpError(404, 'Member profile not found');
  return row;
}
function profile(row: Record<string, any>) {
  const stored = JSON.parse(row.contactInfo || '{}');
  const contactInfo: Record<string, string> = { email: row.email };
  contactFields.forEach((field) => {
    contactInfo[field] = typeof stored[field] === 'string' ? stored[field] : '';
  });
  return {
    person: {
      id: row.id,
      name: memberName(row),
      contactInfo,
      birthDate: row.birthDate,
      householdId: row.householdId,
      householdRole: row.householdRole,
      directoryVisible: !!row.directoryVisible,
      shareEmail: !!row.shareEmail,
    },
    church: { id: row.churchId, name: row.churchName, subDomain: row.subDomain },
    settings: {
      profileEditMode: hasApproval(row.churchSettings) ? 'review' : 'direct',
      familyAddEnabled: !!row.householdId,
      familyEditMode: row.householdId ? 'review' : 'unavailable',
    },
  };
}
export function clean(value: unknown, field: string, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value) || (required && !value.trim()))
    throw new HttpError(400, `Invalid ${field}`);
  return value.trim();
}
export function birthDate(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, 'Invalid birthDate');
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value > now().slice(0, 10))
    throw new HttpError(400, 'Invalid birthDate');
  return value;
}
/** Recheck identity, live session, household and policy in the mutation statement, not only before the batch. */
export function writeGuard(ctx: Context, row: Record<string, any>) {
  return {
    sql: `EXISTS(SELECT 1 FROM people mp JOIN user_churches uc ON uc.churchId=mp.churchId AND uc.personId=mp.id
      JOIN users u ON u.id=uc.userId JOIN sessions s ON s.userId=u.id JOIN churches c ON c.id=mp.churchId
      WHERE mp.churchId=? AND mp.id=? AND mp.removed=0 AND mp.householdId IS ? AND uc.userId=?
      AND s.id=? AND s.expiresAt>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.disabled=0 AND u.passwordState='active' AND s.passwordVersion=u.passwordVersion
      AND c.settings=?)`,
    values: [
      ctx.principal.churchId,
      ctx.principal.personId,
      row.householdId,
      ctx.principal.userId,
      ctx.principal.sessionId,
      row.churchSettings,
    ],
  };
}
function audit(ctx: Context, action: string, entityId: string) {
  return ctx.env.DB.prepare(
    'INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) SELECT ?,?,?,?,?,? WHERE changes()>0',
  ).bind(id(), ctx.principal.churchId, ctx.principal.userId, action, entityId, now());
}
function householdMember(row: Record<string, any>, personId: string) {
  return { id: row.id, name: memberName(row), householdRole: row.householdRole, isSelf: row.id === personId };
}

export async function memberProfile(ctx: Context): Promise<Response | undefined> {
  const { request, principal } = ctx;
  if (ctx.path === '/member/v1/churches') {
    if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const rows = await all(
      ctx,
      `SELECT c.id churchId,c.name churchName,c.subDomain,p.id,p.firstName,p.lastName,p.middleName,p.nickName
      FROM user_churches uc JOIN churches c ON c.id=uc.churchId JOIN people p ON p.churchId=uc.churchId AND p.id=uc.personId
      WHERE uc.userId=? AND p.removed=0 ORDER BY c.name,c.id`,
      principal.userId,
    );
    return json(
      rows.map((row) => ({
        church: { id: row.churchId, name: row.churchName, subDomain: row.subDomain },
        person: { id: row.id, name: memberName(row) },
        selected: row.churchId === principal.churchId,
      })),
    );
  }
  if (ctx.path === '/member/v1/me') {
    if (!['GET', 'POST'].includes(request.method)) throw new HttpError(405, 'Method not allowed');
    const row = await self(ctx);
    if (request.method === 'GET') return json(profile(row));
    const input = await body(request);
    const fields = Object.keys(input);
    if (
      Array.isArray(input) ||
      !fields.length ||
      fields.some((field) => ![...nameFields, ...contactFields, ...consentFields, 'birthDate'].includes(field))
    )
      throw new HttpError(400, 'Only own profile fields and directory preferences may be changed');
    if (hasApproval(row.churchSettings) && fields.some((field) => !consentFields.includes(field)))
      throw new HttpError(409, 'This church requires staff review for profile changes; contact church staff');
    const assignments: string[] = [],
      values: any[] = [],
      contacts: Record<string, string> = {};
    for (const field of fields) {
      if (consentFields.includes(field)) {
        if (typeof input[field] !== 'boolean') throw new HttpError(400, 'Directory preferences must be booleans');
        assignments.push(`${field}=?`);
        values.push(input[field] ? 1 : 0);
      } else if (nameFields.includes(field)) {
        assignments.push(`${field}=?`);
        values.push(clean(input[field], field, 100, ['firstName', 'lastName'].includes(field)));
      } else if (contactFields.includes(field))
        contacts[field] = clean(input[field], field, field.endsWith('Phone') ? 40 : 200);
      else {
        assignments.push('birthDate=?');
        values.push(birthDate(input.birthDate));
      }
    }
    if (Object.keys(contacts).length) {
      assignments.push('contactInfo=json_patch(contactInfo,?)');
      values.push(JSON.stringify(contacts));
    }
    const guard = writeGuard(ctx, row);
    const results = await ctx.env.DB.batch([
      ctx.env.DB.prepare(`UPDATE people SET ${assignments.join(',')} WHERE churchId=? AND id=? AND ${guard.sql}`).bind(
        ...values,
        principal.churchId,
        principal.personId,
        ...guard.values,
      ),
      audit(ctx, 'member.profile.update', principal.personId),
    ]);
    if (!results[0].meta.changes)
      throw new HttpError(409, 'Profile, session or church policy changed; refresh before saving');
    return json(profile(await self(ctx)));
  }
  if (ctx.path === '/member/v1/household') {
    if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const row = await self(ctx);
    if (!row.householdId) return json({ household: null, members: [], canAdd: false });
    const guard = writeGuard(ctx, row);
    const results = await ctx.env.DB.batch<Record<string, any>>([
      ctx.env.DB.prepare(`SELECT id,name FROM households WHERE churchId=? AND id=? AND ${guard.sql}`).bind(
        principal.churchId,
        row.householdId,
        ...guard.values,
      ),
      ctx.env.DB.prepare(
        `SELECT id,firstName,lastName,middleName,nickName,householdRole FROM people
        WHERE churchId=? AND householdId=? AND removed=0 AND ${guard.sql} ORDER BY lastName,firstName,id LIMIT 101`,
      ).bind(principal.churchId, row.householdId, ...guard.values),
    ]);
    const household = results[0].results[0],
      members = results[1].results;
    if (!household) throw new HttpError(409, 'Household or session changed; refresh before viewing');
    return json({
      household,
      members: members.slice(0, 100).map((p) => householdMember(p, principal.personId)),
      canAdd: !!household && members.length < 100,
    });
  }
  if (ctx.path === '/member/v1/household/members') {
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const input = await body(request);
    if (
      Array.isArray(input) ||
      Object.keys(input).some((field) => !['first', 'last', 'mobilePhone', 'householdRole'].includes(field))
    )
      throw new HttpError(400, 'Only new family member name, phone and household role may be supplied');
    const row = await self(ctx);
    if (!row.householdId) throw new HttpError(409, 'Ask church staff to link your household before adding family');
    if (hasApproval(row.churchSettings))
      throw new HttpError(409, 'This church requires staff review for family additions; contact church staff');
    const firstName = clean(input.first, 'first', 100, true);
    const lastName =
      input.last === undefined || input.last === '' ? row.lastName : clean(input.last, 'last', 100, true);
    const role = input.householdRole ?? 'Other';
    if (!['Head', 'Spouse', 'Child', 'Other'].includes(role)) throw new HttpError(400, 'Invalid householdRole');
    const contactInfo =
      input.mobilePhone === undefined ? {} : { mobilePhone: clean(input.mobilePhone, 'mobilePhone', 40) };
    const personId = id(),
      guard = writeGuard(ctx, row);
    const results = await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `INSERT INTO people(id,churchId,firstName,lastName,contactInfo,householdId,householdRole,dateAdded)
        SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql}
        AND (SELECT count(*) FROM people WHERE churchId=? AND householdId=? AND removed=0)<100`,
      ).bind(
        personId,
        principal.churchId,
        firstName,
        lastName,
        JSON.stringify(contactInfo),
        row.householdId,
        role,
        now(),
        ...guard.values,
        principal.churchId,
        row.householdId,
      ),
      audit(ctx, 'member.household.add', personId),
    ]);
    if (!results[0].meta.changes)
      throw new HttpError(
        409,
        'Household, session or church policy changed, or household is full; refresh before adding',
      );
    return json(householdMember({ id: personId, firstName, lastName, householdRole: role }, principal.personId), 201);
  }
  return undefined;
}
