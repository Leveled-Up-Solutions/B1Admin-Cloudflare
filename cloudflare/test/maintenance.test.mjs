import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';

test('scheduled maintenance expires auth state and records an idempotent job marker', async () => {
  const h = await createHarness();
  try {
    const current = new Date();
    const old = new Date(current.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const future = new Date(current.getTime() + 2 * 60 * 60 * 1000).toISOString();
    const { data } = await h.login();
    for (const [sid, expires] of [
      ['expired-session', old],
      ['valid-session', future],
    ]) {
      await h.db
        .prepare('INSERT INTO sessions(id,userId,expiresAt,createdAt) VALUES(?,?,?,?)')
        .bind(sid, data.user.id, expires, old)
        .run();
      await h.db.prepare('INSERT INTO auth_attempts(id,attempts,expiresAt) VALUES(?,?,?)').bind(sid, 1, expires).run();
    }
    const worker = await h.mf.getWorker();
    assert.equal((await worker.scheduled({ scheduledTime: current, cron: '0 * * * *' })).outcome, 'ok');
    assert.equal(await h.db.prepare('SELECT id FROM sessions WHERE id=?').bind('expired-session').first(), null);
    assert.ok(await h.db.prepare('SELECT id FROM sessions WHERE id=?').bind('valid-session').first());
    assert.equal(await h.db.prepare('SELECT id FROM auth_attempts WHERE id=?').bind('expired-session').first(), null);
    assert.ok(await h.db.prepare('SELECT id FROM auth_attempts WHERE id=?').bind('valid-session').first());
    assert.equal((await worker.scheduled({ scheduledTime: current, cron: '0 * * * *' })).outcome, 'ok');
    assert.equal(
      (await h.db.prepare('SELECT count(*) count FROM job_runs').first()).count,
      1,
      'retry uses the same hourly marker',
    );
  } finally {
    await h.dispose();
  }
});
