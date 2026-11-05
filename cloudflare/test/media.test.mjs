import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { applySql, createHarness } from './harness.mjs';
let h, admin, viewer, other, member, bucket, media;
const PART = 8 * 1024 * 1024;
test.before(async () => {
  h = await createHarness();
  bucket = await h.mf.getR2Bucket('FILES');
  admin = (await h.login()).token;
  viewer = (await h.login('viewer@example.test')).token;
  other = (await h.login('other@example.test')).token;
  member = (await h.login('member@example.test')).token;
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/media-uploads.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  media = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
});
test.after(async () => h?.dispose());
async function data(r, status = 200) {
  assert.equal(r.status, status, await r.clone().text());
  return r.json();
}
const headers = { 'Content-Type': 'application/octet-stream' };
const payload = (size, fields = {}) => ({
  contentId: 'sermon-demo',
  fileName: 'synthetic.bin',
  fileType: 'application/octet-stream',
  size,
  idempotencyKey: crypto.randomUUID(),
  ...fields,
});
const post = (path, json = {}, token = admin) => h.req(path, { method: 'POST', token, json });
const create = async (size, fields = {}) => data(await post('/content/files/uploads', payload(size, fields)), 201);
const part = (s, n, bytes, token = admin) =>
  h.req(`/content/files/uploads/${s.id}/parts/${n}`, { method: 'PUT', token, headers, body: bytes });
const complete = (s) => post(`/content/files/uploads/${s.id}/complete`);
const abort = (s) => h.req(`/content/files/uploads/${s.id}`, { method: 'DELETE', token: admin });
const row = (s) => h.db.prepare('SELECT * FROM media_uploads WHERE id=?').bind(s.id).first();
async function uploaded(bytes = '0123456789') {
  return (
    await data(
      await h.req('/content/files/upload?fileName=synthetic.txt&contentId=sermon-demo', {
        method: 'POST',
        token: admin,
        headers: { 'Content-Type': 'text/plain' },
        body: bytes,
      }),
      201,
    )
  )[0];
}
function context(path, env, method = 'POST', bytes) {
  return {
    request: new Request('http://localhost/api' + path, { method, ...(bytes ? { body: bytes } : {}) }),
    url: new URL('http://localhost/api' + path),
    path,
    env: { DB: h.db, FILES: bucket, ...env },
    principal: {
      userId: 'user-admin',
      churchId: 'church-demo',
      personId: 'person-admin',
      role: 'admin',
      sessionId: 'test',
    },
  };
}

