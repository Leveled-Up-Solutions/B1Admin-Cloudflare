import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';

let h, admin, member, other, groupMember;
const base = '/member/v1/profile-requests';
test.before(async () => {
  h = await createHarness();
  admin = (await h.login()).token;
  const multi = await h.login('multi-member@example.test');
  member = multi.data.userChurches.find((c) => c.church.id === 'church-demo').jwt;
  other = multi.data.userChurches.find((c) => c.church.id === 'church-other').jwt;
  groupMember = (await h.login('member@example.test')).token;
});
test.after(async () => h?.dispose());
test.beforeEach(async () => {
  await h.db.prepare("UPDATE churches SET settings='[]' WHERE id='church-demo'").run();
});
async function data(response) {
  assert.ok(response.ok, `${response.status} ${await response.clone().text()}`);
  return response.json();
}
async function policy(value = 'group-welcome') {
  await h.db
    .prepare('UPDATE churches SET settings=? WHERE id=?')
    .bind(JSON.stringify({ directoryApprovalGroupId: value }), 'church-demo')
    .run();
}
async function create(kind, changes, personId) {
  return data(
    await h.req(base, { method: 'POST', token: member, json: { kind, changes, ...(personId ? { personId } : {}) } }),
  );
}
async function decide(id, action = 'approve', token = admin, json = {}) {
  return h.req(`${base}/${id}/${action}`, { method: 'POST', token, json });
}
async function person(id = 'person-multi-demo') {
  return h.db.prepare('SELECT * FROM people WHERE id=?').bind(id).first();
}

test('own profile review pins identity, keeps private changes out of tasks, and applies one atomic decision', async () => {
  await policy();
  const before = await person();
  const request = await create('profile', { firstName: 'Reviewed Morgan', mobilePhone: '555-0123' });
  assert.equal(request.kind, 'profile');
  assert.equal(request.status, 'pending');
  assert.equal(request.canReview, false);
  assert.equal(request.target.id, 'person-multi-demo');
  assert.equal(request.requester.id, 'person-multi-demo');
  assert.ok(!('snapshot' in request) && !('reviewGroupId' in request));
  assert.equal((await person()).firstName, before.firstName);
  const task = await data(await h.req('/doing/tasks/' + request.taskId, { token: groupMember }));
  assert.equal(task.taskType, 'directoryUpdate');
  assert.equal(task.createdById, 'person-multi-demo');
  assert.equal(task.assignedToId, 'group-welcome');
  assert.equal(task.associatedWithId, 'person-multi-demo');
  assert.ok(!('data' in task) && !JSON.stringify(task).includes('555-0123'));
  assert.equal((await h.req(base + '/' + request.id, { token: groupMember })).status, 403);
  assert.equal((await decide(request.id, 'approve', groupMember)).status, 403);
  assert.equal((await h.req(base + '/' + request.id, { token: other })).status, 404);
  const result = await data(await decide(request.id));
  assert.equal(result.status, 'approved');
  assert.equal((await person()).firstName, 'Reviewed Morgan');
  assert.equal(JSON.parse((await person()).contactInfo).mobilePhone, '555-0123');
  assert.equal((await data(await h.req('/doing/tasks/' + request.taskId, { token: admin }))).status, 'Closed');
  const audits = await h.db.prepare('SELECT count(*) n FROM audit_log WHERE entityId=?').bind(request.id).first();
  assert.equal((await data(await decide(request.id))).status, 'approved');
  assert.deepEqual(
    await h.db.prepare('SELECT count(*) n FROM audit_log WHERE entityId=?').bind(request.id).first(),
    audits,
  );
  assert.equal((await decide(request.id, 'decline', admin, { reason: 'Too late' })).status, 409);
});

