import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';

let h, member, other;
test.before(async () => {
  h = await createHarness();
  member = (await h.login('member@example.test')).token;
  other = (await h.login('other@example.test')).token;
});
test.after(async () => {
  await h?.dispose();
});
async function data(path, token = member) {
  const response = await h.req('/member/v1/' + path, { token });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test('directory search and metadata paginate only opted-in names, preserving legacy arrays', async () => {
  await h.db.batch(
    Array.from({ length: 105 }, (_, index) =>
      h.db
        .prepare(
          "INSERT INTO people(id,churchId,firstName,lastName,email,contactInfo,directoryVisible,shareEmail,dateAdded) VALUES(?,?,?,?,?,?,1,0,'2026-01-01')",
        )
        .bind(
          'paged-person-' + index,
          'church-demo',
          'Page',
          'Member ' + String(index).padStart(3, '0'),
          `private-${index}@example.test`,
          '{"mobilePhone":"private phone"}',
        ),
    ),
  );
  await h.db
    .prepare(
      "INSERT INTO people(id,churchId,firstName,lastName,directoryVisible,dateAdded) VALUES('paged-private','church-demo','Private','Needle',0,'2026-01-01'),('paged-foreign','church-other','Foreign','Needle',1,'2026-01-01'),('paged-literal','church-demo','Percent%_\\Family','Example',1,'2026-01-01')",
    )
    .run();
  const legacy = await data('directory?q=Page%20Member');
  assert.ok(Array.isArray(legacy));
  assert.equal(legacy.length, 100);
  const first = await data('directory?q=Page%20Member&paged=1&limit=60');
  assert.deepEqual(first.pagination, {
    limit: 60,
    offset: 0,
    count: 60,
    hasMore: true,
    nextOffset: 60,
    truncated: false,
  });
  const second = await data('directory?q=Page%20Member&paged=1&limit=60&offset=60');
  assert.deepEqual(second.pagination, {
    limit: 60,
    offset: 60,
    count: 45,
    hasMore: false,
    nextOffset: null,
    truncated: false,
  });
  const ids = [...first.items, ...second.items].map((person) => person.id);
  assert.equal(new Set(ids).size, 105);
  for (const person of [...first.items, ...second.items]) {
    assert.deepEqual(Object.keys(person).sort(), ['contactInfo', 'id', 'name']);
    assert.deepEqual(person.contactInfo, {});
  }
  assert.equal((await data('directory?q=Needle&paged=1')).items.length, 0);
  assert.equal((await data('directory?q=Page&paged=1', other)).items.length, 0);
  assert.equal((await data('directory?q=private-0%40example.test&paged=1')).items.length, 0);
  assert.deepEqual(
    (await data('directory?q=' + encodeURIComponent('%_\\') + '&paged=1')).items.map((person) => person.id),
    ['paged-literal'],
  );
});

test('group paging applies membership, archive and joining rules before search and offset', async () => {
  for (let index = 0; index < 25; index++) {
    const id = 'paged-group-' + index;
    await h.db
      .prepare("INSERT INTO groups(id,churchId,name,joinPolicy) VALUES(?,'church-demo',?,'open')")
      .bind(id, 'Paging group ' + String(index).padStart(2, '0'))
      .run();
    if (index < 15)
      await h.db
        .prepare("INSERT INTO group_members(id,churchId,groupId,personId) VALUES(?,'church-demo',?,'person-alex')")
        .bind('paged-membership-' + index, id)
        .run();
  }
  await h.db
    .prepare(
      "INSERT INTO groups(id,churchId,name,joinPolicy,archived) VALUES('paged-closed','church-demo','Paging group hidden','closed',0),('paged-archived','church-demo','Paging group archived','open',1),('paged-other','church-other','Paging group foreign','open',0)",
    )
    .run();
  const mine = await data('groups?paged=1&q=Paging&limit=10&offset=10');
  assert.equal(mine.items.length, 5);
  assert.equal(mine.pagination.hasMore, false);
  assert.ok(mine.items.every((group) => Number(group.id.split('-').pop()) < 15));
  const available = await data('groups/available?paged=1&q=Paging&limit=6');
  assert.equal(available.items.length, 6);
  assert.equal(available.pagination.nextOffset, 6);
  const rest = await data('groups/available?paged=1&q=Paging&limit=6&offset=6');
  assert.equal(rest.items.length, 4);
  assert.equal(rest.pagination.hasMore, false);
  assert.ok([...available.items, ...rest.items].every((group) => Number(group.id.split('-').pop()) >= 15));
});

test('sermon search pages only published past content and preserves field projection', async () => {
  await h.db.batch(
    Array.from({ length: 24 }, (_, index) =>
      h.db
        .prepare(
          "INSERT INTO content_sermons(id,churchId,title,description,speaker,publishDate,visibility,publishedAt,updatedAt) VALUES(?,'church-demo',?,'Paged description','Synthetic speaker','2020-01-01','public','2020-01-01','2020-01-01')",
        )
        .bind('paged-sermon-' + String(index).padStart(2, '0'), 'Paged sermon ' + index),
    ),
  );
  await h.db
    .prepare(
      "INSERT INTO content_sermons(id,churchId,title,publishDate,visibility,publishedAt,updatedAt) VALUES('paged-draft','church-demo','Paged sermon draft','2020-01-01','public',NULL,'2020-01-01'),('paged-private-sermon','church-demo','Paged sermon private','2020-01-01','private','2020-01-01','2020-01-01'),('paged-future','church-demo','Paged sermon future','2099-01-01','public','2020-01-01','2020-01-01'),('paged-foreign-sermon','church-other','Paged sermon foreign','2020-01-01','public','2020-01-01','2020-01-01')",
    )
    .run();
  const first = await data('sermons?q=Synthetic%20speaker&paged=1&limit=20');
  const next = await data('sermons?q=Paged%20sermon&paged=1&limit=20&offset=20');
  assert.equal(first.items.length, 20);
  assert.equal(first.pagination.nextOffset, 20);
  assert.equal(next.items.length, 4);
  assert.equal(next.pagination.hasMore, false);
  assert.equal(new Set([...first.items, ...next.items].map((item) => item.id)).size, 24);
  for (const item of [...first.items, ...next.items]) assert.equal('churchId' in item, false);
  assert.equal((await data('sermons?q=private&paged=1')).items.length, 0);
});

test('calendar metadata counts visible expanded occurrences after exclusions', async () => {
  await h.db
    .prepare("INSERT INTO groups(id,churchId,name) VALUES('paged-private-group','church-demo','Private')")
    .run();
  for (const [id, group] of [
    ['paged-event', null],
    ['paged-hidden-event', 'paged-private-group'],
  ])
    await h.db
      .prepare(
        "INSERT INTO calendar_events(id,churchId,calendarId,groupId,title,start,end,timeZone,recurrenceRule,updatedAt) VALUES(?,'church-demo','calendar-demo',?,'Paging event','2027-05-01T10:00:00Z','2027-05-01T11:00:00Z','UTC','FREQ=DAILY;COUNT=25','2026-01-01')",
      )
      .bind(id, group)
      .run();
  await h.db
    .prepare(
      "INSERT INTO calendar_event_exceptions(id,churchId,eventId,exceptionDate,createdAt) VALUES('paged-exception','church-demo','paged-event','2027-05-03','2026-01-01')",
    )
    .run();
  const path = 'calendar?from=2027-05-01T00:00:00Z&to=2027-06-01T00:00:00Z&paged=1&limit=20';
  const first = await data(path),
    next = await data(path + '&offset=20');
  assert.equal(first.items.length, 20);
  assert.equal(first.pagination.hasMore, true);
  assert.equal(next.items.length, 4);
  assert.equal(next.pagination.hasMore, false);
  const rows = [...first.items, ...next.items];
  assert.ok(rows.every((row) => row.id === 'paged-event' && row.occurrenceDate !== '2027-05-03'));
  assert.equal(new Set(rows.map((row) => row.occurrenceId)).size, 24);
  assert.equal((await data(path, other)).items.length, 0);
});

test('offset cap is explicit and malformed bounds or search are rejected', async () => {
  await h.db
    .prepare(
      "INSERT INTO people(id,churchId,firstName,lastName,directoryVisible,dateAdded) SELECT 'cap-person-'||value,'church-demo','Cap',printf('%05d',value),1,'2026-01-01' FROM json_each(?)",
    )
    .bind(JSON.stringify(Array.from({ length: 10002 }, (_, index) => index)))
    .run();
  const capped = await data('directory?q=Cap&paged=1&offset=10000&limit=1');
  assert.equal(capped.items.length, 1);
  assert.deepEqual(capped.pagination, {
    limit: 1,
    offset: 10000,
    count: 1,
    hasMore: false,
    nextOffset: null,
    truncated: true,
  });
  for (const query of [
    'offset=10001',
    'offset=-1',
    'limit=101',
    'limit=0',
    'paged=maybe',
    'q=' + 'a'.repeat(101),
    'q=bad%00name',
  ])
    assert.equal((await h.req('/member/v1/directory?' + query, { token: member })).status, 400, query);
  assert.equal((await h.req('/member/v1/calendar?paged=1&limit=201', { token: member })).status, 400);
});

test('literal contains searches accept long ASCII and multibyte text without D1 LIKE pattern limits', async () => {
  const queries = ['Long' + 'a'.repeat(70), '界'.repeat(30) + ' %_\\Needle'];
  for (const [index, query] of queries.entries()) {
    await h.db
      .prepare(
        "INSERT INTO people(id,churchId,firstName,lastName,directoryVisible,dateAdded) VALUES(?,'church-demo',?,'Example',1,'2026-01-01')",
      )
      .bind('long-person-' + index, query)
      .run();
    await h.db
      .prepare(
        "INSERT INTO groups(id,churchId,name,joinPolicy) VALUES(?,'church-demo',?,'open'),(?,'church-demo',?,'open')",
      )
      .bind('long-own-' + index, query + ' own', 'long-available-' + index, query + ' available')
      .run();
    await h.db
      .prepare("INSERT INTO group_members(id,churchId,groupId,personId) VALUES(?,'church-demo',?,'person-alex')")
      .bind('long-membership-' + index, 'long-own-' + index)
      .run();
    await h.db
      .prepare(
        "INSERT INTO content_sermons(id,churchId,title,publishDate,visibility,publishedAt,updatedAt) VALUES(?,'church-demo',?,'2020-01-01','public','2020-01-01','2020-01-01')",
      )
      .bind('long-sermon-' + index, query)
      .run();
    for (const [path, id] of [
      ['directory', 'long-person-'],
      ['groups', 'long-own-'],
      ['groups/available', 'long-available-'],
      ['sermons', 'long-sermon-'],
    ]) {
      const page = await data(path + '?paged=1&q=' + encodeURIComponent(query));
      assert.deepEqual(
        page.items.map((item) => item.id),
        [id + index],
        path + ' ' + query,
      );
    }
  }
  for (const path of ['directory', 'groups', 'groups/available', 'sermons']) {
    const page = await data(path + '?paged=1&q=' + encodeURIComponent('%_\\'));
    assert.ok(page.items.length > 0, path);
    assert.ok(
      page.items.every((item) => (item.name?.display || item.name || item.title).includes('%_\\')),
      path,
    );
  }
});