test('private ranges, HEAD, validators and unsatisfiable responses have exact HTTP semantics', async () => {
  const file = await uploaded(),
    path = `/content/files/download/${file.id}`,
    full = await h.req(path, { token: admin, headers: { 'Accept-Encoding': 'identity' } });
  assert.equal(full.status, 200);
  assert.equal(await full.text(), '0123456789');
  assert.equal(full.headers.get('content-length'), '10');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.match(full.headers.get('cache-control'), /no-store/);
  for (const [range, status, expected, contentRange] of [
    ['bytes=2-5', 206, '2345', 'bytes 2-5/10'],
    ['bytes=7-', 206, '789', 'bytes 7-9/10'],
    ['bytes=-3', 206, '789', 'bytes 7-9/10'],
    ['bytes=0-99999999999999999999999', 206, '0123456789', 'bytes 0-9/10'],
    ['bytes=-99', 206, '0123456789', 'bytes 0-9/10'],
    ['bytes=10-', 416, '', 'bytes */10'],
    ['bytes=-0', 416, '', 'bytes */10'],
    ['bytes=5-2', 416, '', 'bytes */10'],
    ['bytes=0-1,5-6', 200, '0123456789', null],
    ['nonsense', 200, '0123456789', null],
  ]) {
    const r = await h.req(path, { token: admin, headers: { Range: range, 'Accept-Encoding': 'identity' } });
    assert.equal(r.status, status, range);
    assert.equal(await r.text(), expected, range);
    assert.equal(r.headers.get('content-range'), contentRange);
    assert.equal(r.headers.get('content-length'), String(expected.length));
  }
  const head = await h.req(path, { method: 'HEAD', token: admin, headers: { Range: 'bytes=1-2' } });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(head.headers.get('content-range'), null);
  for (const [ifRange, status] of [
    [full.headers.get('etag'), 206],
    [full.headers.get('last-modified'), 206],
    ['W/' + full.headers.get('etag'), 200],
    ['"different"', 200],
    ['Tue, 01 Jan 2097 00:00:00 GMT', 200],
  ])
    assert.equal(
      (await h.req(path, { token: admin, headers: { Range: 'bytes=1-2', 'If-Range': ifRange } })).status,
      status,
    );
  const unchanged = await h.req(path, { token: admin, headers: { 'If-None-Match': full.headers.get('etag') } });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');
});
test('range and HEAD check tenant/member publication before disclosing object metadata', async () => {
  const file = await uploaded('Protected archive'),
    path = `/content/files/download/${file.id}`,
    memberPath = `/member/v1/files/${file.id}/download`;
  for (const method of ['GET', 'HEAD']) {
    assert.equal((await h.req(path, { method, headers: { Range: 'bytes=0-3' } })).status, 401);
    assert.equal((await h.req(path, { method, token: other, headers: { Range: 'bytes=0-3' } })).status, 404);
    assert.equal(
      (await h.req(memberPath, { method, token: member, headers: { Range: 'bytes=0-3' } })).status,
      method === 'GET' ? 206 : 200,
    );
  }
  await h.db.prepare("UPDATE content_sermons SET publishedAt=NULL WHERE id='sermon-demo'").run();
  for (const method of ['GET', 'HEAD']) {
    const r = await h.req(memberPath, { method, token: member, headers: { Range: 'bytes=99999-' } });
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('content-range'), null);
  }
  await h.db.prepare("UPDATE content_sermons SET publishedAt='2020-01-01T00:00:00.000Z' WHERE id='sermon-demo'").run();
});
test('real multipart completion concatenates sparse parts, validates bytes and is idempotent', async () => {
  const s = await create(PART + 3),
    bytes = new Uint8Array(PART).fill(65);
  assert.equal((await h.req(`/content/files/download/${s.fileId}`, { token: admin })).status, 404);
  assert.equal((await complete(s)).status, 409);
  const first = await data(await part(s, 1, bytes));
  assert.equal('uploadId' in s, false);
  assert.equal('objectKey' in s, false);
  assert.equal('etag' in first, false);
  assert.equal(first.sha256.length, 64);
  assert.deepEqual(await data(await part(s, 1, bytes)), first);
  assert.equal((await part(s, 1, new Uint8Array(PART).fill(66))).status, 409);
  await data(await part(s, 2, 'END'));
  const finished = await data(await complete(s));
  assert.equal(finished.state, 'complete');
  assert.equal(finished.file.size, PART + 3);
  assert.equal((await data(await complete(s))).file.id, s.fileId);
  const r = await h.req(`/content/files/download/${s.fileId}`, {
    token: admin,
    headers: { Range: `bytes=${PART - 1}-` },
  });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), 'AEND');
  assert.equal((await abort(s)).status, 409);
  assert.equal(
    (
      await h.db
        .prepare('SELECT count(*) n FROM audit_log WHERE id=?')
        .bind(s.id + ':complete')
        .first()
    ).n,
    1,
  );
});
test('sessions validate ownership, metadata and part bounds without publishing incomplete files', async () => {
  const s = await create(3);
  assert.equal((await h.req(`/content/files/uploads/${s.id}`, { token: other })).status, 404);
  assert.equal((await part(s, 1, 'abc', other)).status, 404);
  assert.equal((await part(s, 1, 'abc', viewer)).status, 403);
  assert.equal((await part(s, 1, 'abc', member)).status, 403);
  assert.equal((await part(s, 0, 'abc')).status, 400);
  assert.equal((await part(s, 1, 'ab')).status, 400);
  assert.equal((await part(s, 1, 'abcd')).status, 413);
  assert.equal((await h.req(`/content/files/${s.fileId}`, { method: 'DELETE', token: admin })).status, 409);
  for (const fields of [
    { contentId: 'missing' },
    { fileType: 'text/html' },
    { fileName: '../bad' },
    { size: 1073741825 },
    { size: 0 },
  ])
    assert.ok([400, 404, 415].includes((await post('/content/files/uploads', payload(3, fields))).status));
  await data(await abort(s));
  await data(await abort(s));
});
test('creation idempotency binds immutable parameters and active-session limits roll back pending files', async () => {
  const input = payload(1),
    s = await data(await post('/content/files/uploads', input), 201);
  assert.equal((await data(await post('/content/files/uploads', input))).id, s.id);
  assert.equal((await post('/content/files/uploads', { ...input, size: 2 })).status, 409);
  const second = await create(1),
    third = await create(1),
    before = await h.db.prepare("SELECT count(*) n FROM content_files WHERE state='pending'").first();
  assert.equal((await post('/content/files/uploads', payload(1))).status, 409);
  assert.equal((await h.db.prepare("SELECT count(*) n FROM content_files WHERE state='pending'").first()).n, before.n);
  for (const item of [s, second, third]) await data(await abort(item));
});
test('late identical retries get separate physical parts and cannot alter a completed manifest', async () => {
  const s = await create(3),
    saved = await row(s);
  let release, reached;
  const gate = new Promise((r) => (release = r)),
    entered = new Promise((r) => (reached = r));
  const delayed = {
    resumeMultipartUpload: (key, uploadId) => {
      const upload = bucket.resumeMultipartUpload(key, uploadId);
      return {
        uploadPart: async (number, bytes) => {
          const result = await upload.uploadPart(number, bytes);
          reached();
          await gate;
          return result;
        },
      };
    },
  };
  const pending = media.mediaUploads(
    context(`/content/files/uploads/${s.id}/parts/1`, { FILES: delayed }, 'PUT', 'abc'),
  );
  await entered;
  await data(await part(s, 1, 'abc'));
  const selected = await h.db
    .prepare('SELECT providerPartNumber,attempts FROM media_upload_parts WHERE sessionId=?')
    .bind(s.id)
    .first();
  assert.equal(selected.providerPartNumber, 2);
  assert.equal(selected.attempts, 2);
  await data(await complete(s));
  release();
  await pending;
  assert.equal(await (await bucket.get(saved.objectKey)).text(), 'abc');
});
test('unknown R2 completion retains a frozen hidden session and reconciles on retry', async () => {
  const s = await create(4);
  await data(await part(s, 1, 'data'));
  const uncertain = {
    head: async () => null,
    resumeMultipartUpload: (key, uploadId) => {
      const upload = bucket.resumeMultipartUpload(key, uploadId);
      return {
        complete: async (manifest) => {
          await upload.complete(manifest);
          throw new Error('Synthetic lost response');
        },
      };
    },
  };
  await assert.rejects(
    media.mediaUploads(context(`/content/files/uploads/${s.id}/complete`, { FILES: uncertain })),
    /Completion is pending/,
  );
  assert.equal((await row(s)).state, 'completing');
  assert.equal((await h.req(`/content/files/download/${s.fileId}`, { token: admin })).status, 404);
  assert.equal((await data(await complete(s))).state, 'complete');
});
test('R2 completion followed by D1 failure is safely retryable', async () => {
  const s = await create(4);
  await data(await part(s, 1, 'data'));
  const failed = {
    prepare: (...args) => h.db.prepare(...args),
    batch: async () => {
      throw new Error('Synthetic D1 failure');
    },
  };
  await assert.rejects(
    media.mediaUploads(context(`/content/files/uploads/${s.id}/complete`, { DB: failed })),
    /Synthetic D1 failure/,
  );
  assert.equal((await row(s)).state, 'completing');
  assert.equal((await h.req(`/content/files/download/${s.fileId}`, { token: admin })).status, 404);
  assert.equal((await data(await complete(s))).state, 'complete');
});
test('abort wins against an in-flight completion and cleanup removes late objects', async () => {
  const s = await create(4);
  await data(await part(s, 1, 'data'));
  const saved = await row(s);
  let release, reached;
  const gate = new Promise((r) => (release = r)),
    entered = new Promise((r) => (reached = r));
  const delayed = {
    head: (key) => bucket.head(key),
    resumeMultipartUpload: (key, uploadId) => {
      const upload = bucket.resumeMultipartUpload(key, uploadId);
      return {
        complete: async (manifest) => {
          const object = await upload.complete(manifest);
          reached();
          await gate;
          return object;
        },
      };
    },
  };
  const finishing = media.mediaUploads(context(`/content/files/uploads/${s.id}/complete`, { FILES: delayed }));
  await entered;
  await data(await abort(s));
  release();
  await assert.rejects(finishing, /cancelled/);
  assert.equal(await bucket.head(saved.objectKey), null);
  assert.equal((await row(s)).state, 'aborted');
  await bucket.put(saved.objectKey, 'late');
  await media.cleanupUploads({ DB: h.db, FILES: bucket });
  assert.equal(await bucket.head(saved.objectKey), null);
});
test('scheduled cleanup preserves fresh sessions and expires abandoned uploads repeatably', async () => {
  const s = await create(3),
    saved = await row(s);
  await data(await part(s, 1, 'abc'));
  await h.db
    .prepare("UPDATE content_files SET dateModified='2020-01-01T00:00:00.000Z' WHERE id=?")
    .bind(s.fileId)
    .run();
  assert.equal((await (await h.mf.getWorker()).scheduled()).outcome, 'ok');
  assert.equal((await row(s)).state, 'uploading');
  await h.db.prepare("UPDATE media_uploads SET expiresAt='2020-01-01T00:00:00.000Z' WHERE id=?").bind(s.id).run();
  assert.equal((await complete(s)).status, 410);
  assert.equal((await (await h.mf.getWorker()).scheduled()).outcome, 'ok');
  assert.equal((await row(s)).state, 'aborted');
  assert.equal(await h.db.prepare('SELECT id FROM content_files WHERE id=?').bind(s.fileId).first(), null);
  await assert.rejects(bucket.resumeMultipartUpload(saved.objectKey, saved.uploadId).uploadPart(8, 'abc'));
  assert.equal((await (await h.mf.getWorker()).scheduled()).outcome, 'ok');
});
test('sessions and R2 parts survive a full local runtime restart', async () => {
  const persistencePath = await mkdtemp(join(tmpdir(), 'b1-media-restart-'));
  let instance;
  try {
    instance = await createHarness({ persistencePath });
    let token = (await instance.login()).token;
    const s = await data(
      await instance.req('/content/files/uploads', { method: 'POST', token, json: payload(PART + 3) }),
      201,
    );
    await data(
      await instance.req(`/content/files/uploads/${s.id}/parts/1`, {
        method: 'PUT',
        token,
        headers,
        body: new Uint8Array(PART).fill(82),
      }),
    );
    await instance.dispose();
    instance = await createHarness({ persistencePath, initialize: false });
    token = (await instance.login()).token;
    assert.equal((await data(await instance.req(`/content/files/uploads/${s.id}`, { token }))).parts.length, 1);
    await data(
      await instance.req(`/content/files/uploads/${s.id}/parts/2`, { method: 'PUT', token, headers, body: 'END' }),
    );
    await data(await instance.req(`/content/files/uploads/${s.id}/complete`, { method: 'POST', token, json: {} }));
    const r = await instance.req(`/content/files/download/${s.fileId}`, {
      token,
      headers: { Range: `bytes=${PART - 1}-` },
    });
    assert.equal(r.status, 206);
    assert.equal(await r.text(), 'REND');
  } finally {
    await instance?.dispose();
    await rm(persistencePath, { recursive: true, force: true });
  }
});

