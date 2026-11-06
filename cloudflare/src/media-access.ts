import { authenticate } from './auth';
import { authorizedArchiveFile } from './content';
import { body, first, HttpError, json, now } from './http';
import { downloadFile } from './media';
import { loadGrants, permissionKey } from './permissions';
import { resourceSnapshot, resourceWriteGuard } from './resource-permissions';
import type { Context, Env, Principal } from './types';
import { mediaCookie as cookie, mediaContextCookie, revokeMediaAccess } from './media-session';

const COOKIE = '__Secure-b1-media';
const MAX_AGE = 2 * 60 * 60;
const MAX_GRANTS = 20;
const filePattern = /^[A-Za-z0-9_-]{1,100}$/;
function filePath(fileId: string) {
  return `/api/media/files/${fileId}/`;
}
function secureContext(request: Request, env: Env): void {
  const url = new URL(request.url);
  if (
    url.protocol !== 'https:' &&
    !(['development', 'test'].includes(env.APP_ENV) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new HttpError(503, 'Private media requires HTTPS');
}
/** Cookie routes are same-origin only, including configured CORS origins. A development
 * Vite proxy changes the host; permit its explicit loopback origin only in development. */
function sameOrigin(request: Request, env: Env, mutation: boolean): void {
  const url = new URL(request.url),
    origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Same-origin media access required');
  let proxiedDevelopment = false;
  if (origin && env.APP_ENV === 'development') {
    try {
      const source = new URL(origin);
      proxiedDevelopment =
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
        ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname) &&
        (env.ALLOWED_ORIGINS || '')
          .split(',')
          .map((s) => s.trim())
          .includes(origin) &&
        site === 'same-origin';
    } catch {
      /* invalid origins are rejected below */
    }
  }
  if ((mutation && !origin) || (origin && origin !== url.origin && !proxiedDevelopment))
    throw new HttpError(403, 'Same-origin media access required');
}
async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
function randomToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
function readCookie(request: Request): string {
  const values = (request.headers.get('Cookie') || '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.startsWith(COOKIE + '='))
    .map((s) => s.slice(COOKIE.length + 1));
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0]))
    throw new HttpError(401, 'Open this archive again to authorize playback');
  return values[0];
}
function readContextCookie(request: Request): string | undefined {
  const values = (request.headers.get('Cookie') || '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('__Secure-b1-media-context='))
    .map((s) => s.slice('__Secure-b1-media-context='.length));
  if (values.length > 1 || (values.length === 1 && !/^[A-Za-z0-9_-]{1,100}$/.test(values[0])))
    throw new HttpError(401, 'Invalid media session context');
  return values[0];
}
function withCookies(response: Response, cookies: string[]): Response {
  for (const value of cookies) response.headers.append('Set-Cookie', value);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
async function cookieContext(request: Request, env: Env, fileId: string): Promise<{ ctx: Context; audience: string }> {
  const row = await env.DB.prepare(
    `SELECT a.userId,a.churchId,a.sessionId,a.audience,uc.personId,uc.role
    FROM media_access a JOIN sessions s ON s.id=a.sessionId AND s.userId=a.userId AND s.mediaAccessVersion=a.sessionVersion
    JOIN users u ON u.id=s.userId JOIN user_churches uc ON uc.userId=a.userId AND uc.churchId=a.churchId
    JOIN people p ON p.churchId=uc.churchId AND p.id=uc.personId
    WHERE a.tokenHash=? AND a.fileId=? AND a.expiresAt>? AND s.expiresAt>? AND u.disabled=0
      AND u.passwordState='active' AND s.passwordVersion=u.passwordVersion AND p.removed=0`,
  )
    .bind(await digest(readCookie(request)), fileId, now(), now())
    .first<Principal & { audience: string }>();
  if (!row) throw new HttpError(401, 'Media access expired; open this archive again');
  if (readContextCookie(request) !== row.sessionId)
    throw new HttpError(401, 'The signed-in media session has changed; open this archive again');
  const grants = await loadGrants(env, row.userId, row.churchId, row.role);
  const principal: Principal = {
    userId: row.userId,
    churchId: row.churchId,
    sessionId: row.sessionId,
    personId: row.personId,
    role: row.role === 'member' && grants.length ? 'viewer' : row.role,
    permissions: grants.map(permissionKey),
  };
  return { ctx: { request, env, principal, url: new URL(request.url), path: '/media' }, audience: row.audience };
}

/** Only these exact endpoints accept cookie authentication. All ordinary APIs retain bearer authentication. */
export async function mediaAccessRoutes(request: Request, env: Env, path: string): Promise<Response | undefined> {
  if (path !== '/media/access' && !path.startsWith('/media/files/')) return undefined;
  secureContext(request, env);
  if (path === '/media/access') {
    if (!['POST', 'DELETE'].includes(request.method)) throw new HttpError(405, 'Use POST or DELETE for media access');
    sameOrigin(request, env, true);
    const principal = await authenticate(request, env);
    if (request.method === 'DELETE')
      return withCookies(json({ revoked: true }), await revokeMediaAccess(env, principal.sessionId));
    const currentContext = readContextCookie(request);
    if (currentContext && currentContext !== principal.sessionId)
      throw new HttpError(409, 'The signed-in account has changed. Sign in again before opening this archive.');
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || ''))
      throw new HttpError(415, 'JSON required');
    const input = await body(request);
    if (
      !filePattern.test(input.fileId || '') ||
      typeof input.fileId !== 'string' ||
      !['member', 'staff'].includes(input.audience)
    )
      throw new HttpError(400, 'A fileId and member or staff audience are required');
    const ctx: Context = { request, env, principal, url: new URL(request.url), path };
    const session = await first(
      ctx,
      'SELECT mediaAccessVersion,expiresAt FROM sessions WHERE id=?',
      principal.sessionId,
    );
    if (!session) throw new HttpError(401, 'Session expired');
    const file = await authorizedArchiveFile(ctx, input.fileId, input.audience === 'member');
    const sermon = await first(
      ctx,
      'SELECT * FROM content_sermons WHERE churchId=? AND id=?',
      principal.churchId,
      file.contentId,
    );
    if (!sermon) throw new HttpError(404, 'File not found');
    const createdAt = now(),
      expiry = Math.min(Date.now() + MAX_AGE * 1000, Date.parse(session.expiresAt));
    const expiresAt = new Date(expiry).toISOString(),
      token = randomToken();
    const guards = resourceWriteGuard(ctx, {
      requirements: input.audience === 'member' ? [] : [{ resource: 'Sermons', action: 'View', row: sermon }],
      snapshots: [resourceSnapshot('content_files', file), resourceSnapshot('content_sermons', sermon)],
      checks: [
        {
          sql: 'EXISTS(SELECT 1 FROM sessions WHERE id=? AND mediaAccessVersion=?)',
          values: [principal.sessionId, session.mediaAccessVersion],
        },
        {
          sql: '(SELECT count(*) FROM media_access WHERE sessionId=? AND expiresAt>? AND fileId<>?)<?',
          values: [principal.sessionId, createdAt, file.id, MAX_GRANTS],
        },
        ...(input.audience === 'member'
          ? [
              {
                sql: "EXISTS(SELECT 1 FROM content_sermons WHERE churchId=? AND id=? AND visibility='public' AND publishedAt IS NOT NULL AND publishDate<=?)",
                values: [principal.churchId, file.contentId, createdAt],
              },
            ]
          : []),
      ],
    });
    await env.DB.batch([
      ...guards,
      env.DB.prepare('DELETE FROM media_access WHERE sessionId=? AND (fileId=? OR expiresAt<=?)').bind(
        principal.sessionId,
        file.id,
        createdAt,
      ),
      env.DB.prepare(
        'INSERT INTO media_access(tokenHash,sessionId,userId,churchId,fileId,audience,sessionVersion,createdAt,expiresAt) VALUES(?,?,?,?,?,?,?,?,?)',
      ).bind(
        await digest(token),
        principal.sessionId,
        principal.userId,
        principal.churchId,
        file.id,
        input.audience,
        session.mediaAccessVersion,
        createdAt,
        expiresAt,
      ),
    ]);
    return withCookies(
      json({ playUrl: filePath(file.id) + 'play', downloadUrl: filePath(file.id) + 'download', expiresAt }, 201),
      [
        cookie(file.id, token, Math.max(0, Math.floor((expiry - Date.now()) / 1000))),
        ...(!currentContext ? [mediaContextCookie(principal.sessionId)] : []),
      ],
    );
  }
  const match = /^\/media\/files\/([A-Za-z0-9_-]{1,100})\/(play|download)$/.exec(path);
  if (!match) throw new HttpError(404, 'Media route not found');
  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Use GET or HEAD for media files');
  sameOrigin(request, env, false);
  const { ctx, audience } = await cookieContext(request, env, match[1]);
  const file = await authorizedArchiveFile(ctx, match[1], audience === 'member');
  if (match[2] === 'play' && !/^(audio\/(mpeg|mp4|wav)|video\/mp4)$/.test(file.fileType))
    throw new HttpError(415, 'This archive is download-only');
  const response = await downloadFile(request, env.FILES, file, { inline: match[2] === 'play' });
  response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return response;
}
