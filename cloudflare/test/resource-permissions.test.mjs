import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
async function data(r, status = 200) {
  assert.equal(r.status, status, await r.clone().text());
  return r.json();
}
async function fixture(action = 'Edit') {
  const h = await createHarness(),
    admin = (await h.login()).token,
    token = (await h.login('member@example.test')).token;
  const req = (path, options = {}, auth = token) => h.req(path, { token: auth, ...options });
  const save = (path, json, auth = admin) => req(path, { method: 'POST', json }, auth).then((r) => data(r));
  const calendars = await save('/content/calendars', [{ name: 'Calendar A' }, { name: 'Calendar B' }]);
  const playlists = await save('/content/playlists', [{ title: 'Playlist A' }, { title: 'Playlist B' }]);
  const sermons = await save(
    '/content/sermons',
    playlists.map((p, i) => ({
      title: 'Sermon ' + i,
      playlistId: p.id,
      publishDate: '2026-01-01',
      visibility: 'private',
    })),
  );
  const events = await save(
    '/content/events',
    calendars.map((c, i) => ({
      calendarId: c.id,
      title: 'Event ' + i,
      start: '2027-01-04T10:00:00Z',
      end: '2027-01-04T11:00:00Z',
      recurrenceRule: 'FREQ=WEEKLY;COUNT=3',
    })),
  );
  const [role] = await save('/membership/roles', [{ name: 'Resource-scoped staff' }]);
  const grant = async (contentType, contentId, permission = action) =>
    (
      await save('/membership/rolepermissions', [
        { roleId: role.id, apiName: 'ContentApi', contentType, contentId, action: permission },
      ])
    )[0];
  const calendarGrant = await grant('Calendars', calendars[0].id),
    playlistGrant = await grant('Playlists', playlists[0].id),
    sermonGrant = await grant('Sermons', 'sermon-demo');
  await save('/membership/rolemembers', [{ roleId: role.id, userId: 'user-member' }]);
  return {
    h,
    admin,
    token,
    req,
    save,
    grant,
    role,
    calendars,
    playlists,
    sermons,
    events,
    calendarGrant,
    playlistGrant,
    sermonGrant,
  };
}
test('calendar scope filters lists, instances and exception reads before returning private event data', async () => {
  const f = await fixture();
  try {
    const rows = await data(await f.req('/content/calendars'));
    assert.deepEqual(
      rows.map((r) => r.id),
      [f.calendars[0].id],
    );
    assert.equal(rows[0].canEdit, true);
    assert.equal(rows[0].canCreate, false);
    assert.deepEqual(
      (await data(await f.req('/content/events'))).map((r) => r.id),
      [f.events[0].id],
    );
    const instances = await data(await f.req('/content/events/instances?start=2027-01-01&end=2027-02-01'));
    assert.equal(instances.length, 3);
    assert.ok(instances.every((r) => r.calendarId === f.calendars[0].id));
    for (const path of [
      '/content/calendars/' + f.calendars[1].id,
      '/content/events/' + f.events[1].id,
      '/content/events/' + f.events[1].id + '/occurrences/2027-01-04',
      '/content/eventExceptions?eventId=' + f.events[1].id,
    ])
      assert.equal((await f.req(path)).status, 403, path);
    assert.deepEqual(await data(await f.req('/content/events?calendarId=' + f.calendars[1].id)), []);
    assert.equal((await f.req('/membership/people')).status, 403);
    assert.equal((await f.req('/content/pages')).status, 403);
  } finally {
    await f.h.dispose();
  }
});
test('resource View never admits mutation, while global Calendars Admin applies only to calendars', async () => {
  const f = await fixture('View');
  try {
    assert.equal(
      (await f.req('/content/calendars', { method: 'POST', json: [{ id: f.calendars[0].id, name: 'No' }] })).status,
      403,
    );
    assert.equal(
      (await f.req('/content/sermons/' + f.sermons[0].id + '/publish', { method: 'POST', json: {} })).status,
      403,
    );
    await f.grant('Calendars', '', 'Admin');
    const [newCalendar] = await f.save('/content/calendars', [{ name: 'Calendar admin create' }], f.token);
    assert.ok(newCalendar.id);
    await f.save('/content/events', [{ id: f.events[1].id, title: 'Global calendar edit' }], f.token);
    assert.equal(
      (
        await f.req('/content/sermons', {
          method: 'POST',
          json: [{ title: 'Not a calendar', publishDate: '2026-01-01' }],
        })
      ).status,
      403,
    );
    assert.equal((await f.req('/content/calendars/fake/provider', { method: 'POST', json: {} })).status, 403);
  } finally {
    await f.h.dispose();
  }
});
test('calendar event moves and recurring edits require both scopes and preserve transactional batches', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.req('/content/calendars', { method: 'POST', json: [{ name: 'No global creation' }] })).status,
      403,
    );
    assert.equal(
      (
        await f.req('/content/events', {
          method: 'POST',
          json: [
            { id: f.events[0].id, title: 'Rollback' },
            { id: f.events[1].id, title: 'Denied' },
          ],
        })
      ).status,
      403,
    );
    assert.equal((await data(await f.req('/content/events/' + f.events[0].id))).title, 'Event 0');
    assert.equal(
      (
        await f.req('/content/events', {
          method: 'POST',
          json: [{ id: f.events[0].id, calendarId: f.calendars[1].id }],
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.req('/content/events/' + f.events[0].id + '/future/2027-01-11', {
          method: 'POST',
          json: { calendarId: f.calendars[1].id, title: 'No split' },
        })
      ).status,
      403,
    );
    await f.save(
      '/content/events/' + f.events[0].id + '/occurrences/2027-01-04',
      { title: 'Permitted occurrence' },
      f.token,
    );
    const exceptions = await data(await f.req('/content/eventExceptions?eventId=' + f.events[0].id));
    assert.equal(exceptions.length, 1);
    assert.equal((await f.req('/content/eventExceptions/' + exceptions[0].id, { method: 'DELETE' })).status, 200);
    await f.grant('Calendars', f.calendars[1].id);
    await f.save('/content/events', [{ id: f.events[0].id, calendarId: f.calendars[1].id }], f.token);
    assert.equal((await data(await f.req('/content/events/' + f.events[0].id))).calendarId, f.calendars[1].id);
    assert.equal((await f.h.db.prepare('SELECT count(*) n FROM write_guards').first()).n, 0);
  } finally {
    await f.h.dispose();
  }
});
test('playlist grants inherit sermon read/edit; exact sermon grants do not expose sibling records', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(
      (await data(await f.req('/content/playlists'))).map((r) => r.id),
      [f.playlists[0].id],
    );
    const ids = (await data(await f.req('/content/sermons'))).map((r) => r.id).sort();
    assert.deepEqual(ids, [f.sermons[0].id, 'sermon-demo'].sort());
    assert.equal((await f.req('/content/sermons/' + f.sermons[1].id)).status, 403);
    assert.equal((await f.req('/content/playlists/' + f.playlists[1].id)).status, 403);
    const [created] = await f.save(
      '/content/sermons',
      [{ title: 'Created within playlist', playlistId: f.playlists[0].id, publishDate: '2026-01-01' }],
      f.token,
    );
    assert.equal(created.playlistId, f.playlists[0].id);
    assert.equal(
      (
        await f.req('/content/sermons', {
          method: 'POST',
          json: [{ title: 'Outside folder', publishDate: '2026-01-01' }],
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.req('/content/playlists', { method: 'POST', json: [{ title: 'New root playlist' }] })).status,
      403,
    );
    await f.save('/content/sermons', [{ id: f.sermons[0].id, visibility: 'public' }], f.token);
    assert.equal(
      (await f.req('/content/sermons/' + f.sermons[0].id + '/publish', { method: 'POST', json: {} })).status,
      200,
    );
    assert.equal((await f.req('/content/sermons/' + f.sermons[0].id + '/published', { method: 'DELETE' })).status, 200);
  } finally {
    await f.h.dispose();
  }
});
test('sermon moves and bulk saves require source plus destination rights including unassigned destination', async () => {
  const f = await fixture();
  try {
    for (const changes of [
      { id: f.sermons[0].id, playlistId: f.playlists[1].id },
      { id: f.sermons[1].id, playlistId: f.playlists[0].id },
      { id: f.sermons[0].id, playlistId: null },
    ])
      assert.equal((await f.req('/content/sermons', { method: 'POST', json: [changes] })).status, 403);
    assert.equal(
      (
        await f.req('/content/sermons', {
          method: 'POST',
          json: [
            { id: f.sermons[0].id, title: 'Rollback' },
            { id: f.sermons[1].id, title: 'No' },
          ],
        })
      ).status,
      403,
    );
    assert.equal((await data(await f.req('/content/sermons/' + f.sermons[0].id))).title, 'Sermon 0');
    await f.grant('Playlists', f.playlists[1].id);
    await f.save('/content/sermons', [{ id: f.sermons[0].id, playlistId: f.playlists[1].id }], f.token);
    await f.grant('Sermons', '', 'Edit');
    await f.save('/content/sermons', [{ id: f.sermons[0].id, playlistId: null }], f.token);
    assert.equal((await data(await f.req('/content/sermons/' + f.sermons[0].id))).playlistId, null);
  } finally {
    await f.h.dispose();
  }
});
test('permission metadata contains only delegatable resource names and actions; scopes validate and revoke on delete', async () => {
  const f = await fixture();
  try {
    await f.save('/membership/rolepermissions', [
      { roleId: f.role.id, apiName: 'MembershipApi', contentType: 'Roles', action: 'View' },
    ]);
    // Eligible scope must survive more than one page of earlier, unauthorized names.
    await f.h.db
      .prepare(
        "WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<1001) INSERT INTO calendars(id,churchId,name,timeZone,updatedAt) SELECT 'hidden-calendar-'||n,'church-demo','0 Hidden '||n,'UTC','2026-01-01' FROM numbers",
      )
      .run();
    const scopes = await data(await f.req('/membership/permissionScopes'));
    assert.deepEqual(scopes.map((r) => r.id).sort(), [f.calendars[0].id, f.playlists[0].id, 'sermon-demo'].sort());
    assert.ok(scopes.every((r) => Object.keys(r).sort().join(',') === 'id,name,permissions,scopeType'));
    assert.ok(scopes.every((r) => r.permissions[0].actions.join(',') === 'Edit'));
    for (const [kind, id, status] of [
      ['Calendars', f.playlists[0].id, 400],
      ['Sermons', f.calendars[0].id, 400],
      ['Content', f.sermons[0].id, 501],
    ])
      assert.equal(
        (
          await f.req(
            '/membership/rolepermissions',
            {
              method: 'POST',
              json: [{ roleId: f.role.id, apiName: 'ContentApi', contentType: kind, contentId: id, action: 'Edit' }],
            },
            f.admin,
          )
        ).status,
        status,
      );
    assert.equal(
      (
        await f.req(
          '/membership/rolepermissions',
          {
            method: 'POST',
            json: [
              {
                roleId: f.role.id,
                apiName: 'ContentApi',
                contentType: 'Calendars',
                contentId: f.calendars[0].id,
                action: 'Admin',
              },
            ],
          },
          f.admin,
        )
      ).status,
      400,
    );
    const [empty] = await f.save('/content/playlists', [{ title: 'Disposable scope' }]);
    const grant = await f.grant('Playlists', empty.id);
    assert.equal((await f.req('/content/playlists/' + empty.id, { method: 'DELETE' })).status, 200);
    assert.equal(await f.h.db.prepare('SELECT id FROM role_permissions WHERE id=?').bind(grant.id).first(), null);
  } finally {
    await f.h.dispose();
  }
});
test('scoped file access follows current sermon/playlist authorization and never exposes another archive', async () => {
  const f = await fixture();
  try {
    const upload = (sermonId, auth = f.token) =>
      f.req(
        '/content/files/upload?contentId=' + sermonId + '&fileName=synthetic.txt',
        { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'synthetic' },
        auth,
      );
    const [a] = await data(await upload(f.sermons[0].id), 201),
      [b] = await data(await upload(f.sermons[1].id, f.admin), 201);
    assert.deepEqual(
      (await data(await f.req('/content/files'))).map((r) => r.id),
      [a.id],
    );
    assert.equal((await f.req('/content/files/download/' + a.id)).status, 200);
    for (const path of [
      '/content/files/' + b.id,
      '/content/files/download/' + b.id,
      '/content/files/sermon/' + f.sermons[1].id,
    ])
      assert.equal((await f.req(path)).status, 403, path);
    assert.equal((await upload(f.sermons[1].id)).status, 403);
    assert.equal((await f.req('/content/files/' + b.id, { method: 'DELETE' })).status, 403);
    await f.save('/content/sermons', [{ id: f.sermons[0].id, playlistId: f.playlists[1].id }]);
    assert.equal((await f.req('/content/files/download/' + a.id)).status, 403);
  } finally {
    await f.h.dispose();
  }
});
test('multipart uploads use scoped sermon rights and publication stays private until authorized completion', async () => {
  const f = await fixture();
  try {
    const session = await data(
      await f.req('/content/files/uploads', {
        method: 'POST',
        json: {
          contentId: f.sermons[0].id,
          fileName: 'synthetic.txt',
          fileType: 'text/plain',
          size: 3,
          idempotencyKey: crypto.randomUUID(),
        },
      }),
      201,
    );
    assert.equal((await f.req('/content/files/' + session.fileId)).status, 404);
    assert.equal(
      (await f.req('/content/files/uploads/' + session.id + '/parts/1', { method: 'PUT', body: 'abc' })).status,
      200,
    );
    const completed = await data(
      await f.req('/content/files/uploads/' + session.id + '/complete', { method: 'POST', json: {} }),
    );
    assert.equal(completed.state, 'complete');
    const next = await data(
      await f.req('/content/files/uploads', {
        method: 'POST',
        json: {
          contentId: f.sermons[0].id,
          fileName: 'later.txt',
          fileType: 'text/plain',
          size: 3,
          idempotencyKey: crypto.randomUUID(),
        },
      }),
      201,
    );
    await f.req('/membership/rolepermissions/' + f.playlistGrant.id, { method: 'DELETE' }, f.admin);
    assert.equal(
      (await f.req('/content/files/uploads/' + next.id + '/parts/1', { method: 'PUT', body: 'abc' })).status,
      403,
    );
    assert.equal(
      (await f.h.db.prepare('SELECT state FROM media_uploads WHERE id=?').bind(next.id).first()).state,
      'aborted',
    );
    assert.equal(await f.h.db.prepare('SELECT id FROM content_files WHERE id=?').bind(next.fileId).first(), null);
  } finally {
    await f.h.dispose();
  }
});
test('multipart completion rechecks a revoked playlist grant after R2 commits and removes private pending bytes', async () => {
  const f = await fixture();
  try {
    const bundled = await build({
      stdin: {
        contents: "export {authenticate} from './src/auth.ts'; export {mediaUploads} from './src/media-uploads.ts';",
        resolveDir: fileURLToPath(new URL('../', import.meta.url)),
      },
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
    });
    const handlers = await import(
      'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64')
    );
    const session = await data(
      await f.req('/content/files/uploads', {
        method: 'POST',
        json: {
          contentId: f.sermons[0].id,
          fileName: 'revoked.txt',
          fileType: 'text/plain',
          size: 3,
          idempotencyKey: crypto.randomUUID(),
        },
      }),
      201,
    );
    await data(await f.req('/content/files/uploads/' + session.id + '/parts/1', { method: 'PUT', body: 'abc' }));
    const bucket = await f.h.mf.getR2Bucket('FILES');
    const saved = await f.h.db.prepare('SELECT * FROM media_uploads WHERE id=?').bind(session.id).first();
    let completed = 0;
    const FILES = new Proxy(bucket, {
      get(target, key) {
        if (key === 'resumeMultipartUpload')
          return (...args) => {
            const upload = target.resumeMultipartUpload(...args);
            return new Proxy(upload, {
              get(inner, property) {
                if (property === 'complete')
                  return async (...parts) => {
                    const object = await inner.complete(...parts);
                    completed++;
                    await f.h.db.prepare('DELETE FROM role_permissions WHERE id=?').bind(f.playlistGrant.id).run();
                    return object;
                  };
                const value = Reflect.get(inner, property);
                return typeof value === 'function' ? value.bind(inner) : value;
              },
            });
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const path = '/content/files/uploads/' + session.id + '/complete';
    const request = new Request('http://localhost/api' + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + f.token },
    });
    const env = { DB: f.h.db, FILES, SESSION_SECRET: 'test-only-secret-never-for-deployment-123456789' };
    const principal = await handlers.authenticate(request, env);
    await assert.rejects(
      handlers.mediaUploads({ request, url: new URL(request.url), path, env, principal }),
      /authorized_write_snapshot|CHECK constraint/i,
    );
    assert.equal(completed, 1);
    assert.equal(
      (await f.h.db.prepare('SELECT state FROM media_uploads WHERE id=?').bind(session.id).first()).state,
      'aborted',
    );
    assert.equal(await f.h.db.prepare('SELECT id FROM content_files WHERE id=?').bind(session.fileId).first(), null);
    assert.equal(await bucket.head(saved.objectKey), null);
    assert.equal(
      (
        await f.h.db
          .prepare("SELECT count(*) n FROM audit_log WHERE entityId=? AND action='content.files.multipart.complete'")
          .bind(session.fileId)
          .first()
      ).n,
      0,
    );
    assert.equal((await f.h.db.prepare('SELECT count(*) n FROM write_guards').first()).n, 0);
  } finally {
    await f.h.dispose();
  }
});
