import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHarness } from './harness.mjs';

const bundle = await build({
  stdin: {
    contents:
      "export { authenticate } from './src/auth.ts'; export { memberApprovals } from './src/member-approvals.ts';",
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
});
const { authenticate, memberApprovals } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);
const base = '/member/v1/profile-requests';
const change = { kind: 'family-edit', personId: 'person-family-demo', changes: { mobilePhone: '555-0199' } };

async function fixture({ submit = true } = {}) {
  const h = await createHarness();
  try {
    await h.db.batch([
      h.db
        .prepare("UPDATE churches SET settings=? WHERE id='church-demo'")
        .bind(JSON.stringify({ directoryApprovalGroupId: 'group-welcome' })),
      h.db
        .prepare("UPDATE people SET contactInfo=? WHERE id='person-family-demo'")
        .bind(JSON.stringify({ mobilePhone: '555-0100', address1: 'Private baseline address' })),
      h.db.prepare("INSERT INTO roles(id,churchId,name) VALUES('reviewer','church-demo','Directory reviewer')"),
      h.db.prepare(
        "INSERT INTO role_permissions(id,churchId,roleId,apiName,contentType,contentId,action) VALUES('review-people','church-demo','reviewer','MembershipApi','People','','Edit')",
      ),
      h.db.prepare(
        "INSERT INTO role_members(id,churchId,roleId,userId,addedBy,dateAdded) VALUES('review-member','church-demo','reviewer','user-member','user-admin','2026-01-01')",
      ),
    ]);
    const requester = (await h.login('multi-member@example.test')).data.userChurches.find(
      (c) => c.church.id === 'church-demo',
    ).jwt;
    const reviewer = (await h.login('member@example.test')).token;
    let record;
    if (submit) {
      const response = await h.req(base, { method: 'POST', token: requester, json: change });
      assert.equal(response.status, 201, await response.clone().text());
      record = await response.json();
      assert.ok(!JSON.stringify(record).includes('Private baseline address'));
      assert.ok(!JSON.stringify(record).includes('555-0100'));
    }
    const env = { DB: h.db, SESSION_SECRET: 'test-only-secret-never-for-deployment-123456789' };
    async function race({ create = false, competingWrite }) {
      const path = create ? base : `${base}/${record.id}/approve`;
      const request = new Request('http://localhost/api' + path, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + (create ? requester : reviewer), 'Content-Type': 'application/json' },
        body: JSON.stringify(create ? change : {}),
      });
      const principal = await authenticate(request, env);
      const auditsBefore = (await h.db.prepare('SELECT count(*) n FROM audit_log').first()).n;
      const tasksBefore = (await h.db.prepare('SELECT count(*) n FROM tasks').first()).n;
      let intercepted = 0;
      const db = {
        prepare: (...args) => h.db.prepare(...args),
        batch: async (statements) => {
          intercepted++;
          assert.equal(intercepted, 1);
          await competingWrite();
          return h.db.batch(statements);
        },
      };
      await assert.rejects(
        memberApprovals({ request, url: new URL(request.url), path, principal, env: { ...env, DB: db } }),
        (error) => error.status === 409,
      );
      assert.equal(intercepted, 1, 'Transition executes after preflight and before the write transaction');
      assert.equal((await h.db.prepare('SELECT count(*) n FROM write_guards').first()).n, 0);
      assert.equal((await h.db.prepare('SELECT count(*) n FROM audit_log').first()).n, auditsBefore);
      assert.equal((await h.db.prepare('SELECT count(*) n FROM tasks').first()).n, tasksBefore);
      if (record) {
        assert.equal(
          (await h.db.prepare('SELECT status FROM member_change_requests WHERE id=?').bind(record.id).first()).status,
          'pending',
        );
        assert.equal(
          (await h.db.prepare('SELECT status FROM tasks WHERE id=?').bind(record.taskId).first()).status,
          'Open',
        );
      } else {
        assert.equal((await h.db.prepare('SELECT count(*) n FROM member_change_requests').first()).n, 0);
      }
    }
    return { h, requester, reviewer, record, race };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}

