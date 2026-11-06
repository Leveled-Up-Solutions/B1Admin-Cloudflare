import type { Env, Principal } from './types';
import { body, HttpError, id, json, now } from './http';
import { checkPassword, randomToken, tokenHash } from './passwords';
import {
  accountThrottle,
  assertConditions,
  dbNow,
  liveSession,
  opaqueToken,
  securityAudit,
  securityBatch,
  strictFields,
} from './auth-security';
import { base32, decryptSecret, encryptSecret, matchedStep, recoveryCode, recoveryHash } from './mfa-crypto';
import { factorProof } from './mfa-proof';
type Authenticate = (request: Request, env: Env) => Promise<Principal>;
async function passwordUser(request: Request, env: Env, principal: Principal, password: unknown) {
  await accountThrottle(request, env, 'mfa-settings', principal.userId, 10);
  const user = await env.DB.prepare("SELECT * FROM users WHERE id=? AND disabled=0 AND passwordState='active'")
    .bind(principal.userId)
    .first<any>();
  if (
    !user ||
    typeof password !== 'string' ||
    password.length > 256 ||
    !(await checkPassword(password, user.passwordHash))
  )
    throw new HttpError(400, 'Incorrect current password');
  return user;
}
async function backupSet(env: Env, userId: string) {
  const codes = Array.from({ length: 10 }, recoveryCode);
  const hashes = await Promise.all(codes.map((code) => recoveryHash(userId, code)));
  return {
    codes,
    statements: hashes.map((hash) =>
      env.DB.prepare('INSERT INTO auth_mfa_codes(userId,codeHash) VALUES(?,?)').bind(userId, hash),
    ),
  };
}
export async function startMfaLogin(env: Env, user: any): Promise<Response | undefined> {
  const factor = await env.DB.prepare('SELECT factorId FROM auth_mfa WHERE userId=?').bind(user.id).first<any>();
  if (!factor) return undefined;
  const token = randomToken(),
    expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO auth_mfa_challenges(tokenHash,userId,factorId,passwordVersion,expiresAt) SELECT ?,u.id,m.factorId,u.passwordVersion,? FROM users u JOIN auth_mfa m ON m.userId=u.id WHERE u.id=? AND u.passwordHash=? AND u.passwordVersion=? AND u.disabled=0 AND u.passwordState='active' AND m.factorId=? RETURNING userId`,
  )
    .bind(await tokenHash(token), expiresAt, user.id, user.passwordHash, user.passwordVersion, factor.factorId)
    .all();
  if (result.results.length !== 1) throw new HttpError(400, 'Account changed; sign in again');
  return json({ mfaRequired: true, mfaToken: token, expiresAt });
}
export async function finishMfaLogin(
  request: Request,
  env: Env,
  input: Record<string, unknown>,
): Promise<{ user: any; sessionId: string }> {
  strictFields(input, ['mfaToken', 'mfaCode']);
  const hash = await tokenHash(opaqueToken(input.mfaToken));
  const challenge = await env.DB.prepare(
    `SELECT c.*,u.passwordHash FROM auth_mfa_challenges c JOIN users u ON u.id=c.userId JOIN auth_mfa m ON m.userId=u.id AND m.factorId=c.factorId WHERE c.tokenHash=? AND c.consumedAt IS NULL AND c.expiresAt>${dbNow} AND u.disabled=0 AND u.passwordState='active' AND u.passwordVersion=c.passwordVersion`,
  )
    .bind(hash)
    .first<any>();
  if (!challenge) throw new HttpError(400, 'Sign-in challenge is invalid or expired');
  await accountThrottle(request, env, 'mfa-login', challenge.userId, 20);
  const attempt = await env.DB.prepare(
    `UPDATE auth_mfa_challenges SET attempts=attempts+1 WHERE tokenHash=? AND consumedAt IS NULL AND expiresAt>${dbNow} AND attempts<5 RETURNING attempts`,
  )
    .bind(hash)
    .all();
  if (attempt.results.length !== 1) throw new HttpError(429, 'Sign-in challenge exhausted; start again');
  const proof = await factorProof(request, env, challenge.userId, input.mfaCode, true);
  const sessionId = id();
  await securityBatch(env, [
    ...assertConditions(
      env,
      {
        sql: `EXISTS(SELECT 1 FROM auth_mfa_challenges c JOIN users u ON u.id=c.userId JOIN auth_mfa m ON m.userId=u.id AND m.factorId=c.factorId WHERE c.tokenHash=? AND c.consumedAt IS NULL AND c.expiresAt>${dbNow} AND c.attempts<=5 AND u.disabled=0 AND u.passwordState='active' AND u.passwordVersion=c.passwordVersion AND c.passwordVersion=?)`,
        values: [hash, challenge.passwordVersion],
      },
      proof.condition,
    ),
    ...proof.statements,
    env.DB.prepare(`UPDATE auth_mfa_challenges SET consumedAt=${dbNow} WHERE tokenHash=?`).bind(hash),
    env.DB.prepare('INSERT INTO sessions(id,userId,expiresAt,createdAt,passwordVersion) VALUES(?,?,?,?,?)').bind(
      sessionId,
      challenge.userId,
      new Date(Date.now() + 8 * 3600000).toISOString(),
      now(),
      challenge.passwordVersion,
    ),
    securityAudit(env, challenge.userId, 'login.mfa.success'),
  ]);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(challenge.userId).first();
  return { user, sessionId };
}
export async function mfaRoutes(
  request: Request,
  env: Env,
  path: string,
  authenticate: Authenticate,
): Promise<Response | undefined> {
  const route = path.toLowerCase();
  if (!route.startsWith('/membership/users/mfa/')) return undefined;
  const principal = await authenticate(request, env);
  if (route === '/membership/users/mfa/status' && request.method === 'GET') {
    const factor = await env.DB.prepare('SELECT enabledAt FROM auth_mfa WHERE userId=?').bind(principal.userId).first();
    const count = await env.DB.prepare('SELECT count(*) count FROM auth_mfa_codes WHERE userId=? AND usedAt IS NULL')
      .bind(principal.userId)
      .first<any>();
    return json({ enabled: !!factor, backupCodesLeft: count?.count || 0 });
  }
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const input = await body(request);
  if (route === '/membership/users/mfa/setup') {
    strictFields(input, ['currentPassword']);
    const user = await passwordUser(request, env, principal, input.currentPassword);
    if (await env.DB.prepare('SELECT userId FROM auth_mfa WHERE userId=?').bind(user.id).first())
      throw new HttpError(409, 'Disable the existing authenticator before replacing it');
    const secret = base32(crypto.getRandomValues(new Uint8Array(20))),
      factorId = id(),
      setupToken = randomToken();
    const encrypted = await encryptSecret(env, user.id, factorId, secret),
      expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
    await securityBatch(env, [
      ...assertConditions(env, liveSession(principal, user.passwordVersion, user.passwordHash), {
        sql: 'NOT EXISTS(SELECT 1 FROM auth_mfa WHERE userId=?)',
        values: [user.id],
      }),
      env.DB.prepare(
        'INSERT INTO auth_mfa_enrollments(userId,tokenHash,factorId,encryptedSecret,sessionId,passwordVersion,expiresAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(userId) DO UPDATE SET tokenHash=excluded.tokenHash,factorId=excluded.factorId,encryptedSecret=excluded.encryptedSecret,sessionId=excluded.sessionId,passwordVersion=excluded.passwordVersion,expiresAt=excluded.expiresAt',
      ).bind(
        user.id,
        await tokenHash(setupToken),
        factorId,
        encrypted,
        principal.sessionId,
        user.passwordVersion,
        expiresAt,
      ),
      securityAudit(env, user.id, 'security.mfa.setup'),
    ]);
    return json({
      secret,
      otpauthUrl: `otpauth://totp/${encodeURIComponent('B1 Cloudflare:' + user.email)}?secret=${secret}&issuer=B1%20Cloudflare&algorithm=SHA1&digits=6&period=30`,
      setupToken,
      expiresAt,
    });
  }
  if (route === '/membership/users/mfa/enable') {
    strictFields(input, ['setupToken', 'code']);
    await accountThrottle(request, env, 'mfa-enable', principal.userId, 10);
    const token = await tokenHash(opaqueToken(input.setupToken));
    const pending = await env.DB.prepare(
      `SELECT * FROM auth_mfa_enrollments WHERE userId=? AND tokenHash=? AND sessionId=? AND expiresAt>${dbNow}`,
    )
      .bind(principal.userId, token, principal.sessionId)
      .first<any>();
    if (!pending) throw new HttpError(400, 'Authenticator setup is invalid or expired');
    const secret = await decryptSecret(env, principal.userId, pending.factorId, pending.encryptedSecret);
    const step = await matchedStep(secret, input.code);
    if (step === null) throw new HttpError(400, 'Invalid authenticator code');
    const backups = await backupSet(env, principal.userId);
    await securityBatch(env, [
      ...assertConditions(env, liveSession(principal, pending.passwordVersion), {
        sql: `EXISTS(SELECT 1 FROM auth_mfa_enrollments WHERE userId=? AND tokenHash=? AND sessionId=? AND factorId=? AND expiresAt>${dbNow} AND abs(CAST(strftime('%s','now') AS INTEGER)/30-?)<=1) AND NOT EXISTS(SELECT 1 FROM auth_mfa WHERE userId=?)`,
        values: [principal.userId, token, principal.sessionId, pending.factorId, step, principal.userId],
      }),
      env.DB.prepare('INSERT INTO auth_mfa(userId,factorId,encryptedSecret,lastStep,enabledAt) VALUES(?,?,?,?,?)').bind(
        principal.userId,
        pending.factorId,
        pending.encryptedSecret,
        step,
        now(),
      ),
      ...backups.statements,
      env.DB.prepare('UPDATE users SET passwordVersion=passwordVersion+1 WHERE id=?').bind(principal.userId),
      securityAudit(env, principal.userId, 'security.mfa.enabled'),
    ]);
    return json({ backupCodes: backups.codes, sessionsRevoked: true });
  }
  if (['/membership/users/mfa/disable', '/membership/users/mfa/backupcodes'].includes(route)) {
    strictFields(input, ['currentPassword', 'code']);
    const user = await passwordUser(request, env, principal, input.currentPassword);
    const rotate = route.endsWith('/backupcodes');
    const proof = await factorProof(request, env, user.id, input.code, true, rotate);
    const backups = rotate ? await backupSet(env, user.id) : null;
    await securityBatch(env, [
      ...assertConditions(env, liveSession(principal, user.passwordVersion, user.passwordHash), proof.condition),
      ...proof.statements,
      env.DB.prepare('DELETE FROM auth_mfa_codes WHERE userId=?').bind(user.id),
      ...(backups ? backups.statements : [env.DB.prepare('DELETE FROM auth_mfa WHERE userId=?').bind(user.id)]),
      env.DB.prepare('UPDATE users SET passwordVersion=passwordVersion+1 WHERE id=?').bind(user.id),
      securityAudit(env, user.id, rotate ? 'security.mfa.codes.rotated' : 'security.mfa.disabled'),
    ]);
    return json({ ...(backups ? { backupCodes: backups.codes } : { enabled: false }), sessionsRevoked: true });
  }
  throw new HttpError(501, 'This authenticator operation is not supported; recovery requires the local operator');
}
