import type { Env, Principal } from './types';
import { factorProof } from './mfa-proof';
import { assertConditions, dbNow, liveSession, securityBatch } from './auth-security';
import { body, HttpError, json, id, now, requiredString } from './http';
import { checkPassword, hashPassword, passwordPolicy, randomToken, tokenHash } from './passwords';
type Authenticate = (request: Request, env: Env) => Promise<Principal>;
type Row = Record<string, any>;

const validInvitation = `SELECT i.*,u.passwordHash,u.passwordState FROM auth_invitations i
 JOIN users u ON u.id=i.userId JOIN people p ON p.id=i.personId AND p.churchId=i.churchId
 WHERE i.tokenHash=? AND i.consumedAt IS NULL AND i.revokedAt IS NULL AND i.expiresAt>${dbNow}
 AND u.disabled=0 AND u.passwordVersion=i.passwordVersion AND lower(u.email)=i.email AND lower(p.email)=i.email AND p.removed=0
 AND ((i.mode IN ('setPassword','bootstrap') AND u.passwordState='pending') OR (i.mode='link' AND u.passwordState='active'))
 AND (i.mode<>'setPassword' OR NOT EXISTS(SELECT 1 FROM user_churches pendingLink WHERE pendingLink.userId=u.id))
 AND (i.roleId IS NULL OR EXISTS(SELECT 1 FROM roles r WHERE r.churchId=i.churchId AND r.id=i.roleId))
 AND NOT EXISTS(SELECT 1 FROM user_churches uc WHERE uc.churchId=i.churchId AND uc.userId=i.userId AND uc.personId<>i.personId)
 AND NOT EXISTS(SELECT 1 FROM user_churches uc WHERE uc.churchId=i.churchId AND uc.personId=i.personId AND uc.userId<>i.userId)
 AND ((i.mode='bootstrap' AND EXISTS(SELECT 1 FROM auth_bootstrap b WHERE b.invitationId=i.id)) OR
 (i.mode<>'bootstrap' AND EXISTS(SELECT 1 FROM user_churches issuer JOIN users issuerUser ON issuerUser.id=issuer.userId JOIN people issuerPerson ON issuerPerson.id=issuer.personId AND issuerPerson.churchId=issuer.churchId AND issuerPerson.removed=0 WHERE issuer.churchId=i.churchId AND issuer.userId=i.createdBy AND issuer.role='admin' AND issuerUser.disabled=0 AND issuerUser.passwordState='active')))`;

function fields(input: Row, allowed: string[]) {
  if (Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key)))
    throw new HttpError(400, 'Unexpected request field');
}
function emailAddress(value: unknown): string {
  const email = requiredString(value, 'email', 254).toLowerCase();
  if (
    !/^[\x21-\x7e]+$/.test(email) ||
    email.split('@').length !== 2 ||
    !/^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,63}$/.test(email)
  )
    throw new HttpError(400, 'A valid ASCII email address is required');
  return email;
}
async function throttle(request: Request, env: Env, scope: string, subject: string, max = 30) {
  const timestamp = now(),
    expiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const keys = [
    `${scope}:subject:${await tokenHash(subject)}`,
    `${scope}:ip:${request.headers.get('CF-Connecting-IP') || 'local'}`,
  ];
  const result = await env.DB.batch(
    keys.map((key) =>
      env.DB.prepare(
        'INSERT INTO auth_attempts(id,attempts,expiresAt) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET attempts=CASE WHEN expiresAt<? THEN 1 ELSE attempts+1 END,expiresAt=CASE WHEN expiresAt<? THEN excluded.expiresAt ELSE expiresAt END RETURNING attempts',
      ).bind(key, expiry, timestamp, timestamp),
    ),
  );
  if (result.some((r) => Number((r.results[0] as Row)?.attempts) > max))
    throw new HttpError(429, 'Too many account requests; retry later');
}
function admin(principal: Principal) {
  if (principal.role !== 'admin') throw new HttpError(403, 'A bootstrap administrator must manage account invitations');
}
function audit(env: Env, principal: Principal, action: string, entityId: string) {
  return env.DB.prepare('INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) VALUES(?,?,?,?,?,?)').bind(
    id(),
    principal.churchId,
    principal.userId,
    action,
    entityId,
    now(),
  );
}
function rawToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new HttpError(400, 'Invitation is invalid or expired');
  return value;
}
async function invitation(env: Env, hash: string): Promise<Row> {
  const result = await env.DB.prepare(validInvitation).bind(hash).first<Row>();
  if (!result) throw new HttpError(400, 'Invitation is invalid or expired');
  return result;
}