test('family additions are private, account-free, and concurrent approvals create only one person', async () => {
  await policy();
  const request = await create('family-add', {
    first: 'Reviewed Family',
    mobilePhone: '555-0190',
    householdRole: 'Child',
  });
  const before = (await h.db.prepare('SELECT count(*) n FROM people').first()).n;
  const results = await Promise.all([decide(request.id), decide(request.id)]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200],
  );
  const approved = await results[0].json();
  const added = await person(approved.target.id);
  assert.equal((await h.db.prepare('SELECT count(*) n FROM people').first()).n, before + 1);
  assert.equal(added.householdId, 'household-multi-demo');
  assert.equal(added.directoryVisible, 0);
  assert.equal(added.shareEmail, 0);
  assert.equal(added.membershipStatus, 'Visitor');
  assert.equal(added.email, '');
  assert.equal(
    (await h.db.prepare('SELECT count(*) n FROM user_churches WHERE personId=?').bind(added.id).first()).n,
    0,
  );
  assert.equal(
    (await h.db.prepare('SELECT count(*) n FROM auth_invitations WHERE personId=?').bind(added.id).first()).n,
    0,
  );
  await h.db.prepare('UPDATE people SET removed=1 WHERE id=?').bind(added.id).run();
  await data(await decide(request.id));
  assert.equal((await person(added.id)).removed, 1);
  assert.equal((await h.db.prepare('SELECT count(*) n FROM people').first()).n, before + 1);
});

