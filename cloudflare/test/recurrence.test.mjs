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
test.after(async () => h?.dispose());
async function data(r) {
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
const save = (rows) => h.req('/content/events', { method: 'POST', token: admin, json: rows });
async function series(fields = {}) {
  return (
    await data(
      await save([
        {
          calendarId: 'calendar-demo',
          title: 'Recurring synthetic',
          start: '2027-03-07T09:00:00-05:00',
          end: '2027-03-07T10:00:00-05:00',
          recurrenceRule: 'FREQ=WEEKLY;COUNT=3',
          ...fields,
        },
      ]),
    )
  )[0];
}
async function instances(row, start = '2027-03-01', end = '2027-04-01', token = admin) {
  return (
    await data(
      await h.req(`/content/events/instances?calendarId=${row.calendarId}&start=${start}&end=${end}`, { token }),
    )
  ).filter((item) => item.id === row.id || item.seriesId === row.id);
}
const change = (path, json, token = admin) => h.req(path, { method: 'POST', token, json });
const remove = (path, token = admin) => h.req(path, { method: 'DELETE', token });

test('weekly civil time survives spring and autumn DST with stable occurrence identities', async () => {
  const spring = await series(),
    rows = await instances(spring, undefined, undefined, viewer);
  assert.deepEqual(
    rows.map((r) => r.start),
    ['2027-03-07T14:00:00.000Z', '2027-03-14T13:00:00.000Z', '2027-03-21T13:00:00.000Z'],
  );
  assert.deepEqual(
    rows.map((r) => r.end),
    ['2027-03-07T15:00:00.000Z', '2027-03-14T14:00:00.000Z', '2027-03-21T14:00:00.000Z'],
  );
  assert.equal(rows[1].occurrenceId, spring.id + ':2027-03-14');
  const autumn = await series({
    start: '2027-10-31T01:30:00-04:00',
    end: '2027-10-31T02:30:00-04:00',
  });
  const fall = await instances(autumn, '2027-10-30', '2027-11-20');
  assert.deepEqual(
    fall.map((r) => r.start),
    ['2027-10-31T05:30:00.000Z', '2027-11-07T05:30:00.000Z', '2027-11-14T06:30:00.000Z'],
  );
  assert.equal(fall[1].end, '2027-11-07T07:30:00.000Z');
});
test('nonexistent local times skip without consuming COUNT; UTC and date UNTIL are inclusive', async () => {
  const gap = await series({
    start: '2027-03-13T02:30:00-05:00',
    end: '2027-03-13T03:30:00-05:00',
    recurrenceRule: 'FREQ=DAILY;COUNT=3',
  });
  assert.deepEqual(
    (await instances(gap)).map((r) => r.occurrenceDate),
    ['2027-03-13', '2027-03-15', '2027-03-16'],
  );
  assert.equal((await instances(await series({ recurrenceRule: 'FREQ=WEEKLY;UNTIL=20270314T125959Z' }))).length, 1);
  assert.equal((await instances(await series({ recurrenceRule: 'FREQ=WEEKLY;UNTIL=20270314' }))).length, 2);
});
test('all-day month-end and ordinal weekday recurrence follow the upstream RRULE fields', async () => {
  const monthly = await series({
    start: '2027-01-31',
    end: '2027-02-01',
    allDay: true,
    recurrenceRule: 'FREQ=MONTHLY;COUNT=3',
  });
  assert.deepEqual(
    (await instances(monthly, '2027-01-01', '2027-06-01')).map((r) => [r.start, r.end]),
    [
      ['2027-01-31', '2027-02-01'],
      ['2027-03-31', '2027-04-01'],
      ['2027-05-31', '2027-06-01'],
    ],
  );
  const ordinal = await series({
    start: '2027-01-11',
    end: '2027-01-12',
    allDay: true,
    recurrenceRule: 'FREQ=MONTHLY;BYDAY=2MO;COUNT=3',
  });
  assert.deepEqual(
    (await instances(ordinal, '2027-01-01', '2027-04-01')).map((r) => r.start),
    ['2027-01-11', '2027-02-08', '2027-03-08'],
  );
});
test('upstream exception arrays use local dates, preserve COUNT, and restore one occurrence', async () => {
  const row = await series();
  const [exception] = await data(
    await change('/content/eventExceptions', [{ eventId: row.id, exceptionDate: '2027-03-14T13:00:00Z' }]),
  );
  assert.equal(exception.exceptionDate, '2027-03-14');
  assert.deepEqual((await data(await h.req('/content/events/' + row.id, { token: admin }))).exceptionDates, [
    '2027-03-14',
  ]);
  assert.deepEqual(
    (await instances(row)).map((r) => r.occurrenceDate),
    ['2027-03-07', '2027-03-21'],
  );
  await data(await remove('/content/eventExceptions/' + exception.id));
  assert.equal((await instances(row)).length, 3);
});
test('occurrence edits replace atomically; invalid changes preserve data and series schedule edits require reset', async () => {
  const row = await series(),
    path = `/content/events/${row.id}/occurrences/2027-03-14`;
  assert.equal((await change(path, { title: 'Bad', start: 'bad' })).status, 400);
  assert.equal((await instances(row)).length, 3);
  const override = await data(
    await change(path, {
      title: 'Moved',
      start: '2027-03-15T15:00:00Z',
      end: '2027-03-15T16:00:00Z',
    }),
  );
  const result = await instances(row);
  assert.equal(result.length, 3);
  assert.equal(result.filter((r) => r.title === 'Moved').length, 1);
  assert.equal(override.recurrenceParentId, row.id);
  assert.equal((await save([{ id: row.id, start: '2027-03-07T14:30:00Z' }])).status, 409);
  await data(await save([{ id: row.id, title: 'Renamed' }]));
  const [exception] = await data(await h.req(`/content/eventExceptions?eventId=${row.id}`, { token: admin }));
  await data(await remove('/content/eventExceptions/' + exception.id));
  assert.equal((await h.req('/content/events/' + override.id, { token: admin })).status, 404);
  await data(await remove(path));
  assert.equal((await instances(row)).length, 2);
  await data(
    await save([
      {
        id: row.id,
        recurrenceRule: 'FREQ=WEEKLY;COUNT=4',
        resetExceptions: true,
      },
    ]),
  );
  assert.equal((await instances(row)).length, 4);
});
test('this-and-future changes split COUNT and deletion excludes the selected date', async () => {
  const row = await series({ recurrenceRule: 'FREQ=WEEKLY;COUNT=5' });
  const next = await data(
    await change(`/content/events/${row.id}/future/2027-03-21`, {
      title: 'Future revision',
    }),
  );
  assert.equal(next.recurrenceRule, 'FREQ=WEEKLY;COUNT=3');
  assert.equal(next.start, '2027-03-21T13:00:00.000Z');
  assert.equal((await instances(row, '2027-03-01', '2027-05-01')).length, 2);
  assert.equal((await instances(next, '2027-03-01', '2027-05-01')).length, 3);
  await data(await remove(`/content/events/${next.id}/future/2027-03-28`));
  assert.deepEqual(
    (await instances(next)).map((r) => r.occurrenceDate),
    ['2027-03-21'],
  );
});
test('recurrence endpoints reject foreign tenants, viewers, members, forged scope and non-occurrence dates', async () => {
  const row = await series(),
    path = `/content/events/${row.id}/occurrences/2027-03-14`;
  assert.equal((await remove(path, other)).status, 404);
  assert.equal((await remove(path, viewer)).status, 403);
  assert.equal((await remove(path, member)).status, 403);
  assert.equal((await remove(`/content/events/${row.id}/occurrences/2027-03-15`)).status, 404);
  assert.equal((await change(path, { churchId: 'church-other' })).status, 403);
  assert.equal(
    (await change('/content/eventExceptions', [{ eventId: row.id, exceptionDate: '2027-03-14' }], other)).status,
    404,
  );
  assert.equal((await instances(row, undefined, undefined, other)).length, 0);
});
test('unsupported rules and unbounded expansion fail explicitly', async () => {
  for (const recurrenceRule of [
    'FREQ=SECONDLY',
    'FREQ=DAILY;COUNT=0',
    'FREQ=WEEKLY;BYDAY=XY',
    'FREQ=MONTHLY;BYMONTHDAY=32',
    'FREQ=DAILY;INTERVAL=0',
    'FREQ=DAILY;COUNT=1001',
    'FREQ=DAILY;COUNT=3;UNTIL=20271231',
    'FREQ=DAILY\nDTSTART:20270101',
    'FREQ=WEEKLY;BYDAY=0MO',
    'FREQ=DAILY;UNTIL=20270230',
  ])
    assert.equal(
      (
        await save([
          {
            calendarId: 'calendar-demo',
            title: 'Invalid',
            start: '2027-03-01',
            end: '2027-03-02',
            allDay: true,
            recurrenceRule,
          },
        ])
      ).status,
      400,
      recurrenceRule,
    );
  assert.equal(
    (
      await h.req('/content/events/instances?start=2027-01-01&end=2029-01-01', {
        token: admin,
      })
    ).status,
    400,
  );
  const [calendar] = await data(await change('/content/calendars', [{ name: 'Limits', timeZone: 'UTC' }]));
  for (let i = 0; i < 3; i++)
    await series({
      calendarId: calendar.id,
      start: '2027-01-01',
      end: '2027-01-02',
      allDay: true,
      recurrenceRule: 'FREQ=DAILY',
    });
  const response = await h.req(`/content/events/instances?calendarId=${calendar.id}&start=2027-01-01&end=2028-01-01`, {
    token: admin,
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /1000 occurrences/);
});

test('all-day overlap in an instant window uses the calendar midnight, not the UTC date', async () => {
  const row = await series({
    start: '2027-03-14',
    end: '2027-03-15',
    allDay: true,
    recurrenceRule: null,
  });
  const matches = await instances(
    row,
    encodeURIComponent('2027-03-15T02:00:00Z'),
    encodeURIComponent('2027-03-15T03:00:00Z'),
  );
  assert.equal(matches.length, 1);
  assert.equal(
    (await instances(row, encodeURIComponent('2027-03-15T04:00:00Z'), encodeURIComponent('2027-03-15T05:00:00Z')))
      .length,
    0,
  );
  assert.equal(
    (
      await h.req('/content/events/instances?start=not-a-date', {
        token: admin,
      })
    ).status,
    400,
  );
});
test('non-hour DST changes preserve local time and inclusive until dates', async () => {
  const row = await series({
    timeZone: 'Australia/Lord_Howe',
    start: '2027-09-26T09:00:00+10:30',
    end: '2027-09-26T10:00:00+10:30',
    recurrenceRule: 'FREQ=WEEKLY;COUNT=2',
  });
  assert.deepEqual(
    (await instances(row, '2027-09-25', '2027-10-10')).map((r) => r.start),
    ['2027-09-25T22:30:00.000Z', '2027-10-02T22:00:00.000Z'],
  );
});
test('deleting a series cascades its replacement rows and excluded dates', async () => {
  const row = await series();
  const override = await data(
    await change(`/content/events/${row.id}/occurrences/2027-03-14`, {
      title: 'Replacement',
    }),
  );
  await data(await remove('/content/events/' + row.id));
  assert.equal((await h.req('/content/events/' + override.id, { token: admin })).status, 404);
  assert.equal(
    (await h.db.prepare('SELECT COUNT(*) n FROM calendar_event_exceptions WHERE eventId=?').bind(row.id).first()).n,
    0,
  );
});

test('completed COUNT series do not exhaust current-calendar computation limits', async () => {
  const [calendar] = await data(
    await change('/content/calendars', [{ name: 'Old completed series', timeZone: 'UTC' }]),
  );
  for (let i = 0; i < 10; i++)
    await series({
      calendarId: calendar.id,
      start: '2020-01-01',
      end: '2020-01-02',
      allDay: true,
      recurrenceRule: 'FREQ=DAILY;COUNT=1',
    });
  const rows = await data(
    await h.req(`/content/events/instances?calendarId=${calendar.id}&start=2027-01-01&end=2027-02-01`, {
      token: admin,
    }),
  );
  assert.deepEqual(rows, []);
});
