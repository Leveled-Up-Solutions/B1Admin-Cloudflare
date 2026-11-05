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
async function data(response) {
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function post(path, json, token = admin) {
  return h.req('/membership/' + path, { method: 'POST', token, json });
}
async function createRole(name) {
  return (await data(await post('roles', [{ name }])))[0];
}
test('role administration protects bootstrap admins and rejects unprivileged mutations', async () => {
  assert.equal((await post('roles', [{ name: 'Unauthorized' }], viewer)).status, 403);
  assert.equal((await post('roles', [{ name: 'Unauthorized' }], member)).status, 403);
  assert.equal(
    (await h.req('/membership/roles/builtin-administrators', { method: 'DELETE', token: admin })).status,
    409,
  );
  assert.equal(
    (await h.req('/membership/rolemembers/builtin-member-user-admin', { method: 'DELETE', token: admin })).status,
    409,
  );
  const roles = await data(await h.req('/membership/roles/church/church-demo', { token: admin }));
  assert.ok(roles.some((r) => r.protected && r.name === 'Domain Admins'));
  assert.equal((await h.req('/membership/roles/church/church-other', { token: admin })).status, 403);
});
test('custom permissions grant and revoke access on the next request without token refresh', async () => {
  const role = await createRole('Directory editors');
  const [permission] = await data(
    await post('rolepermissions', [
      { roleId: role.id, apiName: 'MembershipApi', contentType: 'People', action: 'Edit' },
    ]),
  );
  const [assignment] = await data(await post('rolemembers', [{ roleId: role.id, personId: 'person-alex' }]));
  assert.equal(assignment.userId, 'user-member');
  // This JWT was issued before the role existed. D1 grants, not stale JWT claims, decide access.
  let response = await post('people', [{ name: { first: 'Delegated', last: 'Editor' } }], member);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await post('groups', [{ name: 'Not allowed' }], member)).status, 403);
  assert.equal(
    (await h.req('/membership/rolepermissions/' + permission.id, { method: 'DELETE', token: admin })).status,
    200,
  );
  assert.equal((await post('people', [{ name: { first: 'No longer allowed' } }], member)).status, 403);
  const members = await data(
    await h.req('/membership/rolemembers/roles/' + role.id + '?include=users', { token: admin }),
  );
  assert.equal(members[0].user.email, 'member@example.test');
  assert.equal('passwordHash' in members[0].user, false);
  assert.equal((await h.req('/membership/roles/' + role.id, { method: 'DELETE', token: admin })).status, 200);
  assert.equal(await h.db.prepare('SELECT id FROM role_members WHERE id=?').bind(assignment.id).first(), null);
});
test('role references remain tenant scoped and validation rolls back bulk writes', async () => {
  const role = await createRole('Isolation role');
  assert.equal(
    (
      await post(
        'rolepermissions',
        [{ roleId: role.id, apiName: 'MembershipApi', contentType: 'People', action: 'View' }],
        other,
      )
    ).status,
    404,
  );
  assert.equal((await post('rolemembers', [{ roleId: role.id, userId: 'user-other' }])).status, 400);
  const response = await post('rolepermissions', [
    { id: 'bulk-role-good', roleId: role.id, apiName: 'MembershipApi', contentType: 'People', action: 'View' },
    { roleId: role.id, apiName: 'MembershipApi', contentType: 'Server', action: 'Admin' },
  ]);
  assert.equal(response.status, 400);
  assert.equal(await h.db.prepare("SELECT id FROM role_permissions WHERE id='bulk-role-good'").first(), null);
  assert.equal(
    (
      await post('rolepermissions', [
        {
          roleId: role.id,
          apiName: 'MembershipApi',
          contentType: 'People',
          action: 'View',
          contentId: 'specific-person',
        },
      ])
    ).status,
    501,
  );
  assert.equal(
    (await post('rolepermissions', [{ roleId: null, apiName: 'MembershipApi', contentType: 'People', action: 'View' }]))
      .status,
    501,
  );
});
test('delegated role editors cannot grant themselves or others elevated privileges', async () => {
  const editor = await createRole('Delegated role editors');
  await data(
    await post('rolepermissions', [
      { roleId: editor.id, apiName: 'MembershipApi', contentType: 'Roles', action: 'Edit' },
      { roleId: editor.id, apiName: 'MembershipApi', contentType: 'Roles', action: 'View' },
    ]),
  );
  await data(await post('rolemembers', [{ roleId: editor.id, userId: 'user-viewer' }]));
  const target = (await data(await post('roles', [{ name: 'Managed by delegated editor' }], viewer)))[0];
  assert.equal(
    (
      await post(
        'rolepermissions',
        [{ roleId: target.id, apiName: 'MembershipApi', contentType: 'People', action: 'Edit' }],
        viewer,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await post(
        'rolepermissions',
        [{ roleId: target.id, apiName: 'MembershipApi', contentType: 'Roles', action: 'View' }],
        viewer,
      )
    ).status,
    403,
  );
  assert.equal((await post('rolemembers', [{ roleId: target.id, userId: 'user-viewer' }], viewer)).status, 403);
  assert.equal((await post('roles', [{ id: editor.id, name: 'Self edited' }], viewer)).status, 403);
  // The viewer already holds People View and may delegate only that existing grant.
  assert.equal(
    (
      await post(
        'rolepermissions',
        [{ roleId: target.id, apiName: 'MembershipApi', contentType: 'People', action: 'View' }],
        viewer,
      )
    ).status,
    200,
  );
});
test('upstream audit list contract is paginated, filterable and permission protected', async () => {
  assert.equal((await h.req('/membership/auditlogs', { token: viewer })).status, 403);
  assert.equal((await h.req('/membership/auditlogs', { token: member })).status, 403);
  const result = await data(
    await h.req('/membership/auditlogs?category=permission&module=membership&limit=2&offset=0', { token: admin }),
  );
  assert.equal(result.limit, 2);
  assert.ok(result.count >= 2);
  assert.equal(result.logs.length, 2);
  assert.ok(result.logs.every((log) => log.category === 'permission' && log.churchId === 'church-demo' && log.created));
  const empty = await data(await h.req('/membership/auditlogs?entityId=does-not-exist', { token: admin }));
  assert.equal(empty.count, 0);
  const foreign = await data(await h.req('/membership/auditlogs', { token: other }));
  assert.ok(foreign.logs.every((log) => log.churchId === 'church-other'));
  assert.equal((await h.req('/membership/auditlogs?limit=1000', { token: admin })).status, 400);
});
