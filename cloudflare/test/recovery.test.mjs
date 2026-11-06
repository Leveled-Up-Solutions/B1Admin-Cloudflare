import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createHarness } from './harness.mjs';
import { otp } from './mfa-helper.mjs';
async function data(response) {
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
const call = (h, path, json, token) => h.req('/membership/users/' + path, { method: 'POST', json, token });
const password = 'Synthetic recovered passphrase 2026!';
async function issue(h, userId = 'user-member', resetMfa = false, overrides = {}) {
  const user = await h.db.prepare('SELECT * FROM users WHERE id=?').bind(userId).first();
  const token = randomBytes(32).toString('base64url'),
    id = randomUUID(),
    created = new Date().toISOString(),
    expires = new Date(Date.now() + 1800000).toISOString();
  await h.db
    .prepare(
      'INSERT INTO auth_local_recoveries(id,tokenHash,userId,email,passwordVersion,resetMfa,createdAt,expiresAt) VALUES(?,?,?,?,?,?,?,?)',
    )
    .bind(
      id,
      createHash('sha256').update(token).digest('base64url'),
      userId,
      overrides.email || user.email,
      overrides.passwordVersion ?? user.passwordVersion,
      resetMfa ? 1 : 0,
      created,
      expires,
    )
    .run();
  return { token, id };
}
async function complete(h, token, newPassword = password, mfaCode) {
  return call(h, 'recovery/complete', { recoveryToken: token, newPassword, ...(mfaCode ? { mfaCode } : {}) });
}
async function enroll(h, token) {
  const setup = await data(await call(h, 'mfa/setup', { currentPassword: 'LocalDemo2026!' }, token));
  return data(await call(h, 'mfa/enable', { setupToken: setup.setupToken, code: otp(setup.secret) }, token));
}
test('local recovery is exact-identity, single-use, expiring and revokes old password and sessions', async () => {
  const h = await createHarness();
  try {
    const old = (await h.login('member@example.test')).token;
    await assert.rejects(issue(h, 'user-member', false, { email: 'other@example.test' }), /recovery_account_snapshot/);
    await assert.rejects(issue(h, 'user-member', false, { passwordVersion: 99 }), /recovery_account_snapshot/);
    const issued = await issue(h),
      row = await h.db.prepare('SELECT * FROM auth_local_recoveries WHERE id=?').bind(issued.id).first();
    assert.ok(!JSON.stringify(row).includes(issued.token));
    const previews = await data(await call(h, 'recovery/preview', { recoveryToken: issued.token }));
    assert.equal(previews.requiresMfa, false);
    assert.equal(previews.resetMfa, false);
    assert.equal('email' in previews, false);
    const results = await Promise.all([complete(h, issued.token), complete(h, issued.token)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
    assert.equal((await h.req('/member/v1/me', { token: old })).status, 401);
    assert.equal((await call(h, 'login', { email: 'member@example.test', password: 'LocalDemo2026!' })).status, 401);
    assert.ok((await data(await call(h, 'login', { email: 'member@example.test', password }))).user);
    assert.equal((await complete(h, issued.token)).status, 400);
    const expired = await issue(h);
    await h.db
      .prepare(
        "UPDATE auth_local_recoveries SET createdAt='2019-01-01T00:00:00.000Z',expiresAt='2020-01-01T00:00:00.000Z' WHERE id=?",
      )
      .bind(expired.id)
      .run();
    assert.equal((await complete(h, expired.token)).status, 400);
  } finally {
    await h.dispose();
  }
});
test('reissue, identity changes and disabled users invalidate offline recovery; tenant admins cannot issue/reset', async () => {
  const h = await createHarness();
  try {
    const admin = (await h.login()).token;
    assert.equal((await call(h, 'recovery', { userId: 'user-other' }, admin)).status, 501);
    assert.equal((await call(h, 'mfa/reset/user-other', {}, admin)).status, 501);
    const first = await issue(h),
      second = await issue(h);
    assert.equal((await complete(h, first.token)).status, 400);
    await h.db.prepare("UPDATE users SET email='changed@example.test' WHERE id='user-member'").run();
    await h.db.prepare("UPDATE users SET email='member@example.test' WHERE id='user-member'").run();
    assert.equal((await complete(h, second.token)).status, 400);
    const disabled = await issue(h);
    await h.db.prepare("UPDATE users SET disabled=1 WHERE id='user-member'").run();
    assert.equal((await complete(h, disabled.token)).status, 400);
    await assert.rejects(issue(h), /recovery_account_snapshot/);
  } finally {
    await h.dispose();
  }
});
test('password recovery preserves and requires MFA unless local operator explicitly authorized factor reset', async () => {
  const h = await createHarness();
  try {
    const member = (await h.login('member@example.test')).token,
      backups = await enroll(h, member),
      issued = await issue(h);
    assert.equal((await data(await call(h, 'recovery/preview', { recoveryToken: issued.token }))).requiresMfa, true);
    assert.equal((await complete(h, issued.token)).status, 400);
    assert.equal((await complete(h, issued.token, password, backups.backupCodes[0])).status, 200);
    const login = await data(await call(h, 'login', { email: 'member@example.test', password }));
    assert.equal(login.mfaRequired, true);
    const breakGlass = await issue(h, 'user-member', true);
    assert.equal((await complete(h, breakGlass.token, password + ' again')).status, 200);
    assert.equal(await h.db.prepare("SELECT userId FROM auth_mfa WHERE userId='user-member'").first(), null);
    assert.equal((await call(h, 'login', { mfaToken: login.mfaToken, mfaCode: backups.backupCodes[1] })).status, 400);
    assert.ok(
      (await data(await call(h, 'login', { email: 'member@example.test', password: password + ' again' }))).user,
    );
  } finally {
    await h.dispose();
  }
});
test('existing-account invitation cannot bypass MFA to link a shared account into another church', async () => {
  const h = await createHarness();
  try {
    const member = (await h.login('member@example.test')).token,
      backups = await enroll(h, member),
      other = (await h.login('other@example.test')).token;
    const [person] = await data(
      await h.req('/membership/people', {
        method: 'POST',
        token: other,
        json: [{ name: { first: 'Shared', last: 'Synthetic' }, contactInfo: { email: 'member@example.test' } }],
      }),
    );
    const invite = await data(await call(h, 'invitations', { personId: person.id }, other));
    const authGuid = new URL(invite.invitationUrl, 'https://local.test').searchParams.get('auth');
    assert.equal((await data(await call(h, 'invitations/preview', { authGuid }))).requiresMfa, true);
    assert.equal((await call(h, 'acceptInvitation', { authGuid, currentPassword: 'LocalDemo2026!' })).status, 400);
    assert.equal(
      (
        await call(h, 'acceptInvitation', {
          authGuid,
          currentPassword: 'LocalDemo2026!',
          mfaCode: backups.backupCodes[0],
        })
      ).status,
      200,
    );
    const count = await h.db.prepare("SELECT count(*) n FROM user_churches WHERE userId='user-member'").first();
    assert.equal(count.n, 2);
    assert.equal(
      (
        await call(h, 'acceptInvitation', {
          authGuid,
          currentPassword: 'LocalDemo2026!',
          mfaCode: backups.backupCodes[1],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await h.db
          .prepare("SELECT count(*) n FROM auth_mfa_codes WHERE userId='user-member' AND usedAt IS NULL")
          .first()
      ).n,
      9,
    );
  } finally {
    await h.dispose();
  }
});
test('password recovery never restores a removed person link or tenant access', async () => {
  const h = await createHarness();
  try {
    const old = (await h.login('member@example.test')).token;
    await h.db.prepare("UPDATE people SET removed=1 WHERE id='person-alex'").run();
    assert.equal((await h.req('/member/v1/me', { token: old })).status, 403);
    const token = await issue(h);
    assert.equal((await complete(h, token.token)).status, 200);
    assert.equal((await h.db.prepare("SELECT removed FROM people WHERE id='person-alex'").first()).removed, 1);
    const signed = await data(await call(h, 'login', { email: 'member@example.test', password }));
    assert.deepEqual(signed.userChurches, []);
    assert.equal(
      (
        await h.req('/membership/churches/select', {
          method: 'POST',
          token: signed.user.jwt,
          json: { churchId: 'church-demo' },
        })
      ).status,
      403,
    );
  } finally {
    await h.dispose();
  }
});