test('custom archive editors can resume their own sessions without granting session access to other staff', async () => {
  const [role] = await data(await post('/membership/roles', [{ name: 'Synthetic archive editor' }]));
  await data(
    await post('/membership/rolepermissions', [
      { roleId: role.id, apiName: 'ContentApi', contentType: 'StreamingServices', action: 'Edit' },
    ]),
  );
  await data(await post('/membership/rolemembers', [{ roleId: role.id, userId: 'user-member' }]));
  const s = await data(await post('/content/files/uploads', payload(3), member), 201);
  assert.equal((await h.req('/content/files/uploads?contentId=sermon-demo', { token: member })).status, 200);
  assert.equal((await h.req(`/content/files/uploads/${s.id}`, { token: member })).status, 200);
  assert.equal((await h.req(`/content/files/uploads/${s.id}`, { token: admin })).status, 404);
  assert.equal((await h.req('/content/files/uploads?contentId=sermon-demo', { token: viewer })).status, 403);
  assert.equal((await h.req(`/content/files/uploads/${s.id}`, { method: 'DELETE', token: member })).status, 200);
  await h.db.prepare('DELETE FROM roles WHERE id=?').bind(role.id).run();
});
test('known creation persistence failure compensates the multipart handle and leaves an explicit aborted receipt', async () => {
  const input = payload(3);
  await h.db
    .prepare(
      "CREATE TRIGGER synthetic_upload_id_failure BEFORE UPDATE OF uploadId ON media_uploads BEGIN SELECT RAISE(ABORT,'synthetic upload id failure'); END",
    )
    .run();
  try {
    assert.equal((await post('/content/files/uploads', input)).status, 500);
    const replay = await data(await post('/content/files/uploads', input));
    assert.equal(replay.state, 'aborted');
    assert.equal(replay.fileId, null);
  } finally {
    await h.db.prepare('DROP TRIGGER synthetic_upload_id_failure').run();
  }
});
test('failed attempts are bounded and a mismatched completed object cannot become a published file', async () => {
  const s = await create(3);
  const failing = {
    resumeMultipartUpload: () => ({
      uploadPart: async () => {
        throw new Error('Synthetic unavailable R2');
      },
    }),
  };
  for (let n = 0; n < 8; n++)
    await assert.rejects(
      media.mediaUploads(context(`/content/files/uploads/${s.id}/parts/1`, { FILES: failing }, 'PUT', 'abc')),
      /did not complete/,
    );
  await assert.rejects(
    media.mediaUploads(context(`/content/files/uploads/${s.id}/parts/1`, { FILES: failing }, 'PUT', 'abc')),
    /eight-attempt limit/,
  );
  await data(await abort(s));
  const mismatch = await create(3);
  await data(await part(mismatch, 1, 'abc'));
  const saved = await row(mismatch);
  await bucket.put(saved.objectKey, 'abc', {
    customMetadata: { churchId: 'church-other', uploadSessionId: mismatch.id, fileId: mismatch.fileId },
  });
  assert.equal((await complete(mismatch)).status, 409);
  assert.equal((await h.req(`/content/files/download/${mismatch.fileId}`, { token: admin })).status, 404);
  await data(await abort(mismatch));
});

