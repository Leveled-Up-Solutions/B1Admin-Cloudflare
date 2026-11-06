import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHarness } from './harness.mjs';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/permissions.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { authorizeStaffRoute } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);
function context(path, method, permissions) {
  const request = new Request('http://localhost/api' + path, { method });
  return {
    request,
    url: new URL(request.url),
    path,
    principal: {
      userId: 'synthetic',
      churchId: 'church-demo',
      personId: 'synthetic',
      sessionId: 'synthetic',
      role: 'member',
      permissions,
    },
  };
}
test('central authorization requires a matching scoped grant without broad write authorization', () => {
  const ctx = context('/doing/plans', 'POST', ['DoingApi_Plans_group-sound_Edit']);
  authorizeStaffRoute(ctx);
  assert.equal(ctx.writeAuthorized, false);
  assert.throws(
    () => authorizeStaffRoute(context('/doing/plans', 'POST', ['DoingApi_Plans_group-sound_View'])),
    /permission required/,
  );
  assert.throws(() => authorizeStaffRoute(context('/doing/plans', 'POST', [])), /permission required/);
  assert.throws(
    () => authorizeStaffRoute(context('/doing/tasks', 'POST', ['DoingApi_Plans_group-sound_Edit'])),
    /permission required/,
  );
  assert.throws(
    () => authorizeStaffRoute(context('/doing/unknownRoute', 'GET', ['DoingApi_Plans_group-sound_Edit'])),
    /permission required/,
  );
  assert.throws(
    () => authorizeStaffRoute(context('/doing/blockoutDates/upcoming', 'GET', ['DoingApi_Plans_group-sound_Edit'])),
    /permission required/,
  );
  authorizeStaffRoute(context('/doing/planPeople/plan-demo', 'GET', ['DoingApi_Plans_group-sound_View']));
  assert.throws(() => authorizeStaffRoute(context('/doing/planPeople/plan-demo', 'GET', [])), /permission required/);
});

async function data(response) {
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
test('permission scope metadata exposes only scopes the role viewer can delegate', async () => {
  const h = await createHarness();
  try {
    const admin = (await h.login()).token,
      member = (await h.login('member@example.test')).token;
    const post = (path, json) => h.req('/membership/' + path, { token: admin, method: 'POST', json });
    assert.equal((await h.req('/membership/permissionScopes', { token: member })).status, 403);
    const [role] = await data(await post('roles', [{ name: 'Scoped permission metadata reviewer' }]));
    await data(
      await post('rolepermissions', [
        { roleId: role.id, apiName: 'MembershipApi', contentType: 'Roles', action: 'View' },
        { roleId: role.id, apiName: 'DoingApi', contentType: 'Plans', contentId: 'group-sound', action: 'Edit' },
        { roleId: role.id, apiName: 'DoingApi', contentType: 'Tasks', contentId: 'group-media', action: 'View' },
      ]),
    );
    await data(await post('rolemembers', [{ roleId: role.id, userId: 'user-member' }]));
    const scopes = await data(await h.req('/membership/permissionScopes', { token: member }));
    assert.deepEqual(scopes.map((row) => row.id).sort(), ['group-media', 'group-sound']);
    assert.deepEqual(scopes.find((row) => row.id === 'group-sound').permissions, [
      { apiName: 'DoingApi', contentType: 'Plans', actions: ['Edit'] },
    ]);
    assert.deepEqual(scopes.find((row) => row.id === 'group-media').permissions, [
      { apiName: 'DoingApi', contentType: 'Tasks', actions: ['View'] },
    ]);
    assert.ok(scopes.every((row) => Object.keys(row).sort().join(',') === 'id,name,permissions,scopeType'));
    const broad = await data(await h.req('/membership/permissionScopes', { token: admin }));
    assert.equal(broad.find((row) => row.id === 'group-sound').permissions.length, 4);
    assert.ok(!broad.find((row) => row.id === 'group-media').permissions.some((row) => row.contentType === 'Plans'));
    assert.equal(
      (
        await post('rolepermissions', [
          { roleId: role.id, apiName: 'DoingApi', contentType: 'Plans', contentId: 'group-media', action: 'Edit' },
        ])
      ).status,
      400,
    );
    assert.equal(
      (
        await post('rolepermissions', [
          { roleId: role.id, apiName: 'ContentApi', contentType: 'Content', contentId: 'group-media', action: 'Edit' },
        ])
      ).status,
      501,
    );
  } finally {
    await h.dispose();
  }
});
