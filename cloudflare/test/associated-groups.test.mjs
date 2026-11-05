import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
let h, admin, viewer, member, other;
test.before(async () => {
  h = await createHarness();
  admin = (await h.login()).token;
  viewer = (await h.login('viewer@example.test')).token;
  member = (await h.login('member@example.test')).token;
  other = (await h.login('other@example.test')).token;
});
test.after(async () => {
  await h?.dispose();
});
async function data(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
const post = (rows, token = admin) => h.req('/membership/associatedGroups', { method: 'POST', token, json: rows });
const item = { contentType: 'planType', contentId: 'plan-type-street', groupId: 'group-welcome', settings: 'both' };
test('original plan-type/group association CRUD persists wire fields and audits', async () => {
  const [row] = await data(await post([item]));
  assert.equal(row.churchId, 'church-demo');
  assert.equal(row.settings, 'both');
  let list = await data(
    await h.req('/membership/associatedGroups/content/planType/plan-type-street', { token: admin }),
  );
  assert.ok(list.some((x) => x.id === row.id));
  list = await data(
    await h.req('/membership/associatedGroups/group/group-welcome?contentType=planType', { token: viewer }),
  );
  assert.equal(list[0].id, row.id);
  const [updated] = await data(await post([{ id: row.id, settings: 'future' }]));
  assert.equal(updated.settings, 'future');
  assert.equal((await h.req('/membership/associatedGroups/' + row.id, { method: 'DELETE', token: admin })).status, 200);
  assert.equal(await h.db.prepare('SELECT id FROM associated_groups WHERE id=?').bind(row.id).first(), null);
  assert.equal((await h.db.prepare('SELECT count(*) n FROM audit_log WHERE entityId=?').bind(row.id).first()).n, 3);
});
test('association foreign keys, duplicate checks, and bulk validation isolate tenants', async () => {
  const [row] = await data(await post([item]));
  assert.equal((await post([item])).status, 409);
  assert.equal((await post([item], other)).status, 404);
  assert.equal((await post([{ id: row.id, settings: 'past' }], other)).status, 404);
  assert.equal((await post([{ ...item, groupId: 'group-other' }])).status, 404);
  assert.equal(
    (await h.req('/membership/associatedGroups/content/planType/plan-type-street', { token: other })).status,
    404,
  );
  assert.equal((await h.req('/membership/associatedGroups/group/group-welcome', { token: other })).status, 404);
  const before = (await h.db.prepare('SELECT count(*) n FROM associated_groups').first()).n;
  assert.equal(
    (
      await post([
        { ...item, groupId: 'group-streaming' },
        { ...item, groupId: 'group-media', settings: 'anything' },
      ])
    ).status,
    400,
  );
  assert.equal((await h.db.prepare('SELECT count(*) n FROM associated_groups').first()).n, before);
  assert.equal((await post([{ ...item, contentType: 'person' }])).status, 501);
  assert.equal(
    (await h.req('/membership/associatedGroups/group/group-welcome?contentType=person', { token: admin })).status,
    501,
  );
});
test('only Plans edit allows mutation and custom role grant revocation is immediate', async () => {
  assert.equal((await post([item], viewer)).status, 403);
  assert.equal((await post([item], member)).status, 403);
  const [role] = await data(
    await h.req('/membership/roles', { method: 'POST', token: admin, json: [{ name: 'Plan association editors' }] }),
  );
  const [permission] = await data(
    await h.req('/membership/rolepermissions', {
      method: 'POST',
      token: admin,
      json: [{ roleId: role.id, apiName: 'DoingApi', contentType: 'Plans', action: 'Edit' }],
    }),
  );
  await data(
    await h.req('/membership/rolemembers', {
      method: 'POST',
      token: admin,
      json: [{ roleId: role.id, userId: 'user-member' }],
    }),
  );
  const [row] = await data(await post([{ ...item, groupId: 'group-streaming' }], member));
  assert.equal(row.groupId, 'group-streaming');
  assert.equal(
    (await h.req('/membership/rolepermissions/' + permission.id, { method: 'DELETE', token: admin })).status,
    200,
  );
  assert.equal(
    (await h.req('/membership/associatedGroups/' + row.id, { method: 'DELETE', token: member })).status,
    403,
  );
});
test('malformed association bodies cannot mutate state', async () => {
  for (const invalid of [null, 42, {}, [], [null], [[]]]) assert.equal((await post(invalid)).status, 400);
  assert.equal((await post([{ ...item, settings: { past: true } }])).status, 400);
  assert.equal((await post([{ ...item, churchId: 'church-other' }])).status, 403);
});
test('plan-type associations grant direct group members only the selected published date range', async () => {
  const [type] = await data(
    await h.req('/doing/planTypes', {
      method: 'POST',
      token: admin,
      json: [{ ministryId: 'group-sound', name: 'Association visibility fixture' }],
    }),
  );
  const createPlan = async (name, serviceDate, prepared = false) =>
    (
      await data(
        await h.req('/doing/plans', {
          method: 'POST',
          token: admin,
          json: [{ ministryId: 'group-sound', planTypeId: type.id, name, serviceDate, prepared }],
        }),
      )
    )[0];
  const future = await createPlan('Future group plan', '2099-01-01');
  const past = await createPlan('Past group plan', '2020-01-01');
  const draft = await createPlan('Draft group plan', '2099-01-02', true);
  const get = (plan) => h.req('/doing/plans/' + plan.id, { token: member });
  assert.equal((await get(future)).status, 403);
  const [association] = await data(
    await post([{ contentType: 'planType', contentId: type.id, groupId: 'group-welcome', settings: 'future' }]),
  );
  assert.equal((await get(future)).status, 200);
  assert.equal((await get(past)).status, 403);
  assert.equal((await get(draft)).status, 403);
  await data(await post([{ id: association.id, settings: 'past' }]));
  assert.equal((await get(future)).status, 403);
  assert.equal((await get(past)).status, 200);
  await data(await post([{ id: association.id, settings: 'both' }]));
  assert.equal((await get(future)).status, 200);
  assert.equal((await get(past)).status, 200);
  assert.equal((await h.req('/doing/plans/' + future.id, { token: other })).status, 404);
  assert.equal(
    (await h.req('/membership/associatedGroups/' + association.id, { method: 'DELETE', token: admin })).status,
    200,
  );
  assert.equal((await get(future)).status, 403);
});
