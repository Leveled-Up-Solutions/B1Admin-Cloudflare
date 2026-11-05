import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
let h, admin, viewer, other;
test.before(async () => {
  h = await createHarness();
  admin = (await h.login()).token;
  viewer = (await h.login('viewer@example.test')).token;
  other = (await h.login('other@example.test')).token;
});
test.after(async () => {
  await h?.dispose();
});
test('health and instance describe real local storage and explicit limits', async () => {
  const r = await h.req('/health');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).database, 'D1');
  const c = await (await h.req('/capabilities')).json();
  assert.ok(c.unsupported.includes('payments'));
});
test('membership auth and CORS fail closed', async () => {
  assert.equal((await h.req('/membership/people')).status, 401);
  assert.equal(
    (await h.req('/membership/people', { token: admin, headers: { origin: 'https://evil.test' } })).status,
    403,
  );
  assert.equal(
    (
      await h.req('/membership/users/login', {
        method: 'POST',
        json: { email: 'admin@example.test', password: 'wrong' },
      })
    ).status,
    401,
  );
});
test('tenant reads, forged identities and read-only writes are isolated', async () => {
  const people = await (
    await h.req('/membership/people', { token: admin, headers: { 'X-Church-Id': 'church-other' } })
  ).json();
  assert.equal(people.length, 3);
  assert.ok(people.every((p) => p.churchId === 'church-demo'));
  assert.equal((await h.req('/membership/people/person-other', { token: admin })).status, 404);
  assert.equal(
    (await h.req('/membership/people', { method: 'POST', token: viewer, json: [{ name: { first: 'No' } }] })).status,
    403,
  );
  assert.equal(
    (
      await h.req('/membership/people', {
        method: 'POST',
        token: admin,
        json: [{ id: 'person-other', name: { first: 'Overwrite' } }],
      })
    ).status,
    404,
  );
});
test('people/household/group lifecycle persists and audits nested wire shape', async () => {
  let r = await h.req('/membership/households', { method: 'POST', token: admin, json: [{ name: 'Test Household' }] });
  assert.equal(r.status, 200);
  const [house] = await r.json();
  r = await h.req('/membership/people', {
    method: 'POST',
    token: admin,
    json: [
      {
        name: { first: 'Taylor', last: 'Fixture' },
        contactInfo: { email: 'taylor@example.test' },
        householdId: house.id,
      },
    ],
  });
  assert.equal(r.status, 200);
  const [person] = await r.json();
  assert.equal(person.name.display, 'Taylor Fixture');
  r = await h.req('/membership/people/search?term=Taylor', { token: admin });
  assert.equal((await r.json())[0].id, person.id);
  r = await h.req('/membership/groupmembers', {
    method: 'POST',
    token: admin,
    json: [{ groupId: 'group-welcome', personId: person.id }],
  });
  assert.equal(r.status, 200);
  const [gm] = await r.json();
  const list = await (await h.req('/membership/groupmembers?personId=' + person.id, { token: admin })).json();
  assert.equal(list[0].person.name.first, 'Taylor');
  assert.equal((await h.req('/membership/groupmembers/' + gm.id, { method: 'DELETE', token: admin })).status, 200);
  assert.equal((await h.req('/membership/people/' + person.id, { method: 'DELETE', token: admin })).status, 200);
  assert.equal((await h.req('/membership/people/' + person.id, { token: admin })).status, 404);
  const audit = await h.db.prepare('SELECT count(*) n FROM audit_log WHERE entityId=?').bind(person.id).first();
  assert.equal(audit.n, 2);
});
test('multi-record writes validate before committing and enforce foreign tenant relationships', async () => {
  let r = await h.req('/membership/people', {
    method: 'POST',
    token: admin,
    json: [{ id: 'atomic-person', name: { first: 'Atomic' } }, { name: { first: '' } }],
  });
  assert.equal(r.status, 400);
  assert.equal(await h.db.prepare('SELECT id FROM people WHERE id=?').bind('atomic-person').first(), null);
  r = await h.req('/membership/groupmembers', {
    method: 'POST',
    token: other,
    json: [{ personId: 'person-other', groupId: 'group-welcome' }],
  });
  assert.equal(r.status, 400);
});
test('logout revokes all API tokens tied to the session and disabled users lose access', async () => {
  const { token, data } = await h.login();
  assert.equal((await h.req('/membership/users/logout', { method: 'POST', token })).status, 200);
  assert.equal((await h.req('/membership/people', { token })).status, 401);
  assert.equal((await h.req('/membership/users/login', { method: 'POST', json: { jwt: data.user.jwt } })).status, 401);
  await h.db.prepare('UPDATE users SET disabled=1 WHERE id=?').bind('user-other').run();
  assert.equal((await h.req('/membership/people', { token: other })).status, 401);
});
test('unported workflows and payments are explicit', async () => {
  assert.equal((await h.req('/giving/donate/charge', { method: 'POST', token: admin, json: {} })).status, 501);
  assert.equal((await h.req('/doing/workflows', { token: admin })).status, 501);
});
test('JSON byte limits and malformed inputs return client errors', async () => {
  for (const value of [null, 'text', 123])
    assert.equal((await h.req('/membership/users/login', { method: 'POST', json: value })).status, 400);
  assert.equal(
    (
      await h.req('/membership/people', {
        method: 'POST',
        token: admin,
        json: [{ name: { first: 'Invalid' }, birthDate: '2026-02-31' }],
      })
    ).status,
    400,
  );
  assert.equal((await h.req('/membership/people/list?pageSize=1.5', { token: admin })).status, 400);
  assert.equal(
    (
      await h.req('/membership/people', {
        method: 'POST',
        token: admin,
        json: [{ name: { first: 'Large' }, contactInfo: { address1: 'é'.repeat(600000) } }],
      })
    ).status,
    413,
  );
});
test('100-record requests stay below D1 per-statement bindings and keep batch atomic', async () => {
  const people = Array.from({ length: 100 }, (_, n) => ({
    id: `bulk-person-${n}`,
    name: { first: 'Bulk', last: String(n) },
  }));
  const response = await h.req('/membership/people', { method: 'POST', token: admin, json: people });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).length, 100);
  const fetched = await h.req('/membership/people/ids?ids=' + people.map((p) => p.id).join(','), { token: admin });
  assert.equal(fetched.status, 200);
  assert.equal((await fetched.json()).length, 100);
  const audit = await h.db
    .prepare("SELECT count(*) n FROM audit_log WHERE action='people.save' AND entityId LIKE 'bulk-person-%'")
    .first();
  assert.equal(audit.n, 100);
});
