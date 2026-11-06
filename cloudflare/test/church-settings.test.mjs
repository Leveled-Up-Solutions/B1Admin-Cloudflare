import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHarness } from './harness.mjs';
test('church settings allow only the current tenant and validated editable fields', async () => {
  const h = await createHarness();
  try {
    const admin = (await h.login()).token,
      viewer = (await h.login('viewer@example.test')).token;
    const save = (json, token = admin) => h.req('/membership/churches', { token, method: 'POST', json });
    assert.equal(
      (
        await save([
          {
            id: 'church-demo',
            name: 'Synthetic Church',
            timeZone: 'America/Chicago',
          },
        ])
      ).status,
      200,
    );
    const church = await (await h.req('/membership/churches/current', { token: admin })).json();
    assert.equal(church.name, 'Synthetic Church');
    assert.equal(church.timeZone, 'America/Chicago');
    assert.equal((await save([{ id: 'church-demo', timeZone: 'Mars/Olympus' }])).status, 400);
    assert.equal((await save([{ id: 'church-other', timeZone: 'UTC' }])).status, 403);
    assert.equal((await save([{ id: 'church-demo', timeZone: 'UTC' }], viewer)).status, 403);
    assert.equal((await save([{ id: 'church-demo', subDomain: 'replacement' }])).status, 400);
    assert.equal((await save([{ id: 'church-demo', settings: [{ key: 'sensitive', value: 'bad' }] }])).status, 400);
    assert.equal((await save([{ id: 'church-demo', directoryApprovalGroupId: 'group-welcome' }])).status, 200);
    assert.equal(
      (await (await h.req('/membership/churches/current', { token: admin })).json()).directoryApprovalGroupId,
      'group-welcome',
    );
    assert.equal((await save([{ id: 'church-demo', directoryApprovalGroupId: '' }])).status, 200);
    assert.equal(
      (await (await h.req('/membership/churches/current', { token: admin })).json()).directoryApprovalGroupId,
      '',
    );
    assert.ok(
      await h.db.prepare("SELECT id FROM audit_log WHERE action='churches.save' AND churchId='church-demo'").first(),
    );
  } finally {
    await h.dispose();
  }
});

async function data(response) {
  assert.ok(response.ok, `${response.status} ${await response.clone().text()}`);
  return response.json();
}
async function settingsRole(h, admin) {
  const [role] = await data(
    await h.req('/membership/roles', { token: admin, method: 'POST', json: [{ name: 'Church settings only' }] }),
  );
  const [permission] = await data(
    await h.req('/membership/rolepermissions', {
      token: admin,
      method: 'POST',
      json: [{ roleId: role.id, apiName: 'MembershipApi', contentType: 'Settings', action: 'Edit' }],
    }),
  );
  await data(
    await h.req('/membership/rolemembers', {
      token: admin,
      method: 'POST',
      json: [{ roleId: role.id, personId: 'person-alex' }],
    }),
  );
  return { role, permission };
}

