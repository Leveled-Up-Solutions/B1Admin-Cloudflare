import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';

let h, admin, viewer, other, member;
test.before(async () => {
  h = await createHarness();
  admin = (await h.login()).token;
  viewer = (await h.login('viewer@example.test')).token;
  other = (await h.login('other@example.test')).token;
  member = (await h.login('member@example.test')).token;
});
test.after(async () => {
  await h?.dispose();
});
const save = (resource, data, token = admin) => h.req(`/content/${resource}`, { method: 'POST', token, json: data });
async function data(response) {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test('calendar and event CRUD preserve group scope and audit each mutation', async () => {
  const [calendar] = await data(
    await save('calendars', [
      { name: 'Team test', groupId: 'group-welcome', timeZone: 'America/New_York', color: '#123456' },
    ]),
  );
  const [event] = await data(
    await save('events', [
      {
        calendarId: calendar.id,
        title: 'Planning',
        start: '2027-01-01T10:00:00-05:00',
        end: '2027-01-01T11:00:00-05:00',
      },
    ]),
  );
  assert.equal(event.start, '2027-01-01T15:00:00.000Z');
  assert.equal(event.end, '2027-01-01T16:00:00.000Z');
  assert.equal(event.groupId, 'group-welcome');
  assert.equal(event.timeZone, 'America/New_York');
  assert.equal(event.allDay, false);
  const groupEvents = await data(await h.req('/content/events/group/group-welcome', { token: admin }));
  assert.ok(groupEvents.some((row) => row.id === event.id));
  assert.equal((await h.req(`/content/calendars/${calendar.id}`, { method: 'DELETE', token: admin })).status, 409);
  assert.equal((await save('calendars', [{ id: calendar.id, groupId: null }])).status, 409);
  const [updated] = await data(await save('events', [{ id: event.id, title: 'Updated planning' }]));
  assert.equal(updated.title, 'Updated planning');
  assert.equal((await h.req(`/content/events/${event.id}`, { method: 'DELETE', token: admin })).status, 200);
  assert.equal((await h.req(`/content/calendars/${calendar.id}`, { method: 'DELETE', token: admin })).status, 200);
  assert.equal((await h.req(`/content/events/${event.id}`, { token: admin })).status, 404);
  const count = await h.db.prepare('SELECT count(*) n FROM audit_log WHERE entityId=?').bind(event.id).first();
  assert.equal(count.n, 3);
});

test('all-day dates retain civil dates with an exclusive end', async () => {
  const [event] = await data(
    await save('events', [
      { calendarId: 'calendar-demo', title: 'All day', start: '2027-03-14', end: '2027-03-15', allDay: true },
    ]),
  );
  assert.equal(event.start, '2027-03-14');
  assert.equal(event.end, '2027-03-15');
  assert.equal(event.allDay, true);
  for (const [start, end] of [
    ['2027-02-30', '2027-03-03'],
    ['2027-03-14', '2027-03-14'],
    ['2027-03-14', '2027-03-13'],
  ]) {
    assert.equal(
      (await save('events', [{ calendarId: 'calendar-demo', title: 'Invalid', start, end, allDay: true }])).status,
      400,
    );
  }
  assert.equal(
    (
      await save('events', [
        { calendarId: 'calendar-demo', title: 'No offset', start: '2027-01-01T10:00', end: '2027-01-01T11:00' },
      ])
    ).status,
    400,
  );
  assert.equal((await save('calendars', [{ name: 'Bad zone', timeZone: 'MadeUp/Zone' }])).status, 400);
});

test('timed event instants survive a daylight-saving transition', async () => {
  const [event] = await data(
    await save('events', [
      {
        calendarId: 'calendar-demo',
        title: 'DST',
        start: '2027-03-14T01:30:00-05:00',
        end: '2027-03-14T03:30:00-04:00',
        timeZone: 'America/New_York',
      },
    ]),
  );
  assert.equal(Date.parse(event.end) - Date.parse(event.start), 60 * 60 * 1000);
  const filtered = await data(
    await h.req(
      '/content/events?calendarId=calendar-demo&start=2027-03-14T06%3A00%3A00Z&end=2027-03-14T08%3A00%3A00Z',
      { token: admin },
    ),
  );
  assert.ok(filtered.some((row) => row.id === event.id));
});

test('calendar writes reject forged tenants, foreign relations, and viewer permissions', async () => {
  assert.equal((await h.req('/content/calendars/calendar-demo', { token: other })).status, 404);
  assert.equal((await h.req('/content/events/event-demo', { token: other })).status, 404);
  assert.equal((await save('calendars', [{ name: 'No', groupId: 'group-welcome' }], other)).status, 404);
  assert.equal(
    (
      await save(
        'events',
        [{ title: 'Foreign', calendarId: 'calendar-demo', start: '2027-01-01T10:00Z', end: '2027-01-01T11:00Z' }],
        other,
      )
    ).status,
    404,
  );
  assert.equal((await save('events', [{ id: 'event-demo', title: 'Hijack' }], other)).status, 404);
  assert.equal((await save('calendars', [{ name: 'No' }], viewer)).status, 403);
  assert.equal((await h.req('/content/events/event-demo', { method: 'DELETE', token: viewer })).status, 403);
  assert.equal((await h.req('/content/events', { token: member })).status, 403);
  assert.equal((await h.req('/content/calendars', { token: viewer })).status, 200);
  assert.equal((await save('calendars', [{ name: 'No', churchId: 'church-other' }])).status, 403);
});

test('invalid batch writes leave no partial calendar changes', async () => {
  const before = await h.db.prepare('SELECT count(*) n FROM calendars').first();
  assert.equal((await save('calendars', [{ name: 'Atomic valid' }, { name: '' }])).status, 400);
  const after = await h.db.prepare('SELECT count(*) n FROM calendars').first();
  assert.equal(after.n, before.n);
  assert.equal(
    (
      await save('events', [
        {
          calendarId: 'calendar-demo',
          title: 'Unported recurring',
          start: '2027-01-01T10:00Z',
          end: '2027-01-01T11:00Z',
          recurrenceRule: 'FREQ=WEEKLY',
        },
      ])
    ).status,
    501,
  );
});

test('D1 relationship guards reject writes even when application validation is bypassed', async () => {
  await assert.rejects(
    h.db.prepare("UPDATE calendars SET groupId=NULL WHERE id='calendar-welcome'").run(),
    /calendar_group_has_events/,
  );
  await assert.rejects(
    h.db.prepare("UPDATE calendar_events SET groupId=NULL WHERE id='event-welcome'").run(),
    /event_calendar_group/,
  );
  const row = await h.db.prepare("SELECT groupId FROM calendar_events WHERE id='event-welcome'").first();
  assert.equal(row.groupId, 'group-welcome');
});
