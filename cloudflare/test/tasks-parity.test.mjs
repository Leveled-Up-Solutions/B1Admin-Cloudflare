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
async function data(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
const post = (json, token = admin) => h.req('/doing/tasks', { method: 'POST', token, json });
test('associated person can read their manual task and timeline, never edit it or discover unrelated requested IDs', async () => {
  const [about, privateTask] = await data(
    await post([
      {
        title: 'Task about Alex',
        assignedToType: 'person',
        assignedToId: 'person-admin',
        associatedWithType: 'person',
        associatedWithId: 'person-alex',
      },
      {
        title: 'Private unrelated task',
        assignedToType: 'person',
        assignedToId: 'person-admin',
      },
    ]),
  );
  assert.equal((await h.req('/doing/tasks/' + about.id, { token: member })).status, 200);
  const timeline = await data(
    await h.req('/doing/tasks/timeline?taskIds=' + privateTask.id, {
      token: member,
    }),
  );
  assert.ok(timeline.some((row) => row.id === about.id && row.postType === 'task' && row.postId === about.id));
  assert.ok(!timeline.some((row) => row.id === privateTask.id));
  assert.equal((await post([{ id: about.id, status: 'Closed' }], member)).status, 403);
  assert.equal((await h.req('/doing/tasks/' + about.id, { token: other })).status, 404);
  assert.ok(
    !(
      await data(
        await h.req('/doing/tasks/timeline?taskIds=' + about.id, {
          token: other,
        }),
      )
    ).some((row) => row.id === about.id),
  );
  await data(await post([{ id: about.id, status: 'Closed' }]));
  assert.ok(!(await data(await h.req('/doing/tasks/timeline', { token: member }))).some((row) => row.id === about.id));
  assert.ok(
    (
      await data(
        await h.req('/doing/tasks/timeline?taskIds=' + about.id, {
          token: member,
        }),
      )
    ).some((row) => row.id === about.id),
  );
});
test('group query accepts 100 IDs without D1 binding overflow and loses access immediately on membership removal', async () => {
  await h.db
    .prepare("INSERT INTO groups(id,churchId,name) VALUES('task-group','church-demo','Task fixture group')")
    .run();
  await h.db
    .prepare(
      "INSERT INTO group_members(id,churchId,groupId,personId) VALUES('task-group-member','church-demo','task-group','person-alex')",
    )
    .run();
  const [row] = await data(
    await post([
      {
        title: 'Group work',
        assignedToType: 'group',
        assignedToId: 'task-group',
      },
    ]),
  );
  const query = () =>
    h.req('/doing/tasks/loadForGroups', {
      method: 'POST',
      token: member,
      json: {
        groupIds: ['task-group', ...Array.from({ length: 99 }, (_, i) => 'absent-' + i)],
        status: 'Open',
      },
    });
  assert.ok((await data(await query())).some((t) => t.id === row.id));
  assert.ok(
    (
      await data(
        await h.req('/doing/tasks/timeline?taskIds=' + row.id, {
          token: member,
        }),
      )
    ).some((t) => t.id === row.id),
  );
  await h.db.prepare("DELETE FROM group_members WHERE id='task-group-member'").run();
  assert.deepEqual(await data(await query()), []);
  assert.equal((await h.req('/doing/tasks/' + row.id, { token: member })).status, 403);
  assert.ok(
    !(
      await data(
        await h.req('/doing/tasks/timeline?taskIds=' + row.id, {
          token: member,
        }),
      )
    ).some((t) => t.id === row.id),
  );
});
test('duplicate IDs and malformed due dates reject full batches without changes or audit records', async () => {
  const [row] = await data(
    await post([
      {
        title: 'Stable task',
        assignedToType: 'person',
        assignedToId: 'person-admin',
        dueDate: '2027-02-28T12:30:00-05:00',
      },
    ]),
  );
  assert.equal(row.dueDate, '2027-02-28T17:30:00.000Z');
  const count = (await h.db.prepare('SELECT count(*) n FROM audit_log').first()).n;
  assert.equal(
    (
      await post([
        { id: row.id, title: 'First' },
        { id: row.id, title: 'Second' },
      ])
    ).status,
    400,
  );
  for (const dueDate of [
    '2027-02-30',
    '2027-02-30T10:00:00Z',
    '2027-02-28T12:00:00',
    '2027-02-28T24:00:00Z',
    true,
    0,
    {},
  ])
    assert.equal(
      (
        await post([
          { id: row.id, title: 'Changed' },
          {
            title: 'Invalid',
            assignedToType: 'person',
            assignedToId: 'person-admin',
            dueDate,
          },
        ])
      ).status,
      400,
    );
  assert.equal((await data(await h.req('/doing/tasks/' + row.id, { token: admin }))).title, 'Stable task');
  assert.equal((await h.db.prepare('SELECT count(*) n FROM audit_log').first()).n, count);
  const [cleared] = await data(await post([{ id: row.id, dueDate: null }]));
  assert.equal(cleared.dueDate, null);
});
test('unrelated custom role grants do not broaden task timelines or group queries', async () => {
  const [row] = await data(
    await post([
      {
        title: 'Restricted task',
        assignedToType: 'person',
        assignedToId: 'person-admin',
      },
    ]),
  );
  const [role] = await data(
    await h.req('/membership/roles', {
      method: 'POST',
      token: admin,
      json: [{ name: 'Task privacy regression' }],
    }),
  );
  await data(
    await h.req('/membership/rolepermissions', {
      method: 'POST',
      token: admin,
      json: [
        {
          roleId: role.id,
          apiName: 'MembershipApi',
          contentType: 'People',
          action: 'Edit',
        },
      ],
    }),
  );
  await data(
    await h.req('/membership/rolemembers', {
      method: 'POST',
      token: admin,
      json: [{ roleId: role.id, userId: 'user-member' }],
    }),
  );
  assert.equal((await h.req('/doing/tasks/' + row.id, { token: member })).status, 403);
  assert.ok(
    !(
      await data(
        await h.req('/doing/tasks/timeline?taskIds=' + row.id, {
          token: member,
        }),
      )
    ).some((t) => t.id === row.id),
  );
  assert.deepEqual(
    await data(
      await h.req('/doing/tasks/loadForGroups', {
        method: 'POST',
        token: member,
        json: { groupIds: ['task-group'], status: 'Open' },
      }),
    ),
    [],
  );
});
