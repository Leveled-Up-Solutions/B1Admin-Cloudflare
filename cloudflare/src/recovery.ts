import type { Env } from './types';
import { body, HttpError, id, json } from './http';
import { hashPassword, passwordPolicy, tokenHash } from './passwords';
import {
  accountThrottle,
  assertConditions,
  dbNow,
  opaqueToken,
  securityAudit,
  securityBatch,
  strictFields,
} from './auth-security';
import { factorProof } from './mfa-proof';
const validRecovery = `SELECT r.*,u.passwordState FROM auth_local_recoveries r JOIN users u ON u.id=r.userId
 WHERE r.tokenHash=? AND r.consumedAt IS NULL AND r.revokedAt IS NULL AND r.expiresAt>${dbNow}
 AND lower(u.email)=r.email AND u.disabled=0 AND u.passwordVersion=r.passwordVersion
 AND (u.passwordState='active' OR EXISTS(SELECT 1 FROM auth_bootstrap b WHERE b.userId=u.id))`;
export async function recoveryRoutes(request: Request, env: Env, path: string): Promise<Response | undefined> {
  const route = path.toLowerCase();
  if (!['/membership/users/recovery/preview', '/membership/users/recovery/complete'].includes(route)) return undefined;
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const input = await body(request),
    preview = route.endsWith('/preview');
  strictFields(input, preview ? ['recoveryToken'] : ['recoveryToken', 'newPassword', 'mfaCode']);
  const hash = await tokenHash(opaqueToken(input.recoveryToken));
  await accountThrottle(request, env, 'local-recovery', hash, 10);
  const record = await env.DB.prepare(validRecovery).bind(hash).first<any>();
  if (!record) throw new HttpError(400, 'Recovery request is invalid or expired');
  if (preview)
    return json({
      expiresAt: record.expiresAt,
      resetMfa: !!record.resetMfa,
      requiresMfa:
        !record.resetMfa &&
        !!(await env.DB.prepare('SELECT userId FROM auth_mfa WHERE userId=?').bind(record.userId).first()),
    });
  const proof = record.resetMfa ? null : await factorProof(request, env, record.userId, input.mfaCode);
  const passwordHash = hashPassword(passwordPolicy(input.newPassword));
  await securityBatch(env, [
    ...assertConditions(env, { sql: `EXISTS(${validRecovery})`, values: [hash] }, ...(proof ? [proof.condition] : [])),
    ...(proof?.statements || []),
    env.DB.prepare(`UPDATE auth_local_recoveries SET consumedAt=${dbNow} WHERE tokenHash=?`).bind(hash),
    ...(record.resetMfa ? [env.DB.prepare('DELETE FROM auth_mfa WHERE userId=?').bind(record.userId)] : []),
    env.DB.prepare(
      "UPDATE users SET passwordHash=?,passwordState='active',passwordVersion=passwordVersion+1,passwordMutationId=? WHERE id=?",
    ).bind(passwordHash, id(), record.userId),
    securityAudit(
      env,
      record.userId,
      record.resetMfa ? 'security.recovery.password-and-mfa' : 'security.recovery.password',
    ),
  ]);
  return json({ success: true, email: record.email, sessionsRevoked: true, mfaReset: !!record.resetMfa });
}
