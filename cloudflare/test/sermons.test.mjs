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
async function data(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
const save = (rows, token = admin) => h.req('/content/sermons', { method: 'POST', token, json: rows });

test('sermon archive requires deliberate public publication and filters future dates', async () => {
  const [sermon] = await data(
    await save([
      {
        title: 'Archive test',
        speaker: 'Synthetic Speaker',
        publishDate: '2020-01-01',
        visibility: 'public',
      },
    ]),
  );
  assert.equal((await h.req(`/public/v1/churches/demo/sermons/${sermon.id}`)).status, 404);
  assert.equal(
    (
      await h.req(`/content/sermons/${sermon.id}/publish`, {
        method: 'POST',
        token: admin,
      })
    ).status,
    200,
  );
  let publicRow = await data(await h.req(`/public/v1/churches/demo/sermons/${sermon.id}`));
  assert.equal(publicRow.title, 'Archive test');
  assert.equal('churchId' in publicRow, false);
  assert.equal('updatedAt' in publicRow, false);
  await save([{ id: sermon.id, title: 'Corrected title' }]);
  publicRow = await data(await h.req(`/public/v1/churches/demo/sermons/${sermon.id}`));
  assert.equal(publicRow.title, 'Corrected title');
  await save([{ id: sermon.id, publishDate: '2099-01-01' }]);
  assert.equal((await h.req(`/public/v1/churches/demo/sermons/${sermon.id}`)).status, 404);
  await save([{ id: sermon.id, publishDate: '2020-01-01' }]);
  assert.equal(
    (
      await h.req(`/content/sermons/${sermon.id}/published`, {
        method: 'DELETE',
        token: admin,
      })
    ).status,
    200,
  );
  assert.equal((await h.req(`/public/v1/churches/demo/sermons/${sermon.id}`)).status, 404);
  assert.equal(
    (
      await h.req(`/content/sermons/${sermon.id}`, {
        method: 'DELETE',
        token: admin,
      })
    ).status,
    200,
  );
});

test('sermon mutations are tenant and role protected and reject unsafe media URLs', async () => {
  assert.equal((await save([{ title: 'No', publishDate: '2020-01-01' }], viewer)).status, 403);
  assert.equal((await h.req('/content/sermons/sermon-demo', { token: other })).status, 404);
  assert.equal((await save([{ id: 'sermon-demo', title: 'Hijack' }], other)).status, 404);
  assert.equal((await h.req('/content/sermons', { token: member })).status, 403);
  assert.equal(
    (
      await save([
        {
          title: 'Unsafe',
          publishDate: '2020-01-01',
          videoUrl: 'javascript:alert(1)',
        },
      ])
    ).status,
    400,
  );
  assert.equal((await save([{ title: 'Invalid date', publishDate: '2027-02-30' }])).status, 400);
  assert.equal((await h.req('/public/v1/churches/demo/sermons?limit=999')).status, 400);
  assert.equal((await h.req('/public/v1/churches/demo/pages')).status, 404);
  assert.equal(
    (
      await h.req('/public/v1/churches/demo/sermons', {
        method: 'POST',
        json: {},
      })
    ).status,
    405,
  );
});

test('upstream playlist fields and sermon associations round-trip without crossing tenants', async () => {
  const [playlist] = await data(
    await h.req('/content/playlists', {
      method: 'POST',
      token: admin,
      json: [
        {
          title: 'Synthetic series',
          description: 'Test playlist',
          publishDate: '2020-01-01',
        },
      ],
    }),
  );
  const [sermon] = await data(
    await save([
      {
        title: 'Series sermon',
        publishDate: '2020-01-01',
        playlistId: playlist.id,
        videoType: 'youtube',
        videoData: 'synthetic-video-id',
        duration: 1800,
      },
    ]),
  );
  assert.equal(sermon.playlistId, playlist.id);
  assert.equal(sermon.videoType, 'youtube');
  assert.equal(sermon.videoData, 'synthetic-video-id');
  assert.equal(sermon.duration, 1800);
  assert.equal(
    (
      await h.req(`/content/playlists/${playlist.id}`, {
        method: 'DELETE',
        token: admin,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await save(
        [
          {
            title: 'Cross tenant',
            publishDate: '2020-01-01',
            playlistId: playlist.id,
          },
        ],
        other,
      )
    ).status,
    404,
  );
  assert.equal((await h.req(`/content/playlists/${playlist.id}`, { token: other })).status, 404);
  assert.equal(
    (
      await h.req(`/content/sermons/${sermon.id}`, {
        method: 'DELETE',
        token: admin,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await h.req(`/content/playlists/${playlist.id}`, {
        method: 'DELETE',
        token: admin,
      })
    ).status,
    200,
  );
});

test('R2 archive upload/download/delete persists bytes and hides object keys', async () => {
  const response = await h.req('/content/files/upload?fileName=archive.txt&contentId=sermon-demo', {
    method: 'POST',
    token: admin,
    headers: { 'Content-Type': 'text/plain' },
    body: 'Synthetic sermon transcript',
  });
  const [file] = await data(response, 201);
  assert.equal(file.provider, 'r2');
  assert.equal('objectKey' in file, false);
  const row = await h.db.prepare('SELECT objectKey FROM content_files WHERE id=?').bind(file.id).first();
  const bucket = await h.mf.getR2Bucket('FILES');
  assert.ok(await bucket.head(row.objectKey));
  const download = await h.req(`/content/files/download/${file.id}`, {
    token: admin,
  });
  assert.equal(await download.text(), 'Synthetic sermon transcript');
  assert.match(download.headers.get('Content-Disposition'), /^attachment/);
  assert.equal(download.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal((await h.req(`/content/files/download/${file.id}`, { token: other })).status, 404);
  assert.equal((await h.req(`/content/files/download/${file.id}`)).status, 401);
  assert.equal(
    (
      await h.req(`/content/files/${file.id}`, {
        method: 'DELETE',
        token: viewer,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await h.req('/content/sermons/sermon-demo', {
        method: 'DELETE',
        token: admin,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await h.req(`/content/files/${file.id}`, {
        method: 'DELETE',
        token: admin,
      })
    ).status,
    200,
  );
  assert.equal(await bucket.head(row.objectKey), null);
  assert.equal((await h.req(`/content/files/download/${file.id}`, { token: admin })).status, 404);
});

test('upstream base64 shape is bounded and attached only to existing tenant sermons', async () => {
  const valid = {
    fileName: 'transcript.txt',
    contentType: 'sermon',
    contentId: 'sermon-demo',
    fileType: 'text/plain',
    fileContents: 'data:text/plain;base64,SGVsbG8=',
  };
  const [file] = await data(
    await h.req('/content/files', {
      method: 'POST',
      token: admin,
      json: [valid],
    }),
    201,
  );
  assert.equal(await (await h.req(`/content/files/download/${file.id}`, { token: admin })).text(), 'Hello');
  for (const [input, status] of [
    [{ ...valid, fileName: '../escape.txt' }, 400],
    [
      {
        ...valid,
        fileType: 'text/html',
        fileContents: 'data:text/html;base64,SGVsbG8=',
      },
      415,
    ],
    [{ ...valid, contentId: 'missing' }, 404],
  ]) {
    assert.equal(
      (
        await h.req('/content/files', {
          method: 'POST',
          token: admin,
          json: [input],
        })
      ).status,
      status,
    );
  }
  assert.equal(
    (
      await h.req('/content/files', {
        method: 'POST',
        token: other,
        json: [valid],
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await h.req('/content/files', {
        method: 'POST',
        token: admin,
        json: [{ ...valid, fileContents: 'data:text/html;base64,SGVsbG8=' }],
      })
    ).status,
    400,
  );
});

test('public sermon feed respects hidden-site setting and never leaks settings', async () => {
  await h.db
    .prepare('UPDATE churches SET settings=? WHERE id=?')
    .bind(JSON.stringify([{ keyName: 'hidePublicSite', value: 'true' }]), 'church-demo')
    .run();
  assert.equal((await h.req('/public/v1/churches/demo/sermons')).status, 404);
  await h.db.prepare('UPDATE churches SET settings=? WHERE id=?').bind('[]', 'church-demo').run();
  const result = await data(await h.req('/public/v1/churches/demo/sermons'));
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.every((row) => !('settings' in row)));
});

test('scheduled cleanup retries interrupted file operations and preserves fresh uploads', async () => {
  const bucket = await h.mf.getR2Bucket('FILES');
  for (const [fileId, state, created] of [
    ['old-pending', 'pending', '2020-01-01T00:00:00.000Z'],
    ['old-deleting', 'deleting', '2020-01-01T00:00:00.000Z'],
    ['new-pending', 'pending', new Date().toISOString()],
    ['old-ready', 'ready', '2020-01-01T00:00:00.000Z'],
  ]) {
    await h.db
      .prepare(
        'INSERT INTO content_files(id,churchId,contentId,fileName,fileType,size,objectKey,state,dateModified) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .bind(fileId, 'church-demo', 'sermon-demo', 'test.txt', 'text/plain', 1, fileId, state, created)
      .run();
    await bucket.put(fileId, 'x');
  }
  const worker = await h.mf.getWorker();
  const result = await worker.scheduled();
  assert.equal(result.outcome, 'ok');
  assert.equal(await bucket.head('old-pending'), null);
  assert.equal(await bucket.head('old-deleting'), null);
  assert.ok(await bucket.head('new-pending'));
  assert.ok(await bucket.head('old-ready'));
  assert.equal(await h.db.prepare("SELECT id FROM content_files WHERE id='old-pending'").first(), null);
  assert.equal((await worker.scheduled()).outcome, 'ok');
});