test('existing household editing is always a proposal with no private baseline disclosure, including direct-edit churches', async () => {
  await h.db
    .prepare(
      'UPDATE people SET contactInfo=\'{"mobilePhone":"private-existing","address1":"Hidden address"}\',birthDate=\'2012-06-01\' WHERE id=\'person-family-demo\'',
    )
    .run();
  const before = await person('person-family-demo');
  const request = await create('family-edit', { mobilePhone: 'new-family-number' }, 'person-family-demo');
  assert.deepEqual(request.changes, { mobilePhone: 'new-family-number' });
  assert.ok(!JSON.stringify(request).includes('private-existing') && !JSON.stringify(request).includes('2012-06-01'));
  assert.deepEqual(await person('person-family-demo'), before);
  const task = await data(await h.req('/doing/tasks/' + request.taskId, { token: admin }));
  assert.equal(task.assignedToType, 'person');
  assert.equal(task.assignedToId, 'person-admin');
  const household = await data(await h.req('/member/v1/household', { token: member }));
  assert.ok(household.members.every((p) => !('birthDate' in p) && !('contactInfo' in p)));
  await data(await decide(request.id));
  const saved = await person('person-family-demo');
  assert.equal(JSON.parse(saved.contactInfo).mobilePhone, 'new-family-number');
  assert.equal(JSON.parse(saved.contactInfo).address1, 'Hidden address');
  assert.equal(saved.birthDate, before.birthDate);
  assert.equal(saved.householdRole, before.householdRole);
  assert.equal(
    (
      await h.req(base, {
        method: 'POST',
        token: member,
        json: { kind: 'family-edit', personId: 'person-family-other', changes: { firstName: 'No' } },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await h.req(base, {
        method: 'POST',
        token: member,
        json: { kind: 'family-edit', personId: 'person-admin', changes: { firstName: 'No' } },
      })
    ).status,
    404,
  );
});

test('review needs People Edit and review routing authority; generic My Work updates cannot decide protected requests', async () => {
  await policy();
  const request = await create('profile', { nickName: 'Review by permitted member' });
  const role = (
    await data(
      await h.req('/membership/roles', { method: 'POST', token: admin, json: [{ name: 'Profile reviewers' }] }),
    )
  )[0];
  await data(
    await h.req('/membership/rolepermissions', {
      method: 'POST',
      token: admin,
      json: [{ roleId: role.id, apiName: 'MembershipApi', contentType: 'People', action: 'Edit' }],
    }),
  );
  await data(
    await h.req('/membership/rolemembers', {
      method: 'POST',
      token: admin,
      json: [{ roleId: role.id, personId: 'person-alex' }],
    }),
  );
  try {
    const reviewer = await data(await h.req(base + '/review?paged=1', { token: groupMember }));
    assert.ok(reviewer.items.some((r) => r.id === request.id && r.canReview));
    const task = await data(await h.req('/doing/tasks/' + request.taskId, { token: admin }));
    assert.equal(
      (await h.req('/doing/tasks', { method: 'POST', token: admin, json: [{ id: task.id, status: 'Closed' }] })).status,
      409,
    );
    assert.equal((await h.req('/doing/tasks/' + task.id, { method: 'DELETE', token: admin })).status, 409);
    assert.equal(
      (
        await h.req('/doing/tasks', {
          method: 'POST',
          token: admin,
          json: [
            { title: 'Forged', taskType: 'directoryUpdate', assignedToType: 'person', assignedToId: 'person-admin' },
          ],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await h.req('/doing/tasks', {
          method: 'POST',
          token: admin,
          json: [
            { title: 'Forged', memberRequestId: request.id, assignedToType: 'person', assignedToId: 'person-admin' },
          ],
        })
      ).status,
      400,
    );
    await data(await decide(request.id, 'approve', groupMember));
    const second = await create('profile', { nickName: 'Requires current group membership' });
    await h.db
      .prepare(
        "DELETE FROM group_members WHERE churchId='church-demo' AND groupId='group-welcome' AND personId='person-alex'",
      )
      .run();
    assert.equal((await decide(second.id, 'approve', groupMember)).status, 403);
    await data(await decide(second.id, 'decline', admin, { reason: 'Reviewer left group' }));
  } finally {
    await h.db
      .prepare(
        "INSERT INTO group_members(id,churchId,groupId,personId) VALUES('restored-review-member','church-demo','group-welcome','person-alex') ON CONFLICT(churchId,groupId,personId) DO NOTHING",
      )
      .run();
    await h.req('/membership/roles/' + role.id, { method: 'DELETE', token: admin });
  }
});

test('decline and own cancellation close tasks without applying fields and distinguish terminal outcomes', async () => {
  await policy();
  const before = await person();
  const declined = await create('profile', { firstName: 'Never applied decline' });
  const result = await data(await decide(declined.id, 'decline', admin, { reason: 'Please verify the spelling' }));
  assert.equal(result.reason, 'Please verify the spelling');
  assert.equal(result.status, 'declined');
  assert.equal((await data(await h.req(base + '/' + declined.id, { token: member }))).reason, result.reason);
  const cancelled = await create('profile', { firstName: 'Never applied cancel' });
  assert.equal((await h.req(base + '/' + cancelled.id, { method: 'DELETE', token: groupMember })).status, 403);
  assert.equal(
    (await data(await h.req(base + '/' + cancelled.id, { method: 'DELETE', token: member }))).status,
    'cancelled',
  );
  assert.equal(
    (await data(await h.req(base + '/' + cancelled.id, { method: 'DELETE', token: member }))).status,
    'cancelled',
  );
  assert.equal((await decide(cancelled.id)).status, 409);
  assert.deepEqual(await person(), before);
});

test('stale fields, account links, household moves and review policy changes block approval without closing its queue item', async () => {
  const cases = [
    [
      "UPDATE people SET firstName='Staff changed field' WHERE id='person-family-demo'",
      "UPDATE people SET firstName='Casey' WHERE id='person-family-demo'",
    ],
    [
      "UPDATE people SET householdId='household-demo' WHERE id='person-family-demo'",
      "UPDATE people SET householdId='household-multi-demo' WHERE id='person-family-demo'",
    ],
    [
      "UPDATE user_churches SET personId='person-family-demo' WHERE userId='user-member' AND churchId='church-demo'",
      "UPDATE user_churches SET personId='person-alex' WHERE userId='user-member' AND churchId='church-demo'",
    ],
    [
      "UPDATE people SET householdId='household-demo' WHERE id='person-multi-demo'",
      "UPDATE people SET householdId='household-multi-demo' WHERE id='person-multi-demo'",
    ],
    [
      'UPDATE churches SET settings=\'{"directoryApprovalGroupId":"group-welcome"}\' WHERE id=\'church-demo\'',
      "UPDATE churches SET settings='[]' WHERE id='church-demo'",
    ],
  ];
  for (const [change, restore] of cases) {
    const request = await create('family-edit', { firstName: 'Must not overwrite' }, 'person-family-demo');
    await h.db.prepare(change).run();
    try {
      assert.equal((await decide(request.id)).status, 409, change);
      assert.equal(
        (await h.db.prepare('SELECT status FROM member_change_requests WHERE id=?').bind(request.id).first()).status,
        'pending',
      );
      assert.equal(
        (await h.db.prepare('SELECT status FROM tasks WHERE id=?').bind(request.taskId).first()).status,
        'Open',
      );
      assert.notEqual((await person('person-family-demo')).firstName, 'Must not overwrite');
    } finally {
      await h.db.prepare(restore).run();
    }
    await data(await h.req(base + '/' + request.id, { method: 'DELETE', token: member }));
  }
});

test('concurrent duplicate submissions create one task and audit, and paginated ownership stays tenant-scoped', async () => {
  await policy();
  const payload = { kind: 'profile', changes: { middleName: 'Idempotent' } };
  const responses = await Promise.all([
    h.req(base, { method: 'POST', token: member, json: payload }),
    h.req(base, { method: 'POST', token: member, json: payload }),
  ]);
  assert.ok(responses.every((r) => [200, 201].includes(r.status)));
  const requests = await Promise.all(responses.map((r) => r.json()));
  assert.equal(requests[0].id, requests[1].id);
  assert.equal(
    (await h.db.prepare('SELECT count(*) n FROM audit_log WHERE entityId=?').bind(requests[0].id).first()).n,
    1,
  );
  assert.equal(
    (
      await h.req(base, {
        method: 'POST',
        token: member,
        json: { kind: 'profile', changes: { firstName: 'Conflicting pending' } },
      })
    ).status,
    409,
  );
  const page = await data(await h.req(base + '/my?paged=1&limit=2', { token: member }));
  assert.equal(page.items.length, 2);
  assert.equal(page.pagination.hasMore, true);
  assert.ok(page.items.every((r) => r.requester.id === 'person-multi-demo'));
  assert.deepEqual(await data(await h.req(base + '/my', { token: other })), []);
  assert.deepEqual(await data(await h.req(base + '/review', { token: groupMember })), []);
  await data(await h.req(base + '/' + requests[0].id, { method: 'DELETE', token: member }));
});

test('request whitelist excludes consent, identity, administrative fields and unsupported media, with fail-closed policy configuration', async () => {
  await policy();
  for (const changes of [
    {},
    { email: 'changed@example.test' },
    { directoryVisible: true },
    { shareEmail: true },
    { householdRole: 'Head' },
    { householdId: 'other' },
    { membershipStatus: 'Staff' },
    { id: 'person-admin' },
    { photo: 'data:image/png;base64,a' },
    { firstName: '' },
    { birthDate: '2025-02-29' },
  ]) {
    assert.equal(
      (await h.req(base, { method: 'POST', token: member, json: { kind: 'profile', changes } })).status,
      400,
      JSON.stringify(changes),
    );
  }
  assert.equal(
    (
      await h.req(base, {
        method: 'POST',
        token: member,
        json: { kind: 'profile', personId: 'person-admin', changes: { firstName: 'No' } },
      })
    ).status,
    400,
  );
  await policy('unknown-group');
  assert.equal(
    (await h.req(base, { method: 'POST', token: member, json: { kind: 'profile', changes: { firstName: 'No' } } }))
      .status,
    409,
  );
  await policy({ invalid: 'setting' });
  assert.equal(
    (await h.req('/member/v1/me', { method: 'POST', token: member, json: { firstName: 'No bypass' } })).status,
    409,
  );
  assert.equal(
    (await h.req(base, { method: 'POST', token: member, json: { kind: 'profile', changes: { firstName: 'No' } } }))
      .status,
    409,
  );
  assert.equal(
    (
      await h.req('/member/v1/me', {
        method: 'POST',
        token: member,
        json: { directoryVisible: false, shareEmail: false },
      })
    ).status,
    200,
  );
});

test('a family proposal does not reveal whether a hidden field already equals the proposed value', async () => {
  await h.db.prepare("UPDATE people SET birthDate='2012-06-01' WHERE id='person-family-demo'").run();
  for (const value of ['2012-06-01', '2012-06-02']) {
    const response = await h.req(base, {
      method: 'POST',
      token: member,
      json: { kind: 'family-edit', personId: 'person-family-demo', changes: { birthDate: value } },
    });
    assert.equal(response.status, 201);
    const request = await response.json();
    assert.deepEqual(request.changes, { birthDate: value });
    assert.equal(Object.keys(request).includes('snapshot'), false);
    await data(await h.req(base + '/' + request.id, { method: 'DELETE', token: member }));
  }
});

test('malformed stored approval settings fail closed in both object and array representations', async () => {
  const malformed = [false, 0, null, true, {}, []].flatMap((value) => [
    { directoryApprovalGroupId: value },
    [{ keyName: 'directoryApprovalGroupId', value }],
  ]);
  malformed.push(
    [{ keyName: 'directoryApprovalGroupId' }],
    [
      { keyName: 'directoryApprovalGroupId', value: '' },
      { keyName: 'directoryApprovalGroupId', value: false },
    ],
    [
      { keyName: 'directoryApprovalGroupId', value: 'group-welcome' },
      { keyName: 'directoryApprovalGroupId', value: 0 },
    ],
    null,
    false,
    0,
  );
  const before = await person();
  for (const settings of malformed) {
    await h.db.prepare('UPDATE churches SET settings=? WHERE id=?').bind(JSON.stringify(settings), 'church-demo').run();
    assert.equal(
      (await data(await h.req('/member/v1/me', { token: member }))).settings.profileEditMode,
      'review',
      JSON.stringify(settings),
    );
    assert.equal(
      (
        await h.req('/member/v1/me', {
          token: member,
          method: 'POST',
          json: { firstName: 'No malformed-policy bypass' },
        })
      ).status,
      409,
    );
    assert.equal(
      (await h.req('/member/v1/household/members', { token: member, method: 'POST', json: { first: 'No bypass' } }))
        .status,
      409,
    );
    assert.equal(
      (
        await h.req(base, {
          token: member,
          method: 'POST',
          json: { kind: 'profile', changes: { firstName: 'No invalid queue' } },
        })
      ).status,
      409,
    );
  }
  assert.deepEqual(await person(), before);
  for (const settings of [
    {},
    [],
    { directoryApprovalGroupId: '' },
    [{ keyName: 'directoryApprovalGroupId', value: '' }],
  ]) {
    await h.db.prepare('UPDATE churches SET settings=? WHERE id=?').bind(JSON.stringify(settings), 'church-demo').run();
    assert.equal((await data(await h.req('/member/v1/me', { token: member }))).settings.profileEditMode, 'direct');
  }
});

test('competing decisions have one terminal result; full households and archived review groups cannot apply additions', async () => {
  await policy();
  const before = await person();
  const request = await create('profile', { firstName: 'Concurrent decision result' });
  const responses = await Promise.all([
    decide(request.id),
    decide(request.id, 'decline', admin, { reason: 'Declined concurrently' }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const saved = await data(await h.req(base + '/' + request.id, { token: member }));
  assert.equal(
    (await person()).firstName,
    saved.status === 'approved' ? 'Concurrent decision result' : before.firstName,
  );
  assert.equal(
    (
      await h.db
        .prepare(
          "SELECT count(*) n FROM audit_log WHERE entityId=? AND action IN('member.profileRequest.approve','member.profileRequest.decline')",
        )
        .bind(request.id)
        .first()
    ).n,
    1,
  );
  for (const limit of ['household', 'group']) {
    const addition = await create('family-add', { first: 'Blocked addition ' + limit });
    if (limit === 'group') await h.db.prepare("UPDATE groups SET archived=1 WHERE id='group-welcome'").run();
    else {
      const count = (
        await h.db
          .prepare("SELECT count(*) n FROM people WHERE householdId='household-multi-demo' AND removed=0")
          .first()
      ).n;
      await h.db.batch(
        Array.from({ length: 100 - count }, (_, i) =>
          h.db
            .prepare(
              "INSERT INTO people(id,churchId,firstName,lastName,householdId,dateAdded) VALUES(?,'church-demo','Capacity','Fixture','household-multi-demo','2026-01-01')",
            )
            .bind(`approval-cap-${i}`),
        ),
      );
    }
    try {
      assert.equal((await decide(addition.id)).status, 409);
    } finally {
      await h.db.prepare("UPDATE groups SET archived=0 WHERE id='group-welcome'").run();
      await h.db.prepare("DELETE FROM people WHERE id LIKE 'approval-cap-%'").run();
    }
    assert.equal(
      (await h.db.prepare('SELECT status FROM tasks WHERE id=?').bind(addition.taskId).first()).status,
      'Open',
    );
    await data(await decide(addition.id, 'decline', admin, { reason: 'Cannot safely apply' }));
  }
});
