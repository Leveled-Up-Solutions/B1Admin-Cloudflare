import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHarness } from './harness.mjs';
let h, admin, member, other;
const origin = { Origin: 'http://localhost' };
const cookies = (r) =>
  r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
async function data(r, status = 200) {
  assert.equal(r.status, status, await r.clone().text());
  return r.json();
}
test.before(async () => {
  h = await createHarness();
  admin = (await h.login()).token;
  member = (await h.login('member@example.test')).token;
  other = (await h.login('other@example.test')).token;
});
test.after(async () => h?.dispose());
async function upload(type = 'audio/wav') {
  return (
    await data(
      await h.req('/content/files/upload?fileName=synthetic.wav&contentId=sermon-demo', {
        method: 'POST',
        token: admin,
        headers: { 'Content-Type': type },
        body: 'synthetic-wave-bytes',
      }),
      201,
    )
  )[0];
}
async function grant(file, token = member, audience = 'member') {
  const response = await h.req('/media/access', {
    method: 'POST',
    token,
    headers: origin,
    json: { fileId: file.id, audience },
  });
  return { response, body: await data(response, 201), cookies: cookies(response) };
}
const media = (g, extras = {}, cookie = g.cookies, path = g.body.playUrl) =>
  h.req(path.replace(/^\/api/, ''), { ...extras, headers: { Cookie: cookie, ...(extras.headers || {}) } });

