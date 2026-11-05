import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHarness } from './harness.mjs';

let h, token, second, api;
test.before(async () => {
  h = await createHarness();
  token = (await h.login('multi-member@example.test')).data.userChurches.find(
    (uc) => uc.church.id === 'church-demo',
  ).jwt;
  const compiled = await build({
    entryPoints: [new URL('../src/member-profile.ts', import.meta.url).pathname],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  });
  api = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
});
test.after(async () => {
  await h?.dispose();
});
async function data(response) {
  assert.ok(response.ok, `${response.status} ${await response.clone().text()}`);
  return response.json();
}
test('church list and switching follow existing account links, with no directory or household leakage', async () => {
  const churches = await data(await h.req('/member/v1/churches', { token }));
  assert.deepEqual(
    churches.map((c) => [c.church.id, c.selected]),
    [
      ['church-demo', true],
      ['church-other', false],
    ],
  );
  for (const c of churches) assert.deepEqual(Object.keys(c).sort(), ['church', 'person', 'selected']);
  const selected = await data(
    await h.req('/membership/churches/select', { method: 'POST', token, json: { churchId: 'church-other' } }),
  );
  second = selected.jwt;
  const original = await data(await h.req('/member/v1/household', { token }));
  assert.deepEqual(original.members.map((p) => p.id).sort(), ['person-family-demo', 'person-multi-demo']);
  const other = await data(await h.req('/member/v1/household', { token: second }));
  assert.equal(other.household.id, 'household-multi-other');
  assert.ok(other.members.every((p) => !('contactInfo' in p) && !('birthDate' in p)));
  assert.deepEqual(other.members.map((p) => p.id).sort(), ['person-family-other', 'person-multi-other']);
  assert.deepEqual(await data(await h.req('/member/v1/directory', { token: second })), []);
  assert.equal(
    (await h.req('/membership/churches/select', { method: 'POST', token, json: { churchId: 'unknown' } })).status,
    403,
  );
  const single = (await h.login('member@example.test')).token;
  assert.equal(
    (await h.req('/membership/churches/select', { method: 'POST', token: single, json: { churchId: 'church-other' } }))
      .status,
    403,
  );
  await h.db.prepare("UPDATE people SET removed=1 WHERE id='person-multi-other'").run();
  assert.equal((await data(await h.req('/member/v1/churches', { token }))).length, 1);
  await h.db.prepare("UPDATE people SET removed=0 WHERE id='person-multi-other'").run();
});
test('own profile updates preserve account identity, household authority and other church records', async () => {
  const before = await h.db.prepare("SELECT * FROM users WHERE id='user-multi'").first();
  const result = await data(
    await h.req('/member/v1/me', {
      method: 'POST',
      token,
      json: {
        firstName: 'Morgan Updated',
        lastName: 'Demo',
        middleName: 'R',
        nickName: 'Mo',
        mobilePhone: '555-0101',
        homePhone: '',
        address1: '1 Synthetic Lane',
        address2: 'Unit 2',
        city: 'Example',
        state: 'CA',
        zip: '00000',
        birthDate: '1990-02-28',
      },
    }),
  );
  assert.equal(result.person.name.display, 'Mo Demo');
  assert.equal(result.person.contactInfo.address1, '1 Synthetic Lane');
  assert.equal(result.person.birthDate, '1990-02-28');
  assert.equal(result.person.householdRole, 'Head');
  assert.equal(result.person.householdId, 'household-multi-demo');
  assert.equal(result.person.directoryVisible, false);
  assert.deepEqual(await h.db.prepare("SELECT * FROM users WHERE id='user-multi'").first(), before);
  assert.equal((await data(await h.req('/member/v1/me', { token: second }))).person.name.first, 'Morgan');
  const privateRow = await h.db.prepare("SELECT firstName FROM people WHERE id='person-family-demo'").first();
  assert.equal(privateRow.firstName, 'Casey');
  await h.req('/member/v1/me', { method: 'POST', token, json: { birthDate: null } });
  assert.equal((await data(await h.req('/member/v1/me', { token }))).person.birthDate, null);
});
test('profile whitelist rejects identity, household, other-person, malformed and impossible-date input', async () => {
  for (const json of [
    {},
    [],
    { id: 'person-family-demo' },
    { email: 'new@example.test' },
    { contactInfo: { email: 'x' } },
    { householdId: 'household-multi-other' },
    { householdRole: 'Head' },
    { membershipStatus: 'Staff' },
    { role: 'admin' },
    { firstName: ' ' },
    { nickName: 5 },
    { city: 'line\nbreak' },
    { birthDate: '2023-02-29' },
    { birthDate: '9999-01-01' },
    { birthDate: '2000-02-29T00:00:00Z' },
    { directoryVisible: 1 },
  ])
    assert.equal((await h.req('/member/v1/me', { method: 'POST', token, json })).status, 400, JSON.stringify(json));
});
test('new family member uses current household, defaults private and creates no account or invitation', async () => {
  await h.db.prepare("UPDATE people SET householdRole='Child' WHERE id='person-multi-demo'").run();
  const created = await data(
    await h.req('/member/v1/household/members', {
      method: 'POST',
      token,
      json: { first: 'Taylor', mobilePhone: '555-0199', householdRole: 'Other' },
    }),
  );
  const row = await h.db.prepare('SELECT * FROM people WHERE id=?').bind(created.id).first();
  assert.equal(row.lastName, 'Demo');
  assert.equal(row.householdId, 'household-multi-demo');
  assert.equal(row.churchId, 'church-demo');
  assert.equal(row.directoryVisible, 0);
  assert.equal(row.shareEmail, 0);
  assert.equal(row.email, '');
  assert.equal(row.membershipStatus, 'Visitor');
  assert.equal(
    (await h.db.prepare('SELECT count(*) n FROM user_churches WHERE personId=?').bind(created.id).first()).n,
    0,
  );
  assert.equal(
    (await h.db.prepare('SELECT count(*) n FROM auth_invitations WHERE personId=?').bind(created.id).first()).n,
    0,
  );
  assert.equal((await data(await h.req('/member/v1/me', { token }))).person.householdRole, 'Child');
  for (const json of [
    { first: 'No', id: 'person-family-demo' },
    { first: 'No', householdId: 'household-multi-other' },
    { first: 'No', email: 'bad@example.test' },
    { first: 'No', householdRole: 'Administrator' },
  ])
    assert.equal((await h.req('/member/v1/household/members', { method: 'POST', token, json })).status, 400);
  const single = (await h.login('member@example.test')).token;
  assert.deepEqual(await data(await h.req('/member/v1/household', { token: single })), {
    household: null,
    members: [],
    canAdd: false,
  });
  assert.equal(
    (await h.req('/member/v1/household/members', { method: 'POST', token: single, json: { first: 'No' } })).status,
    409,
  );
});
test('directory approval policy blocks direct profile and family writes while preserving self-service consent', async () => {
  for (const settings of [
    [{ keyName: 'directoryApprovalGroupId', value: 'group-welcome' }],
    { directoryApprovalGroupId: 'group-welcome' },
  ]) {
    await h.db.prepare('UPDATE churches SET settings=? WHERE id=?').bind(JSON.stringify(settings), 'church-demo').run();
    const me = await data(await h.req('/member/v1/me', { token }));
    assert.deepEqual(me.settings, { profileEditMode: 'staff', familyAddEnabled: false });
    assert.equal((await data(await h.req('/member/v1/household', { token }))).canAdd, false);
    assert.equal((await h.req('/member/v1/me', { method: 'POST', token, json: { mobilePhone: '555' } })).status, 409);
    assert.equal(
      (await h.req('/member/v1/household/members', { method: 'POST', token, json: { first: 'No' } })).status,
      409,
    );
    assert.equal(
      (await h.req('/member/v1/me', { method: 'POST', token, json: { directoryVisible: false, shareEmail: false } }))
        .status,
      200,
    );
  }
  await h.db.prepare("UPDATE churches SET settings='[]' WHERE id='church-demo'").run();
});
test('family addition limits apply per active household and do not reveal or fill another church household', async () => {
  const count = await h.db
    .prepare("SELECT count(*) n FROM people WHERE householdId='household-multi-demo' AND removed=0")
    .first();
  const statements = Array.from({ length: 100 - count.n }, (_, index) =>
    h.db
      .prepare(
        "INSERT INTO people(id,churchId,firstName,lastName,householdId,householdRole,dateAdded) VALUES(?,'church-demo','Synthetic','Family','household-multi-demo','Other','2026-01-01')",
      )
      .bind(`family-cap-${index}`),
  );
  await h.db.batch(statements);
  const household = await data(await h.req('/member/v1/household', { token }));
  assert.equal(household.members.length, 100);
  assert.equal(household.canAdd, false);
  assert.equal(
    (await h.req('/member/v1/household/members', { method: 'POST', token, json: { first: 'Over limit' } })).status,
    409,
  );
  const other = await data(await h.req('/member/v1/household', { token: second }));
  assert.equal(other.members.length, 2);
  assert.equal(other.canAdd, true);
  await h.db.prepare("DELETE FROM people WHERE id LIKE 'family-cap-%'").run();
});
test('atomic profile/household guards reject policy, household, removal, link and session changes after the initial read', async () => {
  const cases = [
    [
      'UPDATE churches SET settings=\'[{"keyName":"directoryApprovalGroupId","value":"review"}]\' WHERE id=\'church-demo\'',
      "UPDATE churches SET settings='[]' WHERE id='church-demo'",
    ],
    [
      "UPDATE people SET householdId='household-demo' WHERE id='person-multi-demo'",
      "UPDATE people SET householdId='household-multi-demo' WHERE id='person-multi-demo'",
    ],
    [
      "UPDATE people SET removed=1 WHERE id='person-multi-demo'",
      "UPDATE people SET removed=0 WHERE id='person-multi-demo'",
    ],
    [
      "UPDATE user_churches SET personId='person-family-demo' WHERE userId='user-multi' AND churchId='church-demo'",
      "UPDATE user_churches SET personId='person-multi-demo' WHERE userId='user-multi' AND churchId='church-demo'",
    ],
  ];
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  for (const path of ['/member/v1/me', '/member/v1/household/members', '/member/v1/household']) {
    for (const [change, restore] of cases) {
      const initial = await h.db.prepare('SELECT count(*) n FROM people').first();
      const audits = await h.db.prepare('SELECT count(*) n FROM audit_log').first();
      const householdRead = path === '/member/v1/household';
      const request = new Request('http://localhost/api' + path, {
        method: householdRead ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: householdRead
          ? undefined
          : JSON.stringify(path.endsWith('/me') ? { firstName: 'Must Not Save' } : { first: 'Must Not Create' }),
      });
      const DB = {
        prepare: h.db.prepare.bind(h.db),
        batch: async (statements) => {
          await h.db.prepare(change).run();
          return h.db.batch(statements);
        },
      };
      await assert.rejects(
        api.memberProfile({
          path,
          request,
          url: new URL(request.url),
          env: { DB },
          principal: {
            userId: claims.id,
            churchId: 'church-demo',
            personId: 'person-multi-demo',
            sessionId: claims.sid,
            role: 'member',
          },
        }),
        (error) => error.status === 409,
      );
      await h.db.prepare(restore).run();
      assert.deepEqual(await h.db.prepare('SELECT count(*) n FROM people').first(), initial);
      assert.deepEqual(await h.db.prepare('SELECT count(*) n FROM audit_log').first(), audits);
      assert.notEqual(
        (await h.db.prepare("SELECT firstName FROM people WHERE id='person-multi-demo'").first()).firstName,
        'Must Not Save',
      );
    }
  }
  const request = new Request('http://localhost/api/member/v1/me', {
    method: 'POST',
    body: JSON.stringify({ nickName: 'revoked' }),
  });
  await assert.rejects(
    api.memberProfile({
      path: '/member/v1/me',
      request,
      url: new URL(request.url),
      env: {
        DB: {
          prepare: h.db.prepare.bind(h.db),
          batch: async (statements) => {
            await h.db.prepare('DELETE FROM sessions WHERE id=?').bind(claims.sid).run();
            return h.db.batch(statements);
          },
        },
      },
      principal: {
        userId: claims.id,
        churchId: 'church-demo',
        personId: 'person-multi-demo',
        sessionId: claims.sid,
        role: 'member',
      },
    }),
    (error) => error.status === 409,
  );
  assert.equal((await h.req('/member/v1/me', { token })).status, 401);
  assert.equal((await h.req('/member/v1/me', { token: second })).status, 401);
  assert.equal(
    (await h.req('/membership/churches/select', { method: 'POST', token: second, json: { churchId: 'church-demo' } }))
      .status,
    401,
  );
});

