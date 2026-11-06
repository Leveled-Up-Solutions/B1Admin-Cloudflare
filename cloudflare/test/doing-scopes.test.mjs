import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
async function ok(response) {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function fixture(action = 'Edit') {
  const h = await createHarness();
  const admin = (await h.login()).token;
  const token = (await h.login('member@example.test')).token;
  const save = (path, json, auth = admin) => h.req(path, { token: auth, method: 'POST', json }).then(ok);
  const [otherMinistry] = await save('/membership/groups', [{ name: 'Other Ministry', tags: 'ministry' }]);
  const [otherTeam] = await save('/membership/groups', [
    { name: 'Other Team', tags: 'team', categoryName: otherMinistry.id },
  ]);
  const [otherType] = await save('/doing/planTypes', [{ name: 'Other Type', ministryId: otherMinistry.id }]);
  const [otherPlan] = await save('/doing/plans', [
    {
      name: 'Other Draft',
      ministryId: otherMinistry.id,
      planTypeId: otherType.id,
      serviceDate: '2099-03-01',
      prepared: true,
    },
  ]);
  const [otherPosition] = await save('/doing/positions', [
    { name: 'Other Position', planId: otherPlan.id, groupId: otherTeam.id },
  ]);
  const [role] = await save('/membership/roles', [{ name: 'Scoped Doing Staff' }]);
  const grants = await save('/membership/rolepermissions', [
    { roleId: role.id, apiName: 'DoingApi', contentType: 'Plans', contentId: 'group-sound', action },
    { roleId: role.id, apiName: 'DoingApi', contentType: 'Tasks', contentId: 'group-sound-board', action },
  ]);
  await save('/membership/rolemembers', [{ roleId: role.id, userId: 'user-member' }]);
  const req = (path, auth = token) => h.req(path, { token: auth });
  return { h, admin, token, save, req, otherMinistry, otherTeam, otherType, otherPlan, otherPosition, role, grants };
}
test('Plans ministry scopes filter roots, ids, types, child rows and metadata without directory access', async () => {
  const f = await fixture();
  try {
    for (const path of ['/doing/plans', '/doing/plans/ids?ids=plan-demo,' + f.otherPlan.id]) {
      const rows = await ok(await f.req(path));
      assert.deepEqual(
        rows.map((r) => r.id),
        ['plan-demo'],
      );
    }
    assert.deepEqual(
      (await ok(await f.req('/doing/planTypes'))).map((r) => r.id),
      ['plan-type-street'],
    );
    for (const path of [
      '/doing/plans/' + f.otherPlan.id,
      '/doing/planTypes/' + f.otherType.id,
      '/doing/positions/' + f.otherPosition.id,
      '/doing/positions/plan/' + f.otherPlan.id,
      '/doing/plans/types/' + f.otherType.id,
    ])
      assert.equal((await f.req(path)).status, 403, path);
    assert.equal((await f.req('/doing/plans/plan-demo')).status, 200);
    assert.deepEqual(await ok(await f.req('/doing/ministryScopes')), [
      { id: 'group-sound', name: 'Sound Ministry', canEdit: true },
    ]);
    assert.deepEqual(await ok(await f.req('/doing/taskGroupScopes')), [
      { id: 'group-sound-board', name: 'Sound Board Team', canEdit: true },
    ]);
    assert.equal((await f.req('/membership/people')).status, 403);
    assert.equal((await f.req('/membership/groups/tag/team')).status, 403);
    assert.equal(
      (await f.req('/doing/plans/' + f.otherPlan.id, (await f.h.login('other@example.test')).token)).status,
      404,
    );
  } finally {
    await f.h.dispose();
  }
});
test('Plans View can read one ministry but cannot mutate even its own scope', async () => {
  const f = await fixture('View');
  try {
    assert.equal((await f.req('/doing/assignments/plan/plan-demo')).status, 200);
    assert.equal(
      (await f.h.req('/doing/plans', { token: f.token, method: 'POST', json: [{ id: 'plan-demo', name: 'No' }] }))
        .status,
      403,
    );
    assert.equal(
      (await f.h.req('/doing/positions/position-streaming', { token: f.token, method: 'DELETE' })).status,
      403,
    );
    assert.equal((await ok(await f.req('/doing/ministryScopes')))[0].canEdit, false);
  } finally {
    await f.h.dispose();
  }
});
test('Scoped Plans moves, copies and mixed batches require both source and destination ministries', async () => {
  const f = await fixture();
  try {
    const before = await f.h.db.prepare('SELECT COUNT(*) n FROM doing_plans').first();
    assert.equal(
      (
        await f.h.req('/doing/plans', {
          token: f.token,
          method: 'POST',
          json: [
            { id: 'plan-demo', name: 'Should rollback' },
            { id: f.otherPlan.id, name: 'Forbidden' },
          ],
        })
      ).status,
      403,
    );
    assert.equal((await ok(await f.req('/doing/plans/plan-demo'))).name, 'Sunday Street Church');
    assert.equal(
      (
        await f.h.req('/doing/positions', {
          token: f.token,
          method: 'POST',
          json: [{ id: 'position-sound', planId: f.otherPlan.id }],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.h.req('/doing/plans/copy/plan-demo', {
          token: f.token,
          method: 'POST',
          json: {
            ministryId: f.otherMinistry.id,
            planTypeId: f.otherType.id,
            name: 'Forbidden copy',
            serviceDate: '2099-04-01',
          },
        })
      ).status,
      403,
    );
    assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM doing_plans').first()).n, before.n);
    const copy = await f.save(
      '/doing/plans/copy/plan-demo',
      { name: 'Scoped copy', serviceDate: '2099-04-01', copyMode: 'none' },
      f.token,
    );
    assert.equal(copy.ministryId, 'group-sound');
    assert.equal(copy.planTypeId, 'plan-type-street');
    await f.save('/membership/rolepermissions', [
      { roleId: f.role.id, apiName: 'DoingApi', contentType: 'Plans', contentId: f.otherMinistry.id, action: 'Edit' },
    ]);
    const moved = await f.save(
      '/doing/plans',
      [{ id: copy.id, ministryId: f.otherMinistry.id, planTypeId: f.otherType.id }],
      f.token,
    );
    assert.equal(moved[0].ministryId, f.otherMinistry.id);
    assert.equal(
      (
        await f.h.req('/doing/planTypes', {
          token: f.admin,
          method: 'POST',
          json: [{ id: 'plan-type-street', ministryId: f.otherMinistry.id }],
        })
      ).status,
      409,
    );
    assert.equal((await f.h.db.prepare('SELECT count(*) n FROM write_guards').first()).n, 0);
  } finally {
    await f.h.dispose();
  }
});
test('Scoped Plans preserve private availability and narrow team/person selectors', async () => {
  const f = await fixture();
  try {
    const [block] = await f.save('/doing/blockoutDates', [
      { personId: 'person-admin', startDate: '2099-01-01', endDate: '2099-01-02' },
    ]);
    const [pref] = await f.save('/doing/schedulingPreferences', [{ personId: 'person-admin', maxPerMonth: 9 }]);
    for (const path of [
      '/doing/blockoutDates/upcoming',
      '/doing/blockoutDates/' + block.id,
      '/doing/schedulingPreferences/' + pref.id,
    ])
      assert.equal((await f.req(path)).status, 403, path);
    assert.deepEqual(await ok(await f.req('/doing/blockoutDates')), []);
    await f.save('/doing/blockoutDates', [{ startDate: '2099-02-01', endDate: '2099-02-02' }], f.token);
    const teams = await ok(await f.req('/doing/planTeams/plan-demo'));
    assert.equal(teams.length, 3);
    assert.ok(teams.every((r) => Object.keys(r).sort().join(',') === 'categoryName,id,memberCount,name'));
    const people = await ok(await f.req('/doing/planPeople/plan-demo'));
    assert.ok(people.length >= 2);
    assert.ok(people.every((r) => Object.keys(r).sort().join(',') === 'id,name'));
    const members = await ok(await f.req('/doing/positionMembers/position-sound'));
    assert.deepEqual(members.map((r) => r.personId).sort(), ['person-admin', 'person-alex'].sort());
    for (const path of [
      '/doing/planTeams/' + f.otherPlan.id,
      '/doing/planPeople/' + f.otherPlan.id,
      '/doing/positionMembers/' + f.otherPosition.id,
      '/doing/ministryTeams/' + f.otherMinistry.id,
    ])
      assert.equal((await f.req(path)).status, 403, path);
    assert.equal(
      (
        await f.h.req('/doing/positions', {
          token: f.token,
          method: 'POST',
          json: [{ id: 'position-streaming', groupId: f.otherTeam.id }],
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.h.req('/doing/assignments', {
          token: f.token,
          method: 'POST',
          json: [{ positionId: 'position-streaming', personId: 'person-admin' }],
        })
      ).status,
      403,
    );
    const [assignment] = await f.save(
      '/doing/assignments',
      [{ positionId: 'position-streaming', personId: 'person-jordan' }],
      f.token,
    );
    assert.equal(assignment.personId, 'person-jordan');
    await f.save('/doing/assignments', [{ positionId: 'position-streaming', personId: 'person-admin' }]); // global manual override
  } finally {
    await f.h.dispose();
  }
});
test('Tasks scopes expose assigned-group work and require old plus new edit scope', async () => {
  const f = await fixture();
  try {
    const [a, b, p] = await f.save('/doing/tasks', [
      { title: 'Scoped group task', assignedToType: 'group', assignedToId: 'group-sound-board' },
      { title: 'Other group task', assignedToType: 'group', assignedToId: f.otherTeam.id },
      { title: 'Person task', assignedToType: 'person', assignedToId: 'person-admin' },
    ]);
    const ids = (await ok(await f.req('/doing/tasks'))).map((r) => r.id);
    assert.ok(ids.includes(a.id));
    assert.ok(!ids.includes(b.id));
    assert.equal((await f.req('/doing/tasks/' + a.id)).status, 200);
    assert.equal((await f.req('/doing/tasks/' + b.id)).status, 403);
    const timeline = await ok(await f.req('/doing/tasks/timeline?taskIds=' + [a.id, b.id, p.id].join(',')));
    assert.ok(timeline.some((r) => r.id === a.id));
    assert.ok(!timeline.some((r) => r.id === b.id || r.id === p.id));
    await f.save('/doing/tasks', [{ id: a.id, status: 'Closed' }], f.token);
    assert.ok((await ok(await f.req('/doing/tasks/closed'))).some((r) => r.id === a.id));
    for (const changes of [
      { id: a.id, assignedToType: 'group', assignedToId: f.otherTeam.id },
      { id: b.id, assignedToType: 'group', assignedToId: 'group-sound-board' },
      { title: 'No person create', assignedToType: 'person', assignedToId: 'person-alex' },
    ])
      assert.equal((await f.h.req('/doing/tasks', { token: f.token, method: 'POST', json: [changes] })).status, 403);
    assert.equal(
      (
        await f.h.req('/doing/tasks', {
          token: f.token,
          method: 'POST',
          json: [
            { id: a.id, title: 'Rollback' },
            { id: b.id, title: 'Forbidden' },
          ],
        })
      ).status,
      403,
    );
    assert.equal((await ok(await f.req('/doing/tasks/' + a.id))).title, 'Scoped group task');
    await f.save('/membership/rolepermissions', [
      { roleId: f.role.id, apiName: 'DoingApi', contentType: 'Tasks', contentId: f.otherTeam.id, action: 'Edit' },
    ]);
    await f.save('/doing/tasks', [{ id: a.id, assignedToId: f.otherTeam.id }], f.token);
    assert.equal((await ok(await f.req('/doing/tasks/' + a.id))).assignedToId, f.otherTeam.id);
  } finally {
    await f.h.dispose();
  }
});
test('Association scope follows its plan type ministry on list, save and delete', async () => {
  const f = await fixture();
  try {
    const [a, b] = await f.save('/membership/associatedGroups', [
      { contentType: 'planType', contentId: 'plan-type-street', groupId: 'group-media', settings: 'both' },
      { contentType: 'planType', contentId: f.otherType.id, groupId: 'group-media', settings: 'both' },
    ]);
    assert.deepEqual(
      (await ok(await f.req('/membership/associatedGroups/group/group-media'))).map((r) => r.id),
      [a.id],
    );
    assert.equal((await f.req('/membership/associatedGroups/content/planType/' + f.otherType.id)).status, 403);
    assert.equal(
      (
        await f.h.req('/membership/associatedGroups', {
          token: f.token,
          method: 'POST',
          json: [{ id: a.id, contentId: f.otherType.id }],
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.h.req('/membership/associatedGroups/' + b.id, { token: f.token, method: 'DELETE' })).status,
      403,
    );
    await f.save('/membership/associatedGroups', [{ id: a.id, settings: 'future' }], f.token);
    assert.deepEqual(
      (await ok(await f.req('/membership/groups/group-media/plans'))).map((r) => r.id),
      ['plan-demo'],
    );
  } finally {
    await f.h.dispose();
  }
});
test('Deleting group scopes and removing ministry tags revoke grants rather than revive stale authority', async () => {
  const f = await fixture();
  try {
    await f.save('/membership/groups', [{ id: 'group-sound', tags: 'team' }]);
    assert.equal((await f.req('/doing/planTypes')).status, 403);
    await f.save('/membership/groups', [{ id: 'group-sound', tags: 'ministry' }]);
    assert.equal((await f.req('/doing/planTypes')).status, 403);
    const [group] = await f.save('/membership/groups', [{ name: 'Temporary task scope' }]);
    const [grant] = await f.save('/membership/rolepermissions', [
      { roleId: f.role.id, apiName: 'DoingApi', contentType: 'Tasks', contentId: group.id, action: 'Edit' },
    ]);
    assert.equal((await f.h.req('/membership/groups/' + group.id, { token: f.admin, method: 'DELETE' })).status, 200);
    assert.equal(await f.h.db.prepare('SELECT id FROM role_permissions WHERE id=?').bind(grant.id).first(), null);
  } finally {
    await f.h.dispose();
  }
});

test('scoped copies and ministry moves cannot bypass the destination volunteer pool', async () => {
  const f = await fixture();
  try {
    await f.save('/membership/rolepermissions', [
      { roleId: f.role.id, apiName: 'DoingApi', contentType: 'Plans', contentId: f.otherMinistry.id, action: 'Edit' },
    ]);
    const cross = {
      ministryId: f.otherMinistry.id,
      planTypeId: f.otherType.id,
      name: 'Cross pool',
      serviceDate: '2099-05-01',
    };
    assert.equal(
      (await f.h.req('/doing/plans/copy/plan-demo', { token: f.token, method: 'POST', json: cross })).status,
      403,
    );
    assert.equal(
      (
        await f.h.req('/doing/plans', {
          token: f.token,
          method: 'POST',
          json: [{ id: 'plan-demo', ministryId: f.otherMinistry.id, planTypeId: f.otherType.id }],
        })
      ).status,
      403,
    );
    const override = await f.save('/doing/plans/copy/plan-demo', cross);
    assert.equal(override.ministryId, f.otherMinistry.id);
    await f.h.db
      .prepare("DELETE FROM group_members WHERE groupId='group-sound-board' AND personId='person-alex'")
      .run();
    assert.equal(
      (
        await f.h.req('/doing/plans/copy/plan-demo', {
          token: f.token,
          method: 'POST',
          json: { name: 'Stale pool', serviceDate: '2099-05-01' },
        })
      ).status,
      403,
    );
    const positions = await f.save(
      '/doing/plans/copy/plan-demo',
      { name: 'Positions only', serviceDate: '2099-05-01', copyMode: 'positions' },
      f.token,
    );
    assert.ok(positions.id);
  } finally {
    await f.h.dispose();
  }
});
