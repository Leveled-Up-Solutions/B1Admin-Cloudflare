import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHarness } from './harness.mjs';

const bundle = await build({
  stdin: {
    contents: "export { authenticate } from './src/auth.ts'; export { roles } from './src/roles.ts';",
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
});
const { authenticate, roles } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);
async function data(response) {
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function fixture() {
  const h = await createHarness();
  const admin = (await h.login()).token,
    token = (await h.login('member@example.test')).token;
  const post = (path, json) => h.req('/membership/' + path, { token: admin, method: 'POST', json });
  const [manager, target] = await data(
    await post('roles', [{ name: 'Delegated role manager' }, { name: 'Delegatable people readers' }]),
  );
  const grants = await data(
    await post('rolepermissions', [
      ...['View', 'Edit'].map((action) => ({
        roleId: manager.id,
        apiName: 'MembershipApi',
        contentType: 'Roles',
        action,
      })),
      ...['View', 'View Names'].map((action) => ({
        roleId: manager.id,
        apiName: 'MembershipApi',
        contentType: 'People',
        action,
      })),
    ]),
  );
  const [targetGrant] = await data(
    await post('rolepermissions', [
      { roleId: target.id, apiName: 'MembershipApi', contentType: 'People', action: 'View' },
    ]),
  );
  await data(await post('rolemembers', [{ roleId: manager.id, userId: 'user-member' }]));
  const env = { DB: h.db, SESSION_SECRET: 'test-only-secret-never-for-deployment-123456789' };
  async function race(path, method, json, competingWrite, actorToken = token) {
    const request = new Request('http://localhost/api/membership/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + actorToken, 'Content-Type': 'application/json' },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const principal = await authenticate(request, env);
    let invoked = 0;
    const db = {
      prepare: (...args) => h.db.prepare(...args),
      batch: async (statements) => {
        invoked++;
        await competingWrite();
        return h.db.batch(statements);
      },
    };
    await assert.rejects(
      roles({ request, url: new URL(request.url), path: '/membership/' + path, principal, env: { ...env, DB: db } }),
      /CHECK constraint failed/,
    );
    assert.equal(invoked, 1);
    assert.equal((await h.db.prepare('SELECT count(*) n FROM write_guards').first()).n, 0);
  }
  return { h, admin, token, manager, target, targetGrant, grants, race };
}

test('role authority revoked after preflight cannot create a role or audit evidence', async () => {
  const f = await fixture();
  try {
    const before = (
      await f.h.db.prepare("SELECT count(*) n FROM audit_log WHERE action='permission.role.save'").first()
    ).n;
    await f.race('roles', 'POST', [{ id: 'stale-role', name: 'Stale role' }], () =>
      f.h.db
        .prepare("DELETE FROM role_permissions WHERE roleId=? AND contentType='Roles' AND action='Edit'")
        .bind(f.manager.id)
        .run(),
    );
    assert.equal(await f.h.db.prepare("SELECT id FROM roles WHERE id='stale-role'").first(), null);
    assert.equal(
      (await f.h.db.prepare("SELECT count(*) n FROM audit_log WHERE action='permission.role.save'").first()).n,
      before,
    );
  } finally {
    await f.h.dispose();
  }
});

test('a bulk role edit rolls back earlier inserts when a later target becomes the actor own role', async () => {
  const f = await fixture();
  try {
    await f.race(
      'roles',
      'POST',
      [
        { id: 'rollback-role', name: 'Earlier role' },
        { id: f.target.id, name: 'Cannot rename own role' },
      ],
      () =>
        f.h.db
          .prepare(
            "INSERT INTO role_members(id,churchId,roleId,userId,addedBy,dateAdded) VALUES('race-own','church-demo',?,'user-member','user-admin','2026-01-01')",
          )
          .bind(f.target.id)
          .run(),
    );
    assert.equal(await f.h.db.prepare("SELECT id FROM roles WHERE id='rollback-role'").first(), null);
    assert.equal(
      (await f.h.db.prepare('SELECT name FROM roles WHERE id=?').bind(f.target.id).first()).name,
      'Delegatable people readers',
    );
  } finally {
    await f.h.dispose();
  }
});

test('revoking a held grant after preflight prevents its delegation', async () => {
  const f = await fixture();
  try {
    await f.race(
      'rolepermissions',
      'POST',
      [
        {
          id: 'stale-grant',
          roleId: f.target.id,
          apiName: 'MembershipApi',
          contentType: 'People',
          action: 'View Names',
        },
      ],
      () =>
        f.h.db
          .prepare("DELETE FROM role_permissions WHERE roleId=? AND contentType='People' AND action='View Names'")
          .bind(f.manager.id)
          .run(),
    );
    assert.equal(await f.h.db.prepare("SELECT id FROM role_permissions WHERE id='stale-grant'").first(), null);
  } finally {
    await f.h.dispose();
  }
});

test('a role strengthened concurrently cannot be assigned by a weaker delegate', async () => {
  const f = await fixture();
  try {
    await f.race('rolemembers', 'POST', [{ id: 'stale-assignment', roleId: f.target.id, userId: 'user-viewer' }], () =>
      f.h.db
        .prepare(
          "INSERT INTO role_permissions(id,churchId,roleId,apiName,contentType,contentId,action) VALUES('race-stronger','church-demo',?,'MembershipApi','Settings','','Edit')",
        )
        .bind(f.target.id)
        .run(),
    );
    assert.equal(await f.h.db.prepare("SELECT id FROM role_members WHERE id='stale-assignment'").first(), null);
    assert.ok(await f.h.db.prepare("SELECT id FROM role_permissions WHERE id='race-stronger'").first());
  } finally {
    await f.h.dispose();
  }
});

test('a permission moved to another role after preflight cannot be deleted through its old role', async () => {
  const f = await fixture();
  try {
    await f.race('rolepermissions/' + f.targetGrant.id, 'DELETE', undefined, () =>
      f.h.db.batch([
        f.h.db
          .prepare("DELETE FROM role_permissions WHERE roleId=? AND contentType='People' AND action='View'")
          .bind(f.manager.id),
        f.h.db.prepare('UPDATE role_permissions SET roleId=? WHERE id=?').bind(f.manager.id, f.targetGrant.id),
      ]),
    );
    assert.equal(
      (await f.h.db.prepare('SELECT roleId FROM role_permissions WHERE id=?').bind(f.targetGrant.id).first()).roleId,
      f.manager.id,
    );
  } finally {
    await f.h.dispose();
  }
});

test('logout, expiry, person removal and account relinking during a queued role write are rejected', async () => {
  for (const transition of ['logout', 'expiry', 'person', 'link']) {
    const f = await fixture();
    try {
      await f.race('roles', 'POST', [{ id: 'revoked-session-role', name: 'No longer authorized' }], () => {
        if (transition === 'logout') return f.h.db.prepare("DELETE FROM sessions WHERE userId='user-member'").run();
        if (transition === 'expiry')
          return f.h.db
            .prepare("UPDATE sessions SET expiresAt='2000-01-01T00:00:00.000Z' WHERE userId='user-member'")
            .run();
        if (transition === 'link')
          return f.h.db
            .prepare(
              "UPDATE user_churches SET personId='person-family-demo' WHERE userId='user-member' AND churchId='church-demo'",
            )
            .run();
        return f.h.db.prepare("UPDATE people SET removed=1 WHERE id='person-alex'").run();
      });
      assert.equal(await f.h.db.prepare("SELECT id FROM roles WHERE id='revoked-session-role'").first(), null);
    } finally {
      await f.h.dispose();
    }
  }
});
