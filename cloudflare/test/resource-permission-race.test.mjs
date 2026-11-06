import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHarness } from './harness.mjs';

const bundle = await build({
  stdin: {
    contents: `export { authenticate } from './src/auth.ts';
      export { calendar } from './src/calendar.ts';
      export { content, cleanupFiles } from './src/content.ts';
      export { roles } from './src/roles.ts';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
});
const handlers = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);

async function fixture() {
  const h = await createHarness();
  try {
    await h.db.batch([
      ...['editor', 'target'].map((name) =>
        h.db.prepare('INSERT INTO roles(id,churchId,name) VALUES(?,?,?)').bind(name, 'church-demo', name),
      ),
      h.db.prepare(
        "INSERT INTO role_members(id,churchId,roleId,userId,addedBy,dateAdded) VALUES('editor-member','church-demo','editor','user-member','user-admin','2026-01-01')",
      ),
      ...['View', 'Edit'].map((action) =>
        h.db
          .prepare(
            'INSERT INTO role_permissions(id,churchId,roleId,apiName,contentType,contentId,action) VALUES(?,?,?,?,?,?,?)',
          )
          .bind('roles-' + action, 'church-demo', 'editor', 'MembershipApi', 'Roles', '', action),
      ),
      ...['a', 'b', 'c'].flatMap((suffix) => [
        h.db
          .prepare(
            "INSERT INTO calendars(id,churchId,name,timeZone,updatedAt) VALUES(?,'church-demo',?,'UTC','2026-01-01')",
          )
          .bind('calendar-' + suffix, 'Calendar ' + suffix),
        h.db
          .prepare(
            "INSERT INTO content_playlists(id,churchId,title,publishDate,updatedAt) VALUES(?,'church-demo',?,'2026-01-01','2026-01-01')",
          )
          .bind('playlist-' + suffix, 'Playlist ' + suffix),
      ]),
      ...['a', 'b'].flatMap((suffix) => [
        h.db
          .prepare(
            "INSERT INTO role_permissions(id,churchId,roleId,apiName,contentType,contentId,action) VALUES(?,'church-demo','editor','ContentApi','Calendars',?,'Edit')",
          )
          .bind('calendar-grant-' + suffix, 'calendar-' + suffix),
        h.db
          .prepare(
            "INSERT INTO role_permissions(id,churchId,roleId,apiName,contentType,contentId,action) VALUES(?,'church-demo','editor','ContentApi','Playlists',?,'Edit')",
          )
          .bind('playlist-grant-' + suffix, 'playlist-' + suffix),
        h.db
          .prepare(
            "INSERT INTO calendar_events(id,churchId,calendarId,title,start,end,timeZone,updatedAt) VALUES(?,'church-demo','calendar-a',?,'2027-01-01T10:00:00.000Z','2027-01-01T11:00:00.000Z','UTC','2026-01-01')",
          )
          .bind('event-' + suffix, 'Event ' + suffix),
        h.db
          .prepare(
            "INSERT INTO content_sermons(id,churchId,playlistId,title,publishDate,visibility,updatedAt) VALUES(?,'church-demo','playlist-a',?,'2026-01-01','public','2026-01-01')",
          )
          .bind('sermon-' + suffix, 'Sermon ' + suffix),
      ]),
    ]);
    const token = (await h.login('member@example.test')).token;
    const env = { DB: h.db, SESSION_SECRET: 'test-only-secret-never-for-deployment-123456789' };
    async function race(handler, path, method, input, competingWrite) {
      const request = new Request('http://localhost/api' + path, {
        method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      const principal = await handlers.authenticate(request, env);
      const auditBefore = (await h.db.prepare('SELECT count(*) n FROM audit_log').first()).n;
      let invoked = 0;
      const db = {
        prepare: (...args) => h.db.prepare(...args),
        batch: async (statements) => {
          invoked++;
          assert.equal(invoked, 1, 'Mutation must use one atomic guarded batch');
          await competingWrite();
          return h.db.batch(statements);
        },
      };
      await assert.rejects(
        handlers[handler]({ request, url: new URL(request.url), path, principal, env: { ...env, DB: db } }),
        /CHECK constraint failed|changed.*refresh|authority.*changed/i,
      );
      assert.equal(invoked, 1, 'The competing transition must run after handler preflight');
      assert.equal((await h.db.prepare('SELECT count(*) n FROM write_guards').first()).n, 0);
      assert.equal((await h.db.prepare('SELECT count(*) n FROM audit_log').first()).n, auditBefore);
    }
    return { h, token, race };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}

test('calendar grant revocation during an edit prevents both the write and its audit', async () => {
  const f = await fixture();
  try {
    await f.race('calendar', '/content/calendars', 'POST', [{ id: 'calendar-a', name: 'Unauthorized' }], () =>
      f.h.db.prepare("DELETE FROM role_permissions WHERE id='calendar-grant-a'").run(),
    );
    assert.equal((await f.h.db.prepare("SELECT name FROM calendars WHERE id='calendar-a'").first()).name, 'Calendar a');
  } finally {
    await f.h.dispose();
  }
});

test('an event moved beyond scope after preflight rolls back the whole edit batch', async () => {
  const f = await fixture();
  try {
    await f.race(
      'calendar',
      '/content/events',
      'POST',
      [
        { id: 'event-a', title: 'Earlier edit must roll back' },
        { id: 'event-b', title: 'Stale authorized calendar' },
      ],
      () => f.h.db.prepare("UPDATE calendar_events SET calendarId='calendar-c' WHERE id='event-b'").run(),
    );
    assert.equal(
      (await f.h.db.prepare("SELECT title FROM calendar_events WHERE id='event-a'").first()).title,
      'Event a',
    );
    assert.deepEqual(await f.h.db.prepare("SELECT title,calendarId FROM calendar_events WHERE id='event-b'").first(), {
      title: 'Event b',
      calendarId: 'calendar-c',
    });
  } finally {
    await f.h.dispose();
  }
});

test('an event move requires destination calendar authority at commit', async () => {
  const f = await fixture();
  try {
    await f.race('calendar', '/content/events', 'POST', [{ id: 'event-a', calendarId: 'calendar-b' }], () =>
      f.h.db.prepare("DELETE FROM role_permissions WHERE id='calendar-grant-b'").run(),
    );
    assert.equal(
      (await f.h.db.prepare("SELECT calendarId FROM calendar_events WHERE id='event-a'").first()).calendarId,
      'calendar-a',
    );
  } finally {
    await f.h.dispose();
  }
});

test('a sermon moved beyond its playlist grant cannot be changed through stale source authority', async () => {
  const f = await fixture();
  try {
    await f.race('content', '/content/sermons', 'POST', [{ id: 'sermon-a', title: 'Unauthorized' }], () =>
      f.h.db.prepare("UPDATE content_sermons SET playlistId='playlist-c' WHERE id='sermon-a'").run(),
    );
    assert.deepEqual(await f.h.db.prepare("SELECT title,playlistId FROM content_sermons WHERE id='sermon-a'").first(), {
      title: 'Sermon a',
      playlistId: 'playlist-c',
    });
  } finally {
    await f.h.dispose();
  }
});

test('publishing requires a live resource grant and rolls back audit when it was revoked', async () => {
  const f = await fixture();
  try {
    await f.race('content', '/content/sermons/sermon-a/publish', 'POST', {}, () =>
      f.h.db.prepare("DELETE FROM role_permissions WHERE id='playlist-grant-a'").run(),
    );
    assert.equal(
      (await f.h.db.prepare("SELECT publishedAt FROM content_sermons WHERE id='sermon-a'").first()).publishedAt,
      null,
    );
  } finally {
    await f.h.dispose();
  }
});

test('sermon moves check destination authority and atomically roll back earlier bulk rows', async () => {
  const f = await fixture();
  try {
    await f.race(
      'content',
      '/content/sermons',
      'POST',
      [
        { id: 'sermon-a', title: 'Earlier edit must roll back' },
        { id: 'sermon-b', playlistId: 'playlist-b' },
      ],
      () => f.h.db.prepare("DELETE FROM role_permissions WHERE id='playlist-grant-b'").run(),
    );
    assert.equal(
      (await f.h.db.prepare("SELECT title FROM content_sermons WHERE id='sermon-a'").first()).title,
      'Sermon a',
    );
    assert.equal(
      (await f.h.db.prepare("SELECT playlistId FROM content_sermons WHERE id='sermon-b'").first()).playlistId,
      'playlist-a',
    );
  } finally {
    await f.h.dispose();
  }
});

test('a resource deleted during role delegation cannot leave a new dangling scoped grant', async () => {
  const f = await fixture();
  try {
    await f.race(
      'roles',
      '/membership/rolepermissions',
      'POST',
      [
        {
          id: 'stale-calendar-delegation',
          roleId: 'target',
          apiName: 'ContentApi',
          contentType: 'Calendars',
          contentId: 'calendar-b',
          action: 'Edit',
        },
      ],
      () => f.h.db.prepare("DELETE FROM calendars WHERE id='calendar-b'").run(),
    );
    assert.equal(
      await f.h.db.prepare("SELECT id FROM role_permissions WHERE id='stale-calendar-delegation'").first(),
      null,
    );
  } finally {
    await f.h.dispose();
  }
});

test('revoking a scoped grant during delegation prevents passing it to another role', async () => {
  const f = await fixture();
  try {
    await f.race(
      'roles',
      '/membership/rolepermissions',
      'POST',
      [
        {
          id: 'revoked-playlist-delegation',
          roleId: 'target',
          apiName: 'ContentApi',
          contentType: 'Playlists',
          contentId: 'playlist-b',
          action: 'Edit',
        },
      ],
      () => f.h.db.prepare("DELETE FROM role_permissions WHERE id='playlist-grant-b'").run(),
    );
    assert.equal(
      await f.h.db.prepare("SELECT id FROM role_permissions WHERE id='revoked-playlist-delegation'").first(),
      null,
    );
  } finally {
    await f.h.dispose();
  }
});

test('authority lost during R2 upload prevents publication and compensates the stored object', async () => {
  for (const transition of [
    "DELETE FROM role_permissions WHERE id='playlist-grant-a'",
    "UPDATE content_sermons SET playlistId='playlist-c' WHERE id='sermon-a'",
  ]) {
    const f = await fixture();
    try {
      const bucket = await f.h.mf.getR2Bucket('FILES');
      const request = new Request('http://localhost/api/content/files', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json' },
        body: JSON.stringify([
          {
            fileName: 'synthetic-revoked-upload.txt',
            contentType: 'sermon',
            contentId: 'sermon-a',
            fileContents: 'data:text/plain;base64,' + Buffer.from('Private synthetic upload').toString('base64'),
          },
        ]),
      });
      const env = { DB: f.h.db, SESSION_SECRET: 'test-only-secret-never-for-deployment-123456789' };
      const principal = await handlers.authenticate(request, env);
      const before = (await f.h.db.prepare('SELECT count(*) n FROM audit_log').first()).n;
      let storedKey;
      const files = {
        put: async (key, ...args) => {
          storedKey = key;
          const result = await bucket.put(key, ...args);
          await f.h.db.prepare(transition).run();
          return result;
        },
        delete: (...args) => bucket.delete(...args),
      };
      await assert.rejects(
        handlers.content({
          request,
          url: new URL(request.url),
          path: '/content/files',
          principal,
          env: { ...env, FILES: files },
        }),
        /CHECK constraint failed/,
      );
      assert.ok(storedKey, 'The authority transition happens after a real R2 put');
      assert.equal(await bucket.head(storedKey), null);
      assert.equal(
        await f.h.db.prepare("SELECT id FROM content_files WHERE fileName='synthetic-revoked-upload.txt'").first(),
        null,
      );
      assert.equal((await f.h.db.prepare('SELECT count(*) n FROM audit_log').first()).n, before);
      assert.equal((await f.h.db.prepare('SELECT count(*) n FROM write_guards').first()).n, 0);
    } finally {
      await f.h.dispose();
    }
  }
});

test('an uncertain response after the ready transaction cannot delete the committed archive object', async () => {
  const f = await fixture();
  try {
    const bucket = await f.h.mf.getR2Bucket('FILES');
    const bytes = 'Synthetic committed archive';
    const request = new Request('http://localhost/api/content/files', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        {
          fileName: 'synthetic-uncertain-commit.txt',
          contentType: 'sermon',
          contentId: 'sermon-a',
          fileContents: 'data:text/plain;base64,' + Buffer.from(bytes).toString('base64'),
        },
      ]),
    });
    const env = { DB: f.h.db, SESSION_SECRET: 'test-only-secret-never-for-deployment-123456789' };
    const principal = await handlers.authenticate(request, env);
    let batches = 0;
    const db = {
      prepare: (...args) => f.h.db.prepare(...args),
      batch: async (statements) => {
        const result = await f.h.db.batch(statements);
        if (++batches === 2) throw new Error('Synthetic transport failure after commit');
        return result;
      },
    };
    try {
      const response = await handlers.content({
        request,
        url: new URL(request.url),
        path: '/content/files',
        principal,
        env: { ...env, DB: db, FILES: bucket },
      });
      assert.equal(response.status, 201);
    } catch (error) {
      assert.match(String(error), /Synthetic transport failure after commit/);
    }
    assert.equal(batches, 2);
    const row = await f.h.db
      .prepare("SELECT * FROM content_files WHERE fileName='synthetic-uncertain-commit.txt'")
      .first();
    assert.equal(row.state, 'ready');
    const object = await bucket.get(row.objectKey);
    assert.ok(object, 'Confirmed ready metadata must retain its committed R2 object');
    assert.equal(await object.text(), bytes);
    assert.equal(
      (
        await f.h.db
          .prepare("SELECT count(*) n FROM audit_log WHERE action='content.files.upload' AND entityId=?")
          .bind(row.id)
          .first()
      ).n,
      1,
    );
  } finally {
    await f.h.dispose();
  }
});

test('cleanup cannot delete bytes of an upload that became ready after stale-row selection', async () => {
  const f = await fixture();
  try {
    const bucket = await f.h.mf.getR2Bucket('FILES'),
      objectKey = 'synthetic/cleanup-selected-pending';
    await bucket.put(objectKey, 'abc');
    await f.h.db
      .prepare(
        "INSERT INTO content_files(id,churchId,contentId,fileName,fileType,size,objectKey,state,dateModified) VALUES('cleanup-selected','church-demo','sermon-a','cleanup.txt','text/plain',3,?,'pending','2000-01-01')",
      )
      .bind(objectKey)
      .run();
    let interleaved = 0;
    const db = {
      prepare: (sql) => {
        const statement = f.h.db.prepare(sql);
        if (!sql.startsWith('SELECT') || !sql.includes('FROM content_files') || !sql.includes('dateModified<'))
          return statement;
        return {
          bind: (...args) => ({
            all: async () => {
              const result = await statement.bind(...args).all();
              interleaved++;
              const saved = await f.h.db
                .prepare(
                  "UPDATE content_files SET state='ready',dateModified=? WHERE id='cleanup-selected' AND state='pending'",
                )
                .bind(new Date().toISOString())
                .run();
              assert.equal(saved.meta.changes, 1, 'The uploader wins after the collector selects stale metadata');
              return result;
            },
          }),
        };
      },
      batch: (...args) => f.h.db.batch(...args),
    };
    await handlers.cleanupFiles({ DB: db, FILES: bucket });
    assert.equal(interleaved, 1);
    assert.equal(
      (await f.h.db.prepare("SELECT state FROM content_files WHERE id='cleanup-selected'").first()).state,
      'ready',
    );
    const object = await bucket.get(objectKey);
    assert.ok(object, 'Collector must not delete bytes after the ready transition wins');
    assert.equal(await object.text(), 'abc');
  } finally {
    await f.h.dispose();
  }
});

test('an uploader cannot report success or audit publication after cleanup claimed its pending file', async () => {
  const f = await fixture();
  try {
    const bucket = await f.h.mf.getR2Bucket('FILES');
    const request = new Request('http://localhost/api/content/files', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        {
          fileName: 'synthetic-cleanup-wins.txt',
          contentType: 'sermon',
          contentId: 'sermon-a',
          fileContents: 'data:text/plain;base64,YWJj',
        },
      ]),
    });
    const env = { DB: f.h.db, SESSION_SECRET: 'test-only-secret-never-for-deployment-123456789' };
    const principal = await handlers.authenticate(request, env);
    const auditsBefore = (await f.h.db.prepare('SELECT count(*) n FROM audit_log').first()).n;
    let storedKey;
    const files = {
      put: async (key, ...args) => {
        storedKey = key;
        const result = await bucket.put(key, ...args);
        await f.h.db.prepare("UPDATE content_files SET dateModified='2000-01-01' WHERE objectKey=?").bind(key).run();
        await handlers.cleanupFiles({ DB: f.h.db, FILES: bucket });
        return result;
      },
      delete: (...args) => bucket.delete(...args),
    };
    await assert.rejects(
      handlers.content({
        request,
        url: new URL(request.url),
        path: '/content/files',
        principal,
        env: { ...env, FILES: files },
      }),
      /CHECK constraint failed/,
    );
    assert.ok(storedKey);
    assert.equal(await bucket.head(storedKey), null);
    assert.equal(
      await f.h.db.prepare("SELECT id FROM content_files WHERE fileName='synthetic-cleanup-wins.txt'").first(),
      null,
    );
    assert.equal((await f.h.db.prepare('SELECT count(*) n FROM audit_log').first()).n, auditsBefore);
  } finally {
    await f.h.dispose();
  }
});
