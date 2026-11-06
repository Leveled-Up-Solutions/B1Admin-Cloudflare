import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHarness } from './harness.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
  stdin: {
    contents:
      "export { authenticate } from './src/auth.ts'; export { membership } from './src/membership.ts'; export { authorizeStaffRoute } from './src/permissions.ts';",
    resolveDir: root,
    sourcefile: 'group-race-entry.ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
});
const { authenticate, membership, authorizeStaffRoute } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);
async function data(response) {
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function fixture() {
  const h = await createHarness(),
    admin = (await h.login()).token,
    token = (await h.login('member@example.test')).token;
  const post = (path, json) => h.req('/membership/' + path, { token: admin, method: 'POST', json });
  const [a, b] = await data(await post('groups', [{ name: 'Scoped race group' }, { name: 'Other race group' }]));
  const [role] = await data(await post('roles', [{ name: 'Scoped race editor' }]));
  const grants = await data(
    await post(
      'rolepermissions',
      ['Groups', 'Group Members'].map((contentType) => ({
        roleId: role.id,
        apiName: 'MembershipApi',
        contentType,
        contentId: a.id,
        action: 'Edit',
      })),
    ),
  );
  await data(await post('rolemembers', [{ roleId: role.id, userId: 'user-member' }]));
  const [record] = await data(await post('groupmembers', [{ groupId: a.id, personId: 'person-alex' }]));
  const env = {
    DB: h.db,
    SESSION_SECRET: 'test-only-secret-never-for-deployment-123456789',
  };
  async function race(path, method, json, competingWrite) {
    const request = new Request('http://localhost/api/membership/' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
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
    const ctx = {
      request,
      url: new URL(request.url),
      path: '/membership/' + path,
      principal,
      env: { ...env, DB: db },
    };
    authorizeStaffRoute(ctx);
    await assert.rejects(membership(ctx), /CHECK constraint failed/);
    assert.equal(invoked, 1);
    assert.equal((await h.db.prepare('SELECT count(*) n FROM write_guards').first()).n, 0);
  }
  return { h, a, b, role, grants, record, race };
}
test('scoped membership bulk save cannot overwrite a row moved outside its scope after preflight', async () => {
  const f = await fixture();
  try {
    const before = (await f.h.db.prepare("SELECT count(*) n FROM audit_log WHERE action='groupmembers.save'").first())
      .n;
    await f.race(
      'groupmembers',
      'POST',
      [
        { id: 'race-valid-first', groupId: f.a.id, personId: 'person-admin' },
        {
          id: f.record.id,
          groupId: f.a.id,
          personId: 'person-alex',
          leader: true,
        },
      ],
      () => f.h.db.prepare('UPDATE group_members SET groupId=? WHERE id=?').bind(f.b.id, f.record.id).run(),
    );
    assert.equal(await f.h.db.prepare("SELECT id FROM group_members WHERE id='race-valid-first'").first(), null);
    const saved = await f.h.db.prepare('SELECT groupId,leader FROM group_members WHERE id=?').bind(f.record.id).first();
    assert.deepEqual(saved, { groupId: f.b.id, leader: 0 });
    assert.equal(
      (await f.h.db.prepare("SELECT count(*) n FROM audit_log WHERE action='groupmembers.save'").first()).n,
      before,
    );
  } finally {
    await f.h.dispose();
  }
});
test('scoped membership deletion cannot delete a row moved outside its scope after preflight', async () => {
  const f = await fixture();
  try {
    await f.race('groupmembers/' + f.record.id, 'DELETE', undefined, () =>
      f.h.db.prepare('UPDATE group_members SET groupId=? WHERE id=?').bind(f.b.id, f.record.id).run(),
    );
    assert.equal(
      (await f.h.db.prepare('SELECT groupId FROM group_members WHERE id=?').bind(f.record.id).first()).groupId,
      f.b.id,
    );
  } finally {
    await f.h.dispose();
  }
});
test('scoped group edit cannot undo an administrator hierarchy change after preflight', async () => {
  const f = await fixture();
  try {
    await f.race('groups', 'POST', [{ id: f.a.id, name: 'Stale edit' }], () =>
      f.h.db.prepare('UPDATE groups SET parentId=? WHERE id=?').bind(f.b.id, f.a.id).run(),
    );
    assert.deepEqual(await f.h.db.prepare('SELECT name,parentId FROM groups WHERE id=?').bind(f.a.id).first(), {
      name: 'Scoped race group',
      parentId: f.b.id,
    });
  } finally {
    await f.h.dispose();
  }
});
test('scoped group deletion cannot detach a child added after preflight', async () => {
  const f = await fixture();
  try {
    await f.race('groups/' + f.a.id, 'DELETE', undefined, () =>
      f.h.db.prepare('UPDATE groups SET parentId=? WHERE id=?').bind(f.a.id, f.b.id).run(),
    );
    assert.ok(await f.h.db.prepare('SELECT id FROM groups WHERE id=?').bind(f.a.id).first());
  } finally {
    await f.h.dispose();
  }
});
test('scope revocation and logout between preflight and mutation prevent a stale write', async () => {
  for (const transition of ['revoke', 'logout']) {
    const f = await fixture();
    try {
      await f.race(
        'groupmembers',
        'POST',
        [
          {
            id: f.record.id,
            groupId: f.a.id,
            personId: 'person-alex',
            leader: true,
          },
        ],
        () =>
          transition === 'revoke'
            ? f.h.db.prepare('DELETE FROM role_permissions WHERE roleId=?').bind(f.role.id).run()
            : f.h.db.prepare("DELETE FROM sessions WHERE userId='user-member'").run(),
      );
      assert.equal(
        (await f.h.db.prepare('SELECT leader FROM group_members WHERE id=?').bind(f.record.id).first()).leader,
        0,
      );
    } finally {
      await f.h.dispose();
    }
  }
});
test('a session expiring after guard construction is rejected by the transaction clock', async () => {
  const f = await fixture();
  try {
    await f.race(
      'groupmembers',
      'POST',
      [{ id: f.record.id, groupId: f.a.id, personId: 'person-alex', leader: true }],
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        await f.h.db
          .prepare("UPDATE sessions SET expiresAt=? WHERE userId='user-member'")
          .bind(new Date(Date.now() - 1).toISOString())
          .run();
      },
    );
    assert.equal(
      (await f.h.db.prepare('SELECT leader FROM group_members WHERE id=?').bind(f.record.id).first()).leader,
      0,
    );
  } finally {
    await f.h.dispose();
  }
});
