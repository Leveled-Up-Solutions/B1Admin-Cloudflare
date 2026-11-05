import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
let h, admin, member, other, viewer;
test.before(async () => {
  h = await createHarness();
  admin = (await h.login()).token;
  member = (await h.login('member@example.test')).token;
  viewer = (await h.login('viewer@example.test')).token;
  other = (await h.login('other@example.test')).token;
});
test.after(async () => h?.dispose());
async function data(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
const post = (resource, json, token = admin) => h.req('/doing/' + resource, { method: 'POST', token, json });
const save = async (resource, json, token = admin) => data(await post(resource, json, token));
async function source(serviceDate, startTime, endTime) {
  const [plan] = await save('plans', [{ ministryId: 'group-sound', name: 'Time-zone fixture', serviceDate }]);
  await save('times', [{ planId: plan.id, displayName: 'Service', startTime, endTime }]);
  return plan;
}
async function copiedTime(plan, serviceDate, extra = {}) {
  const copied = await save('plans/copy/' + plan.id, {
    serviceDate,
    copyMode: 'positions',
    ...extra,
  });
  return (await data(await h.req('/doing/times/plan/' + copied.id, { token: admin })))[0];
}
test('plan copy preserves church-local hours, milliseconds and overnight day offsets across spring DST', async () => {
  await h.db.prepare("UPDATE churches SET timeZone='America/New_York' WHERE id='church-demo'").run();
  const plan = await source('2027-03-07', '2027-03-08T03:00:00.123Z', '2027-03-08T06:00:00.456Z');
  const time = await copiedTime(plan, '2027-03-14');
  assert.equal(time.startTime, '2027-03-15T02:00:00.123Z');
  assert.equal(time.endTime, '2027-03-15T05:00:00.456Z');
  assert.equal((await post('plans/copy/' + plan.id, { serviceDate: '2027-03-14' }, member)).status, 403);
  assert.equal((await post('plans/copy/' + plan.id, { serviceDate: '2027-03-14' }, other)).status, 404);
});
test('ambiguous repeated hours keep the source offset when available in either direction', async () => {
  const before = await source('2027-10-31', '2027-10-31T05:15:00Z', '2027-10-31T05:45:00Z');
  const early = await copiedTime(before, '2027-11-07');
  assert.equal(early.startTime, '2027-11-07T05:15:00.000Z');
  const after = await source('2027-11-14', '2027-11-14T06:15:00Z', '2027-11-14T06:45:00Z');
  const late = await copiedTime(after, '2027-11-07');
  assert.equal(late.startTime, '2027-11-07T06:15:00.000Z');
});
test('nonexistent DST hour and invalid zones leave target records and audit unchanged', async () => {
  const plan = await source('2027-03-07', '2027-03-07T07:15:00Z', '2027-03-07T07:45:00Z');
  const [target] = await save('plans', [
    {
      ministryId: 'group-sound',
      name: 'DST gap target',
      serviceDate: '2027-03-14',
    },
  ]);
  const before = await h.db.prepare('SELECT count(*) n FROM audit_log').first();
  assert.equal((await post('plans/copy/' + plan.id, { targetPlanId: target.id })).status, 409);
  assert.equal(
    (
      await post('plans/copy/' + plan.id, {
        serviceDate: '2027-03-14',
        timeZone: 'Not/AZone',
      })
    ).status,
    400,
  );
  assert.equal((await h.db.prepare('SELECT count(*) n FROM doing_times WHERE planId=?').bind(target.id).first()).n, 0);
  assert.equal((await h.db.prepare('SELECT count(*) n FROM audit_log').first()).n, before.n);
});
test('explicit copy zone supports half-hour DST changes and UTC remains an explicit option', async () => {
  const plan = await source('2027-03-28', '2027-03-27T22:00:00Z', '2027-03-27T23:00:00Z');
  const time = await copiedTime(plan, '2027-04-04', {
    timeZone: 'Australia/Lord_Howe',
  });
  assert.equal(time.startTime, '2027-04-03T22:30:00.000Z');
  const utc = await copiedTime(plan, '2027-04-04', { timeZone: 'UTC' });
  assert.equal(utc.startTime, '2027-04-03T22:00:00.000Z');
});
test('service times reject ambiguous timestamps and invalid dates without partial writes', async () => {
  const plan = await source('2027-03-07', '2027-03-07T10:00:00Z', '2027-03-07T11:00:00Z');
  for (const startTime of ['2027-03-07', '2027-03-07T10:00:00', '2027-02-30T10:00:00Z', '2027-03-07T24:00:00Z']) {
    assert.equal(
      (
        await post('times', [
          {
            planId: plan.id,
            displayName: 'Invalid',
            startTime,
            endTime: '2027-04-01T11:00:00Z',
          },
        ])
      ).status,
      400,
    );
  }
  assert.equal((await h.db.prepare('SELECT count(*) n FROM doing_times WHERE planId=?').bind(plan.id).first()).n, 1);
  assert.equal((await post('plans', [{ id: plan.id, serviceDate: '2027-01-01not-a-date' }])).status, 400);
});
test('published plan associations flow to descendant members, never siblings, drafts, or another tenant', async () => {
  for (const [id, parentId] of [
    ['tree-root', null],
    ['tree-middle', 'tree-root'],
    ['tree-leaf', 'tree-middle'],
    ['tree-sibling', 'tree-root'],
  ])
    await h.db
      .prepare('INSERT INTO groups(id,churchId,name,parentId) VALUES(?,?,?,?)')
      .bind(id, 'church-demo', id, parentId)
      .run();
  await h.db
    .prepare(
      "INSERT INTO group_members(id,churchId,groupId,personId) VALUES('tree-member','church-demo','tree-leaf','person-alex')",
    )
    .run();
  const [type] = await save('planTypes', [{ ministryId: 'group-sound', name: 'Ancestor plan type' }]);
  const [plan, draft, past] = await save('plans', [
    {
      ministryId: 'group-sound',
      planTypeId: type.id,
      name: 'Published',
      serviceDate: '2099-01-01',
    },
    {
      ministryId: 'group-sound',
      planTypeId: type.id,
      name: 'Prepared',
      serviceDate: '2099-01-01',
      prepared: true,
    },
    {
      ministryId: 'group-sound',
      planTypeId: type.id,
      name: 'Past',
      serviceDate: '2020-01-01',
    },
  ]);
  const [association] = await data(
    await h.req('/membership/associatedGroups', {
      method: 'POST',
      token: admin,
      json: [
        {
          contentType: 'planType',
          contentId: type.id,
          groupId: 'tree-root',
          settings: 'future',
        },
      ],
    }),
  );
  assert.equal((await h.req('/doing/plans/' + plan.id, { token: member })).status, 200);
  assert.equal((await h.req('/doing/plans/' + draft.id, { token: member })).status, 403);
  assert.equal((await h.req('/doing/plans/' + past.id, { token: member })).status, 403);
  assert.equal((await h.req('/doing/assignments/plan/' + plan.id, { token: member })).status, 403);
  assert.equal((await h.req('/doing/plans/' + plan.id, { token: other })).status, 404);
  await data(
    await h.req('/membership/associatedGroups', {
      method: 'POST',
      token: admin,
      json: [{ id: association.id, groupId: 'tree-sibling' }],
    }),
  );
  assert.equal((await h.req('/doing/plans/' + plan.id, { token: member })).status, 403);
  await data(
    await h.req('/membership/associatedGroups', {
      method: 'POST',
      token: admin,
      json: [{ id: association.id, groupId: 'tree-root' }],
    }),
  );
  await h.db.prepare("DELETE FROM group_members WHERE id='tree-member'").run();
  assert.equal((await h.req('/doing/plans/' + plan.id, { token: member })).status, 403);
});
test('group plan list inherits ancestor links but requires membership in the requested group', async () => {
  await h.db
    .prepare(
      "INSERT INTO group_members(id,churchId,groupId,personId) VALUES('tree-member','church-demo','tree-leaf','person-alex')",
    )
    .run();
  const list = await data(await h.req('/membership/groups/tree-leaf/plans', { token: member }));
  assert.deepEqual(
    list.map((p) => p.name),
    ['Published'],
  );
  assert.equal((await h.req('/membership/groups/tree-root/plans', { token: member })).status, 403);
  assert.equal((await h.req('/membership/groups/tree-sibling/plans', { token: member })).status, 403);
  assert.equal((await h.req('/membership/groups/tree-leaf/plans', { token: other })).status, 404);
});
test('sort normalizes both sibling lists and rolls back cycles and cross-plan attempts', async () => {
  const [plan] = await save('plans', [
    {
      ministryId: 'group-sound',
      name: 'Sortable order',
      serviceDate: '2099-01-01',
    },
  ]);
  const [section, otherSection] = await save('planItems', [
    { planId: plan.id, label: 'First section', sort: 1 },
    { planId: plan.id, label: 'Second section', sort: 2 },
  ]);
  const [a, b, c] = await save('planItems', [
    { planId: plan.id, parentId: section.id, label: 'A', sort: 1 },
    { planId: plan.id, parentId: section.id, label: 'B', sort: 4 },
    { planId: plan.id, parentId: otherSection.id, label: 'C', sort: 9 },
  ]);
  await save('planItems/sort', {
    id: b.id,
    parentId: otherSection.id,
    sort: 0.5,
  });
  const read = async () =>
    (
      await h.db
        .prepare('SELECT id,parentId,sort FROM doing_plan_items WHERE churchId=? AND planId=? ORDER BY sort,id')
        .bind('church-demo', plan.id)
        .all()
    ).results;
  const rows = await read();
  assert.equal(rows.find((r) => r.id === a.id).sort, 1);
  assert.equal(rows.find((r) => r.id === b.id).sort, 1);
  assert.equal(rows.find((r) => r.id === c.id).sort, 2);
  assert.equal((await post('planItems/sort', { id: otherSection.id, parentId: b.id })).status, 409);
  assert.equal((await post('planItems/sort', { id: b.id, planId: 'plan-demo' })).status, 400);
  assert.equal((await post('planItems/sort', { id: b.id, sort: 0 }, viewer)).status, 403);
  assert.equal((await post('planItems/sort', { id: b.id, sort: 0 }, other)).status, 404);
  assert.deepEqual(await read(), rows);
});