test('review policy preserves array/object settings, validates target groups, and never accepts raw settings', async () => {
  const h = await createHarness();
  try {
    const admin = (await h.login()).token;
    const save = (value) =>
      h.req('/membership/churches', {
        token: admin,
        method: 'POST',
        json: [{ id: 'church-demo', directoryApprovalGroupId: value }],
      });
    const representations = [
      { enabledFeature: { retained: true }, directoryApprovalGroupId: 'old-value', otherNumber: 17 },
      [
        { keyName: 'retained', value: { nested: true } },
        { id: 'old-setting-id', keyName: 'directoryApprovalGroupId', value: 'old-value', retainedMetadata: 'yes' },
        { keyName: 'directoryApprovalGroupId', value: 'duplicate' },
        { keyName: 'other', value: 17 },
      ],
    ];
    for (const settings of representations) {
      await h.db
        .prepare('UPDATE churches SET settings=? WHERE id=?')
        .bind(JSON.stringify(settings), 'church-demo')
        .run();
      await data(await save('group-welcome'));
      const stored = JSON.parse(
        (await h.db.prepare("SELECT settings FROM churches WHERE id='church-demo'").first()).settings,
      );
      assert.equal(Array.isArray(stored), Array.isArray(settings));
      if (Array.isArray(stored)) {
        assert.deepEqual(
          stored.filter((entry) => entry.keyName !== 'directoryApprovalGroupId'),
          settings.filter((entry) => entry.keyName !== 'directoryApprovalGroupId'),
        );
        assert.deepEqual(
          stored.filter((entry) => entry.keyName === 'directoryApprovalGroupId'),
          [
            {
              id: 'old-setting-id',
              keyName: 'directoryApprovalGroupId',
              value: 'group-welcome',
              retainedMetadata: 'yes',
            },
          ],
        );
      } else assert.deepEqual(stored, { ...settings, directoryApprovalGroupId: 'group-welcome' });
      await data(await save(''));
      assert.equal(
        (await data(await h.req('/membership/churches/current', { token: admin }))).directoryApprovalGroupId,
        '',
      );
    }
    await h.db
      .prepare(
        "INSERT INTO groups(id,churchId,name,archived) VALUES('settings-archived','church-demo','Archived fixture',1),('settings-foreign','church-other','Foreign fixture',0)",
      )
      .run();
    const before = await h.db.prepare("SELECT * FROM churches WHERE id='church-demo'").first();
    for (const value of [
      'settings-archived',
      'settings-foreign',
      'missing-group',
      null,
      true,
      {},
      'x'.repeat(129),
      'group\nwelcome',
    ])
      assert.equal((await save(value)).status, 400, JSON.stringify(value));
    assert.deepEqual(await h.db.prepare("SELECT * FROM churches WHERE id='church-demo'").first(), before);
    assert.equal(
      (
        await h.req('/membership/churches', {
          token: admin,
          method: 'POST',
          json: [{ id: 'church-demo', settings: {} }],
        })
      ).status,
      400,
    );
    await h.db.prepare("UPDATE churches SET settings='null' WHERE id='church-demo'").run();
    assert.equal((await save('group-welcome')).status, 409);
    assert.equal((await h.db.prepare("SELECT settings FROM churches WHERE id='church-demo'").first()).settings, 'null');
  } finally {
    await h.dispose();
  }
});

test('Settings Edit alone exposes a narrow current-tenant group selector without directory or Groups View authority', async () => {
  const h = await createHarness();
  try {
    const admin = (await h.login()).token,
      member = (await h.login('member@example.test')).token,
      viewer = (await h.login('viewer@example.test')).token;
    const path = '/membership/churches/directoryReviewGroups';
    assert.equal((await h.req(path, { token: member })).status, 403);
    assert.equal((await h.req(path, { token: viewer })).status, 403);
    await settingsRole(h, admin);
    await h.db
      .prepare(
        "INSERT INTO groups(id,churchId,name,archived,about) VALUES('settings-only-private','church-demo','Private review group',0,'Do not disclose'),('settings-only-archived','church-demo','Archived group',1,'Hidden'),('settings-only-foreign','church-other','Foreign group',0,'Hidden')",
      )
      .run();
    const groups = await data(await h.req(path, { token: member }));
    assert.ok(groups.some((group) => group.id === 'settings-only-private'));
    assert.ok(groups.every((group) => Object.keys(group).sort().join(',') === 'id,name'));
    assert.ok(groups.every((group) => !['settings-only-archived', 'settings-only-foreign'].includes(group.id)));
    assert.equal((await h.req('/membership/groups', { token: member })).status, 403);
    assert.equal((await h.req('/membership/people', { token: member })).status, 403);
    const saved = await data(
      await h.req('/membership/churches', {
        token: member,
        method: 'POST',
        json: [{ id: 'church-demo', directoryApprovalGroupId: 'settings-only-private' }],
      }),
    );
    assert.equal(saved[0].directoryApprovalGroupId, 'settings-only-private');
  } finally {
    await h.dispose();
  }
});

