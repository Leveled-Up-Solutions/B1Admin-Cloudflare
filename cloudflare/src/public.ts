import type { Env } from './types';
import { HttpError, json } from './http';

type Row = Record<string, any>;
function publicSiteHidden(settings: unknown): boolean {
  try {
    const parsed = typeof settings === 'string' ? JSON.parse(settings) : settings;
    if (Array.isArray(parsed))
      return parsed.some(
        (item) => item?.keyName === 'hidePublicSite' && (item.value === true || item.value === 'true'),
      );
    return parsed?.hidePublicSite === true || parsed?.hidePublicSite === 'true';
  } catch {
    return true;
  }
}

/** A narrow read-only sermon feed for the future website. No website pages or member data. */
export async function publicRoutes(request: Request, env: Env, path: string): Promise<Response | undefined> {
  if (!path.startsWith('/public/')) return undefined;
  const match = /^\/public\/v1\/churches\/([a-z0-9-]+)\/sermons(?:\/([^/]+))?\/?$/.exec(path);
  if (!match) throw new HttpError(404, 'Public API route not found');
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ errors: ['Public API is read-only'] }, 405);
  const church = await env.DB.prepare('SELECT id,settings FROM churches WHERE subDomain=?').bind(match[1]).first<Row>();
  if (!church || publicSiteHidden(church.settings)) throw new HttpError(404, 'Church not found');
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get('limit') || '50';
  const rawOffset = url.searchParams.get('offset') || '0';
  if (!/^\d+$/.test(rawLimit) || !/^\d+$/.test(rawOffset)) throw new HttpError(400, 'Invalid pagination');
  const limit = Number(rawLimit),
    offset = Number(rawOffset);
  if (limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset > 10000)
    throw new HttpError(400, 'Invalid pagination');
  const entityId = match[2];
  const rows = (
    await env.DB.prepare(
      `SELECT id,title,description,speaker,publishDate,videoUrl,audioUrl,thumbnail,publishedAt FROM content_sermons
    WHERE churchId=? AND visibility='public' AND publishedAt IS NOT NULL AND publishDate<=?
    ${entityId ? 'AND id=?' : ''} ORDER BY publishDate DESC,id LIMIT ? OFFSET ?`,
    )
      .bind(church.id, new Date().toISOString(), ...(entityId ? [entityId] : []), limit, offset)
      .all<Row>()
  ).results;
  if (entityId && !rows.length) throw new HttpError(404, 'Published sermon not found');
  const data = entityId ? rows[0] : { data: rows, pagination: { limit, offset, count: rows.length } };
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}
