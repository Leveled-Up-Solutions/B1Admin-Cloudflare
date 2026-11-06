import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
let h, admin, member;
test.before(async () => {
  h = await createHarness();
  admin = (await h.login()).token;
  member = (await h.login('member@example.test')).token;
});
test.after(async () => {
  await h?.dispose();
});
async function data(response) {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
const post = (path, json, token = admin) => h.req(path, { method: 'POST', token, json });
test('unrelated custom grant preserves own self-service while keeping other task and schedule details private', async () => {
  const [ownBlockout] = await data(
    await post('/doing/blockoutdates', [{ startDate: '2027-01-01', endDate: '2027-01-02' }], member),
  );
  const [privateTask, ownTask] = await data(
    await post('/doing/tasks', [
      {
        title: 'Staff-only task',
        assignedToType: 'person',
        assignedToId: 'person-admin',
      },
      {
        title: 'Personal task',
        assignedToType: 'person',
        assignedToId: 'person-alex',
      },
    ]),
  );
  const [groupTask] = await data(
    await post('/doing/tasks', [
      {
        title: 'Media team-only task',
        assignedToType: 'group',
        assignedToId: 'group-media',
      },
    ]),
  );
  assert.equal((await h.req('/doing/tasks/' + privateTask.id, { token: member })).status, 403);
  const [role] = await data(await post('/membership/roles', [{ name: 'Unrelated people editor' }]));
  await data(
    await post('/membership/rolepermissions', [
      {
        roleId: role.id,
        apiName: 'MembershipApi',
        contentType: 'People',
        action: 'Edit',
      },
    ]),
  );
  await data(await post('/membership/rolemembers', [{ roleId: role.id, userId: 'user-member' }]));
  assert.equal((await h.req('/doing/tasks/' + privateTask.id, { token: member })).status, 403);
  assert.equal((await h.req('/doing/tasks/' + groupTask.id, { token: member })).status, 403);
  assert.equal((await h.req('/doing/tasks/' + ownTask.id, { token: member })).status, 200);
  assert.deepEqual(
    await data(await post('/doing/tasks/loadForGroups', { groupIds: ['group-media'], status: 'Open' }, member)),
    [],
  );
  assert.equal((await h.req('/doing/plans/public/signup/church-demo', { token: member })).status, 200);
  assert.equal((await h.req('/doing/blockoutdates/' + ownBlockout.id, { token: member })).status, 200);
  assert.equal(
    (
      await h.req('/doing/blockoutdates/' + ownBlockout.id, {
        method: 'DELETE',
        token: member,
      })
    ).status,
    200,
  );
  const [preferences] = await data(await post('/doing/schedulingpreferences', [{ maxPerMonth: 2 }], member));
  assert.equal(
    (
      await h.req('/doing/schedulingpreferences/' + preferences.id, {
        token: member,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await h.req('/doing/schedulingpreferences/' + preferences.id, {
        method: 'DELETE',
        token: member,
      })
    ).status,
    200,
  );
});
test('self-service dispatch rejects wrong methods and extra action suffixes without mutating assignments', async () => {
  const before = await h.db.prepare("SELECT status FROM doing_assignments WHERE id='assignment-demo'").first();
  for (const [method, path, json] of [
    ['POST', '/doing/assignments/accept/assignment-demo/extra', {}],
    ['DELETE', '/doing/assignments/accept/assignment-demo', undefined],
    ['GET', '/doing/assignments/accept/assignment-demo', undefined],
    ['POST', '/doing/assignments/signup/extra', { positionId: 'position-media' }],
    ['POST', '/doing/planitems/sort', { id: 'plan-item-welcome', sort: 999 }],
    ['GET', '/doing/blockoutdates/people?ids=person-admin', undefined],
    ['GET', '/doing/schedulingpreferences/ids?ids=missing', undefined],
  ])
    assert.equal((await h.req(path, { method, token: member, json })).status, 403, path);
  const after = await h.db.prepare("SELECT status FROM doing_assignments WHERE id='assignment-demo'").first();
  assert.equal(after.status, before.status);
  assert.equal((await post('/doing/assignments/accept/assignment-demo', {}, member)).status, 200);
  assert.equal((await post('/doing/assignments/decline/assignment-demo', {}, member)).status, 200);
});
