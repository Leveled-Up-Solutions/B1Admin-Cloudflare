import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
let h, admin, viewer, member;
test.before(async () => {
  h = await createHarness();
  admin = (await h.login()).token;
  viewer = (await h.login('viewer@example.test')).token;
  member = (await h.login('member@example.test')).token;
});
test.after(async () => h?.dispose());
const save = (path, json, token = admin) => h.req(path, { method: 'POST', token, json });
async function fixture(prefix) {
  const [household] = await (await save('/membership/households', [{ name: prefix }])).json();
  const people = await (
    await save('/membership/people', [
      {
        name: { first: prefix + ' Parent', last: 'Fixture' },
        householdId: household.id,
        householdRole: 'Head',
      },
      {
        name: { first: prefix + ' Child', last: 'Fixture' },
        householdId: household.id,
        householdRole: 'Child',
      },
    ])
  ).json();
  return { household, people };
}
test('original household save changes roles, moves people, splits omissions and preserves other person fields', async () => {
  const a = await fixture('Original'),
    b = await fixture('Other');
  const response = await save('/membership/people/household/' + a.household.id, [
    {
      ...a.people[0],
      householdRole: 'Spouse',
      name: { first: 'Must not overwrite' },
    },
    { ...b.people[0], householdId: a.household.id, householdRole: 'Head' },
  ]);
  assert.equal(response.status, 200, await response.clone().text());
  const people = await response.json();
  assert.equal(people.length, 2);
  assert.equal(people.find((p) => p.id === a.people[0].id).name.first, 'Original Parent');
  assert.equal(people.find((p) => p.id === a.people[0].id).householdRole, 'Spouse');
  const removed = await (await h.req('/membership/people/' + a.people[1].id, { token: admin })).json();
  assert.notEqual(removed.householdId, a.household.id);
  assert.equal(removed.householdRole, 'Head');
  assert.equal(
    (
      await (
        await h.req('/membership/households/' + removed.householdId, {
          token: admin,
        })
      ).json()
    ).name,
    'Fixture',
  );
  const otherMember = await (await h.req('/membership/people/' + b.people[1].id, { token: admin })).json();
  assert.equal(otherMember.householdId, b.household.id);
  assert.ok(
    await h.db
      .prepare("SELECT id FROM audit_log WHERE action='households.members' AND entityId=?")
      .bind(a.household.id)
      .first(),
  );
});
test('empty household save separates each person and removes the unused source household', async () => {
  const { household, people } = await fixture('Split');
  const result = await save('/membership/people/household/' + household.id, []);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), []);
  const rows = await h.db
    .prepare('SELECT householdId,householdRole FROM people WHERE id IN (?,?)')
    .bind(...people.map((p) => p.id))
    .all();
  assert.equal(new Set(rows.results.map((p) => p.householdId)).size, 2);
  assert.ok(rows.results.every((p) => p.householdId !== household.id && p.householdRole === 'Head'));
  assert.equal((await h.req('/membership/households/' + household.id, { token: admin })).status, 404);
});
test('household writes reject duplicate, foreign and invalid members without partial effects', async () => {
  const { household, people } = await fixture('Atomic');
  const path = '/membership/people/household/' + household.id;
  for (const [input, status] of [
    [[people[0], people[0]], 400],
    [[people[0], { id: 'person-other' }], 404],
    [[{ ...people[0], householdId: 'foreign' }], 400],
    [[{ ...people[0], householdRole: 'Invalid' }], 400],
    [[{ ...people[0], churchId: 'church-other' }], 403],
  ]) {
    assert.equal((await save(path, input)).status, status);
    assert.equal((await (await h.req(path, { token: admin })).json()).length, 2);
  }
  assert.equal((await save(path, [], viewer)).status, 403);
  assert.equal((await save(path, [], member)).status, 403);
  assert.equal((await save('/membership/people/household/household-other', [])).status, 404);
});
test('deleting populated households fails and deleting unused households is audited', async () => {
  const { household } = await fixture('Delete');
  const path = '/membership/households/' + household.id;
  assert.equal((await h.req(path, { token: admin, method: 'DELETE' })).status, 409);
  const [empty] = await (await save('/membership/households', [{ name: 'Empty' }])).json();
  assert.equal(
    (
      await h.req('/membership/households/' + empty.id, {
        token: viewer,
        method: 'DELETE',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await h.req('/membership/households/' + empty.id, {
        token: admin,
        method: 'DELETE',
      })
    ).status,
    200,
  );
  assert.ok(
    await h.db
      .prepare("SELECT id FROM audit_log WHERE action='households.delete' AND entityId=?")
      .bind(empty.id)
      .first(),
  );
});
test('100-member household replacement stays within D1 parameter limits', async () => {
  const [household] = await (await save('/membership/households', [{ name: 'Large synthetic household' }])).json();
  const people = await (
    await save(
      '/membership/people',
      Array.from({ length: 100 }, (_, i) => ({
        name: { first: 'Bulk ' + i },
        householdId: household.id,
      })),
    )
  ).json();
  const response = await save(
    '/membership/people/household/' + household.id,
    people.map((p) => ({ id: p.id, householdRole: 'Other' })),
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).length, 100);
});
