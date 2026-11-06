import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
test('View Names permits name projections without contact, family or demographic access', async () => {
  const h = await createHarness();
  try {
    await h.db
      .prepare(
        "INSERT INTO users(id,email,firstName,lastName,passwordHash) SELECT 'user-names','names@example.test','Names','Reader',passwordHash FROM users WHERE id='user-admin'",
      )
      .run();
    await h.db.prepare("INSERT INTO user_churches VALUES('user-names','church-demo','person-jordan','member')").run();
    await h.db
      .prepare("INSERT INTO roles(id,churchId,name) VALUES('role-names','church-demo','Name-only reader')")
      .run();
    await h.db
      .prepare(
        "INSERT INTO role_permissions(id,churchId,roleId,apiName,contentType,contentId,action) VALUES('grant-names','church-demo','role-names','MembershipApi','People','','View Names')",
      )
      .run();
    await h.db
      .prepare(
        "INSERT INTO role_members(id,churchId,roleId,userId,dateAdded,addedBy) VALUES('rm-names','church-demo','role-names','user-names','2026-01-01T00:00:00Z','user-admin')",
      )
      .run();
    const { token } = await h.login('names@example.test');
    const response = await h.req('/membership/people/list', { token });
    assert.equal(response.status, 200);
    const people = await response.json();
    assert.ok(people.length >= 3);
    assert.ok(people.every((p) => p.name?.first));
    assert.ok(
      people.every((p) => !('contactInfo' in p) && !('birthDate' in p) && !('householdId' in p) && !('email' in p)),
    );
    assert.equal((await h.req('/membership/households', { token })).status, 403);
    assert.equal((await h.req('/membership/people/household/household-demo', { token })).status, 403);
    const found = await (await h.req('/membership/people/search?term=alex@example.test', { token })).json();
    assert.deepEqual(found, []);
    assert.equal(
      (
        await h.req('/membership/people', {
          token,
          method: 'POST',
          json: [{ name: { first: 'Denied' } }],
        })
      ).status,
      403,
    );
    const admin = (await h.login()).token;
    const full = await (await h.req('/membership/people/person-alex', { token: admin })).json();
    assert.equal(full.contactInfo.email, 'alex@example.test');
  } finally {
    await h.dispose();
  }
});
