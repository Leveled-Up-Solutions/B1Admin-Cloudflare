import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
let h, admin, member, role, group, hidden, permission;
async function data(response) {
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
const req = (path, token = member, options = {}) => h.req('/membership/' + path, { token, ...options });
const post = (path, json, token = member) => req(path, token, { method: 'POST', json });
const grant = (contentType, contentId = group.id, targetRole = role.id) =>
  post(
    'rolepermissions',
    [
      {
        roleId: targetRole,
        apiName: 'MembershipApi',
        contentType,
        contentId,
        action: 'Edit',
      },
    ],
    admin,
  );
test.before(async () => {
  h = await createHarness();
  admin = (await h.login()).token;
  member = (await h.login('member@example.test')).token;
  [group, hidden] = await data(
    await post(
      'groups',
      [
        {
          name: 'Scoped group',
          categoryName: 'Visible scope',
          tags: 'standard',
        },
        {
          name: 'Private other group',
          categoryName: 'Hidden scope',
          tags: 'standard',
        },
      ],
      admin,
    ),
  );
  [role] = await data(await post('roles', [{ name: 'One group only' }], admin));
  [permission] = await data(await grant('Groups'));
  await data(await grant('Group Members'));
  await data(await post('rolemembers', [{ roleId: role.id, userId: 'user-member' }], admin));
  await data(
    await post(
      'groupmembers',
      [
        {
          id: 'scope-own-membership',
          groupId: group.id,
          personId: 'person-alex',
        },
        {
          id: 'scope-other-membership',
          groupId: hidden.id,
          personId: 'person-admin',
        },
      ],
      admin,
    ),
  );
});
test.after(async () => h?.dispose());
test('only exact existing tenant group scopes can be created', async () => {
  assert.equal((await grant('Groups', 'group-other')).status, 400);
  assert.equal((await grant('Groups', 'unknown-group')).status, 400);
  assert.equal((await grant('Groups', false)).status, 400);
  assert.equal((await grant('People', group.id)).status, 501);
  assert.equal((await req('groups/' + hidden.id)).status, 403);
  assert.equal((await req('people')).status, 403);
});
test('group lists, IDs, tags and categories filter scoped metadata and member DTOs redact contact details', async () => {
  for (const path of [
    'groups',
    'groups/tag/standard',
    'groups/ids?ids=' + [group.id, hidden.id, 'group-welcome'].join(','),
  ]) {
    const rows = await data(await req(path));
    assert.deepEqual(
      rows.map((r) => r.id),
      [group.id],
    );
  }
  const categories = await data(await req('groups/categories/standard'));
  assert.deepEqual(categories, [{ categoryName: 'Visible scope' }]);
  const rows = await data(await req('groupmembers?groupIds=' + [group.id, hidden.id].join(',')));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].groupId, group.id);
  assert.equal(rows[0].person.name.first, 'Alex');
  for (const field of ['contactInfo', 'birthDate', 'householdId', 'membershipStatus'])
    assert.equal(field in rows[0].person, false);
  assert.deepEqual(await data(await req('groupmembers?groupId=' + hidden.id)), []);
});
test('scoped group edits cannot create groups, modify hierarchy or authorize a mixed bulk request', async () => {
  assert.equal(
    (
      await post('groups', [
        {
          id: group.id,
          name: 'Scoped changed',
          meetingLocation: 'Synthetic room',
        },
      ])
    ).status,
    200,
  );
  assert.equal((await post('groups', [{ name: 'Forbidden new group' }])).status, 403);
  assert.equal((await post('groups', [{ id: hidden.id, name: 'Forbidden' }])).status, 403);
  assert.equal((await post('groups', [{ id: group.id, parentId: hidden.id }])).status, 403);
  assert.equal(
    (
      await post('groups', [
        { id: group.id, name: 'Must roll back' },
        { id: hidden.id, name: 'Forbidden' },
      ])
    ).status,
    403,
  );
  assert.equal((await data(await req('groups/' + group.id))).name, 'Scoped changed');
  assert.equal((await post('groups', [{ id: group.id, archived: true }])).status, 200);
  assert.deepEqual(await data(await req('groups')), []);
  assert.equal((await data(await req('groups?archived=1')))[0].id, group.id);
  await data(await post('groups', [{ id: group.id, archived: false }]));
});
test('group member moves check source and target scopes and bulk denial is atomic', async () => {
  assert.equal(
    (
      await post('groupmembers?groupId=' + group.id, [
        {
          id: 'scope-other-membership',
          groupId: group.id,
          personId: 'person-admin',
        },
      ])
    ).status,
    403,
  );
  assert.equal(
    (
      await post('groupmembers', [
        {
          id: 'scope-own-membership',
          groupId: hidden.id,
          personId: 'person-alex',
        },
      ])
    ).status,
    403,
  );
  assert.equal(
    (
      await post('groupmembers', [
        { id: 'scope-new-good', groupId: group.id, personId: 'person-admin' },
        { id: 'scope-new-bad', groupId: hidden.id, personId: 'person-alex' },
      ])
    ).status,
    403,
  );
  assert.equal(await h.db.prepare("SELECT id FROM group_members WHERE id='scope-new-good'").first(), null);
  assert.equal(
    (
      await req('groupmembers/scope-other-membership', member, {
        method: 'DELETE',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await post('groupmembers', [
        {
          id: 'scope-new-good',
          groupId: group.id,
          personId: 'person-admin',
          leader: true,
        },
      ])
    ).status,
    200,
  );
  assert.equal((await req('groupmembers/scope-new-good', member, { method: 'DELETE' })).status, 200);
});
test('delegated role editors cannot broaden an exact scoped permission or delegate scopes they do not hold', async () => {
  const [editor] = await data(await post('roles', [{ name: 'Scoped role editor' }], admin));
  await data(
    await post(
      'rolepermissions',
      [
        {
          roleId: editor.id,
          apiName: 'MembershipApi',
          contentType: 'Roles',
          action: 'Edit',
        },
        {
          roleId: editor.id,
          apiName: 'MembershipApi',
          contentType: 'Roles',
          action: 'View',
        },
      ],
      admin,
    ),
  );
  await data(await post('rolemembers', [{ roleId: editor.id, userId: 'user-member' }], admin));
  const [target] = await data(await post('roles', [{ name: 'Delegated scoped target' }]));
  const input = {
    roleId: target.id,
    apiName: 'MembershipApi',
    contentType: 'Groups',
    action: 'Edit',
  };
  assert.equal((await post('rolepermissions', [input])).status, 403);
  assert.equal((await post('rolepermissions', [{ ...input, contentId: hidden.id }])).status, 403);
  assert.equal((await post('rolepermissions', [{ ...input, contentId: group.id }])).status, 200);
  assert.equal((await post('rolemembers', [{ roleId: target.id, userId: 'user-member' }])).status, 403);
  assert.equal((await post('rolemembers', [{ roleId: target.id, userId: 'user-viewer' }])).status, 200);
});
test('revocation is live and deleting a group removes scoped grants before ID reuse', async () => {
  await data(await req('rolepermissions/' + permission.id, admin, { method: 'DELETE' }));
  assert.equal((await post('groups', [{ id: group.id, name: 'Revoked' }])).status, 403);
  await data(await grant('Groups'));
  assert.equal((await req('groups/' + group.id, member, { method: 'DELETE' })).status, 200);
  const remaining = await h.db
    .prepare('SELECT count(*) n FROM role_permissions WHERE contentId=?')
    .bind(group.id)
    .first();
  assert.equal(remaining.n, 0);
  await data(await post('groups', [{ id: group.id, name: 'New group with old ID' }], admin));
  assert.equal((await req('groups/' + group.id)).status, 403);
  assert.equal((await post('groups', [{ id: group.id, name: 'Stale grant' }])).status, 403);
});
