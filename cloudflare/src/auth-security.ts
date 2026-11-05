import type { Env, Principal } from './types';
import { HttpError, id, now } from './http';
import { tokenHash } from './passwords';
export type Condition = { sql: string; values: (string | number | null)[] };
export const dbNow = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
export function strictFields(input: Record<string, unknown>, keys: string[]) {
  if (Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key)))
    throw new HttpError(400, 'Unexpected request field');
}
export function opaqueToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new HttpError(400, 'Security request is invalid or expired');
  return value;
}
export async function accountThrottle(request: Request, env: Env, scope: string, subject: string, max = 20) {
  const timestamp = now(),
    expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
  const keys = [
    `${scope}:subject:${await tokenHash(subject)}`,
    `${scope}:ip:${request.headers.get('CF-Connecting-IP') || 'local'}`,
  ];
  const results = await env.DB.batch(
    keys.map((key) =>
      env.DB.prepare(
        'INSERT INTO auth_attempts(id,attempts,expiresAt) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET attempts=CASE WHEN expiresAt<? THEN 1 ELSE attempts+1 END,expiresAt=CASE WHEN expiresAt<? THEN excluded.expiresAt ELSE expiresAt END RETURNING attempts',
      ).bind(key, expiresAt, timestamp, timestamp),
    ),
  );
  if (results.some((row) => Number((row.results[0] as { attempts: number })?.attempts) > max))
    throw new HttpError(429, 'Too many account requests; retry later');
}
export function assertConditions(env: Env, ...conditions: Condition[]): D1PreparedStatement[] {
  const guardId = id();
  return [
    env.DB.prepare(
      `INSERT INTO write_guards(id,valid) VALUES(?,CASE WHEN ${conditions.map((c) => `(${c.sql})`).join(' AND ')} THEN 1 ELSE 0 END)`,
    ).bind(guardId, ...conditions.flatMap((c) => c.values)),
    env.DB.prepare('DELETE FROM write_guards WHERE id=?').bind(guardId),
  ];
}
export function liveSession(principal: Principal, passwordVersion: number, passwordHash?: string): Condition {
  return {
    sql: `EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.userId JOIN user_churches uc ON uc.userId=u.id JOIN people p ON p.id=uc.personId AND p.churchId=uc.churchId WHERE s.id=? AND s.userId=? AND uc.churchId=? AND p.removed=0 AND s.expiresAt>${dbNow} AND s.passwordVersion=u.passwordVersion AND u.passwordVersion=? AND u.disabled=0 AND u.passwordState='active' ${passwordHash ? 'AND u.passwordHash=?' : ''})`,
    values: [
      principal.sessionId,
      principal.userId,
      principal.churchId,
      passwordVersion,
      ...(passwordHash ? [passwordHash] : []),
    ],
  };
}
export async function securityBatch(env: Env, statements: D1PreparedStatement[]) {
  try {
    return await env.DB.batch(statements);
  } catch (error) {
    if (error instanceof Error && error.message.includes('authorized_write_snapshot'))
      throw new HttpError(400, 'Security request changed or expired; retry');
    throw error;
  }
}
export function securityAudit(env: Env, userId: string, action: string): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) SELECT ?||':'||churchId,churchId,userId,?,userId,? FROM user_churches WHERE userId=?",
  ).bind(id(), action, now(), userId);
}
