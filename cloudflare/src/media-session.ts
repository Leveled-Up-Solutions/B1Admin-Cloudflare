import type { Env } from './types';
import { now } from './http';

export function mediaCookie(fileId: string, value: string, maxAge: number): string {
  return `__Secure-b1-media=${value}; Path=/api/media/files/${fileId}/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}
/** Context alone is not a credential: the independent random per-file grant is
 * mandatory. Replacing the signed-in account invalidates the old browser context. */
export function mediaContextCookie(sessionId: string): string {
  return `__Secure-b1-media-context=${sessionId}; Path=/api/media/; Max-Age=${sessionId ? 8 * 60 * 60 : 0}; HttpOnly; Secure; SameSite=Strict`;
}

/** Called after church-selection authorization and before returning its response, or
 * before deleting a logout session. The batch invalidates concurrent issuance too. */
export async function revokeMediaAccess(env: Env, sessionId: string, _request?: Request): Promise<string[]> {
  const results = await env.DB.batch([
    env.DB.prepare('SELECT DISTINCT fileId FROM media_access WHERE sessionId=? LIMIT 20').bind(sessionId),
    env.DB.prepare('UPDATE sessions SET mediaAccessVersion=mediaAccessVersion+1 WHERE id=?').bind(sessionId),
    env.DB.prepare('DELETE FROM media_access WHERE sessionId=?').bind(sessionId),
  ]);
  return [
    ...results[0].results.map((row) => mediaCookie(String((row as { fileId: string }).fileId), '', 0)),
    mediaContextCookie(''),
  ];
}
export async function cleanupMediaAccess(env: Env, timestamp = now()): Promise<void> {
  await env.DB.prepare('DELETE FROM media_access WHERE expiresAt<=?').bind(timestamp).run();
}