export async function lifecycleRoutes(
  request: Request,
  env: Env,
  path: string,
  authenticate: Authenticate,
): Promise<Response | undefined> {
  const route = path.toLowerCase();
  if (route === '/membership/users/invitations/preview' && request.method === 'POST') {
    const input = await body(request);
    fields(input, ['authGuid']);
    const hash = await tokenHash(rawToken(input.authGuid));
    await throttle(request, env, 'invitation-preview', hash);
    const row = await invitation(env, hash);
    return json({
      mode: row.mode === 'bootstrap' ? 'setPassword' : row.mode,
      expiresAt: row.expiresAt,
      ...(row.mode === 'link'
        ? {
            requiresMfa: !!(await env.DB.prepare('SELECT userId FROM auth_mfa WHERE userId=?')
              .bind(row.userId)
              .first()),
          }
        : {}),
    });
  }
  if (
    ['/membership/users/setpasswordguid', '/membership/users/acceptinvitation'].includes(route) &&
    request.method === 'POST'
  ) {
    const input = await body(request),
      setup = route.endsWith('/setpasswordguid');
    fields(input, setup ? ['authGuid', 'newPassword'] : ['authGuid', 'currentPassword', 'mfaCode']);
    const hash = await tokenHash(rawToken(input.authGuid));
    await throttle(request, env, 'invitation-accept', hash);
    const invite = await invitation(env, hash);
    if (setup !== (invite.mode !== 'link')) throw new HttpError(400, 'Use the required invitation acceptance method');
    let passwordHash: string | null = null;
    if (setup) passwordHash = hashPassword(passwordPolicy(input.newPassword));
    else if (
      typeof input.currentPassword !== 'string' ||
      input.currentPassword.length > 256 ||
      !(await checkPassword(input.currentPassword, invite.passwordHash))
    )
      throw new HttpError(401, 'Incorrect current password');
    const proof = setup ? null : await factorProof(request, env, invite.userId, input.mfaCode);
    const claimId = id(),
      timestamp = now();
    const result = await securityBatch(env, [
      // The winning claim gates every side effect in this same D1 transaction; replay cannot create a partial account.
      env.DB.prepare(
        `UPDATE auth_invitations SET consumedAt=?,claimId=? WHERE id IN (SELECT valid.id FROM (${validInvitation}) valid) RETURNING id`,
      ).bind(timestamp, claimId, hash),
      ...(proof
        ? [
            ...assertConditions(
              env,
              { sql: 'EXISTS(SELECT 1 FROM auth_invitations WHERE claimId=?)', values: [claimId] },
              proof.condition,
            ),
            ...proof.statements,
          ]
        : []),
      env.DB.prepare(
        "UPDATE users SET passwordHash=?,passwordState='active',passwordVersion=passwordVersion+1,passwordMutationId=? WHERE id IN(SELECT userId FROM auth_invitations WHERE claimId=? AND mode<>'link')",
      ).bind(passwordHash, claimId, claimId),
      env.DB.prepare(
        "INSERT INTO user_churches(userId,churchId,personId,role) SELECT userId,churchId,personId,CASE WHEN mode='bootstrap' THEN 'admin' ELSE 'member' END FROM auth_invitations WHERE claimId=? ON CONFLICT(userId,churchId) DO NOTHING",
      ).bind(claimId),
      env.DB.prepare(
        "DELETE FROM sessions WHERE userId IN(SELECT userId FROM auth_invitations WHERE claimId=? AND mode<>'link')",
      ).bind(claimId),
      env.DB.prepare(
        'INSERT INTO role_members(id,churchId,roleId,userId,addedBy,dateAdded) SELECT ?,i.churchId,i.roleId,i.userId,i.createdBy,? FROM auth_invitations i JOIN roles r ON r.churchId=i.churchId AND r.id=i.roleId WHERE i.claimId=? ON CONFLICT(churchId,roleId,userId) DO NOTHING',
      ).bind(id(), timestamp, claimId),
      env.DB.prepare(
        "UPDATE auth_invitations SET revokedAt=? WHERE claimId IS NULL AND revokedAt IS NULL AND userId IN(SELECT userId FROM auth_invitations WHERE claimId=? AND mode<>'link')",
      ).bind(timestamp, claimId),
      env.DB.prepare(
        "INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) SELECT ?,churchId,userId,CASE WHEN mode='link' THEN 'security.invitation.linked' ELSE 'security.password.setup' END,userId,? FROM auth_invitations WHERE claimId=?",
      ).bind(id(), timestamp, claimId),
    ]);
    if (result[0].results.length !== 1) throw new HttpError(400, 'Invitation is invalid or expired');
    return json({ success: true, email: invite.email });
  }
  if (route === '/membership/users/updatepassword' && request.method === 'POST') {
    const principal = await authenticate(request, env),
      input = await body(request);
    fields(input, ['currentPassword', 'newPassword']);
    const password = passwordPolicy(input.newPassword);
    await throttle(request, env, 'password-change', principal.userId, 10);
    const user = await env.DB.prepare("SELECT * FROM users WHERE id=? AND disabled=0 AND passwordState='active'")
      .bind(principal.userId)
      .first<Row>();
    if (
      !user ||
      typeof input.currentPassword !== 'string' ||
      input.currentPassword.length > 256 ||
      !(await checkPassword(input.currentPassword, user.passwordHash))
    )
      throw new HttpError(400, 'Incorrect current password');
    if (password === input.currentPassword) throw new HttpError(400, 'Choose a different password');
    const passwordHash = hashPassword(password),
      mutationId = id(),
      timestamp = now();
    const result = await securityBatch(env, [
      ...assertConditions(env, liveSession(principal, user.passwordVersion, user.passwordHash)),
      env.DB.prepare(
        "UPDATE users SET passwordHash=?,passwordVersion=passwordVersion+1,passwordMutationId=? WHERE id=? AND passwordHash=? AND passwordVersion=? AND passwordState='active' AND disabled=0 RETURNING id",
      ).bind(passwordHash, mutationId, user.id, user.passwordHash, user.passwordVersion),
      env.DB.prepare(
        'DELETE FROM sessions WHERE userId IN(SELECT id FROM users WHERE id=? AND passwordMutationId=?)',
      ).bind(user.id, mutationId),
      env.DB.prepare(
        'UPDATE auth_invitations SET revokedAt=? WHERE consumedAt IS NULL AND revokedAt IS NULL AND userId IN(SELECT id FROM users WHERE id=? AND passwordMutationId=?)',
      ).bind(timestamp, user.id, mutationId),
      env.DB.prepare(
        "INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) SELECT ?,?,?, 'security.password.changed',id,? FROM users WHERE id=? AND passwordMutationId=?",
      ).bind(id(), principal.churchId, user.id, timestamp, user.id, mutationId),
    ]);
    if (result[2].results.length !== 1) throw new HttpError(409, 'Account changed; sign in again');
    return json({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      success: true,
      sessionsRevoked: true,
    });
  }
  if (route === '/membership/users/invitations' && request.method === 'POST') {
    const principal = await authenticate(request, env);
    admin(principal);
    const input = await body(request);
    fields(input, ['personId', 'roleId']);
    await throttle(request, env, 'invitation-issue', principal.userId);
    const personId = requiredString(input.personId, 'personId');
    const person = await env.DB.prepare(
      'SELECT id,firstName,lastName,email FROM people WHERE churchId=? AND id=? AND removed=0',
    )
      .bind(principal.churchId, personId)
      .first<Row>();
    if (!person) throw new HttpError(404, 'Person not found');
    const email = emailAddress(person.email);
    const roleId = input.roleId ? requiredString(input.roleId, 'roleId') : null;
    if (
      roleId &&
      !(await env.DB.prepare('SELECT id FROM roles WHERE churchId=? AND id=?').bind(principal.churchId, roleId).first())
    )
      throw new HttpError(400, 'A custom role in this church is required');
    const user = await env.DB.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').bind(email).first<Row>();
    if (user?.disabled) throw new HttpError(409, 'The existing account is disabled');
    if (
      user?.passwordState === 'pending' &&
      (await env.DB.prepare('SELECT userId FROM user_churches WHERE userId=? LIMIT 1').bind(user.id).first())
    )
      throw new HttpError(409, 'This pending account requires its original setup invitation');
    const links = (
      await env.DB.prepare('SELECT userId,personId FROM user_churches WHERE churchId=? AND (personId=? OR userId=?)')
        .bind(principal.churchId, personId, user?.id || '')
        .all<Row>()
    ).results;
    if (links.some((link) => link.personId !== personId || link.userId !== user?.id))
      throw new HttpError(409, 'The account or person already has a different link');
    if (user?.passwordState === 'active' && links.length)
      return json({
        mode: 'login',
        invitationUrl: '/login',
        alreadyLinked: true,
      });
    const token = randomToken(),
      hash = await tokenHash(token),
      invitationId = id(),
      userId = user?.id || id();
    const timestamp = now(),
      expiresAt = new Date(Date.now() + 24 * 3600000).toISOString(),
      mode = user?.passwordState === 'active' ? 'link' : 'setPassword';
    // Authenticate captures a principal before several asynchronous preflight reads.
    // Recheck that exact session and the target snapshot inside every write of the
    // transaction. A password change, logout, demotion, or competing account claim
    // must not leave a new usable invitation, revoke an old one, or create an orphan.
    const canIssue = `EXISTS(SELECT 1 FROM sessions s JOIN users issuer ON issuer.id=s.userId
   JOIN user_churches uc ON uc.userId=issuer.id JOIN people issuerPerson ON issuerPerson.id=uc.personId AND issuerPerson.churchId=uc.churchId AND issuerPerson.removed=0 WHERE s.id=? AND s.userId=? AND uc.churchId=?
   AND uc.role='admin' AND issuer.disabled=0 AND issuer.passwordState='active'
   AND s.passwordVersion=issuer.passwordVersion AND s.expiresAt>${dbNow})
   AND EXISTS(SELECT 1 FROM people p WHERE p.churchId=? AND p.id=? AND p.removed=0 AND lower(p.email)=?)
   AND (? IS NULL OR EXISTS(SELECT 1 FROM roles r WHERE r.churchId=? AND r.id=?))
   AND NOT EXISTS(SELECT 1 FROM user_churches uc WHERE uc.churchId=? AND ((uc.userId=? AND uc.personId<>?) OR (uc.personId=? AND uc.userId<>?)))
   AND (EXISTS(SELECT 1 FROM users target WHERE target.id=? AND lower(target.email)=? AND target.disabled=0 AND target.passwordState=? AND target.passwordVersion=? AND (target.passwordState<>'pending' OR NOT EXISTS(SELECT 1 FROM user_churches pendingLink WHERE pendingLink.userId=target.id)))
    OR (?=1 AND NOT EXISTS(SELECT 1 FROM users target WHERE target.email=? COLLATE NOCASE)))`;
    const issueArgs = [
      principal.sessionId,
      principal.userId,
      principal.churchId,
      principal.churchId,
      personId,
      email,
      roleId,
      principal.churchId,
      roleId,
      principal.churchId,
      userId,
      personId,
      personId,
      userId,
      userId,
      email,
      user?.passwordState || 'pending',
      user?.passwordVersion || 0,
      user ? 0 : 1,
      email,
    ];
    const statements: D1PreparedStatement[] = [];
    if (!user)
      statements.push(
        env.DB.prepare(
          `INSERT INTO users(id,email,firstName,lastName,passwordHash,passwordState) SELECT ?,?,?,?,'!pending','pending' WHERE ${canIssue}`,
        ).bind(userId, email, person.firstName, person.lastName, ...issueArgs),
      );
    statements.push(
      env.DB.prepare(
        `UPDATE auth_invitations SET revokedAt=? WHERE churchId=? AND personId=? AND consumedAt IS NULL AND revokedAt IS NULL AND ${canIssue}`,
      ).bind(timestamp, principal.churchId, personId, ...issueArgs),
    );
    const invitationIndex = statements.length;
    statements.push(
      env.DB.prepare(
        `INSERT INTO auth_invitations(id,tokenHash,churchId,personId,userId,email,mode,roleId,passwordVersion,createdBy,createdAt,expiresAt) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${canIssue} RETURNING id`,
      ).bind(
        invitationId,
        hash,
        principal.churchId,
        personId,
        userId,
        email,
        mode,
        roleId,
        user?.passwordVersion || 0,
        principal.userId,
        timestamp,
        expiresAt,
        ...issueArgs,
      ),
    );
    statements.push(
      env.DB.prepare(
        "INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) SELECT ?,churchId,createdBy,'security.invitation.created',id,? FROM auth_invitations WHERE id=?",
      ).bind(id(), timestamp, invitationId),
    );
    const result = await env.DB.batch(statements);
    if (result[invitationIndex].results.length !== 1)
      throw new HttpError(409, 'Account or invitation authority changed; sign in and try again');
    return json(
      {
        id: invitationId,
        mode,
        expiresAt,
        invitationUrl: `/login?auth=${token}`,
        delivery: 'manual',
      },
      201,
    );
  }
  if (route === '/membership/users/invitations' && request.method === 'GET') {
    const principal = await authenticate(request, env);
    admin(principal);
    const personId = new URL(request.url).searchParams.get('personId');
    return json(
      (
        await env.DB.prepare(
          `SELECT id,personId,userId,email,mode,roleId,createdAt,expiresAt,consumedAt,revokedAt FROM auth_invitations WHERE churchId=? ${personId ? 'AND personId=?' : ''} ORDER BY createdAt DESC LIMIT 100`,
        )
          .bind(principal.churchId, ...(personId ? [personId] : []))
          .all()
      ).results,
    );
  }
  const revoke = /^\/membership\/users\/invitations\/([^/]+)$/.exec(route);
  if (revoke && request.method === 'DELETE') {
    const principal = await authenticate(request, env);
    admin(principal);
    const found = await env.DB.prepare('SELECT id FROM auth_invitations WHERE churchId=? AND id=?')
      .bind(principal.churchId, revoke[1])
      .first();
    if (!found) throw new HttpError(404, 'Invitation not found');
    await env.DB.batch([
      env.DB.prepare('UPDATE auth_invitations SET revokedAt=? WHERE churchId=? AND id=? AND consumedAt IS NULL').bind(
        now(),
        principal.churchId,
        revoke[1],
      ),
      audit(env, principal, 'security.invitation.revoked', revoke[1]),
    ]);
    return json({ success: true });
  }
  return undefined;
}