test('native access is hashed, cookie-bound, private and range capable without bearer URLs', async () => {
  const file = await upload(),
    g = await grant(file);
  assert.deepEqual(Object.keys(g.body).sort(), ['downloadUrl', 'expiresAt', 'playUrl']);
  assert.equal(g.body.playUrl, `/api/media/files/${file.id}/play`);
  const token = g.response.headers.getSetCookie()[0].split(';')[0].split('=')[1];
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const row = await h.db.prepare('SELECT * FROM media_access WHERE fileId=?').bind(file.id).first();
  assert.equal(row.tokenHash, createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(row).includes(token));
  for (const field of g.response.headers.getSetCookie()) {
    assert.match(field, /HttpOnly/);
    assert.match(field, /Secure/);
    assert.match(field, /SameSite=Strict/);
    assert.ok(!field.includes('Domain='));
  }
  const head = await media(g, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('content-length'), String(file.size));
  assert.match(head.headers.get('cache-control'), /private.*no-store/);
  assert.match(head.headers.get('content-disposition'), /^inline/);
  assert.equal(head.headers.get('cross-origin-resource-policy'), 'same-origin');
  const range = await media(g, { headers: { Range: 'bytes=2-7' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'ntheti');
  assert.equal(range.headers.get('content-range'), `bytes 2-7/${file.size}`);
  const download = await media(g, {}, g.cookies, g.body.downloadUrl);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.equal(await download.text(), 'synthetic-wave-bytes');
  assert.equal((await h.req(g.body.playUrl.replace('/api', ''), { token: member })).status, 401);
});

test('independent file grants cannot be exchanged or mixed across sessions or tenants', async () => {
  const first = await upload(),
    second = await upload(),
    a = await grant(first),
    b = await grant(second);
  assert.notEqual(a.cookies, b.cookies);
  assert.equal((await media(a)).status, 200);
  assert.equal((await media(b)).status, 200);
  assert.equal((await media(b, {}, a.cookies)).status, 401);
  assert.equal((await media(a, {}, a.cookies.split(';')[0])).status, 401);
  assert.equal(
    (await media(a, {}, a.cookies.replace(/__Secure-b1-media-context=[^;]+/, '__Secure-b1-media-context=other')))
      .status,
    401,
  );
  assert.equal(
    (
      await h.req('/media/access', {
        method: 'POST',
        token: admin,
        headers: { ...origin, Cookie: a.cookies },
        json: { fileId: first.id, audience: 'staff' },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await h.req('/media/access', {
        method: 'POST',
        token: other,
        headers: origin,
        json: { fileId: first.id, audience: 'staff' },
      })
    ).status,
    404,
  );
});

test('media routes reject CSRF, cross-origin embedding, duplicate cookies and active content playback', async () => {
  const file = await upload(),
    g = await grant(file);
  for (const headers of [
    {},
    { Origin: 'null' },
    { Origin: 'http://localhost:3101' },
    { ...origin, 'Sec-Fetch-Site': 'same-site' },
  ])
    assert.equal(
      (
        await h.req('/media/access', {
          method: 'POST',
          token: member,
          headers,
          json: { fileId: file.id, audience: 'member' },
        })
      ).status,
      403,
    );
  for (const headers of [
    { Origin: 'http://localhost:3101' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
  ])
    assert.equal((await media(g, { headers })).status, 403);
  assert.equal((await media(g, { method: 'POST' })).status, 405);
  assert.equal((await h.req('/membership/people', { headers: { Cookie: g.cookies } })).status, 401);
  assert.equal((await media(g, {}, g.cookies + '; ' + g.cookies.split(';')[0])).status, 401);
  const text = await grant(await upload('text/plain'));
  assert.equal((await media(text)).status, 415);
  assert.equal((await media(text, {}, text.cookies, text.body.downloadUrl)).status, 200);
});

test('unpublishing and file deletion revoke member ranges immediately while staff preview stays scoped', async () => {
  const file = await upload(),
    g = await grant(file);
  const original = await h.db.prepare('SELECT publishedAt FROM content_sermons WHERE id=?').bind('sermon-demo').first();
  await h.db.prepare('UPDATE content_sermons SET publishedAt=NULL WHERE id=?').bind('sermon-demo').run();
  assert.equal((await media(g, { headers: { Range: 'bytes=0-1' } })).status, 404);
  assert.equal(
    (
      await h.req('/media/access', {
        method: 'POST',
        token: member,
        headers: origin,
        json: { fileId: file.id, audience: 'member' },
      })
    ).status,
    404,
  );
  const staff = await grant(file, admin, 'staff');
  assert.equal((await media(staff)).status, 200);
  await h.db
    .prepare('UPDATE content_sermons SET publishedAt=? WHERE id=?')
    .bind(original.publishedAt, 'sermon-demo')
    .run();
  await h.db.prepare("UPDATE content_files SET state='deleting' WHERE id=?").bind(file.id).run();
  assert.equal((await media(g)).status, 404);
  await h.db.prepare("UPDATE content_files SET state='ready' WHERE id=?").bind(file.id).run();
});

test('church selection and logout revoke grants; invalid church selection preserves them', async () => {
  const login = await h.login('member@example.test'),
    file = await upload(),
    g = await grant(file, login.token);
  assert.equal(
    (
      await h.req('/membership/churches/select', {
        method: 'POST',
        token: login.token,
        json: { churchId: 'church-not-member' },
      })
    ).status,
    403,
  );
  assert.equal((await media(g)).status, 200);
  const selected = await h.req('/membership/churches/select', {
    method: 'POST',
    token: login.token,
    json: { churchId: 'church-demo' },
  });
  assert.equal(selected.status, 200);
  assert.ok(selected.headers.getSetCookie().some((v) => v.includes('Max-Age=0')));
  assert.equal((await media(g)).status, 401);
  const next = await grant(file, login.token),
    loggedOut = await h.req('/membership/users/logout', { method: 'POST', token: login.token });
  assert.equal(loggedOut.status, 200);
  assert.ok(loggedOut.headers.getSetCookie().some((v) => v.includes('Max-Age=0')));
  assert.equal((await media(next)).status, 401);
});

test('password-version, membership and grant expiration are rechecked for every request', async () => {
  const login = await h.login('member@example.test'),
    g = await grant(await upload(), login.token),
    sid = JSON.parse(Buffer.from(login.token.split('.')[1], 'base64url')).sid;
  await h.db.prepare('UPDATE sessions SET passwordVersion=passwordVersion+1 WHERE id=?').bind(sid).run();
  assert.equal((await media(g)).status, 401);
  await h.db.prepare('UPDATE sessions SET passwordVersion=passwordVersion-1 WHERE id=?').bind(sid).run();
  await h.db.prepare('UPDATE people SET removed=1 WHERE id=?').bind('person-alex').run();
  assert.equal((await media(g)).status, 401);
  await h.db.prepare('UPDATE people SET removed=0 WHERE id=?').bind('person-alex').run();
  await h.db.prepare("UPDATE media_access SET expiresAt='2000-01-01T00:00:00.000Z' WHERE sessionId=?").bind(sid).run();
  assert.equal((await media(g)).status, 401);
});

test('same-file rotation and explicit revocation invalidate old cookies without affecting bearer APIs', async () => {
  const file = await upload(),
    a = await grant(file),
    b = await grant(file);
  assert.equal((await media(a)).status, 401);
  assert.equal((await media(b)).status, 200);
  const revoked = await h.req('/media/access', { method: 'DELETE', token: member, headers: origin });
  assert.equal(revoked.status, 200);
  assert.ok(revoked.headers.getSetCookie().every((s) => s.includes('Max-Age=0')));
  assert.ok(revoked.headers.getSetCookie().some((s) => s.startsWith('__Secure-b1-media-context=')));
  assert.equal((await media(b)).status, 401);
  assert.equal((await h.req('/member/v1/me', { token: member })).status, 200);
});

test('native grants have bounded session lifetime and a hard per-session file limit', async () => {
  const login = await h.login('member@example.test'),
    sid = JSON.parse(Buffer.from(login.token.split('.')[1], 'base64url')).sid;
  const files = [];
  for (let i = 0; i < 21; i++) files.push(await upload());
  for (const file of files.slice(0, 20)) await grant(file, login.token);
  const denied = await h.req('/media/access', {
    method: 'POST',
    token: login.token,
    headers: origin,
    json: { fileId: files[20].id, audience: 'member' },
  });
  assert.equal(denied.status, 409);
  assert.equal(
    (await h.db.prepare('SELECT count(*) AS n FROM media_access WHERE sessionId=?').bind(sid).first()).n,
    20,
  );
  await grant(files[0], login.token); // replacing the same file does not consume another slot
  const expiry = new Date(Date.now() + 10000).toISOString();
  await h.db.prepare('UPDATE sessions SET expiresAt=? WHERE id=?').bind(expiry, sid).run();
  const bounded = await grant(files[0], login.token);
  assert.equal(bounded.body.expiresAt, expiry);
  assert.ok(Number(/Max-Age=(\d+)/.exec(bounded.response.headers.getSetCookie()[0])[1]) <= 10);
});
