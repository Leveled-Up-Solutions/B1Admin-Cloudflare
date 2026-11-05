import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHarness } from './harness.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
  stdin: {
    contents:
      "export {authenticate} from './src/auth.ts'; export {doing} from './src/doing.ts'; export {tasks} from './src/tasks.ts'; export {associatedGroups} from './src/associated-groups.ts'; export {authorizeStaffRoute} from './src/permissions.ts';",
    resolveDir: root,
    sourcefile: 'doing-race-entry.ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
});
const { authenticate, doing, tasks, associatedGroups, authorizeStaffRoute } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);
async function ok(r) {
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
async function fixture() {
  const h = await createHarness(),
    admin = (await h.login()).token,
    token = (await h.login('member@example.test')).token;
  const save = (path, json) => h.req(path, { token: admin, method: 'POST', json }).then(ok);
  const [other] = await save('/membership/groups', [{ name: 'Race other ministry', tags: 'ministry' }]);
  const [type] = await save('/doing/planTypes', [{ name: 'Race other type', ministryId: other.id }]);
  const [role] = await save('/membership/roles', [{ name: 'Scoped race staff' }]);
  await save('/membership/rolepermissions', [
    { roleId: role.id, apiName: 'DoingApi', contentType: 'Plans', contentId: 'group-sound', action: 'Edit' },
    { roleId: role.id, apiName: 'DoingApi', contentType: 'Tasks', contentId: 'group-sound-board', action: 'Edit' },
  ]);
  await save('/membership/rolemembers', [{ roleId: role.id, userId: 'user-member' }]);
  const env = { DB: h.db, SESSION_SECRET: 'test-only-secret-never-for-deployment-123456789' };
  async function race(path, method, json, compete) {
    const request = new Request('http://localhost/api' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const principal = await authenticate(request, env);
    let calls = 0;
    const db = {
      prepare: (...args) => h.db.prepare(...args),
      batch: async (stmts) => {
        calls++;
        await compete();
        return h.db.batch(stmts);
      },
    };
    const ctx = { request, url: new URL(request.url), path, principal, env: { ...env, DB: db } };
    authorizeStaffRoute(ctx);
    const handler = path.startsWith('/membership/')
      ? associatedGroups
      : path.startsWith('/doing/tasks')
        ? tasks
        : doing;
    await assert.rejects(handler(ctx), /CHECK constraint failed/);
    assert.equal(calls, 1);
    assert.equal((await h.db.prepare('SELECT count(*) n FROM write_guards').first()).n, 0);
  }
  return { h, role, other, type, save, race };
}
test('plan child bulk write aborts when parent ministry changes after preflight', async () => {
  const f = await fixture();
  try {
    const before = (await f.h.db.prepare('SELECT count(*) n FROM audit_log').first()).n;
    await f.race(
      '/doing/positions',
      'POST',
      [
        { planId: 'plan-demo', name: 'Must roll back' },
        { id: 'position-sound', description: 'Stale update' },
      ],
      () =>
        f.h.db
          .prepare('UPDATE doing_plans SET ministryId=?,planTypeId=? WHERE id=?')
          .bind(f.other.id, f.type.id, 'plan-demo')
          .run(),
    );
    assert.equal(await f.h.db.prepare("SELECT id FROM doing_positions WHERE name='Must roll back'").first(), null);
    assert.equal(
      (await f.h.db.prepare("SELECT description FROM doing_positions WHERE id='position-sound'").first()).description,
      'Operate the sound board',
    );
    assert.equal((await f.h.db.prepare('SELECT count(*) n FROM audit_log').first()).n, before);
  } finally {
    await f.h.dispose();
  }
});
test('copy cannot use stale authority when source ministry moves before transaction', async () => {
  const f = await fixture();
  try {
    await f.race(
      '/doing/plans/copy/plan-demo',
      'POST',
      { name: 'Forbidden stale copy', serviceDate: '2099-04-01' },
      () =>
        f.h.db
          .prepare('UPDATE doing_plans SET ministryId=?,planTypeId=? WHERE id=?')
          .bind(f.other.id, f.type.id, 'plan-demo')
          .run(),
    );
    assert.equal(await f.h.db.prepare("SELECT id FROM doing_plans WHERE name='Forbidden stale copy'").first(), null);
  } finally {
    await f.h.dispose();
  }
});
test('task assignment moving outside source scope prevents stale bulk overwrite', async () => {
  const f = await fixture();
  try {
    const [task] = await f.save('/doing/tasks', [
      { title: 'Original race task', assignedToType: 'group', assignedToId: 'group-sound-board' },
    ]);
    await f.race(
      '/doing/tasks',
      'POST',
      [
        { title: 'Rollback new task', assignedToType: 'group', assignedToId: 'group-sound-board' },
        { id: task.id, title: 'Stale overwrite' },
      ],
      () => f.h.db.prepare('UPDATE tasks SET assignedGroupId=? WHERE id=?').bind(f.other.id, task.id).run(),
    );
    assert.equal(await f.h.db.prepare("SELECT id FROM tasks WHERE title='Rollback new task'").first(), null);
    assert.equal(
      (await f.h.db.prepare('SELECT title FROM tasks WHERE id=?').bind(task.id).first()).title,
      'Original race task',
    );
  } finally {
    await f.h.dispose();
  }
});
test('association moving to another ministry after preflight cannot be edited or deleted', async () => {
  for (const method of ['POST', 'DELETE']) {
    const f = await fixture();
    try {
      const [row] = await f.save('/membership/associatedGroups', [
        { contentType: 'planType', contentId: 'plan-type-street', groupId: 'group-media', settings: 'both' },
      ]);
      await f.race(
        '/membership/associatedGroups' + (method === 'DELETE' ? '/' + row.id : ''),
        method,
        method === 'POST' ? [{ id: row.id, settings: 'past' }] : undefined,
        () => f.h.db.prepare('UPDATE associated_groups SET contentId=? WHERE id=?').bind(f.type.id, row.id).run(),
      );
      assert.deepEqual(
        await f.h.db.prepare('SELECT contentId,settings FROM associated_groups WHERE id=?').bind(row.id).first(),
        { contentId: f.type.id, settings: 'both' },
      );
    } finally {
      await f.h.dispose();
    }
  }
});
test('live authority rejects revocation, logout, expiry and removed actor during scoped save', async () => {
  for (const transition of ['revoke', 'logout', 'expire', 'removed']) {
    const f = await fixture();
    try {
      await f.race('/doing/plans', 'POST', [{ id: 'plan-demo', name: 'Forbidden stale name' }], () => {
        if (transition === 'revoke')
          return f.h.db.prepare('DELETE FROM role_permissions WHERE roleId=?').bind(f.role.id).run();
        if (transition === 'logout') return f.h.db.prepare("DELETE FROM sessions WHERE userId='user-member'").run();
        if (transition === 'expire')
          return f.h.db
            .prepare("UPDATE sessions SET expiresAt=? WHERE userId='user-member'")
            .bind(new Date(Date.now() - 1).toISOString())
            .run();
        return f.h.db.prepare("UPDATE people SET removed=1 WHERE id='person-alex'").run();
      });
      assert.equal(
        (await f.h.db.prepare("SELECT name FROM doing_plans WHERE id='plan-demo'").first()).name,
        'Sunday Street Church',
      );
    } finally {
      await f.h.dispose();
    }
  }
});
test('volunteer pool membership and ministry reclassification stay live until assignment commit', async () => {
  for (const transition of ['membership', 'ministry']) {
    const f = await fixture();
    try {
      await f.race(
        '/doing/assignments',
        'POST',
        [{ positionId: 'position-streaming', personId: 'person-jordan' }],
        () =>
          transition === 'membership'
            ? f.h.db.prepare("DELETE FROM group_members WHERE groupId='group-streaming'").run()
            : f.h.db.prepare("UPDATE groups SET categoryName=? WHERE id='group-streaming'").bind(f.other.id).run(),
      );
      assert.equal(
        await f.h.db.prepare("SELECT id FROM doing_assignments WHERE positionId='position-streaming'").first(),
        null,
      );
    } finally {
      await f.h.dispose();
    }
  }
});

test('copy pool checks reject group membership removed immediately before transaction', async () => {
  const f = await fixture();
  try {
    await f.race('/doing/plans/copy/plan-demo', 'POST', { name: 'Stale copied pool', serviceDate: '2099-04-01' }, () =>
      f.h.db.prepare("DELETE FROM group_members WHERE groupId='group-sound-board' AND personId='person-alex'").run(),
    );
    assert.equal(await f.h.db.prepare("SELECT id FROM doing_plans WHERE name='Stale copied pool'").first(), null);
  } finally {
    await f.h.dispose();
  }
});

test('cached copied positions cannot bypass pool validation after source references change', async () => {
  const f = await fixture();
  try {
    await f.race(
      '/doing/plans/copy/plan-demo',
      'POST',
      { name: 'Stale cached pool', serviceDate: '2099-04-01', copyMode: 'positions' },
      () =>
        f.h.db.batch([
          f.h.db.prepare("UPDATE doing_positions SET groupId='group-streaming' WHERE id='position-sound'"),
          f.h.db.prepare("UPDATE groups SET categoryName=? WHERE id='group-sound-board'").bind(f.other.id),
        ]),
    );
    assert.equal(await f.h.db.prepare("SELECT id FROM doing_plans WHERE name='Stale cached pool'").first(), null);
  } finally {
    await f.h.dispose();
  }
});
