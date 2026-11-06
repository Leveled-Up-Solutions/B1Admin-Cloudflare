import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHarness } from './harness.mjs';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/media-access.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
});
const { mediaAccessRoutes } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);

const sameOrigin = { Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' };
function responseCookie(response, name) {
  const entries = response.headers.getSetCookie();
  const entry = entries.find((value) => value.startsWith(name + '='));
  assert.ok(entry, `Response must set ${name}`);
  assert.match(entry, /; HttpOnly(?:;|$)/);
  assert.match(entry, /; Secure(?:;|$)/);
  assert.match(entry, /; SameSite=Strict(?:;|$)/);
  return entry.split(';')[0];
}
async function login(h, email = 'admin@example.test', churchId = 'church-demo') {
  const response = await h.req('/membership/users/login', {
    method: 'POST',
    json: { email, password: 'LocalDemo2026!' },
  });
  assert.equal(response.status, 200, await response.clone().text());
  const token = (await response.json()).userChurches.find((uc) => uc.church.id === churchId).jwt;
  return { token, context: responseCookie(response, '__Secure-b1-media-context') };
}
async function file(h, token) {
  const response = await h.req('/content/files/upload?fileName=synthetic-native.mp3&contentId=sermon-demo', {
    method: 'POST',
    token,
    headers: { 'Content-Type': 'audio/mpeg' },
    body: 'synthetic-media-bytes',
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json())[0];
}
async function grant(h, actor, fileId, audience) {
  const response = await h.req('/media/access', {
    method: 'POST',
    token: actor.token,
    headers: { ...sameOrigin, Cookie: actor.context },
    json: { fileId, audience },
  });
  assert.equal(response.status, 201, await response.clone().text());
  const data = await response.json();
  assert.ok(!data.playUrl.includes('?') && !data.downloadUrl.includes('?'));
  return { ...data, cookie: actor.context + '; ' + responseCookie(response, '__Secure-b1-media') };
}
const playback = (h, access, options = {}) =>
  h.req(access.playUrl.replace(/^\/api/, ''), {
    ...options,
    headers: { ...sameOrigin, Cookie: access.cookie, ...options.headers },
  });

test('a completed different-account login supersedes old native media context without ending its server session', async () => {
  const h = await createHarness();
  try {
    const a = await login(h),
      media = await file(h, a.token);
    await h.db.prepare("UPDATE content_sermons SET publishedAt=NULL WHERE id='sermon-demo'").run();
    const access = await grant(h, a, media.id, 'staff');
    assert.equal((await playback(h, access)).status, 200);
    const b = await login(h, 'member@example.test');
    const tokenCookie = access.cookie.split('; ').find((value) => value.startsWith('__Secure-b1-media='));
    const replaced = { ...access, cookie: b.context + '; ' + tokenCookie };
    assert.equal((await playback(h, replaced)).status, 401);
    assert.equal((await playback(h, replaced, { method: 'HEAD', headers: { Range: 'bytes=0-1' } })).status, 401);
    const sidA = JSON.parse(Buffer.from(a.token.split('.')[1], 'base64url')).sid;
    assert.ok(
      await h.db.prepare('SELECT id FROM sessions WHERE id=?').bind(sidA).first(),
      'A stays live server-side; context binding causes denial',
    );
    for (const [token, context] of [
      [a.token, b.context],
      [b.token, a.context],
    ]) {
      assert.equal(
        (
          await h.req('/media/access', {
            method: 'POST',
            token,
            headers: { ...sameOrigin, Cookie: context },
            json: { fileId: media.id, audience: 'staff' },
          })
        ).status,
        409,
      );
    }
    const denied = await h.req('/media/access', {
      method: 'POST',
      token: b.token,
      headers: { ...sameOrigin, Cookie: b.context },
      json: { fileId: media.id, audience: 'member' },
    });
    assert.equal(denied.status, 404, 'The new member cannot reauthorize the private sermon');
  } finally {
    await h.dispose();
  }
});

test('cookie media never falls back to bearer auth and rejects missing, duplicate and cross-site browser context', async () => {
  const h = await createHarness();
  try {
    const actor = await login(h),
      media = await file(h, actor.token),
      access = await grant(h, actor, media.id, 'staff');
    const fileCookie = access.cookie.split('; ').find((value) => value.startsWith('__Secure-b1-media='));
    for (const Cookie of [fileCookie, access.cookie + '; ' + actor.context, access.cookie + '; ' + fileCookie])
      assert.equal((await playback(h, access, { headers: { Cookie } })).status, 401);
    assert.equal((await h.req(access.playUrl.replace(/^\/api/, ''), { token: actor.token })).status, 401);
    assert.equal(
      (await h.req('/member/v1/me', { headers: { Cookie: access.cookie } })).status,
      401,
      'Media cookies never authenticate an ordinary application API',
    );
    for (const headers of [
      { Origin: 'https://other.example.test', 'Sec-Fetch-Site': 'same-site' },
      { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' },
      { Origin: 'http://localhost', 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      assert.equal((await playback(h, access, { headers })).status, 403);
      assert.equal(
        (
          await h.req('/media/access', {
            method: 'POST',
            token: actor.token,
            headers: { Cookie: actor.context, ...headers },
            json: { fileId: media.id, audience: 'staff' },
          })
        ).status,
        403,
      );
    }
    assert.equal(
      (
        await h.req('/media/access', {
          method: 'POST',
          token: actor.token,
          headers: { Cookie: actor.context },
          json: { fileId: media.id, audience: 'staff' },
        })
      ).status,
      403,
    );
  } finally {
    await h.dispose();
  }
});

test('revocation and unpublishing during media grant issuance leave no usable grant', async () => {
  for (const transition of ['session-version', 'unpublish']) {
    const h = await createHarness();
    try {
      const actor = await login(h),
        media = await file(h, actor.token);
      const request = new Request('http://localhost/api/media/access', {
        method: 'POST',
        headers: {
          ...sameOrigin,
          Authorization: 'Bearer ' + actor.token,
          Cookie: actor.context,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fileId: media.id, audience: 'member' }),
      });
      const sid = JSON.parse(Buffer.from(actor.token.split('.')[1], 'base64url')).sid;
      let intercepted = 0;
      const db = {
        prepare: (...args) => h.db.prepare(...args),
        batch: async (statements) => {
          intercepted++;
          assert.equal(intercepted, 1);
          if (transition === 'session-version')
            await h.db
              .prepare('UPDATE sessions SET mediaAccessVersion=mediaAccessVersion+1 WHERE id=?')
              .bind(sid)
              .run();
          else await h.db.prepare("UPDATE content_sermons SET publishedAt=NULL WHERE id='sermon-demo'").run();
          return h.db.batch(statements);
        },
      };
      await assert.rejects(
        mediaAccessRoutes(
          request,
          {
            DB: db,
            APP_ENV: 'test',
            SESSION_SECRET: 'test-only-secret-never-for-deployment-123456789',
          },
          '/media/access',
        ),
        /CHECK constraint failed/,
      );
      assert.equal(intercepted, 1, 'The competing change occurs after authorization preflight');
      assert.equal((await h.db.prepare('SELECT count(*) n FROM media_access').first()).n, 0);
      assert.equal((await h.db.prepare('SELECT count(*) n FROM write_guards').first()).n, 0);
    } finally {
      await h.dispose();
    }
  }
});

test('unpublishing and church switching invalidate media before conditional, range or HEAD responses', async () => {
  const h = await createHarness();
  try {
    const admin = await login(h),
      media = await file(h, admin.token);
    const actor = await login(h, 'multi-member@example.test');
    const access = await grant(h, actor, media.id, 'member');
    const initial = await playback(h, access),
      etag = initial.headers.get('ETag');
    assert.equal(initial.status, 200);
    await initial.arrayBuffer();
    await h.db.prepare("UPDATE content_sermons SET publishedAt=NULL WHERE id='sermon-demo'").run();
    for (const options of [
      { headers: { 'If-None-Match': etag } },
      { headers: { Range: 'bytes=0-1' } },
      { method: 'HEAD' },
    ])
      assert.equal((await playback(h, access, options)).status, 404);
    await h.db.prepare("UPDATE content_sermons SET publishedAt='2026-01-01' WHERE id='sermon-demo'").run();
    const selected = await h.req('/membership/churches/select', {
      method: 'POST',
      token: actor.token,
      headers: { Cookie: actor.context },
      json: { churchId: 'church-other' },
    });
    assert.equal(selected.status, 200, await selected.clone().text());
    assert.equal((await playback(h, access, { headers: { 'If-None-Match': etag } })).status, 401);
    assert.equal((await playback(h, access, { method: 'HEAD' })).status, 401);
    assert.equal((await h.db.prepare('SELECT count(*) n FROM media_access').first()).n, 0);
  } finally {
    await h.dispose();
  }
});