test('queued profile writes and household reads evaluate natural session expiry at D1 execution time', async () => {
  const freshToken = (await h.login('multi-member@example.test')).data.userChurches.find(
    (uc) => uc.church.id === 'church-demo',
  ).jwt;
  const claims = JSON.parse(Buffer.from(freshToken.split('.')[1], 'base64url'));
  const session = await h.db.prepare('SELECT expiresAt FROM sessions WHERE id=?').bind(claims.sid).first();
  const person = await h.db.prepare("SELECT * FROM people WHERE id='person-multi-demo'").first();
  const count = await h.db.prepare('SELECT count(*) n FROM people').first();
  const audits = await h.db.prepare('SELECT count(*) n FROM audit_log').first();
  for (const path of ['/member/v1/me', '/member/v1/household/members', '/member/v1/household']) {
    const read = path === '/member/v1/household';
    const request = new Request('http://localhost/api' + path, {
      method: read ? 'GET' : 'POST',
      body: read
        ? undefined
        : JSON.stringify(path.endsWith('/me') ? { nickName: 'Expired write' } : { first: 'Expired addition' }),
    });
    const DB = {
      prepare: h.db.prepare.bind(h.db),
      batch: async (statements) => {
        // The prepared guard already captured any JavaScript timestamp. Expiry is
        // initially in the future, then occurs while this D1 batch waits its turn.
        const expiry = new Date(Date.now() + 500).toISOString();
        await h.db.prepare('UPDATE sessions SET expiresAt=? WHERE id=?').bind(expiry, claims.sid).run();
        await new Promise((resolve) => setTimeout(resolve, 650));
        const expired = await h.db
          .prepare("SELECT expiresAt<=strftime('%Y-%m-%dT%H:%M:%fZ','now') expired FROM sessions WHERE id=?")
          .bind(claims.sid)
          .first();
        assert.equal(expired.expired, 1);
        return h.db.batch(statements);
      },
    };
    try {
      await assert.rejects(
        api.memberProfile({
          path,
          request,
          url: new URL(request.url),
          env: { DB },
          principal: {
            userId: claims.id,
            churchId: 'church-demo',
            personId: 'person-multi-demo',
            sessionId: claims.sid,
            role: 'member',
          },
        }),
        (error) => error.status === 409,
      );
      assert.deepEqual(await h.db.prepare("SELECT * FROM people WHERE id='person-multi-demo'").first(), person);
      assert.deepEqual(await h.db.prepare('SELECT count(*) n FROM people').first(), count);
      assert.deepEqual(await h.db.prepare('SELECT count(*) n FROM audit_log').first(), audits);
    } finally {
      await h.db.prepare('UPDATE sessions SET expiresAt=? WHERE id=?').bind(session.expiresAt, claims.sid).run();
    }
  }
});
