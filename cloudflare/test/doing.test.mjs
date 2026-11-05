import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHarness, applySql } from './harness.mjs';
let h, admin, member, viewer, other;
test.before(async () => {
  h = await createHarness();
  await applySql(h.db, await readFile(new URL('../seed-doing.sql', import.meta.url), 'utf8'));
  admin = (await h.login()).token;
  member = (await h.login('member@example.test')).token;
  viewer = (await h.login('viewer@example.test')).token;
  other = (await h.login('other@example.test')).token;
});
test.after(async () => {
  await h?.dispose();
});
async function save(path, payload, token = admin) {
  const r = await h.req('/doing/' + path, {
    method: 'POST',
    token,
    json: payload,
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}

test('existing plan detail contracts preserve plans, positions, time, service-order tree and own assignments', async () => {
  const plans = await (await h.req('/doing/plans/types/plan-type-street', { token: admin })).json();
  assert.equal(plans[0].id, 'plan-demo');
  assert.equal(plans[0].prepared, false);
  const positions = await (await h.req('/doing/positions/plan/plan-demo', { token: admin })).json();
  assert.equal(positions.length, 3);
  assert.equal(positions.find((x) => x.id === 'position-sound').allowSelfSignup, true);
  const items = await (await h.req('/doing/planItems/plan/plan-demo', { token: admin })).json();
  assert.ok(Array.isArray(items[0].children));
  const mine = await (await h.req('/doing/assignments/my', { token: member })).json();
  assert.equal(mine[0].personId, 'person-alex');
  assert.equal(mine[0].positionId, 'position-sound');
  assert.equal((await h.req('/doing/plans/plan-demo', { token: member })).status, 200);
  assert.equal((await h.req('/doing/assignments/plan/plan-demo', { token: member })).status, 403);
  assert.equal((await h.req('/doing/plans/plan-demo', { token: other })).status, 404);
  assert.equal(
    (
      await h.req('/doing/plans', {
        method: 'POST',
        token: viewer,
        json: [{ name: 'No' }],
      })
    ).status,
    403,
  );
});

test('only assignment owner responds and prepared plans stay hidden', async () => {
  assert.equal(
    (
      await h.req('/doing/assignments/accept/assignment-demo', {
        method: 'POST',
        token: admin,
        json: {},
      })
    ).status,
    403,
  );
  const accepted = await save('assignments/accept/assignment-demo', {}, member);
  assert.equal(accepted.status, 'Accepted');
  await save('plans', [{ id: 'plan-demo', prepared: true }]);
  const mine = await (await h.req('/doing/assignments/my', { token: member })).json();
  assert.equal(mine.length, 0);
  assert.equal((await h.req('/doing/plans/plan-demo', { token: member })).status, 403);
  assert.equal(
    (
      await h.req('/doing/assignments/decline/assignment-demo', {
        method: 'POST',
        token: member,
        json: {},
      })
    ).status,
    409,
  );
  await save('plans', [{ id: 'plan-demo', prepared: false }]);
  const declined = await save('assignments/decline/assignment-demo', {}, member);
  assert.equal(declined.status, 'Declined');
});

test('plan copy remaps children and times atomically across month boundaries', async () => {
  const [source] = await save('plans', [
    {
      ministryId: 'group-sound',
      planTypeId: 'plan-type-street',
      name: 'Month end',
      serviceDate: '2027-01-31',
      prepared: true,
    },
  ]);
  const [position] = await save('positions', [
    {
      planId: source.id,
      name: 'Engineer',
      groupId: 'group-sound-board',
      count: 1,
    },
  ]);
  const [time] = await save('times', [
    {
      planId: source.id,
      displayName: 'Gathering',
      startTime: '2027-01-31T10:00:00Z',
      endTime: '2027-01-31T11:00:00Z',
    },
  ]);
  const [parent] = await save('planItems', [{ planId: source.id, label: 'Section', itemType: 'header', sort: 1 }]);
  const [child] = await save('planItems', [
    {
      planId: source.id,
      parentId: parent.id,
      positionId: position.id,
      label: 'Welcome',
      sort: 1,
      seconds: 60,
    },
  ]);
  await save('planItemTimes', [
    {
      planItemId: child.id,
      timeId: time.id,
      positionId: position.id,
      excluded: true,
    },
  ]);
  await save('assignments', [{ positionId: position.id, personId: 'person-alex', status: 'Accepted' }]);
  const target = await save('plans/copy/' + source.id, {
    ministryId: 'group-sound',
    planTypeId: 'plan-type-street',
    name: 'Next week',
    serviceDate: '2027-02-07',
    copyMode: 'all',
    copyServiceOrder: true,
  });
  const times = await (await h.req('/doing/times/plan/' + target.id, { token: admin })).json();
  assert.equal(times[0].startTime, '2027-02-07T10:00:00.000Z');
  const items = await (await h.req('/doing/planItems/plan/' + target.id, { token: admin })).json();
  assert.equal(items[0].children[0].parentId, items[0].id);
  assert.notEqual(items[0].id, parent.id);
  const assignments = await (await h.req('/doing/assignments/plan/' + target.id, { token: admin })).json();
  assert.equal(assignments[0].status, 'Unconfirmed');
  assert.notEqual(assignments[0].positionId, position.id);
  const exclusions = await (await h.req('/doing/planItemTimes/plan/' + target.id, { token: admin })).json();
  assert.equal(exclusions[0].timeId, times[0].id);
  assert.equal(exclusions[0].excluded, true);
  const cycle = await h.req('/doing/planItems', {
    method: 'POST',
    token: admin,
    json: [{ id: parent.id, parentId: child.id }],
  });
  assert.equal(cycle.status, 409);
});

test('invalid cross-tenant and cross-plan relationships roll back full request', async () => {
  const count = await h.db.prepare('SELECT COUNT(*) n FROM doing_positions').first();
  const r = await h.req('/doing/positions', {
    method: 'POST',
    token: admin,
    json: [
      { planId: 'plan-demo', name: 'Valid first' },
      {
        planId: 'plan-demo',
        name: 'Cross tenant',
        groupId: 'unknown-other-group',
      },
    ],
  });
  assert.equal(r.status, 409);
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM doing_positions').first()).n, count.n);
  assert.equal(
    (
      await h.req('/doing/assignments', {
        method: 'POST',
        token: admin,
        json: [{ positionId: 'position-sound', personId: 'person-other' }],
      })
    ).status,
    409,
  );
  const [plan] = await save('plans', [
    {
      ministryId: 'group-sound',
      name: 'Another plan',
      serviceDate: '2027-03-01',
    },
  ]);
  const [time] = await save('times', [
    {
      planId: plan.id,
      displayName: 'Other',
      startTime: '2027-03-01T10:00:00Z',
      endTime: '2027-03-01T11:00:00Z',
    },
  ]);
  assert.equal(
    (
      await h.req('/doing/planItemTimes', {
        method: 'POST',
        token: admin,
        json: [{ planItemId: 'plan-item-welcome', timeId: time.id }],
      })
    ).status,
    409,
  );
});

test('member blockouts and preferences cannot target another person', async () => {
  const [block] = await save('blockoutDates', [{ startDate: '2027-03-01', endDate: '2027-03-02' }], member);
  assert.equal(block.personId, 'person-alex');
  assert.equal(
    (
      await h.req('/doing/blockoutDates', {
        method: 'POST',
        token: member,
        json: [{ id: block.id, personId: 'person-admin' }],
      })
    ).status,
    403,
  );
  assert.equal((await h.req('/doing/blockoutDates/upcoming', { token: member })).status, 403);
  const [pref] = await save('schedulingPreferences', [{ maxPerMonth: 2, householdScheduling: 'together' }], member);
  assert.equal(pref.personId, 'person-alex');
  assert.equal((await h.req('/doing/schedulingPreferences/' + pref.id, { token: other })).status, 404);
  assert.equal(
    (
      await h.req('/doing/blockoutDates/' + block.id, {
        method: 'DELETE',
        token: member,
      })
    ).status,
    200,
  );
});

test('self-signup capacity is enforced atomically across simultaneous requests', async () => {
  const [plan] = await save('plans', [
    {
      ministryId: 'group-sound',
      name: 'Open signup',
      serviceDate: '2099-01-04',
      prepared: false,
    },
  ]);
  const [position] = await save('positions', [{ planId: plan.id, name: 'Welcome', allowSelfSignup: true, count: 1 }]);
  const attempts = await Promise.all(
    [member, admin].map((token) =>
      h.req('/doing/assignments/signup', {
        method: 'POST',
        token,
        json: { positionId: position.id },
      }),
    ),
  );
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
  const assigned = await h.db.prepare('SELECT * FROM doing_assignments WHERE positionId=?').bind(position.id).all();
  assert.equal(assigned.results.length, 1);
  const signup = await (await h.req('/doing/plans/public/signup/church-demo', { token: member })).json();
  const visible = signup.find((r) => r.plan.id === plan.id);
  assert.equal(visible.positions[0].filledCount, 1);
  assert.equal('personId' in visible.positions[0], false);
});

test('provider workflows and outbound notification routes remain explicit', async () => {
  for (const path of [
    '/plans/autofill/plan-demo',
    '/plans/plan-demo/issueRequests',
    '/plans/notifyRange',
    '/providerProxy/browse',
  ])
    assert.equal((await h.req('/doing' + path, { method: 'POST', token: admin, json: {} })).status, 501);
});

test('100-ID compatibility reads fit D1 binding limits and invalid civil dates fail', async () => {
  const ids = Array.from({ length: 100 }, (_, i) => (i === 0 ? 'plan-demo' : 'absent-' + i));
  const response = await h.req('/doing/plans/ids?ids=' + ids.join(','), {
    token: admin,
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).length, 1);
  const positions = await h.req('/doing/positions/plan/ids?planIds=' + ids.join(','), { token: admin });
  assert.equal(positions.status, 200);
  assert.equal((await positions.json()).length, 3);
  assert.equal(
    (
      await h.req('/doing/times', {
        method: 'POST',
        token: admin,
        json: [
          {
            planId: 'plan-demo',
            displayName: 'Invalid',
            startTime: '2027-02-31T10:00:00Z',
            endTime: '2027-03-04T10:00:00Z',
          },
        ],
      })
    ).status,
    400,
  );
});

test('removed people cannot self-signup even with an existing session', async () => {
  const [plan] = await save('plans', [
    {
      ministryId: 'group-sound',
      name: 'Removed-person check',
      serviceDate: '2099-02-01',
      prepared: false,
    },
  ]);
  const [position] = await save('positions', [
    { planId: plan.id, name: 'Restricted', allowSelfSignup: true, count: 1 },
  ]);
  await h.db.prepare("UPDATE people SET removed=1 WHERE id='person-alex'").run();
  try {
    assert.equal(
      (
        await h.req('/doing/assignments/signup', {
          method: 'POST',
          token: member,
          json: { positionId: position.id },
        })
      ).status,
      409,
    );
  } finally {
    await h.db.prepare("UPDATE people SET removed=0 WHERE id='person-alex'").run();
  }
});

test('unrelated custom staff grant never broadens private blockouts or scheduling preferences', async () => {
  const [block] = await save('blockoutDates', [
    {
      personId: 'person-admin',
      startDate: '2028-01-01',
      endDate: '2028-01-02',
    },
  ]);
  await save('schedulingPreferences', [{ personId: 'person-admin', maxPerMonth: 4 }]);
  await h.db.batch([
    h.db.prepare("INSERT INTO roles(id,churchId,name) VALUES('doing-review-role','church-demo','People editor only')"),
    h.db.prepare(
      "INSERT INTO role_permissions(id,churchId,roleId,apiName,contentType,contentId,action) VALUES('doing-review-grant','church-demo','doing-review-role','MembershipApi','People','','Edit')",
    ),
    h.db.prepare(
      "INSERT INTO role_members(id,churchId,roleId,userId,addedBy,dateAdded) VALUES('doing-review-member','church-demo','doing-review-role','user-member','user-admin','2026-11-05')",
    ),
  ]);
  try {
    const blocks = await h.req('/doing/blockoutDates', { token: member });
    assert.equal(blocks.status, 200, await blocks.clone().text());
    assert.ok((await blocks.json()).every((r) => r.personId === 'person-alex'));
    const prefs = await h.req('/doing/schedulingPreferences', {
      token: member,
    });
    assert.equal(prefs.status, 200, await prefs.clone().text());
    const payload = await prefs.json();
    assert.ok(!payload || payload.personId === 'person-alex');
    assert.equal((await h.req('/doing/blockoutDates/' + block.id, { token: member })).status, 403);
    assert.equal(
      (
        await h.req('/doing/blockoutDates', {
          method: 'POST',
          token: member,
          json: [{ id: block.id, endDate: '2028-02-01' }],
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await h.req('/doing/blockoutDates/' + block.id, {
          method: 'DELETE',
          token: member,
        })
      ).status,
      403,
    );
  } finally {
    await h.db.prepare("DELETE FROM roles WHERE id='doing-review-role'").run();
  }
});

test('unimplemented action/resource combinations return deliberate errors rather than SQL failures', async () => {
  for (const path of ['/plans/plan/plan-demo', '/planTypes/plan/plan-demo', '/schedulingPreferences/upcoming']) {
    const response = await h.req('/doing' + path, { token: admin });
    assert.ok([404, 501].includes(response.status), `${path}: ${response.status} ${await response.text()}`);
  }
});
