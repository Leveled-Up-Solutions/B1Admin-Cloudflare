import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
async function ok(r) {
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
test('last administrator linked person cannot be removed, including through direct D1 writes', async () => {
  const h = await createHarness();
  try {
    const admin = (await h.login()).token;
    assert.equal((await h.req('/membership/people/person-admin', { token: admin, method: 'DELETE' })).status, 409);
    await assert.rejects(
      h.db.prepare("UPDATE people SET removed=1 WHERE id='person-admin'").run(),
      /last_bootstrap_administrator/,
    );
    assert.equal((await h.db.prepare("SELECT removed FROM people WHERE id='person-admin'").first()).removed, 0);
    const [ordinary] = await ok(
      await h.req('/membership/people', {
        token: admin,
        method: 'POST',
        json: [{ name: { first: 'Ordinary', last: 'Synthetic' } }],
      }),
    );
    assert.equal((await h.req('/membership/people/' + ordinary.id, { token: admin, method: 'DELETE' })).status, 200);
    assert.equal((await h.db.prepare('SELECT removed FROM people WHERE id=?').bind(ordinary.id).first()).removed, 1);
  } finally {
    await h.dispose();
  }
});
test('removed administrator links never satisfy alternative-admin counts', async () => {
  const h = await createHarness();
  try {
    await h.db.prepare("UPDATE user_churches SET role='admin' WHERE userId='user-viewer'").run();
    await h.db.prepare("UPDATE people SET removed=1 WHERE id='person-jordan'").run();
    for (const sql of [
      "UPDATE people SET removed=1 WHERE id='person-admin'",
      "UPDATE user_churches SET role='member' WHERE userId='user-admin'",
      "DELETE FROM user_churches WHERE userId='user-admin'",
      "UPDATE users SET disabled=1 WHERE id='user-admin'",
      "UPDATE users SET passwordState='pending' WHERE id='user-admin'",
    ])
      await assert.rejects(h.db.prepare(sql).run(), /last_bootstrap_administrator/, sql);
  } finally {
    await h.dispose();
  }
});
test('last-admin link remaps cannot move access to an inactive person or another church', async () => {
  const h = await createHarness();
  try {
    const admin = (await h.login()).token;
    const [removed] = await ok(
      await h.req('/membership/people', {
        token: admin,
        method: 'POST',
        json: [{ name: { first: 'Removed', last: 'Target' } }],
      }),
    );
    await h.db.prepare('UPDATE people SET removed=1 WHERE id=?').bind(removed.id).run();
    await assert.rejects(
      h.db.prepare("UPDATE user_churches SET personId=? WHERE userId='user-admin'").bind(removed.id).run(),
      /last_bootstrap_administrator/,
    );
    await assert.rejects(
      h.db
        .prepare("UPDATE user_churches SET churchId='church-other',personId='person-other' WHERE userId='user-admin'")
        .run(),
      /last_bootstrap_administrator/,
    );
    assert.equal(
      (await h.db.prepare("SELECT personId FROM user_churches WHERE userId='user-admin'").first()).personId,
      'person-admin',
    );
  } finally {
    await h.dispose();
  }
});
test('bulk removal of both active administrators rolls back the entire batch', async () => {
  const h = await createHarness();
  try {
    await h.db.prepare("UPDATE user_churches SET role='admin' WHERE userId='user-viewer'").run();
    await assert.rejects(
      h.db.batch([
        h.db.prepare("UPDATE people SET removed=1 WHERE id='person-jordan'"),
        h.db.prepare("UPDATE people SET removed=1 WHERE id='person-admin'"),
      ]),
      /last_bootstrap_administrator/,
    );
    assert.deepEqual(
      (await h.db.prepare("SELECT removed FROM people WHERE id IN('person-admin','person-jordan')").all()).results,
      [{ removed: 0 }, { removed: 0 }],
    );
    await h.db.prepare("UPDATE people SET removed=1 WHERE id='person-jordan'").run();
    await h.db.prepare("UPDATE people SET removed=0 WHERE id='person-jordan'").run();
    await h.db.prepare("UPDATE user_churches SET role='member' WHERE userId='user-admin'").run();
    assert.equal(
      (await h.db.prepare("SELECT role FROM user_churches WHERE userId='user-admin'").first()).role,
      'member',
    );
  } finally {
    await h.dispose();
  }
});

test('administrator accounts sharing one person cannot authorize removal of that same person', async () => {
  const h = await createHarness();
  try {
    await h.db
      .prepare(
        "UPDATE user_churches SET role='admin',personId='person-admin' WHERE userId='user-viewer' AND churchId='church-demo'",
      )
      .run();
    await assert.rejects(
      h.db.prepare("UPDATE people SET removed=1 WHERE id='person-admin'").run(),
      /last_bootstrap_administrator/,
    );
    assert.equal((await h.db.prepare("SELECT removed FROM people WHERE id='person-admin'").first()).removed, 0);
    // Disabling/deleting one account is still safe while the other shared account works.
    await h.db.prepare("UPDATE users SET disabled=1 WHERE id='user-viewer'").run();
    await h.db.prepare("UPDATE users SET disabled=0 WHERE id='user-viewer'").run();
    await h.db.prepare("DELETE FROM user_churches WHERE userId='user-viewer' AND churchId='church-demo'").run();
    await h.db
      .prepare(
        "INSERT INTO user_churches(userId,churchId,personId,role) VALUES('user-viewer','church-demo','person-admin','admin')",
      )
      .run();
    // A genuinely separate active person restores the alternative-admin path.
    await h.db
      .prepare(
        "UPDATE user_churches SET personId='person-jordan' WHERE userId='user-viewer' AND churchId='church-demo'",
      )
      .run();
    await h.db.prepare("UPDATE people SET removed=1 WHERE id='person-admin'").run();
    assert.equal((await h.db.prepare("SELECT removed FROM people WHERE id='person-admin'").first()).removed, 1);
  } finally {
    await h.dispose();
  }
});
