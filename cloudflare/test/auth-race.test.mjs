import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHarness } from './harness.mjs';

// Execute the actual lifecycle handler against Miniflare D1 while inserting a
// deterministic competing write immediately before its final transaction. This
// models a request whose valid principal/preflight became stale without relying
// on scheduler timing or adding test hooks to the production Worker.
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
  stdin: {
    contents:
      "export { authenticate } from './src/auth.ts'; export { lifecycleRoutes } from './src/auth-lifecycle.ts';",
    resolveDir: root,
    sourcefile: 'auth-race-entry.ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
});
const { authenticate, lifecycleRoutes } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);
async function data(response) {
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function fixture() {
  const h = await createHarness();
  const token = (await h.login()).token;
  const [person] = await data(
    await h.req('/membership/people', {
      token,
      method: 'POST',
      json: [
        {
          name: { first: 'Invitation race fixture' },
          contactInfo: { email: 'invitation-race@example.test' },
        },
      ],
    }),
  );
  const request = new Request('http://localhost/api/membership/users/invitations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ personId: person.id }),
  });
  const env = {
    DB: h.db,
    SESSION_SECRET: 'test-only-secret-never-for-deployment-123456789',
  };
  const principal = await authenticate(request, env);
  async function staleIssue(competingWrite) {
    let batchCount = 0;
    const db = {
      prepare: (...args) => h.db.prepare(...args),
      batch: async (statements) => {
        if (++batchCount === 2) await competingWrite(); // first batch is throttling
        return h.db.batch(statements);
      },
    };
    await assert.rejects(
      lifecycleRoutes(request, { ...env, DB: db }, '/membership/users/invitations', async () => principal),
      (error) => error.status === 409,
    );
    assert.equal(batchCount, 2);
  }
  async function noOrphan() {
    assert.equal(await h.db.prepare('SELECT id FROM users WHERE email=?').bind(person.contactInfo.email).first(), null);
    assert.equal(
      (await h.db.prepare('SELECT count(*) n FROM auth_invitations WHERE personId=?').bind(person.id).first()).n,
      0,
    );
    assert.equal(
      (await h.db.prepare("SELECT count(*) n FROM audit_log WHERE action='security.invitation.created'").first()).n,
      0,
    );
  }
  return { h, token, person, principal, staleIssue, noOrphan };
}
test('logout between invitation preflight and write leaves no invitation, user or audit entry', async () => {
  const f = await fixture();
  try {
    await f.staleIssue(async () =>
      data(
        await f.h.req('/membership/users/logout', {
          token: f.token,
          method: 'POST',
          json: {},
        }),
      ),
    );
    await f.noOrphan();
  } finally {
    await f.h.dispose();
  }
});
test('password change during issuance invalidates the captured administrator session atomically', async () => {
  const f = await fixture();
  try {
    await f.staleIssue(async () =>
      data(
        await f.h.req('/membership/users/updatePassword', {
          token: f.token,
          method: 'POST',
          json: {
            currentPassword: 'LocalDemo2026!',
            newPassword: 'Synthetic changed password 2026!',
          },
        }),
      ),
    );
    await f.noOrphan();
    assert.equal((await f.h.req('/member/v1/me', { token: f.token })).status, 401);
  } finally {
    await f.h.dispose();
  }
});
test('administrator demotion during issuance cannot leave a token that revives after promotion', async () => {
  const f = await fixture();
  try {
    await f.h.db
      .prepare("UPDATE user_churches SET role='admin' WHERE userId='user-viewer' AND churchId='church-demo'")
      .run();
    await f.staleIssue(() =>
      f.h.db
        .prepare("UPDATE user_churches SET role='viewer' WHERE userId='user-admin' AND churchId='church-demo'")
        .run(),
    );
    await f.h.db
      .prepare("UPDATE user_churches SET role='admin' WHERE userId='user-admin' AND churchId='church-demo'")
      .run();
    await f.noOrphan();
  } finally {
    await f.h.dispose();
  }
});
test('reissue after session revocation does not revoke a previously valid invitation', async () => {
  const f = await fixture();
  try {
    const invite = await data(
      await f.h.req('/membership/users/invitations', {
        token: f.token,
        method: 'POST',
        json: { personId: f.person.id },
      }),
    );
    await f.staleIssue(() => f.h.db.prepare('DELETE FROM sessions WHERE id=?').bind(f.principal.sessionId).run());
    const rows = (
      await f.h.db.prepare('SELECT id,revokedAt FROM auth_invitations WHERE personId=?').bind(f.person.id).all()
    ).results;
    assert.deepEqual(rows, [{ id: invite.id, revokedAt: null }]);
    assert.equal(
      (await f.h.db.prepare("SELECT count(*) n FROM audit_log WHERE action='security.invitation.created'").first()).n,
      1,
    );
  } finally {
    await f.h.dispose();
  }
});
test('a target email change after preflight produces no pending account for the stale identity', async () => {
  const f = await fixture();
  try {
    await f.staleIssue(() =>
      f.h.db.prepare("UPDATE people SET email='replacement-race@example.test' WHERE id=?").bind(f.person.id).run(),
    );
    await f.noOrphan();
  } finally {
    await f.h.dispose();
  }
});
test('removing both active administrators in one batch rolls back the entire access change', async () => {
  const f = await fixture();
  try {
    await f.h.db
      .prepare("UPDATE user_churches SET role='admin' WHERE userId='user-viewer' AND churchId='church-demo'")
      .run();
    await assert.rejects(
      f.h.db.batch([
        f.h.db.prepare("UPDATE user_churches SET role='viewer' WHERE userId='user-admin' AND churchId='church-demo'"),
        f.h.db.prepare("DELETE FROM user_churches WHERE userId='user-viewer' AND churchId='church-demo'"),
      ]),
      /last_bootstrap_administrator/,
    );
    assert.equal(
      (
        await f.h.db
          .prepare("SELECT count(*) n FROM user_churches WHERE churchId='church-demo' AND role='admin'")
          .first()
      ).n,
      2,
    );
    await assert.rejects(
      f.h.db.prepare("UPDATE users SET disabled=1 WHERE id IN('user-admin','user-viewer')").run(),
      /last_bootstrap_administrator/,
    );
    assert.equal(
      (
        await f.h.db
          .prepare("SELECT count(*) n FROM users WHERE id IN('user-admin','user-viewer') AND disabled=0")
          .first()
      ).n,
      2,
    );
  } finally {
    await f.h.dispose();
  }
});
