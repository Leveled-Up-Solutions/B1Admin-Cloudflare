import test from 'node:test';
import assert from 'node:assert/strict';
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
    assert.ok(
      await h.db.prepare("SELECT id FROM audit_log WHERE action='churches.save' AND churchId='church-demo'").first(),
    );
  } finally {
    await h.dispose();
  }
});