test('queued church settings writes recheck current grant, session, active identity, previous settings and target group atomically', async () => {
  const h = await createHarness();
  try {
    const admin = (await h.login()).token,
      member = (await h.login('member@example.test')).token;
    const { permission } = await settingsRole(h, admin);
    const claims = JSON.parse(Buffer.from(member.split('.')[1], 'base64url'));
    const compiled = await build({
      entryPoints: [new URL('../src/membership.ts', import.meta.url).pathname],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
    });
    const api = await import(
      'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
    );
    const session = await h.db.prepare('SELECT * FROM sessions WHERE id=?').bind(claims.sid).first();
    const grant = await h.db.prepare('SELECT * FROM role_permissions WHERE id=?').bind(permission.id).first();
    const cases = [
      [
        () => h.db.prepare('DELETE FROM role_permissions WHERE id=?').bind(permission.id).run(),
        () =>
          h.db
            .prepare(
              'INSERT INTO role_permissions(id,churchId,roleId,apiName,contentType,contentId,action) VALUES(?,?,?,?,?,?,?)',
            )
            .bind(
              grant.id,
              grant.churchId,
              grant.roleId,
              grant.apiName,
              grant.contentType,
              grant.contentId,
              grant.action,
            )
            .run(),
      ],
      [
        () => h.db.prepare("UPDATE people SET removed=1 WHERE id='person-alex'").run(),
        () => h.db.prepare("UPDATE people SET removed=0 WHERE id='person-alex'").run(),
      ],
      [
        () =>
          h.db
            .prepare(
              "UPDATE user_churches SET personId='person-family-demo' WHERE userId='user-member' AND churchId='church-demo'",
            )
            .run(),
        () =>
          h.db
            .prepare(
              "UPDATE user_churches SET personId='person-alex' WHERE userId='user-member' AND churchId='church-demo'",
            )
            .run(),
      ],
      [
        () => h.db.prepare("UPDATE users SET passwordVersion=passwordVersion+1 WHERE id='user-member'").run(),
        () => h.db.prepare("UPDATE users SET passwordVersion=passwordVersion-1 WHERE id='user-member'").run(),
      ],
      [
        () =>
          h.db.prepare('UPDATE sessions SET expiresAt=? WHERE id=?').bind('2000-01-01T00:00:00.000Z', claims.sid).run(),
        () => h.db.prepare('UPDATE sessions SET expiresAt=? WHERE id=?').bind(session.expiresAt, claims.sid).run(),
      ],
      [
        () => h.db.prepare("UPDATE churches SET settings='{\"concurrentSetting\":true}' WHERE id='church-demo'").run(),
        () => h.db.prepare("UPDATE churches SET settings='[]' WHERE id='church-demo'").run(),
      ],
      [
        () => h.db.prepare("UPDATE churches SET name='Concurrent church name' WHERE id='church-demo'").run(),
        () => h.db.prepare("UPDATE churches SET name='Demo Church' WHERE id='church-demo'").run(),
      ],
      [
        () => h.db.prepare("UPDATE groups SET archived=1 WHERE id='group-welcome'").run(),
        () => h.db.prepare("UPDATE groups SET archived=0 WHERE id='group-welcome'").run(),
      ],
    ];
    for (const [change, restore] of cases) {
      const audits = await h.db.prepare("SELECT count(*) n FROM audit_log WHERE action='churches.save'").first();
      let concurrent;
      const request = new Request('http://localhost/api/membership/churches', {
        method: 'POST',
        body: JSON.stringify([{ id: 'church-demo', name: 'Must not save', directoryApprovalGroupId: 'group-welcome' }]),
      });
      try {
        await assert.rejects(
          api.membership({
            path: '/membership/churches',
            request,
            url: new URL(request.url),
            principal: {
              churchId: 'church-demo',
              userId: claims.id,
              personId: 'person-alex',
              sessionId: claims.sid,
              role: 'viewer',
              permissions: ['MembershipApi_Settings__Edit'],
            },
            env: {
              DB: {
                prepare: h.db.prepare.bind(h.db),
                batch: async (statements) => {
                  await change();
                  concurrent = await h.db.prepare("SELECT * FROM churches WHERE id='church-demo'").first();
                  return h.db.batch(statements);
                },
              },
            },
          }),
          /constraint failed/i,
        );
        assert.deepEqual(await h.db.prepare("SELECT * FROM churches WHERE id='church-demo'").first(), concurrent);
        assert.deepEqual(
          await h.db.prepare("SELECT count(*) n FROM audit_log WHERE action='churches.save'").first(),
          audits,
        );
      } finally {
        await restore();
      }
    }
  } finally {
    await h.dispose();
  }
});
