import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
test('group details persist; parent relationships reject cross-tenant and cyclic batches atomically', async () => {
  const h = await createHarness();
  try {
    const token = (await h.login()).token;
    const save = (json) => h.req('/membership/groups', { token, method: 'POST', json });
    let r = await save([
      { id: 'parent-test', name: 'Parent' },
      { id: 'child-test', name: 'Child' },
    ]);
    assert.equal(r.status, 200);
    r = await save([
      {
        id: 'child-test',
        parentId: 'parent-test',
        meetingTime: 'Sunday 09:00',
        meetingLocation: 'Synthetic room',
        archived: true,
        joinPolicy: 'request',
      },
    ]);
    assert.equal(r.status, 200);
    const [saved] = await r.json();
    assert.equal(saved.meetingLocation, 'Synthetic room');
    assert.equal(saved.archived, true);
    const loaded = await (await h.req('/membership/groups/child-test', { token })).json();
    assert.equal(loaded.parentId, 'parent-test');
    assert.equal(loaded.meetingTime, 'Sunday 09:00');
    r = await save([{ id: 'parent-test', parentId: 'child-test', name: 'Must roll back' }]);
    assert.equal(r.status, 409);
    assert.equal((await (await h.req('/membership/groups/parent-test', { token })).json()).name, 'Parent');
    assert.equal((await save([{ id: 'parent-test', parentId: 'parent-test' }])).status, 400);
    assert.equal((await save([{ id: 'parent-test', parentId: 'group-other' }])).status, 400);
    // Both changes are valid in isolation. The database guard catches a cycle introduced within one batch.
    assert.equal(
      (
        await save([
          { id: 'cycle-a', name: 'A' },
          { id: 'cycle-b', name: 'B' },
        ])
      ).status,
      200,
    );
    assert.equal(
      (
        await save([
          { id: 'cycle-a', parentId: 'cycle-b' },
          { id: 'cycle-b', parentId: 'cycle-a' },
        ])
      ).status,
      409,
    );
    assert.equal((await (await h.req('/membership/groups/cycle-a', { token })).json()).parentId, null);
    assert.ok(
      !(await (await h.req('/membership/groups/tag/standard', { token })).json()).some((g) => g.id === 'child-test'),
    );
    assert.deepEqual(
      (await (await h.req('/membership/groups?archived=1', { token })).json()).map((g) => g.id),
      ['child-test'],
    );
  } finally {
    await h.dispose();
  }
});
