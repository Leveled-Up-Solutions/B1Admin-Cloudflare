import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash, scryptSync } from 'node:crypto';
import { createHarness } from './harness.mjs';
let h, admin, viewer;
const strong = 'Synthetic invitation passphrase 2026!';
test.before(async () => {
  h = await createHarness();
  admin = (await h.login()).token;
  viewer = (await h.login('viewer@example.test')).token;
});
test.after(async () => h?.dispose());
async function data(response) {
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function person(email) {
  return (
    await data(
      await h.req('/membership/people', {
        method: 'POST',
        token: admin,
        json: [
          {
            name: { first: 'Invitation', last: 'Fixture' },
            contactInfo: { email },
          },
        ],
      }),
    )
  )[0];
}
async function issue(p, extra = {}) {
  const response = await h.req('/membership/users/invitations', {
    method: 'POST',
    token: admin,
    json: { personId: p.id, ...extra },
  });
  const value = await data(response);
  return {
    ...value,
    authGuid: new URL(value.invitationUrl, 'https://local.test').searchParams.get('auth'),
  };
}
async function preview(authGuid) {
  return h.req('/membership/users/invitations/preview', {
    method: 'POST',
    json: { authGuid },
  });
}
async function accept(authGuid, newPassword = strong) {
  return h.req('/membership/users/setPasswordGuid', {
    method: 'POST',
    json: { authGuid, newPassword },
  });
}
async function login(email, password) {
  return h.req('/membership/users/login', {
    method: 'POST',
    json: { email, password },
  });
}
test('manual invitation issuance requires bootstrap administrator and exact tenant person', async () => {
  const p = await person('invite-one@example.test');
  assert.equal(
    (
      await h.req('/membership/users/invitations', {
        method: 'POST',
        token: viewer,
        json: { personId: p.id },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await h.req('/membership/users/invitations', {
        method: 'POST',
        token: admin,
        json: { personId: 'person-other' },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await h.req('/membership/users/invitations', {
        method: 'POST',
        token: admin,
        json: { personId: p.id, role: 'admin' },
      })
    ).status,
    400,
  );
  const invitation = await issue(p);
  assert.equal(invitation.mode, 'setPassword');
  assert.equal(invitation.delivery, 'manual');
  const row = await h.db.prepare('SELECT * FROM auth_invitations WHERE id=?').bind(invitation.id).first();
  assert.notEqual(row.tokenHash, invitation.authGuid);
  assert.equal(row.tokenHash, createHash('sha256').update(invitation.authGuid).digest('base64url'));
  assert.ok(!JSON.stringify(row).includes(invitation.authGuid));
  const display = await data(await preview(invitation.authGuid));
  assert.deepEqual(Object.keys(display).sort(), ['expiresAt', 'mode']);
  const listed = await data(
    await h.req('/membership/users/invitations?personId=' + p.id, {
      token: admin,
    }),
  );
  assert.ok(!JSON.stringify(listed).includes(invitation.authGuid));
  assert.ok(!JSON.stringify(listed).includes(row.tokenHash));
  assert.equal(await h.db.prepare('SELECT userId FROM user_churches WHERE personId=?').bind(p.id).first(), null);
  assert.equal((await login('invite-one@example.test', strong)).status, 401);
});
test('new password setup claims once, hashes with scrypt and grants only the requested custom role', async () => {
  const p = await person('invite-setup@example.test');
  const [role] = await data(
    await h.req('/membership/roles', {
      method: 'POST',
      token: admin,
      json: [{ name: 'Invitation directory readers' }],
    }),
  );
  await data(
    await h.req('/membership/rolepermissions', {
      method: 'POST',
      token: admin,
      json: [
        {
          roleId: role.id,
          apiName: 'MembershipApi',
          contentType: 'People',
          action: 'View',
        },
      ],
    }),
  );
  const invitation = await issue(p, { roleId: role.id });
  assert.equal((await accept(invitation.authGuid, 'short')).status, 400);
  const responses = await Promise.all([accept(invitation.authGuid), accept(invitation.authGuid)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400]);
  const signed = await data(await login('invite-setup@example.test', strong));
  assert.equal(signed.userChurches[0].role, 'member');
  assert.equal((await h.req('/membership/people', { token: signed.userChurches[0].jwt })).status, 200);
  const user = await h.db.prepare('SELECT * FROM users WHERE email=?').bind('invite-setup@example.test').first();
  assert.equal(user.passwordState, 'active');
  assert.equal(user.passwordVersion, 1);
  assert.match(user.passwordHash, /^scrypt\$32768\$8\$3\$/);
  const [, N, r, pFactor, salt, hash] = user.passwordHash.split('$');
  const expected = scryptSync(strong, Buffer.from(salt, 'base64url'), 32, {
    N: Number(N),
    r: Number(r),
    p: Number(pFactor),
    maxmem: 40 * 1024 * 1024,
  });
  assert.equal(expected.toString('base64url'), hash);
  assert.equal((await accept(invitation.authGuid)).status, 400);
  assert.equal((await preview(invitation.authGuid)).status, 400);
  const count = await h.db
    .prepare('SELECT count(*) n FROM role_members WHERE userId=? AND roleId=?')
    .bind(user.id, role.id)
    .first();
  assert.equal(count.n, 1);
});
test('reissue, revoke, expiry and person changes invalidate invitation tokens', async () => {
  const p = await person('invite-reissue@example.test');
  const first = await issue(p),
    second = await issue(p);
  assert.equal((await preview(first.authGuid)).status, 400);
  assert.equal(
    (
      await h.req('/membership/users/invitations/' + second.id, {
        method: 'DELETE',
        token: admin,
      })
    ).status,
    200,
  );
  assert.equal((await accept(second.authGuid)).status, 400);
  const expired = await issue(p);
  await h.db
    .prepare(
      "UPDATE auth_invitations SET createdAt='2020-01-01T00:00:00.000Z',expiresAt='2020-01-02T00:00:00.000Z' WHERE id=?",
    )
    .bind(expired.id)
    .run();
  assert.equal((await preview(expired.authGuid)).status, 400);
  const changed = await issue(p);
  await h.db.prepare("UPDATE people SET email='changed@example.test' WHERE id=?").bind(p.id).run();
  await h.db.prepare("UPDATE people SET email='invite-reissue@example.test' WHERE id=?").bind(p.id).run();
  assert.equal((await accept(changed.authGuid)).status, 400);
});
test('existing-account linking requires its current password and never resets it', async () => {
  const p = await person('other@example.test');
  const invitation = await issue(p);
  assert.equal(invitation.mode, 'link');
  assert.equal((await accept(invitation.authGuid)).status, 400);
  assert.equal(
    (
      await h.req('/membership/users/acceptInvitation', {
        method: 'POST',
        json: { authGuid: invitation.authGuid, currentPassword: 'wrong' },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await h.req('/membership/users/acceptInvitation', {
        method: 'POST',
        json: {
          authGuid: invitation.authGuid,
          currentPassword: 'LocalDemo2026!',
        },
      })
    ).status,
    200,
  );
  const signed = await data(await login('other@example.test', 'LocalDemo2026!'));
  assert.equal(signed.userChurches.length, 2);
  assert.equal(signed.userChurches.find((c) => c.church.id === 'church-demo').role, 'member');
  assert.equal((await login('other@example.test', strong)).status, 401);
});
test('password change checks the current password, revokes every session and invalidates user JWT refresh', async () => {
  const p = await person('invite-password@example.test');
  const invitation = await issue(p);
  await data(await accept(invitation.authGuid));
  const first = await data(await login('invite-password@example.test', strong)),
    second = await data(await login('invite-password@example.test', strong)),
    token = first.userChurches[0].jwt;
  assert.equal(
    (
      await h.req('/membership/users/updatePassword', {
        method: 'POST',
        token,
        json: { currentPassword: 'wrong', newPassword: strong + ' changed' },
      })
    ).status,
    400,
  );
  assert.equal((await h.req('/member/v1/me', { token })).status, 200);
  const changed = await data(
    await h.req('/membership/users/updatePassword', {
      method: 'POST',
      token,
      json: { currentPassword: strong, newPassword: strong + ' changed' },
    }),
  );
  assert.equal(changed.sessionsRevoked, true);
  assert.equal('passwordHash' in changed, false);
  for (const value of [token, second.userChurches[0].jwt])
    assert.equal((await h.req('/member/v1/me', { token: value })).status, 401);
  assert.equal(
    (
      await h.req('/membership/users/login', {
        method: 'POST',
        json: { jwt: first.user.jwt },
      })
    ).status,
    401,
  );
  assert.equal((await login('invite-password@example.test', strong)).status, 401);
  assert.equal((await login('invite-password@example.test', strong + ' changed')).status, 200);
});
test('issuer demotion permanently revokes outstanding invitations and last admin is protected', async () => {
  const p = await person('invite-demotion@example.test'),
    invitation = await issue(p);
  await assert.rejects(
    h.db.prepare("UPDATE user_churches SET role='viewer' WHERE userId='user-admin' AND churchId='church-demo'").run(),
    /last_bootstrap_administrator/,
  );
  await h.db
    .prepare("UPDATE user_churches SET role='admin' WHERE userId='user-viewer' AND churchId='church-demo'")
    .run();
  await h.db
    .prepare("UPDATE user_churches SET role='viewer' WHERE userId='user-admin' AND churchId='church-demo'")
    .run();
  await h.db
    .prepare("UPDATE user_churches SET role='admin' WHERE userId='user-admin' AND churchId='church-demo'")
    .run();
  assert.equal((await accept(invitation.authGuid)).status, 400);
  await h.db
    .prepare("UPDATE user_churches SET role='viewer' WHERE userId='user-viewer' AND churchId='church-demo'")
    .run();
  await assert.rejects(
    h.db.prepare("UPDATE users SET disabled=1 WHERE id='user-admin'").run(),
    /last_bootstrap_administrator/,
  );
});
test('bootstrap is a single atomic local-only operation and cannot overwrite an installation', async () => {
  const isolated = await createHarness({ seed: false });
  try {
    const token = randomBytes(32).toString('base64url'),
      hash = createHash('sha256').update(token).digest('base64url'),
      created = new Date().toISOString(),
      expires = new Date(Date.now() + 3600000).toISOString();
    const statement = () =>
      isolated.db
        .prepare(
          'INSERT INTO auth_bootstrap(id,churchId,personId,userId,invitationId,churchName,subDomain,email,firstName,lastName,tokenHash,createdAt,expiresAt) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          'bootstrap-church',
          'bootstrap-person',
          'bootstrap-user',
          'bootstrap-invite',
          'Synthetic Bootstrap',
          'bootstrap',
          'bootstrap@example.test',
          'Bootstrap',
          'Fixture',
          hash,
          created,
          expires,
        );
    await statement().run();
    await assert.rejects(statement().run(), /empty installation/);
    const preview = await isolated.req('/membership/users/invitations/preview', {
      method: 'POST',
      json: { authGuid: token },
    });
    assert.equal(preview.status, 200);
    assert.equal(
      (
        await isolated.req('/membership/users/setPasswordGuid', {
          method: 'POST',
          json: { authGuid: token, newPassword: strong },
        })
      ).status,
      200,
    );
    const signed = await data(
      await isolated.req('/membership/users/login', {
        method: 'POST',
        json: { email: 'bootstrap@example.test', password: strong },
      }),
    );
    assert.equal(signed.userChurches[0].role, 'admin');
    assert.equal(
      (
        await isolated.req('/membership/bootstrap', {
          method: 'POST',
          json: {},
        })
      ).status,
      401,
    );
  } finally {
    await isolated.dispose();
  }
});
test('another church cannot activate a pending bootstrap administrator through a replacement invitation', async () => {
  const isolated = await createHarness({ seed: false });
  try {
    const token = randomBytes(32).toString('base64url'),
      hash = createHash('sha256').update(token).digest('base64url'),
      created = new Date().toISOString(),
      expires = new Date(Date.now() + 3600000).toISOString();
    await isolated.db
      .prepare(
        'INSERT INTO auth_bootstrap(id,churchId,personId,userId,invitationId,churchName,subDomain,email,firstName,lastName,tokenHash,createdAt,expiresAt) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        'pending-church',
        'pending-person',
        'pending-user',
        'pending-invite',
        'Pending Synthetic Church',
        'pending',
        'pending-admin@example.test',
        'Pending',
        'Admin',
        hash,
        created,
        expires,
      )
      .run();
    const seedHash = (await h.db.prepare("SELECT passwordHash FROM users WHERE id='user-admin'").first()).passwordHash;
    await isolated.db.batch([
      isolated.db.prepare(
        "INSERT INTO churches(id,name,subDomain) VALUES('attacker-church','Other Synthetic Church','other-synthetic')",
      ),
      isolated.db
        .prepare(
          "INSERT INTO people(id,churchId,firstName,lastName,email,dateAdded) VALUES('attacker-person','attacker-church','Other','Admin','other-admin@example.test',?)",
        )
        .bind(created),
      isolated.db
        .prepare(
          "INSERT INTO people(id,churchId,firstName,lastName,email,dateAdded) VALUES('target-person','attacker-church','Pending','Admin','pending-admin@example.test',?)",
        )
        .bind(created),
      isolated.db
        .prepare(
          "INSERT INTO users(id,email,firstName,lastName,passwordHash) VALUES('attacker-user','other-admin@example.test','Other','Admin',?)",
        )
        .bind(seedHash),
      isolated.db.prepare(
        "INSERT INTO user_churches(userId,churchId,personId,role) VALUES('attacker-user','attacker-church','attacker-person','admin')",
      ),
    ]);
    const signed = await data(
      await isolated.req('/membership/users/login', {
        method: 'POST',
        json: { email: 'other-admin@example.test', password: 'LocalDemo2026!' },
      }),
    );
    assert.equal(
      (
        await isolated.req('/membership/users/invitations', {
          method: 'POST',
          token: signed.userChurches[0].jwt,
          json: { personId: 'target-person' },
        })
      ).status,
      409,
    );
    // Defense in depth also rejects a preexisting stale ordinary token pointing at a linked pending account.
    const stale = randomBytes(32).toString('base64url');
    await isolated.db
      .prepare(
        "INSERT INTO auth_invitations(id,tokenHash,churchId,personId,userId,email,mode,passwordVersion,createdBy,createdAt,expiresAt) VALUES('stale-cross-church',?,'attacker-church','target-person','pending-user','pending-admin@example.test','setPassword',0,'attacker-user',?,?)",
      )
      .bind(createHash('sha256').update(stale).digest('base64url'), created, expires)
      .run();
    assert.equal(
      (
        await isolated.req('/membership/users/setPasswordGuid', {
          method: 'POST',
          json: { authGuid: stale, newPassword: strong + ' takeover' },
        })
      ).status,
      400,
    );
    assert.equal(
      (await isolated.db.prepare("SELECT passwordState FROM users WHERE id='pending-user'").first()).passwordState,
      'pending',
    );
    assert.equal(
      (
        await isolated.req('/membership/users/setPasswordGuid', {
          method: 'POST',
          json: { authGuid: token, newPassword: strong },
        })
      ).status,
      200,
    );
    const bootstrapped = await data(
      await isolated.req('/membership/users/login', {
        method: 'POST',
        json: { email: 'pending-admin@example.test', password: strong },
      }),
    );
    assert.equal(bootstrapped.userChurches.length, 1);
    assert.equal(bootstrapped.userChurches[0].church.id, 'pending-church');
  } finally {
    await isolated.dispose();
  }
});
