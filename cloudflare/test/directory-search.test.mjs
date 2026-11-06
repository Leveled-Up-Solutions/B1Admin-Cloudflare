import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
let h, admin, viewer, member;
test.before(async () => {
  h = await createHarness();
  admin = (await h.login()).token;
  viewer = (await h.login('viewer@example.test')).token;
  member = (await h.login('member@example.test')).token;
  const result = await h.req('/membership/people', {
    token: admin,
    method: 'POST',
    json: [
      {
        id: 'search-alpha',
        name: { first: 'Alpha', last: 'Search' },
        contactInfo: {
          email: 'alpha@example.test',
          mobilePhone: '555-100',
          city: 'Literal_% City',
        },
        birthDate: '2000-02-29',
        anniversary: '2020-04-20',
        gender: 'Female',
        membershipStatus: 'Member',
      },
      {
        id: 'search-beta',
        name: { first: 'Beta', last: 'Search' },
        contactInfo: {
          email: 'beta@example.test',
          homePhone: '555-200',
          city: 'Other',
        },
        birthDate: '2010-06-15',
        membershipStatus: 'Visitor',
      },
      { id: 'search-undated', name: { first: 'Undated', last: 'Search' } },
    ],
  });
  assert.equal(result.status, 200);
});
test.after(async () => h?.dispose());
const search = (json, token = viewer) => h.req('/membership/people/advancedSearch', { token, method: 'POST', json });
const ids = (result) => result.map((p) => p.id).sort();
test('standard upstream filters combine with AND and preserve nested person DTOs', async () => {
  const response = await search([
    { field: 'lastName', operator: 'equals', value: 'search' },
    { field: 'membershipStatus', operator: 'notEquals', value: 'Visitor' },
  ]);
  assert.equal(response.status, 200, await response.clone().text());
  const rows = await response.json();
  assert.deepEqual(ids(rows), ['search-alpha']);
  assert.equal(rows[0].contactInfo.email, 'alpha@example.test');
  assert.deepEqual(ids(await (await search([{ field: 'phone', operator: 'endsWith', value: '200' }])).json()), [
    'search-beta',
  ]);
  assert.deepEqual(ids(await (await search([{ field: 'city', operator: 'contains', value: '_%' }])).json()), [
    'search-alpha',
  ]);
});
test('literal Unicode search strings longer than D1 LIKE limits support containment and edges', async () => {
  const value = 'é'.repeat(35) + '_%';
  await h.db
    .prepare("UPDATE people SET firstName=?, contactInfo=json_set(contactInfo,'$.city',?) WHERE id='search-undated'")
    .bind(value, 'prefix-' + value + '-suffix')
    .run();
  for (const [operator, query] of [
    ['contains', value],
    ['startsWith', 'prefix-' + value],
    ['endsWith', value + '-suffix'],
  ]) {
    assert.deepEqual(ids(await (await search([{ field: 'city', operator, value: query }])).json()), ['search-undated']);
  }
  const ordinary = await h.req('/membership/people/search?term=' + encodeURIComponent(value), { token: viewer });
  assert.equal(ordinary.status, 200);
  assert.deepEqual(ids(await ordinary.json()), ['search-undated']);
  assert.deepEqual(
    ids(
      await (
        await search([
          { field: 'city', operator: 'endsWith', value: '' },
          { field: 'id', operator: 'equals', value: 'search-undated' },
        ])
      ).json(),
    ),
    ['search-undated'],
  );
});
test('date/month/age filters exclude missing dates and use civil dates', async () => {
  assert.deepEqual(ids(await (await search([{ field: 'birthMonth', operator: 'equals', value: '2' }])).json()), [
    'search-alpha',
  ]);
  assert.deepEqual(
    ids(
      await (
        await search([
          { field: 'birthDate', operator: 'lessThan', value: '2005-01-01' },
          { field: 'lastName', operator: 'equals', value: 'Search' },
        ])
      ).json(),
    ),
    ['search-alpha'],
  );
  const today = new Date();
  const age = today.getUTCFullYear() - 2000 - ((today.getUTCMonth() + 1) * 100 + today.getUTCDate() < 229 ? 1 : 0);
  assert.deepEqual(
    ids(
      await (
        await search([
          { field: 'id', operator: 'equals', value: 'search-alpha' },
          { field: 'age', operator: 'equals', value: String(age) },
        ])
      ).json(),
    ),
    ['search-alpha'],
  );
  assert.ok(
    ids(await (await search([{ field: 'dateAdded', operator: 'lastDays', value: '0' }])).json()).includes(
      'search-alpha',
    ),
  );
  assert.equal((await search([{ field: 'birthDate', operator: 'equals', value: '2026-02-31' }])).status, 400);
});
test('ID set filters keep proper IN/NOT IN semantics and D1-safe binding counts', async () => {
  assert.deepEqual(
    ids(
      await (
        await search([
          { field: 'id', operator: 'in', value: 'search-alpha,search-beta' },
          { field: 'id', operator: 'notIn', value: 'search-alpha,missing' },
        ])
      ).json(),
    ),
    ['search-beta'],
  );
  assert.deepEqual(await (await search([{ field: 'id', operator: 'in', value: '' }])).json(), []);
  const list = Array.from({ length: 999 }, (_, i) => 'missing-' + i)
    .concat('search-alpha')
    .join(',');
  assert.deepEqual(ids(await (await search([{ field: 'id', operator: 'in', value: list }])).json()), ['search-alpha']);
});
test('unknown fields/operators, tenant forgery and SQL-like values fail closed', async () => {
  for (const field of ['passwordHash', 'churchId', 'constructor', 'firstName) OR 1=1 --', 'personField_unported'])
    assert.equal((await search([{ field, operator: 'equals', value: 'x' }])).status, 400);
  assert.equal((await search([{ field: 'firstName', operator: 'toString', value: 'x' }])).status, 400);
  assert.equal(
    (
      await search(
        Array.from({ length: 41 }, () => ({
          field: 'id',
          operator: 'equals',
          value: 'x',
        })),
      )
    ).status,
    400,
  );
  assert.deepEqual(
    await (await search([{ field: 'firstName', operator: 'contains', value: "' OR 1=1 --" }])).json(),
    [],
  );
  assert.deepEqual(await (await search([{ field: 'id', operator: 'equals', value: 'person-other' }])).json(), []);
  assert.equal((await search([], member)).status, 403);
});
test('dateAdded uses the church civil day across UTC midnight', async () => {
  const zone = new Date().getUTCHours() >= 10 ? 'Pacific/Kiritimati' : 'Etc/GMT+12';
  await h.db.prepare('UPDATE churches SET timeZone=? WHERE id=?').bind(zone, 'church-demo').run();
  try {
    const rows = await (
      await search([
        { field: 'dateAdded', operator: 'lastDays', value: '0' },
        { field: 'id', operator: 'equals', value: 'search-alpha' },
      ])
    ).json();
    assert.deepEqual(ids(rows), ['search-alpha']);
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .formatToParts(new Date())
        .map((p) => [p.type, p.value]),
    );
    assert.deepEqual(
      ids(
        await (
          await search([
            {
              field: 'dateAdded',
              operator: 'equals',
              value: `${parts.year}-${parts.month}-${parts.day}`,
            },
            { field: 'id', operator: 'equals', value: 'search-alpha' },
          ])
        ).json(),
      ),
      ['search-alpha'],
    );
  } finally {
    await h.db.prepare("UPDATE churches SET timeZone='UTC' WHERE id='church-demo'").run();
  }
});
