import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';

let h, member, admin, other, viewer;
test.before(async () => {
  h = await createHarness();
  member = (await h.login('member@example.test')).token;
  admin = (await h.login()).token;
  other = (await h.login('other@example.test')).token;
  viewer = (await h.login('viewer@example.test')).token;
  for (const [groupId, churchId, policy] of [
    ['requests', 'church-demo', 'request'],
    ['leader-requests', 'church-demo', 'request'],
    ['closed-request', 'church-demo', 'closed'],
    ['foreign-request', 'church-other', 'request'],
  ])
    await h.db
      .prepare('INSERT INTO groups(id,churchId,name,joinPolicy) VALUES(?,?,?,?)')
      .bind(groupId, churchId, groupId, policy)
      .run();
  await h.db
    .prepare(
      "INSERT INTO group_members(id,churchId,groupId,personId,leader) VALUES('request-leader','church-demo','leader-requests','person-alex',1)",
    )
    .run();
});
test.after(async () => {
  await h?.dispose();
});
async function data(response) {
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function create(groupId = 'requests', token = member, message = 'I would like to join.') {
  return data(
    await h.req('/membership/groupjoinrequests', {
      method: 'POST',
      token,
      json: { groupId, message },
    }),
  );
}
test('request creation is own-person, tenant-scoped, policy-limited and concurrency-idempotent', async () => {
  assert.equal((await h.req('/membership/groupjoinrequests/my')).status, 401);
  for (const json of [
    { groupId: 'requests', personId: 'person-admin' },
    { groupId: 'requests', churchId: 'church-other' },
    { groupId: 'requests', status: 'approved' },
    { groupId: 'requests', message: 'x'.repeat(1001) },
  ])
    assert.equal(
      (
        await h.req('/membership/groupjoinrequests', {
          method: 'POST',
          token: member,
          json,
        })
      ).status,
      400,
    );
  for (const [groupId, status] of [
    ['closed-request', 409],
    ['foreign-request', 404],
    ['group-welcome', 409],
  ])
    assert.equal(
      (
        await h.req('/membership/groupjoinrequests', {
          method: 'POST',
          token: member,
          json: { groupId },
        })
      ).status,
      status,
    );
  const requests = await Promise.all(Array.from({ length: 5 }, () => create()));
  assert.equal(new Set(requests.map((x) => x.id)).size, 1);
  assert.equal(requests[0].personId, 'person-alex');
  assert.equal(requests[0].status, 'pending');
  assert.equal('decisionId' in requests[0], false);
  assert.equal(
    (await h.db.prepare("SELECT count(*) n FROM audit_log WHERE action='groupJoinRequest.create'").first()).n,
    1,
  );
  const available = await data(await h.req('/member/v1/groups/available', { token: member }));
  assert.equal(available.find((g) => g.id === 'requests').joinPolicy, 'request');
  assert.ok(!available.some((g) => g.id === 'foreign-request' || g.id === 'closed-request'));
});
test('request lists and decisions require ownership, live group leadership or scoped edit permission', async () => {
  const request = (await data(await h.req('/membership/groupjoinrequests/my', { token: member })))[0];
  assert.deepEqual(await data(await h.req('/membership/groupjoinrequests/my', { token: other })), []);
  assert.deepEqual(await data(await h.req('/member/v1/group-requests/review', { token: member })), []);
  assert.equal((await h.req('/membership/groupjoinrequests/pending', { token: member })).status, 403);
  for (const token of [member, viewer]) {
    assert.equal((await h.req('/membership/groupjoinrequests/group/requests', { token })).status, 403);
    assert.equal(
      (
        await h.req(`/membership/groupjoinrequests/${request.id}/approve`, {
          method: 'POST',
          token,
          json: {},
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await h.req(`/membership/groupjoinrequests/${request.id}/approve`, {
        method: 'POST',
        token: other,
        json: {},
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await h.req(`/membership/groupjoinrequests/${request.id}`, {
        method: 'DELETE',
        token: viewer,
      })
    ).status,
    403,
  );
  const pending = await data(await h.req('/membership/groupjoinrequests/pending', { token: admin }));
  assert.equal(pending[0].person.name.display, 'Alex Example');
  assert.deepEqual(pending[0].person.contactInfo, {});
  assert.equal(pending[0].person.photo, '');
  const leaderRequest = await create('leader-requests', admin);
  const review = await data(await h.req('/member/v1/group-requests/review', { token: member }));
  assert.deepEqual(
    review.map((r) => r.id),
    [leaderRequest.id],
  );
  await h.db.prepare("UPDATE group_members SET leader=0 WHERE id='request-leader'").run();
  assert.equal(
    (
      await h.req(`/membership/groupjoinrequests/${leaderRequest.id}/decline`, {
        method: 'POST',
        token: member,
        json: {},
      })
    ).status,
    403,
  );
  await h.db.prepare("UPDATE group_members SET leader=1 WHERE id='request-leader'").run();
  const declined = await data(
    await h.req(`/membership/groupjoinrequests/${leaderRequest.id}/decline`, {
      method: 'POST',
      token: member,
      json: { declineReason: 'Please contact the group first.' },
    }),
  );
  assert.equal(declined.status, 'declined');
  assert.equal(declined.decidedBy, 'person-alex');
  const own = await data(await h.req('/membership/groupjoinrequests/my', { token: admin }));
  assert.equal(own.find((r) => r.id === leaderRequest.id).declineReason, 'Please contact the group first.');
});
test('approve is atomic and replay-safe without resurrecting a later membership removal', async () => {
  const request = (await data(await h.req('/membership/groupjoinrequests/my', { token: member }))).find(
    (r) => r.groupId === 'requests',
  );
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      h.req(`/membership/groupjoinrequests/${request.id}/approve`, {
        method: 'POST',
        token: admin,
        json: {},
      }),
    ),
  );
  for (const response of results) assert.equal(response.status, 200, await response.clone().text());
  assert.equal(
    (
      await h.db
        .prepare("SELECT count(*) n FROM group_members WHERE groupId='requests' AND personId='person-alex'")
        .first()
    ).n,
    1,
  );
  assert.equal(
    (
      await h.db
        .prepare("SELECT count(*) n FROM audit_log WHERE action='groupJoinRequest.approve' AND entityId=?")
        .bind(request.id)
        .first()
    ).n,
    1,
  );
  assert.equal(
    (
      await h.req(`/membership/groupjoinrequests/${request.id}/decline`, {
        method: 'POST',
        token: admin,
        json: {},
      })
    ).status,
    409,
  );
  await h.req('/member/v1/groups/requests/leave', {
    method: 'DELETE',
    token: member,
  });
  assert.equal(
    (
      await h.req(`/membership/groupjoinrequests/${request.id}/approve`, {
        method: 'POST',
        token: admin,
        json: {},
      })
    ).status,
    200,
  );
  assert.equal(
    await h.db.prepare("SELECT id FROM group_members WHERE groupId='requests' AND personId='person-alex'").first(),
    null,
  );
});
test('cancellation, re-requesting and competing decisions keep one terminal outcome', async () => {
  let request = await create();
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await h.req(`/membership/groupjoinrequests/${request.id}`, {
          method: 'DELETE',
          token: member,
        })
      ).status,
      200,
    );
  assert.equal(
    (await h.db.prepare('SELECT status FROM group_join_requests WHERE id=?').bind(request.id).first()).status,
    'cancelled',
  );
  assert.equal(
    (
      await h.req(`/membership/groupjoinrequests/${request.id}/approve`, {
        method: 'POST',
        token: admin,
        json: {},
      })
    ).status,
    409,
  );
  const prior = request.id;
  request = await create();
  assert.notEqual(request.id, prior);
  const results = await Promise.all(
    ['approve', 'decline'].map((action) =>
      h.req(`/membership/groupjoinrequests/${request.id}/${action}`, {
        method: 'POST',
        token: admin,
        json: {},
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const final = await h.db.prepare('SELECT status FROM group_join_requests WHERE id=?').bind(request.id).first();
  const membership = await h.db
    .prepare("SELECT id FROM group_members WHERE groupId='requests' AND personId='person-alex'")
    .first();
  assert.equal(!!membership, final.status === 'approved');
  assert.equal(
    (
      await h.db
        .prepare(
          "SELECT count(*) n FROM audit_log WHERE action IN ('groupJoinRequest.approve','groupJoinRequest.decline') AND entityId=?",
        )
        .bind(request.id)
        .first()
    ).n,
    1,
  );
});
test('approval cannot add removed people or bypass a newly closed group', async () => {
  const request = await create('leader-requests', admin);
  await h.db.prepare("UPDATE groups SET joinPolicy='closed' WHERE id='leader-requests'").run();
  assert.equal(
    (
      await h.req(`/membership/groupjoinrequests/${request.id}/approve`, {
        method: 'POST',
        token: member,
        json: {},
      })
    ).status,
    409,
  );
  await h.db.prepare("UPDATE groups SET joinPolicy='request' WHERE id='leader-requests'").run();
  await h.db.prepare("UPDATE people SET removed=1 WHERE id='person-admin'").run();
  assert.equal(
    (
      await h.req(`/membership/groupjoinrequests/${request.id}/approve`, {
        method: 'POST',
        token: member,
        json: {},
      })
    ).status,
    409,
  );
  await h.db.prepare("UPDATE people SET removed=0 WHERE id='person-admin'").run();
  assert.equal(
    (
      await h.req(`/membership/groupjoinrequests/${request.id}/approve`, {
        method: 'POST',
        token: member,
        json: {},
      })
    ).status,
    200,
  );
});
test('scoped Group Members Edit grants review and decide only their target group', async () => {
  for (const groupId of ['scoped-request', 'unscoped-request'])
    await h.db
      .prepare("INSERT INTO groups(id,churchId,name,joinPolicy) VALUES(?,'church-demo',?,'request')")
      .bind(groupId, groupId)
      .run();
  const scoped = await create('scoped-request'),
    unscoped = await create('unscoped-request');
  await h.db
    .prepare("INSERT INTO roles(id,churchId,name) VALUES('request-reviewer','church-demo','Request reviewer')")
    .run();
  await h.db
    .prepare(
      "INSERT INTO role_members(id,churchId,roleId,userId,addedBy,dateAdded) VALUES('request-reviewer-member','church-demo','request-reviewer','user-viewer','user-admin','2026-01-01')",
    )
    .run();
  await h.db
    .prepare(
      "INSERT INTO role_permissions(id,churchId,roleId,apiName,contentType,contentId,action) VALUES('request-reviewer-grant','church-demo','request-reviewer','MembershipApi','Group Members','scoped-request','Edit')",
    )
    .run();
  const review = await data(await h.req('/member/v1/group-requests/review', { token: viewer }));
  assert.deepEqual(
    review.map((r) => r.id),
    [scoped.id],
  );
  assert.equal((await h.req('/membership/groupjoinrequests/pending', { token: viewer })).status, 403);
  assert.equal(
    (
      await h.req(`/membership/groupjoinrequests/${unscoped.id}/approve`, {
        method: 'POST',
        token: viewer,
        json: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await h.req(`/membership/groupjoinrequests/${scoped.id}/approve`, {
        method: 'POST',
        token: viewer,
        json: {},
      })
    ).status,
    200,
  );
  await h.db.prepare("DELETE FROM role_permissions WHERE id='request-reviewer-grant'").run();
  assert.equal(
    (
      await h.req('/membership/groupjoinrequests/group/scoped-request', {
        token: viewer,
      })
    ).status,
    403,
  );
});
test('archived groups cannot be discovered, joined, requested or approved', async () => {
  const request = await create('unscoped-request');
  await h.db.prepare("UPDATE groups SET archived=1 WHERE id IN ('unscoped-request','closed-request')").run();
  await h.db.prepare("UPDATE groups SET joinPolicy='open' WHERE id='closed-request'").run();
  const available = await data(await h.req('/member/v1/groups/available', { token: member }));
  assert.ok(!available.some((g) => ['unscoped-request', 'closed-request'].includes(g.id)));
  assert.equal(
    (
      await h.req('/membership/groupjoinrequests', {
        method: 'POST',
        token: member,
        json: { groupId: 'unscoped-request' },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await h.req(`/membership/groupjoinrequests/${request.id}/approve`, {
        method: 'POST',
        token: admin,
        json: {},
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await h.req('/member/v1/groups/closed-request/join', {
        method: 'POST',
        token: member,
      })
    ).status,
    409,
  );
});