test('concurrent creation replays allocate one upload and enforce the owner limit atomically', async () => {
  const input = payload(1),
    responses = await Promise.all(Array.from({ length: 4 }, () => post('/content/files/uploads', input)));
  assert.equal(responses.filter((r) => r.status === 201).length, 1);
  assert.ok(responses.every((r) => [200, 201].includes(r.status)));
  const sessions = await Promise.all(responses.map((r) => r.json()));
  assert.equal(new Set(sessions.map((s) => s.id)).size, 1);
  await data(await abort(sessions[0]));
  const attempts = await Promise.all(Array.from({ length: 4 }, () => post('/content/files/uploads', payload(1))));
  assert.equal(attempts.filter((r) => r.status === 201).length, 3);
  assert.equal(attempts.filter((r) => r.status === 409).length, 1);
  for (const response of attempts) if (response.status === 201) await data(await abort(await response.json()));
});
test('media migration preserves pre-existing file metadata and bytes while expanding the size constraint', async () => {
  const old = await createHarness({ initialize: false });
  try {
    for (const name of ['0001_membership.sql', '0005_sermons.sql'])
      await applySql(old.db, await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
    await old.db
      .prepare("INSERT INTO churches(id,name,subDomain) VALUES('upgrade-church','Synthetic upgrade','upgrade')")
      .run();
    await old.db
      .prepare(
        "INSERT INTO content_sermons(id,churchId,title,publishDate,updatedAt) VALUES('upgrade-sermon','upgrade-church','Synthetic archive','2020-01-01','2020-01-01')",
      )
      .run();
    await old.db
      .prepare(
        "INSERT INTO content_files(id,churchId,contentId,fileName,fileType,size,objectKey,state,dateModified) VALUES('existing-file','upgrade-church','upgrade-sermon','existing.txt','text/plain',3,'existing-object','ready','2020-01-01')",
      )
      .run();
    const files = await old.mf.getR2Bucket('FILES');
    await files.put('existing-object', 'old');
    await applySql(old.db, await readFile(new URL('../migrations/0021_media_uploads.sql', import.meta.url), 'utf8'));
    const preserved = await old.db.prepare("SELECT * FROM content_files WHERE id='existing-file'").first();
    assert.equal(preserved.state, 'ready');
    assert.equal(preserved.fileName, 'existing.txt');
    assert.equal(await (await files.get(preserved.objectKey)).text(), 'old');
    await old.db
      .prepare(
        "INSERT INTO content_files(id,churchId,contentId,fileName,fileType,size,objectKey,state,dateModified) VALUES('large-pending','upgrade-church','upgrade-sermon','large.bin','application/octet-stream',1073741824,'large-object','pending','2020-01-01')",
      )
      .run();
    await assert.rejects(
      old.db.prepare("UPDATE content_files SET size=1073741825 WHERE id='large-pending'").run(),
      /CHECK/,
    );
  } finally {
    await old.dispose();
  }
});
