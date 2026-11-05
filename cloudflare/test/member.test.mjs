import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
let h, token, admin, other;
test.before(async () => {
  h = await createHarness();
  token = (await h.login('member@example.test')).token;
  admin = (await h.login()).token;
  other = (await h.login('other@example.test')).token;
});
test.after(async () => {
  await h?.dispose();
});
async function data(response) {
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
test('member role cannot access staff surfaces and must authenticate', async () => {
  assert.equal((await h.req('/member/v1/me')).status, 401);
  for (const path of [
    '/membership/people',
    '/membership/groupmembers',
    '/content/calendars',
    '/content/files',
    '/membership/auditlog',
  ])
    assert.equal((await h.req(path, { token })).status, 403, path);
  const me = await data(await h.req('/member/v1/me', { token }));
  assert.equal(me.person.id, 'person-alex');
  assert.equal(me.church.id, 'church-demo');
  assert.equal('settings' in me.church, false);
  assert.equal('birthDate' in me.person, false);
});
test('member directory requires opt-in and never discloses withheld contact or household details', async () => {
  const list = await data(await h.req('/member/v1/directory', { token }));
  assert.deepEqual(list.map((p) => p.id).sort(), ['person-admin', 'person-alex']);
  assert.deepEqual(list.find((p) => p.id === 'person-admin').contactInfo, {});
  assert.equal(list.find((p) => p.id === 'person-alex').contactInfo.email, 'alex@example.test');
  for (const person of list) assert.deepEqual(Object.keys(person).sort(), ['contactInfo', 'id', 'name']);
  assert.deepEqual(await data(await h.req('/member/v1/directory', { token: other })), []);
});
test('profile updates are limited to own phone and explicit consent, and opt-out takes effect immediately', async () => {
  for (const json of [
    { personId: 'person-admin', mobilePhone: '555' },
    { churchId: 'church-other' },
    { role: 'admin' },
    { email: 'changed@example.test' },
    { directoryVisible: 'true' },
  ])
    assert.equal((await h.req('/member/v1/me', { method: 'POST', token, json })).status, 400);
  let result = await data(
    await h.req('/member/v1/me', {
      method: 'POST',
      token,
      json: { mobilePhone: '+1 202 555 0100', directoryVisible: false, shareEmail: false },
    }),
  );
  assert.equal(result.person.contactInfo.mobilePhone, '+1 202 555 0100');
  assert.equal(result.person.contactInfo.email, 'alex@example.test');
  let directory = await data(await h.req('/member/v1/directory', { token }));
  assert.ok(!directory.some((p) => p.id === 'person-alex'));
  await h.req('/member/v1/me', { method: 'POST', token, json: { directoryVisible: true } });
  directory = await data(await h.req('/member/v1/directory', { token }));
  assert.deepEqual(directory.find((p) => p.id === 'person-alex').contactInfo, {});
  const audit = await h.db
    .prepare("SELECT count(*) n FROM audit_log WHERE action='member.profile.update' AND entityId='person-alex'")
    .first();
  assert.equal(audit.n, 2);
});
test('member calendar requires membership in both calendar and event groups', async () => {
  await h.db
    .prepare("INSERT INTO groups(id,churchId,name) VALUES('private-group','church-demo','Private group')")
    .run();
  await h.db
    .prepare(
      "INSERT INTO calendars(id,churchId,name,groupId,updatedAt) VALUES('private-calendar','church-demo','Private calendar','private-group','2026-01-01T00:00:00Z')",
    )
    .run();
  for (const [id, calendar, group] of [
    ['private-calendar-event', 'private-calendar', 'private-group'],
    ['private-event', 'calendar-demo', 'private-group'],
  ])
    await h.db
      .prepare(
        'INSERT INTO calendar_events(id,churchId,calendarId,groupId,title,start,end,timeZone,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        id,
        'church-demo',
        calendar,
        group,
        'Hidden',
        '2027-01-01T12:00:00Z',
        '2027-01-01T13:00:00Z',
        'UTC',
        '2026-01-01T00:00:00Z',
      )
      .run();
  const events = await data(await h.req('/member/v1/calendar', { token }));
  assert.ok(events.some((e) => e.id === 'event-welcome'));
  assert.ok(events.some((e) => e.id === 'event-demo'));
  assert.ok(events.every((e) => !e.id.startsWith('private')));
  assert.equal((await h.req('/member/v1/calendar?from=2027-01-01', { token })).status, 400);
});
test('published sermon archive omits drafts, private content and future releases', async () => {
  for (const [id, visibility, publishedAt, date] of [
    ['draft', 'public', null, '2020-01-01'],
    ['private', 'private', '2020-01-01', '2020-01-01'],
    ['future', 'public', '2020-01-01', '2099-01-01'],
  ])
    await h.db
      .prepare(
        'INSERT INTO content_sermons(id,churchId,title,publishDate,visibility,publishedAt,updatedAt) VALUES(?,?,?,?,?,?,?)',
      )
      .bind(id, 'church-demo', id, date, visibility, publishedAt, '2026-01-01T00:00:00Z')
      .run();
  const sermons = await data(await h.req('/member/v1/sermons', { token }));
  assert.deepEqual(
    sermons.map((s) => s.id),
    ['sermon-demo'],
  );
  assert.equal('churchId' in sermons[0], false);
  assert.deepEqual(await data(await h.req('/member/v1/sermons', { token: other })), []);
});
test('self-service group joining is tenant scoped, open-only and idempotent', async () => {
  for (const [id, tenant, policy] of [
    ['joinable', 'church-demo', 'open'],
    ['closed', 'church-demo', 'closed'],
    ['foreign', 'church-other', 'open'],
  ])
    await h.db
      .prepare('INSERT INTO groups(id,churchId,name,joinPolicy) VALUES(?,?,?,?)')
      .bind(id, tenant, id, policy)
      .run();
  let available = await data(await h.req('/member/v1/groups/available', { token }));
  assert.ok(available.some((g) => g.id === 'joinable'));
  assert.ok(!available.some((g) => ['closed', 'foreign'].includes(g.id)));
  for (const group of ['closed', 'foreign'])
    assert.equal(
      (await h.req(`/member/v1/groups/${group}/join`, { method: 'POST', token })).status,
      group === 'closed' ? 409 : 404,
    );
  const responses = await Promise.all(
    Array.from({ length: 3 }, () => h.req('/member/v1/groups/joinable/join', { method: 'POST', token })),
  );
  for (const response of responses) assert.equal(response.status, 200);
  const count = await h.db
    .prepare(
      "SELECT count(*) n FROM group_members WHERE churchId='church-demo' AND groupId='joinable' AND personId='person-alex'",
    )
    .first();
  assert.equal(count.n, 1);
  const groups = await data(await h.req('/member/v1/groups', { token }));
  assert.ok(groups.some((g) => g.id === 'joinable'));
  assert.equal((await h.req('/member/v1/groups/joinable/leave', { method: 'DELETE', token })).status, 200);
  assert.equal((await h.req('/member/v1/groups/joinable/leave', { method: 'DELETE', token })).status, 200);
  assert.equal((await h.req('/member/v1/groups/group-welcome/leave', { method: 'DELETE', token: admin })).status, 409);
});
test('member archive lists and downloads published R2 attachments without private storage keys', async () => {
  const upload = await h.req('/content/files/upload?fileName=demo.txt&contentId=sermon-demo', {
    method: 'POST',
    token: admin,
    headers: { 'Content-Type': 'text/plain' },
    body: 'Synthetic sermon transcript',
  });
  assert.equal(upload.status, 201, await upload.clone().text());
  const [file] = await upload.json();
  const files = await data(await h.req('/member/v1/sermons/sermon-demo/files', { token }));
  assert.equal(files.length, 1);
  assert.equal(files[0].id, file.id);
  assert.equal('objectKey' in files[0], false);
  assert.equal('churchId' in files[0], false);
  const download = await h.req('/member/v1/files/' + file.id + '/download', { token });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'Synthetic sermon transcript');
  assert.match(download.headers.get('Content-Disposition'), /^attachment/);
  assert.equal((await h.req('/member/v1/files/' + file.id + '/download', { token: other })).status, 404);
  assert.equal((await h.req('/member/v1/files/' + file.id + '/download')).status, 401);
  await h.db.prepare('UPDATE content_sermons SET publishedAt=NULL WHERE id=?').bind('sermon-demo').run();
  for (const caller of [token, admin]) {
    assert.equal((await h.req('/member/v1/sermons/sermon-demo/files', { token: caller })).status, 404);
    assert.equal((await h.req('/member/v1/files/' + file.id + '/download', { token: caller })).status, 404);
  }
});
