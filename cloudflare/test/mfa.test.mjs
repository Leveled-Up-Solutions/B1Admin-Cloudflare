import test from 'node:test';
import assert from 'node:assert/strict';
import { otp } from './mfa-helper.mjs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHarness } from './harness.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const bundled = await build({
  entryPoints: [root + 'src/mfa-crypto.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const cryptoHelpers = await import(
  'data:text/javascript;base64,' +
    Buffer.from(bundled.outputFiles[0].text + '\n//# sourceURL=mfa-crypto-test.mjs').toString('base64')
);
async function data(response) {
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
const call = (h, path, token, json) =>
  h.req('/membership/users/' + path, { method: json === undefined ? 'GET' : 'POST', token, json });
const login = (h) => call(h, 'login', undefined, { email: 'member@example.test', password: 'LocalDemo2026!' });
async function fixture() {
  const h = await createHarness();
  const token = (await h.login('member@example.test')).token;
  return { h, token };
}
async function enroll(h, token) {
  const setup = await data(await call(h, 'mfa/setup', token, { currentPassword: 'LocalDemo2026!' }));
  const step = Math.floor((Date.now() + 1500) / 30000) - 1;
  const enabled = await data(
    await call(h, 'mfa/enable', token, { setupToken: setup.setupToken, code: otp(setup.secret, step) }),
  );
  return { ...setup, ...enabled, nextStep: step + 1 };
}
async function challenge(h) {
  return data(await login(h));
}
async function verify(h, mfaToken, mfaCode) {
  return call(h, 'login', undefined, { mfaToken, mfaCode });
}
test('TOTP matches RFC6238 SHA1 vectors and factor ciphertext is bound to account and factor', async () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  for (const [timestamp, expected] of [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])
    assert.equal(await cryptoHelpers.totp(secret, Math.floor(timestamp / 30), 8), expected);
  const env = { AUTH_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
  const encrypted = await cryptoHelpers.encryptSecret(env, 'user-one', 'factor-one', secret);
  assert.ok(!encrypted.includes(secret));
  assert.equal(await cryptoHelpers.decryptSecret(env, 'user-one', 'factor-one', encrypted), secret);
  await assert.rejects(cryptoHelpers.decryptSecret(env, 'user-other', 'factor-one', encrypted), /cannot be opened/);
  await assert.rejects(cryptoHelpers.decryptSecret(env, 'user-one', 'factor-other', encrypted), /cannot be opened/);
  await assert.rejects(cryptoHelpers.encryptSecret({}, 'user-one', 'factor-one', secret), /key is not configured/);
});
test('enrollment requires password and owned setup proof, stores encrypted secret and revokes all old sessions', async () => {
  const { h, token } = await fixture();
  try {
    const other = (await h.login()).token;
    assert.equal((await call(h, 'mfa/setup', token, { currentPassword: 'wrong' })).status, 400);
    const setup = await data(await call(h, 'mfa/setup', token, { currentPassword: 'LocalDemo2026!' }));
    const row = await h.db.prepare("SELECT * FROM auth_mfa_enrollments WHERE userId='user-member'").first();
    assert.ok(!JSON.stringify(row).includes(setup.secret));
    assert.ok(!JSON.stringify(row).includes(setup.setupToken));
    assert.deepEqual(await data(await call(h, 'mfa/status', token)), { enabled: false, backupCodesLeft: 0 });
    assert.equal(
      (await call(h, 'mfa/enable', other, { setupToken: setup.setupToken, code: otp(setup.secret, setup.nextStep) }))
        .status,
      400,
    );
    assert.equal((await call(h, 'mfa/enable', token, { setupToken: setup.setupToken, code: 'not-valid' })).status, 400);
    const enabled = await data(
      await call(h, 'mfa/enable', token, {
        setupToken: setup.setupToken,
        code: otp(setup.secret, Math.floor(Date.now() / 30000) - 1),
      }),
    );
    assert.equal(enabled.backupCodes.length, 10);
    assert.equal(enabled.sessionsRevoked, true);
    assert.equal((await call(h, 'mfa/status', token)).status, 401);
    const factor = await h.db.prepare("SELECT * FROM auth_mfa WHERE userId='user-member'").first();
    assert.ok(!JSON.stringify(factor).includes(setup.secret));
    const codes = (await h.db.prepare("SELECT * FROM auth_mfa_codes WHERE userId='user-member'").all()).results;
    assert.equal(codes.length, 10);
    for (const code of enabled.backupCodes) assert.ok(!JSON.stringify(codes).includes(code));
  } finally {
    await h.dispose();
  }
});
test('password only creates no session; MFA challenge and TOTP are each single-use under concurrency', async () => {
  const { h, token } = await fixture();
  try {
    const setup = await enroll(h, token),
      first = await challenge(h),
      second = await challenge(h);
    assert.equal(first.mfaRequired, true);
    assert.equal(first.user, undefined);
    assert.equal((await h.db.prepare("SELECT count(*) n FROM sessions WHERE userId='user-member'").first()).n, 0);
    const results = await Promise.all([
      verify(h, first.mfaToken, otp(setup.secret, setup.nextStep)),
      verify(h, second.mfaToken, otp(setup.secret, setup.nextStep)),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
    const success = await data(results.find((r) => r.status === 200));
    assert.equal(success.userChurches[0].role, 'member');
    assert.equal((await h.req('/member/v1/me', { token: success.userChurches[0].jwt })).status, 200);
    assert.equal((await verify(h, first.mfaToken, otp(setup.secret, setup.nextStep))).status, 400);
    assert.equal((await verify(h, (await challenge(h)).mfaToken, otp(setup.secret, setup.nextStep))).status, 400);
  } finally {
    await h.dispose();
  }
});
test('backup codes are one-use and login challenges expire, cap attempts and invalidate on password changes', async () => {
  const { h, token } = await fixture();
  try {
    const setup = await enroll(h, token);
    const first = await challenge(h);
    const signed = await data(await verify(h, first.mfaToken, setup.backupCodes[0]));
    assert.equal((await data(await call(h, 'mfa/status', signed.userChurches[0].jwt))).backupCodesLeft, 9);
    assert.equal((await verify(h, (await challenge(h)).mfaToken, setup.backupCodes[0])).status, 400);
    const bad = await challenge(h);
    for (let i = 0; i < 5; i++) assert.equal((await verify(h, bad.mfaToken, 'not-a-code')).status, 400);
    assert.equal((await verify(h, bad.mfaToken, setup.backupCodes[1])).status, 429);
    const expired = await challenge(h);
    await h.db
      .prepare("UPDATE auth_mfa_challenges SET expiresAt='2020-01-01T00:00:00.000Z' WHERE consumedAt IS NULL")
      .run();
    assert.equal((await verify(h, expired.mfaToken, setup.backupCodes[1])).status, 400);
    const stale = await challenge(h);
    await h.db.prepare("UPDATE users SET passwordVersion=passwordVersion+1 WHERE id='user-member'").run();
    assert.equal((await verify(h, stale.mfaToken, setup.backupCodes[1])).status, 400);
  } finally {
    await h.dispose();
  }
});
test('disable requires current password and an unused factor, then revokes sessions', async () => {
  const { h, token } = await fixture();
  try {
    const setup = await enroll(h, token);
    const signed = await data(await verify(h, (await challenge(h)).mfaToken, setup.backupCodes[0])),
      session = signed.userChurches[0].jwt;
    assert.equal(
      (await call(h, 'mfa/disable', session, { currentPassword: 'wrong', code: setup.backupCodes[1] })).status,
      400,
    );
    assert.equal(
      (await call(h, 'mfa/disable', session, { currentPassword: 'LocalDemo2026!', code: setup.backupCodes[0] })).status,
      400,
    );
    const disabled = await data(
      await call(h, 'mfa/disable', session, { currentPassword: 'LocalDemo2026!', code: setup.backupCodes[1] }),
    );
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.sessionsRevoked, true);
    assert.equal((await h.req('/member/v1/me', { token: session })).status, 401);
    assert.ok((await data(await login(h))).user);
  } finally {
    await h.dispose();
  }
});
test('backup rotation requires TOTP, replaces every old backup and revokes sessions', async () => {
  const { h, token } = await fixture();
  try {
    const setup = await enroll(h, token);
    const signed = await data(await verify(h, (await challenge(h)).mfaToken, setup.backupCodes[0])),
      session = signed.userChurches[0].jwt;
    assert.equal(
      (await call(h, 'mfa/backupCodes', session, { currentPassword: 'LocalDemo2026!', code: setup.backupCodes[1] }))
        .status,
      400,
    );
    const changed = await data(
      await call(h, 'mfa/backupCodes', session, {
        currentPassword: 'LocalDemo2026!',
        code: otp(setup.secret, setup.nextStep),
      }),
    );
    assert.equal(changed.backupCodes.length, 10);
    assert.equal((await verify(h, (await challenge(h)).mfaToken, setup.backupCodes[1])).status, 400);
    assert.equal((await verify(h, (await challenge(h)).mfaToken, changed.backupCodes[0])).status, 200);
  } finally {
    await h.dispose();
  }
});
test('factor failure limits apply across login challenges and sensitive settings', async () => {
  const { h, token } = await fixture();
  try {
    const setup = await enroll(h, token);
    const signed = await data(await verify(h, (await challenge(h)).mfaToken, setup.backupCodes[0])),
      session = signed.userChurches[0].jwt;
    for (let batch = 0; batch < 4; batch++) {
      const pending = await challenge(h);
      for (let attempt = 0; attempt < (batch === 3 ? 4 : 5); attempt++)
        assert.equal((await verify(h, pending.mfaToken, 'not-a-code')).status, 400);
    }
    assert.equal(
      (await call(h, 'mfa/disable', session, { currentPassword: 'LocalDemo2026!', code: setup.backupCodes[1] })).status,
      429,
    );
    assert.ok(await h.db.prepare("SELECT userId FROM auth_mfa WHERE userId='user-member'").first());
  } finally {
    await h.dispose();
  }
});