test('review permission or review-group membership revoked after preflight prevents approval', async () => {
  for (const sql of [
    "DELETE FROM role_permissions WHERE id='review-people'",
    "DELETE FROM group_members WHERE personId='person-alex' AND groupId='group-welcome'",
  ]) {
    const f = await fixture();
    try {
      await f.race({ competingWrite: () => f.h.db.prepare(sql).run() });
      assert.equal(
        JSON.parse(
          (await f.h.db.prepare("SELECT contactInfo FROM people WHERE id='person-family-demo'").first()).contactInfo,
        ).mobilePhone,
        '555-0100',
      );
    } finally {
      await f.h.dispose();
    }
  }
});

test('reviewer logout, expiry, removal and identity relinking invalidate a queued approval', async () => {
  for (const sql of [
    "DELETE FROM sessions WHERE userId='user-member'",
    "UPDATE sessions SET expiresAt='2000-01-01T00:00:00.000Z' WHERE userId='user-member'",
    "UPDATE people SET removed=1 WHERE id='person-alex'",
    "UPDATE user_churches SET personId='person-family-demo' WHERE userId='user-member' AND churchId='church-demo'",
  ]) {
    const f = await fixture();
    try {
      await f.race({ competingWrite: () => f.h.db.prepare(sql).run() });
    } finally {
      await f.h.dispose();
    }
  }
});

test('requester household movement, account relinking or disablement prevents applying an old family request', async () => {
  for (const sql of [
    "UPDATE people SET householdId='household-demo' WHERE id='person-multi-demo'",
    "UPDATE user_churches SET personId='person-alex' WHERE userId='user-multi' AND churchId='church-demo'",
    "UPDATE users SET disabled=1 WHERE id='user-multi'",
  ]) {
    const f = await fixture();
    try {
      await f.race({ competingWrite: () => f.h.db.prepare(sql).run() });
    } finally {
      await f.h.dispose();
    }
  }
});

test('target household, linked-account and relevant-field snapshots are checked in the approval transaction', async () => {
  for (const sql of [
    "UPDATE people SET householdId='household-demo' WHERE id='person-family-demo'",
    "UPDATE user_churches SET personId='person-family-demo' WHERE userId='user-viewer' AND churchId='church-demo'",
    "UPDATE people SET contactInfo=json_set(contactInfo,'$.mobilePhone','555-0155') WHERE id='person-family-demo'",
  ]) {
    const f = await fixture();
    try {
      await f.race({ competingWrite: () => f.h.db.prepare(sql).run() });
      const phone = JSON.parse(
        (await f.h.db.prepare("SELECT contactInfo FROM people WHERE id='person-family-demo'").first()).contactInfo,
      ).mobilePhone;
      assert.notEqual(phone, '555-0199');
    } finally {
      await f.h.dispose();
    }
  }
});

test('policy changed after approval preflight cannot be bypassed by the old reviewer route', async () => {
  const f = await fixture();
  try {
    await f.race({
      competingWrite: () => f.h.db.prepare("UPDATE churches SET settings='[]' WHERE id='church-demo'").run(),
    });
  } finally {
    await f.h.dispose();
  }
});

test('submission races cannot leave a task or private request after authority changes', async () => {
  for (const sql of [
    "UPDATE people SET householdId='household-demo' WHERE id='person-multi-demo'",
    "DELETE FROM sessions WHERE userId='user-multi'",
    "UPDATE churches SET settings='[]' WHERE id='church-demo'",
    "UPDATE user_churches SET personId='person-family-demo' WHERE userId='user-viewer' AND churchId='church-demo'",
  ]) {
    const f = await fixture({ submit: false });
    try {
      await f.race({ create: true, competingWrite: () => f.h.db.prepare(sql).run() });
    } finally {
      await f.h.dispose();
    }
  }
});

test('requester logout after submission does not defeat an otherwise authorized asynchronous approval', async () => {
  const f = await fixture();
  try {
    await f.h.db.prepare("DELETE FROM sessions WHERE userId='user-multi'").run();
    const response = await f.h.req(`${base}/${f.record.id}/approve`, { method: 'POST', token: f.reviewer, json: {} });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).status, 'approved');
    assert.equal(
      JSON.parse(
        (await f.h.db.prepare("SELECT contactInfo FROM people WHERE id='person-family-demo'").first()).contactInfo,
      ).mobilePhone,
      '555-0199',
    );
  } finally {
    await f.h.dispose();
  }
});
