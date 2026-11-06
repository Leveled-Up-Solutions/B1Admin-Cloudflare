import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
let h, admin, viewer, other, member;
test.before(async () => {
  h = await createHarness();
  admin = (await h.login()).token;
  viewer = (await h.login('viewer@example.test')).token;
  other = (await h.login('other@example.test')).token;
  member = (await h.login('member@example.test')).token;
});
test.after(async () => h?.dispose());
test('Durable Object event history is tenant scoped, persisted and ordered', async () => {
  const event = {
    action: 'refresh',
    data: { resource: 'groups', id: 'group-welcome' },
  };
  let r = await h.req('/messaging/realtime/events', {
    token: admin,
    method: 'POST',
    json: event,
    headers: { 'X-Church-Id': 'church-other' },
  });
  assert.equal(r.status, 201);
  const first = await r.json();
  assert.equal(first.churchId, 'church-demo');
  assert.equal(first.sequence, 1);
  r = await h.req('/messaging/realtime/events', {
    token: admin,
    method: 'POST',
    json: event,
  });
  assert.equal((await r.json()).sequence, 2);
  const history = await (await h.req('/messaging/realtime/events', { token: admin })).json();
  assert.equal(history.events.length, 2);
  const foreign = await (await h.req('/messaging/realtime/events', { token: other })).json();
  assert.equal(foreign.events.length, 0);
  assert.equal((await h.req('/messaging/realtime/events', { token: viewer })).status, 403);
  assert.equal(
    (
      await h.req('/messaging/realtime/events', {
        token: viewer,
        method: 'POST',
        json: event,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await h.req('/messaging/realtime/events', {
        token: admin,
        method: 'POST',
        json: { ...event, churchId: 'church-other' },
      })
    ).status,
    400,
  );
});
test('WebSocket connects with authentication and logout blocks further events', async () => {
  const session = await h.login();
  const response = await h.req('/messaging/realtime', {
    token: session.token,
    headers: { Upgrade: 'websocket' },
  });
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  assert.ok(socket);
  const received = [];
  socket.addEventListener('message', (event) => received.push(JSON.parse(event.data)));
  socket.accept();
  socket.send('getId');
  const until = async (predicate) => {
    for (let n = 0; n < 50 && !predicate(); n++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(predicate());
  };
  await until(() => received.some((m) => m.action === 'socketId'));
  await h.req('/messaging/realtime/events', {
    token: admin,
    method: 'POST',
    json: { action: 'refresh', data: { resource: 'people' } },
  });
  await until(() => received.some((m) => m.action === 'refresh'));
  const count = received.filter((m) => m.action === 'refresh').length;
  let closed = false;
  socket.addEventListener('close', () => {
    closed = true;
  });
  await h.req('/membership/users/logout', {
    token: session.token,
    method: 'POST',
    json: {},
  });
  await h.req('/messaging/realtime/events', {
    token: admin,
    method: 'POST',
    json: { action: 'refresh', data: { resource: 'people' } },
  });
  await until(() => closed);
  assert.equal(received.filter((m) => m.action === 'refresh').length, count);
  assert.equal((await h.req('/messaging/realtime')).status, 401);
});

async function data(response) {
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function waitFor(predicate) {
  for (let n = 0; n < 500 && !predicate(); n++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate());
}
async function watchSocket(token) {
  const response = await h.req('/messaging/realtime', {
    token,
    headers: { Upgrade: 'websocket' },
  });
  assert.equal(response.status, 101, response.status === 101 ? '' : await response.text());
  const socket = response.webSocket,
    messages = [];
  let closed = false;
  socket.addEventListener('message', (event) => messages.push(JSON.parse(event.data)));
  socket.addEventListener('close', () => {
    closed = true;
  });
  socket.accept();
  socket.send('ping');
  await waitFor(() => messages.some((message) => message.action === 'pong'));
  return { socket, messages, isClosed: () => closed };
}
async function grantSettings(roleId) {
  return (
    await data(
      await h.req('/membership/rolepermissions', {
        token: admin,
        method: 'POST',
        json: [
          {
            roleId,
            apiName: 'MembershipApi',
            contentType: 'Settings',
            action: 'Edit',
          },
        ],
      }),
    )
  )[0];
}
let readerRole;
test('ordinary viewers, unrelated grants, and scoped Settings permissions cannot read church-wide metadata', async () => {
  [readerRole] = await data(
    await h.req('/membership/roles', {
      token: admin,
      method: 'POST',
      json: [{ name: 'Realtime reader fixture' }],
    }),
  );
  await data(
    await h.req('/membership/rolepermissions', {
      token: admin,
      method: 'POST',
      json: [
        {
          roleId: readerRole.id,
          apiName: 'MembershipApi',
          contentType: 'People',
          action: 'View',
        },
      ],
    }),
  );
  await data(
    await h.req('/membership/rolemembers', {
      token: admin,
      method: 'POST',
      json: [{ roleId: readerRole.id, userId: 'user-member' }],
    }),
  );
  for (const token of [viewer, member]) {
    assert.equal((await h.req('/messaging/realtime/events', { token })).status, 403);
    assert.equal(
      (
        await h.req('/messaging/realtime', {
          token,
          headers: { Upgrade: 'websocket' },
        })
      ).status,
      403,
    );
  }
  // Resource-scoped grants may exist in imported data; they are never a global feed grant.
  await h.db
    .prepare(
      "INSERT INTO role_permissions(id,churchId,roleId,apiName,contentType,contentId,action) VALUES('rt-scoped','church-demo',?,'MembershipApi','Settings','group-welcome','Edit')",
    )
    .bind(readerRole.id)
    .run();
  assert.equal((await h.req('/messaging/realtime/events', { token: member })).status, 403);
  await h.db.prepare("DELETE FROM role_permissions WHERE id='rt-scoped'").run();
});
test('global Settings Edit permits reads but not publishing; permission revocation stops the next delivery', async () => {
  const permission = await grantSettings(readerRole.id);
  assert.equal((await h.req('/messaging/realtime/events', { token: member })).status, 200);
  const watch = await watchSocket(member);
  const event = {
    action: 'refresh',
    data: { resource: 'people', id: 'person-admin' },
    conversationId: 'administrative-fixture',
  };
  assert.equal(
    (
      await h.req('/messaging/realtime/events', {
        token: member,
        method: 'POST',
        json: event,
      })
    ).status,
    403,
  );
  await data(
    await h.req('/messaging/realtime/events', {
      token: admin,
      method: 'POST',
      json: event,
    }),
  );
  await waitFor(() => watch.messages.some((message) => message.action === 'refresh'));
  const count = watch.messages.filter((message) => message.action === 'refresh').length;
  await data(
    await h.req('/membership/rolepermissions/' + permission.id, {
      token: admin,
      method: 'DELETE',
    }),
  );
  assert.equal((await h.req('/messaging/realtime/events', { token: member })).status, 403);
  await data(
    await h.req('/messaging/realtime/events', {
      token: admin,
      method: 'POST',
      json: event,
    }),
  );
  await waitFor(watch.isClosed);
  assert.equal(watch.messages.filter((message) => message.action === 'refresh').length, count);
});
test('membership revocation closes a connected settings editor on ping and the Durable Object rejects stale headers', async () => {
  const permission = await grantSettings(readerRole.id);
  const watch = await watchSocket(member);
  const claims = JSON.parse(Buffer.from(member.split('.')[1], 'base64url').toString());
  const namespace = await h.mf.getDurableObjectNamespace('REALTIME');
  const stub = namespace.get(namespace.idFromName('church:church-demo'));
  const headers = {
    'X-Church-Id': 'church-demo',
    'X-User-Id': claims.id,
    'X-Session-Id': claims.sid,
  };
  assert.equal(
    (
      await stub.fetch('https://realtime.internal/publish', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'refresh',
          data: { resource: 'people' },
        }),
      })
    ).status,
    401,
  );
  await h.db.prepare('DELETE FROM role_members WHERE roleId=? AND userId=?').bind(readerRole.id, 'user-member').run();
  watch.socket.send('ping');
  await waitFor(watch.isClosed);
  assert.equal((await stub.fetch('https://realtime.internal/events', { headers })).status, 401);
  await data(
    await h.req('/membership/rolepermissions/' + permission.id, {
      token: admin,
      method: 'DELETE',
    }),
  );
});
test('administrator demotion closes an existing socket before subsequent events', async () => {
  await h.db
    .prepare("UPDATE user_churches SET role='admin' WHERE userId='user-viewer' AND churchId='church-demo'")
    .run();
  const watch = await watchSocket(admin);
  await h.db
    .prepare("UPDATE user_churches SET role='viewer' WHERE userId='user-admin' AND churchId='church-demo'")
    .run();
  try {
    await data(
      await h.req('/messaging/realtime/events', {
        token: viewer,
        method: 'POST',
        json: { action: 'refresh', data: { resource: 'people' } },
      }),
    );
    await waitFor(watch.isClosed);
    assert.equal(
      watch.messages.some((message) => message.action === 'refresh'),
      false,
    );
    assert.equal((await h.req('/messaging/realtime/events', { token: admin })).status, 403);
  } finally {
    await h.db
      .prepare("UPDATE user_churches SET role='admin' WHERE userId='user-admin' AND churchId='church-demo'")
      .run();
    await h.db
      .prepare("UPDATE user_churches SET role='viewer' WHERE userId='user-viewer' AND churchId='church-demo'")
      .run();
  }
});
test('idle-socket alarm rechecks fresh D1 permissions and session versions', async () => {
  // Test the actual alarm method without waiting a minute for the scheduler. D1
  // is real Miniflare; only idle socket/storage handles are controlled test doubles.
  const root = fileURLToPath(new URL('../', import.meta.url));
  const bundle = await build({
    entryPoints: [root + 'src/realtime.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
  });
  const { ChurchRealtime } = await import(
    'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
  );
  const identity = (token) => {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return {
      churchId: claims.churchId,
      userId: claims.id,
      sessionId: claims.sid,
    };
  };
  const socket = (value) => ({
    closed: false,
    deserializeAttachment: () => value,
    close() {
      this.closed = true;
    },
  });
  const privileged = socket(identity(admin)),
    revoked = socket(identity(member));
  let ready,
    scheduled = false;
  const state = {
    blockConcurrencyWhile: (callback) => {
      ready = callback();
    },
    getWebSockets: () => [privileged, revoked].filter((s) => !s.closed),
    storage: {
      get: async () => 'church-demo',
      setAlarm: async () => {
        scheduled = true;
      },
    },
  };
  const instance = new ChurchRealtime(state, { DB: h.db });
  await ready;
  await instance.alarm();
  assert.equal(privileged.closed, false);
  assert.equal(revoked.closed, true);
  assert.equal(scheduled, true);
  const sid = identity(admin).sessionId;
  await h.db.prepare('UPDATE sessions SET passwordVersion=passwordVersion+1 WHERE id=?').bind(sid).run();
  try {
    await instance.alarm();
    assert.equal(privileged.closed, true);
  } finally {
    await h.db.prepare('UPDATE sessions SET passwordVersion=passwordVersion-1 WHERE id=?').bind(sid).run();
  }
});

test('removed linked person closes existing sockets on ping and before event delivery', async () => {
  await h.db
    .prepare("UPDATE user_churches SET role='admin' WHERE userId='user-viewer' AND churchId='church-demo'")
    .run();
  try {
    for (const trigger of ['ping', 'event']) {
      const watch = await watchSocket(viewer);
      const claims = JSON.parse(Buffer.from(viewer.split('.')[1], 'base64url').toString());
      await h.db.prepare("UPDATE people SET removed=1 WHERE id='person-jordan'").run();
      try {
        assert.equal((await h.req('/messaging/realtime/events', { token: viewer })).status, 403);
        const namespace = await h.mf.getDurableObjectNamespace('REALTIME');
        const stub = namespace.get(namespace.idFromName('church:church-demo'));
        assert.equal(
          (
            await stub.fetch('https://realtime.internal/events', {
              headers: { 'X-Church-Id': 'church-demo', 'X-User-Id': claims.id, 'X-Session-Id': claims.sid },
            })
          ).status,
          401,
        );
        if (trigger === 'ping') watch.socket.send('ping');
        else
          await data(
            await h.req('/messaging/realtime/events', {
              token: admin,
              method: 'POST',
              json: { action: 'refresh', data: { resource: 'people' } },
            }),
          );
        await waitFor(watch.isClosed);
        assert.equal(
          watch.messages.some((message) => message.action === 'refresh'),
          false,
        );
      } finally {
        await h.db.prepare("UPDATE people SET removed=0 WHERE id='person-jordan'").run();
      }
    }
  } finally {
    await h.db
      .prepare("UPDATE user_churches SET role='viewer' WHERE userId='user-viewer' AND churchId='church-demo'")
      .run();
  }
});
