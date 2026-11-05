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
test.after(async () => h?.dispose());
test('Durable Object event history is tenant scoped, persisted and ordered', async () => {
  const event = { action: 'refresh', data: { resource: 'groups', id: 'group-welcome' } };
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
  r = await h.req('/messaging/realtime/events', { token: admin, method: 'POST', json: event });
  assert.equal((await r.json()).sequence, 2);
  const history = await (await h.req('/messaging/realtime/events', { token: viewer })).json();
  assert.equal(history.events.length, 2);
  const foreign = await (await h.req('/messaging/realtime/events', { token: other })).json();
  assert.equal(foreign.events.length, 0);
  assert.equal((await h.req('/messaging/realtime/events', { token: viewer, method: 'POST', json: event })).status, 403);
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
  const response = await h.req('/messaging/realtime', { token: session.token, headers: { Upgrade: 'websocket' } });
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
  await h.req('/membership/users/logout', { token: session.token, method: 'POST', json: {} });
  await h.req('/messaging/realtime/events', {
    token: admin,
    method: 'POST',
    json: { action: 'refresh', data: { resource: 'people' } },
  });
  await until(() => closed);
  assert.equal(received.filter((m) => m.action === 'refresh').length, count);
  assert.equal((await h.req('/messaging/realtime')).status, 401);
});
