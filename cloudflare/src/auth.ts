import { builtinGrants, loadGrants, permissionKey } from './permissions';
import { lifecycleRoutes } from './auth-lifecycle';
import { mfaRoutes, startMfaLogin, finishMfaLogin } from './mfa';
import { recoveryRoutes } from './recovery';
import { mediaContextCookie, revokeMediaAccess } from './media-session';
import { checkPassword } from './passwords';
import { body, HttpError, json, id, now } from './http';
import type { Env, Principal } from './types';
const encoder = new TextEncoder();
function base64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
function unbase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (x) => x.charCodeAt(0));
}
async function key(env: Env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)
    throw new HttpError(503, 'Session secret is not configured');
  return crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}
async function sign(env: Env, payload: Record<string, unknown>): Promise<string> {
  const message =
    base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))) +
    '.' +
    base64url(encoder.encode(JSON.stringify(payload)));
  return (
    message + '.' + base64url(new Uint8Array(await crypto.subtle.sign('HMAC', await key(env), encoder.encode(message))))
  );
}
async function verify(env: Env, token: string): Promise<Record<string, any>> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || token.length > 8192) throw new Error();
    const header = JSON.parse(new TextDecoder().decode(unbase64(parts[0])));
    if (header.alg !== 'HS256') throw new Error();
    if (
      !(await crypto.subtle.verify(
        'HMAC',
        await key(env),
        unbase64(parts[2]),
        encoder.encode(parts[0] + '.' + parts[1]),
      ))
    )
      throw new Error();
    const data = JSON.parse(new TextDecoder().decode(unbase64(parts[1])));
    if (
      data.iss !== 'b1-cloudflare' ||
      data.aud !== 'b1-suite' ||
      typeof data.exp !== 'number' ||
      data.exp <= Date.now() / 1000 ||
      typeof data.sid !== 'string' ||
      typeof data.id !== 'string'
    )
      throw new Error();
    const session = await env.DB.prepare(
      "SELECT s.id FROM sessions s JOIN users u ON u.id=s.userId WHERE s.id=? AND s.userId=? AND s.expiresAt>? AND u.disabled=0 AND u.passwordState='active' AND s.passwordVersion=u.passwordVersion",
    )
      .bind(data.sid, data.id, now())
      .first();
    if (!session) throw new Error();
    return data;
  } catch (e) {
    if (e instanceof HttpError && e.status === 503) throw e;
    throw new HttpError(401, 'Invalid or expired session');
  }
}
export async function authenticate(request: Request, env: Env): Promise<Principal> {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) throw new HttpError(401, 'Authentication required');
  const data = await verify(env, auth.slice(7));
  const grant = await env.DB.prepare(
    'SELECT uc.personId,uc.role FROM user_churches uc JOIN people p ON p.id=uc.personId AND p.churchId=uc.churchId WHERE uc.userId=? AND uc.churchId=? AND p.removed=0',
  )
    .bind(data.id, data.churchId || '')
    .first<{ personId: string; role: 'admin' | 'viewer' | 'member' }>();
  if (!grant) throw new HttpError(403, 'Church membership required');
  const grants = await loadGrants(env, data.id, data.churchId, grant.role);
  return {
    userId: data.id,
    churchId: data.churchId,
    personId: grant.personId,
    role: grant.role === 'member' && grants.length ? 'viewer' : grant.role,
    sessionId: data.sid,
    permissions: grants.map(permissionKey),
  };
}
async function responseFor(env: Env, user: any, sessionId: string) {
  const grants = (
    await env.DB.prepare(
      'SELECT uc.*, c.name,c.subDomain,c.settings FROM user_churches uc JOIN churches c ON c.id=uc.churchId JOIN people activePerson ON activePerson.id=uc.personId AND activePerson.churchId=uc.churchId WHERE uc.userId=? AND activePerson.removed=0 ORDER BY c.name',
    )
      .bind(user.id)
      .all<any>()
  ).results;
  const session = await env.DB.prepare('SELECT expiresAt FROM sessions WHERE id=?')
    .bind(sessionId)
    .first<{ expiresAt: string }>();
  if (!session) throw new HttpError(401, 'Session expired');
  const common = {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    sid: sessionId,
    iss: 'b1-cloudflare',
    aud: 'b1-suite',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.parse(session.expiresAt) / 1000),
  };
  const userChurches = [];
  for (const grant of grants) {
    const person = await env.DB.prepare('SELECT * FROM people WHERE churchId=? AND id=?')
      .bind(grant.churchId, grant.personId)
      .first<any>();
    const groups = (
      await env.DB.prepare(
        'SELECT g.id,g.name,g.tags,gm.leader FROM groups g JOIN group_members gm ON gm.groupId=g.id AND gm.churchId=g.churchId WHERE gm.churchId=? AND gm.personId=?',
      )
        .bind(grant.churchId, grant.personId)
        .all()
    ).results;
    const grants = await loadGrants(env, user.id, grant.churchId, grant.role);
    const apis = Object.keys(builtinGrants).map((keyName) => ({
      keyName,
      permissions: grants.filter((p) => p.apiName === keyName),
      jwt: '',
    }));
    const jwt = await sign(env, {
      ...common,
      churchId: grant.churchId,
      personId: grant.personId,
      permissions: grants.map(permissionKey),
      groupIds: groups.map((g) => g.id),
    });
    apis.forEach((a) => (a.jwt = jwt));
    userChurches.push({
      role: grant.role,
      church: {
        id: grant.churchId,
        name: grant.name,
        subDomain: grant.subDomain,
        settings: JSON.parse(grant.settings),
      },
      person: {
        id: grant.personId,
        name: {
          first: person.firstName,
          last: person.lastName,
          display: person.firstName + ' ' + person.lastName,
        },
        membershipStatus: person.membershipStatus,
      },
      groups,
      apis,
      jwt,
    });
  }
  return {
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      jwt: await sign(env, common),
    },
    userChurches,
  };
}
export async function authRoutes(request: Request, env: Env, path: string): Promise<Response | undefined> {
  const recovery = await recoveryRoutes(request, env, path);
  if (recovery) return recovery;
  const mfa = await mfaRoutes(request, env, path, authenticate);
  if (mfa) return mfa;
  const lifecycle = await lifecycleRoutes(request, env, path, authenticate);
  if (lifecycle) return lifecycle;
  if (path === '/membership/users/login' && request.method === 'POST') {
    await key(env);
    const input = await body(request);
    if (input.mfaToken) {
      const result = await finishMfaLogin(request, env, input);
      const response = json(await responseFor(env, result.user, result.sessionId));
      response.headers.append('Set-Cookie', mediaContextCookie(result.sessionId));
      return response;
    }
    let user: any;
    let sid: string;
    if (input.jwt) {
      const claims = await verify(env, input.jwt);
      user = await env.DB.prepare('SELECT * FROM users WHERE id=? AND disabled=0').bind(claims.id).first();
      sid = claims.sid;
    } else {
      if (
        typeof input.email !== 'string' ||
        typeof input.password !== 'string' ||
        input.email.length > 254 ||
        input.password.length > 256
      )
        throw new HttpError(400, 'Email and password required');
      const email = input.email.trim().toLowerCase();
      const hash = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(email))));
      const expiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const timestamp = now();
      const keys = ['email:' + hash, 'ip:' + (request.headers.get('CF-Connecting-IP') || 'local')];
      const results = await env.DB.batch(
        keys.map((k) =>
          env.DB.prepare(
            'INSERT INTO auth_attempts(id,attempts,expiresAt) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET attempts=CASE WHEN expiresAt<? THEN 1 ELSE attempts+1 END, expiresAt=CASE WHEN expiresAt<? THEN excluded.expiresAt ELSE expiresAt END RETURNING attempts',
          ).bind(k, expiry, timestamp, timestamp),
        ),
      );
      if (results.some((r) => Number((r.results[0] as any)?.attempts) > 30))
        throw new HttpError(429, 'Too many login attempts; retry later');
      user = await env.DB.prepare(
        "SELECT * FROM users WHERE email=? COLLATE NOCASE AND disabled=0 AND passwordState='active'",
      )
        .bind(email)
        .first();
      // Use a fixed valid development hash on the unknown-user path to equalize password work.
      const dummy = 'scrypt$32768$8$3$ZHVtbXktc2NyeXB0c2FsdCE$FbzAAfxQZ8tV0UARxyDq89VbsyUHOkBk1Cm3upw-7a4';
      const valid = await checkPassword(input.password, user?.passwordHash || dummy);
      if (!user || !valid) throw new HttpError(401, 'Login failed');
      const challenge = await startMfaLogin(env, user);
      if (challenge) return challenge;
      sid = id();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO sessions(id,userId,expiresAt,createdAt,passwordVersion) SELECT ?,id,?,?,passwordVersion FROM users WHERE id=? AND passwordHash=? AND passwordVersion=? AND disabled=0 AND passwordState='active' AND NOT EXISTS(SELECT 1 FROM auth_mfa WHERE userId=users.id)",
        ).bind(
          sid,
          new Date(Date.now() + 8 * 3600000).toISOString(),
          now(),
          user.id,
          user.passwordHash,
          user.passwordVersion,
        ),
        env.DB.prepare(
          "INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) SELECT ?||':'||churchId,churchId,userId,'login.success',userId,? FROM user_churches WHERE userId=? AND EXISTS(SELECT 1 FROM sessions WHERE id=?)",
        ).bind(id(), now(), user.id, sid),
      ]);
    }
    const response = json(await responseFor(env, user, sid));
    response.headers.append('Set-Cookie', mediaContextCookie(sid));
    return response;
  }
  if (path === '/membership/churches/select' && request.method === 'POST') {
    const token = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
    const claims = await verify(env, token);
    const input = await body(request);
    const user = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(claims.id).first();
    const result = await responseFor(env, user, claims.sid);
    const selected = result.userChurches.find(
      (uc) => uc.church.id === input.churchId || uc.church.subDomain === input.subDomain,
    );
    if (!selected) throw new HttpError(403, 'Church membership required');
    const clearedCookies = await revokeMediaAccess(env, claims.sid, request);
    const response = json(selected);
    for (const cookie of clearedCookies) response.headers.append('Set-Cookie', cookie);
    return response;
  }
  if (path === '/membership/users/logout' && request.method === 'POST') {
    const claims = await verify(env, (request.headers.get('authorization') || '').replace(/^Bearer /, ''));
    const clearedCookies = await revokeMediaAccess(env, claims.sid, request);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE id=?').bind(claims.sid),
      env.DB.prepare(
        "INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) SELECT ?||':'||churchId,churchId,userId,'logout.success',userId,? FROM user_churches WHERE userId=?",
      ).bind(id(), now(), claims.id),
    ]);
    const response = json({ success: true });
    for (const cookie of clearedCookies) response.headers.append('Set-Cookie', cookie);
    return response;
  }
  return undefined;
}
