import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
let h, admin, member, other;
test.before(async () => {
  h = await createHarness();
  admin = (await h.login()).token;
  member = (await h.login('member@example.test')).token;
  other = (await h.login('other@example.test')).token;
});
test.after(async () => h?.dispose());
test('manual My Work creates, assigns, closes and reopens original task wire shapes', async () => {
  const response = await h.req('/doing/tasks', {
    token: admin,
    method: 'POST',
    json: [
      {
        title: 'Set up sound board',
        assignedToType: 'person',
        assignedToId: 'person-admin',
        createdById: 'person-other',
        status: 'Open',
      },
    ],
  });
  assert.equal(response.status, 200);
  const [task] = await response.json();
  assert.equal(task.createdById, 'person-admin');
  assert.equal(task.assignedToLabel, 'Demo Administrator');
  assert.equal(task.status, 'Open');
  let r = await h.req('/doing/tasks', { token: admin, method: 'POST', json: [{ ...task, status: 'Closed' }] });
  assert.equal(r.status, 200);
  assert.ok((await r.json())[0].dateClosed);
  const closed = await (await h.req('/doing/tasks/closed', { token: admin })).json();
  assert.ok(closed.some((t) => t.id === task.id));
  r = await h.req('/doing/tasks', { token: admin, method: 'POST', json: [{ ...task, status: 'Open' }] });
  assert.equal(r.status, 200);
  assert.equal((await r.json())[0].dateClosed, null);
  const audit = await h.db.prepare('SELECT count(*) n FROM audit_log WHERE entityId=?').bind(task.id).first();
  assert.equal(audit.n, 3);
});
test('task relation tenant isolation and bulk validation preserve atomicity', async () => {
  let r = await h.req('/doing/tasks', {
    token: admin,
    method: 'POST',
    json: [
      { id: 'task-good', title: 'Good', assignedToType: 'person', assignedToId: 'person-admin' },
      { title: 'Wrong tenant', assignedToType: 'person', assignedToId: 'person-other' },
    ],
  });
  assert.equal(r.status, 400);
  assert.equal(await h.db.prepare('SELECT id FROM tasks WHERE id=?').bind('task-good').first(), null);
  r = await h.req('/doing/tasks', {
    token: admin,
    method: 'POST',
    json: [{ id: 'task-isolated', title: 'Scoped', assignedToType: 'person', assignedToId: 'person-admin' }],
  });
  assert.equal(r.status, 200);
  assert.equal((await h.req('/doing/tasks/task-isolated', { token: other })).status, 404);
  assert.equal((await h.req('/doing/tasks/task-isolated', { token: member })).status, 403);
});
test('member group tasks are scoped and cannot alter staff tasks', async () => {
  const r = await h.req('/doing/tasks', {
    token: admin,
    method: 'POST',
    json: [{ title: 'Welcome team setup', assignedToType: 'group', assignedToId: 'group-welcome' }],
  });
  assert.equal(r.status, 200);
  const mine = await (
    await h.req('/doing/tasks/loadForGroups', {
      token: member,
      method: 'POST',
      json: { groupIds: ['group-welcome'], status: 'Open' },
    })
  ).json();
  assert.ok(mine.some((t) => t.title === 'Welcome team setup'));
  assert.equal(
    (await h.req('/doing/tasks', { token: member, method: 'POST', json: [{ ...mine[0], status: 'Closed' }] })).status,
    403,
  );
  assert.equal(
    (
      await h.req('/doing/tasks', {
        token: admin,
        method: 'POST',
        json: [{ title: 'Workflow', workflowId: 'fake', assignedToType: 'person', assignedToId: 'person-admin' }],
      })
    ).status,
    400,
  );
});
