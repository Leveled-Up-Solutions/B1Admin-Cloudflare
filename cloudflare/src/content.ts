import type { Context, Env } from './types';
import { all, first, HttpError, id, json, now, records, requiredString, requireAdmin } from './http';

import {
  boundedBytes,
  downloadFile,
  fileResponse,
  FILE_TYPES,
  MAX_FILE_BYTES,
  MAX_BASE64_BYTES,
  type FileRow,
} from './media';
import { cleanupUploads, mediaUploads } from './media-uploads';

type Row = Record<string, any>;
type Resource = 'sermons' | 'playlists';
const tables: Record<Resource, string> = { sermons: 'content_sermons', playlists: 'content_playlists' };

function optionalText(value: unknown, field: string, max = 2000): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `Invalid ${field}`);
  return value;
}

function date(value: unknown, field: string): string {
  const input = requiredString(value, field, 40);
  if (
    !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d))?$/.test(input) ||
    !Number.isFinite(Date.parse(input))
  )
    throw new HttpError(400, `Invalid ${field}`);
  const civil = input.slice(0, 10);
  const midnight = Date.parse(civil + 'T00:00:00.000Z');
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== civil)
    throw new HttpError(400, `Invalid ${field}`);
  return new Date(input).toISOString();
}

function mediaUrl(value: unknown, field: string): string {
  const input = optionalText(value, field, 2048);
  if (!input) return '';
  try {
    const url = new URL(input);
    if (url.protocol === 'https:' && !url.username && !url.password) return input;
  } catch {
    /* validation below */
  }
  throw new HttpError(400, `${field} must be an HTTPS URL`);
}

function clean(resource: Resource, input: Row, previous: Row | null): Row {
  const merged = { ...previous, ...input };
  if (resource === 'playlists')
    return {
      title: requiredString(merged.title, 'title'),
      description: optionalText(merged.description, 'description', 20000),
      publishDate: date(merged.publishDate || now(), 'publishDate'),
      thumbnail: mediaUrl(merged.thumbnail, 'thumbnail'),
      updatedAt: now(),
    };
  const visibility = merged.visibility ?? 'private';
  if (!['public', 'private'].includes(visibility)) throw new HttpError(400, 'visibility must be public or private');
  const common = { title: requiredString(merged.title, 'title'), visibility, updatedAt: now() };
  const duration = merged.duration ?? 0;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 10000000)
    throw new HttpError(400, 'Invalid duration');
  return {
    ...common,
    description: optionalText(merged.description, 'description', 20000),
    speaker: optionalText(merged.speaker, 'speaker', 255),
    publishDate: date(merged.publishDate, 'publishDate'),
    videoUrl: mediaUrl(merged.videoUrl, 'videoUrl'),
    audioUrl: mediaUrl(merged.audioUrl, 'audioUrl'),
    thumbnail: mediaUrl(merged.thumbnail, 'thumbnail'),
    playlistId: merged.playlistId || null,
    videoType: optionalText(merged.videoType, 'videoType', 40),
    videoData: optionalText(merged.videoData, 'videoData', 2000),
    duration,
    publishedAt: previous?.publishedAt ?? null,
  };
}

function auditStatement(ctx: Context, action: string, entityId: string): D1PreparedStatement {
  return ctx.env.DB.prepare(
    'INSERT INTO audit_log (id,churchId,userId,action,entityId,createdAt) VALUES (?,?,?,?,?,?)',
  ).bind(id(), ctx.principal.churchId, ctx.principal.userId, action, entityId, now());
}

function serialize(resource: Resource, row: Row): Row {
  return row;
}

async function contentRecords(
  ctx: Context,
  resource: Resource,
  recordId?: string,
  operation?: string,
): Promise<Response | undefined> {
  const table = tables[resource];
  const churchId = ctx.principal.churchId;
  const method = ctx.request.method;
  if (resource === 'playlists' && operation) return undefined;
  if (operation === 'publish' && method === 'POST' && recordId) {
    requireAdmin(ctx);
    const row = await first(ctx, `SELECT * FROM ${table} WHERE churchId=? AND id=?`, churchId, recordId);
    if (!row) throw new HttpError(404, 'Content not found');
    const publishedAt = now();
    const statement = ctx.env.DB.prepare(
      `UPDATE ${table} SET publishedAt=?,updatedAt=? WHERE churchId=? AND id=?`,
    ).bind(publishedAt, publishedAt, churchId, recordId);
    await ctx.env.DB.batch([statement, auditStatement(ctx, `content.${resource}.publish`, recordId)]);
    return json({ publishedAt });
  }
  if (operation === 'published' && method === 'DELETE' && recordId) {
    requireAdmin(ctx);
    if (!(await first(ctx, `SELECT id FROM ${table} WHERE churchId=? AND id=?`, churchId, recordId)))
      throw new HttpError(404, 'Content not found');
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(`UPDATE ${table} SET publishedAt=NULL,updatedAt=? WHERE churchId=? AND id=?`).bind(
        now(),
        churchId,
        recordId,
      ),
      auditStatement(ctx, `content.${resource}.unpublish`, recordId),
    ]);
    return json({});
  }
  if (operation) return undefined;
  if (method === 'GET') {
    if (recordId) {
      const row = await first(ctx, `SELECT * FROM ${table} WHERE churchId=? AND id=?`, churchId, recordId);
      if (!row) throw new HttpError(404, 'Content not found');
      return json(serialize(resource, row));
    }
    const playlistId = resource === 'sermons' ? ctx.url.searchParams.get('playlistId') : null;
    const rows = await all(
      ctx,
      `SELECT * FROM ${table} WHERE churchId=? ${playlistId ? 'AND playlistId=?' : ''} ORDER BY publishDate DESC LIMIT 500`,
      churchId,
      ...(playlistId ? [playlistId] : []),
    );
    return json(rows.map((row) => serialize(resource, row)));
  }
  if (method === 'POST' && !recordId) {
    requireAdmin(ctx);
    const inputs = await records(ctx.request);
    const statements: D1PreparedStatement[] = [];
    const outputs: Row[] = [];
    const seenIds = new Set<string>();
    for (const input of inputs) {
      if (input.churchId && input.churchId !== churchId) throw new HttpError(403, 'Church mismatch');
      const entityId = input.id ? requiredString(input.id, 'id', 100) : id();
      if (seenIds.has(entityId)) throw new HttpError(400, 'Duplicate content id in request');
      seenIds.add(entityId);
      const previous = await first(ctx, `SELECT * FROM ${table} WHERE churchId=? AND id=?`, churchId, entityId);
      // A provided id denotes an update; do not upsert guessed ids across tenants.
      if (input.id && !previous) throw new HttpError(404, 'Content not found');
      const values = clean(resource, input, previous);
      if (resource === 'sermons' && values.playlistId) {
        requiredString(values.playlistId, 'playlistId', 100);
        if (
          !(await first(ctx, 'SELECT id FROM content_playlists WHERE churchId=? AND id=?', churchId, values.playlistId))
        )
          throw new HttpError(404, 'Playlist not found');
      }
      const columns = Object.keys(values);
      if (previous)
        statements.push(
          ctx.env.DB.prepare(
            `UPDATE ${table} SET ${columns.map((c) => `${c}=?`).join(',')} WHERE churchId=? AND id=?`,
          ).bind(...Object.values(values), churchId, entityId),
        );
      else
        statements.push(
          ctx.env.DB.prepare(
            `INSERT INTO ${table} (id,churchId,${columns.join(',')}) VALUES (${Array(columns.length + 2)
              .fill('?')
              .join(',')})`,
          ).bind(entityId, churchId, ...Object.values(values)),
        );
      statements.push(auditStatement(ctx, `content.${resource}.save`, entityId));
      outputs.push(serialize(resource, { id: entityId, churchId, ...values }));
    }
    await ctx.env.DB.batch(statements);
    return json(outputs);
  }
  if (method === 'DELETE' && recordId) {
    requireAdmin(ctx);
    if (!(await first(ctx, `SELECT id FROM ${table} WHERE churchId=? AND id=?`, churchId, recordId)))
      throw new HttpError(404, 'Content not found');
    if (
      resource === 'sermons' &&
      (await first(ctx, 'SELECT id FROM content_files WHERE churchId=? AND contentId=? LIMIT 1', churchId, recordId))
    )
      throw new HttpError(409, 'Delete archived files before deleting this sermon');
    if (
      resource === 'playlists' &&
      (await first(ctx, 'SELECT id FROM content_sermons WHERE churchId=? AND playlistId=? LIMIT 1', churchId, recordId))
    )
      throw new HttpError(409, 'Move or delete playlist sermons first');
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(`DELETE FROM ${table} WHERE churchId=? AND id=?`).bind(churchId, recordId),
      auditStatement(ctx, `content.${resource}.delete`, recordId),
    ]);
    return json({});
  }
  return undefined;
}

async function upload(ctx: Context, raw: boolean): Promise<Response> {
  requireAdmin(ctx);
  let input: Row;
  let bytes: Uint8Array;
  if (raw) {
    input = {
      fileName: ctx.url.searchParams.get('fileName'),
      fileType: ctx.request.headers.get('Content-Type')?.split(';')[0],
      contentType: ctx.url.searchParams.get('contentType') || 'sermon',
      contentId: ctx.url.searchParams.get('contentId') || '',
    };
    bytes = await boundedBytes(ctx.request, MAX_FILE_BYTES);
  } else {
    const encoded = await boundedBytes(ctx.request, Math.ceil((MAX_BASE64_BYTES * 4) / 3) + 10000);
    let inputs: unknown;
    try {
      inputs = JSON.parse(new TextDecoder().decode(encoded));
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
    if (!Array.isArray(inputs) || inputs.length !== 1 || !inputs[0] || typeof inputs[0] !== 'object')
      throw new HttpError(400, 'Upload exactly one file');
    input = inputs[0];
    if (typeof input.fileContents !== 'string') throw new HttpError(400, 'fileContents data URI is required');
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(input.fileContents);
    if (!match || (input.fileType && input.fileType !== match[1])) throw new HttpError(400, 'Invalid file data URI');
    input.fileType = match[1];
    try {
      bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
    } catch {
      throw new HttpError(400, 'Invalid base64 data');
    }
  }
  if (input.id)
    throw new HttpError(400, 'File uploads create immutable ids; upload a new file and delete the previous file');
  if (input.churchId && input.churchId !== ctx.principal.churchId) throw new HttpError(403, 'Church mismatch');
  if (!bytes.length || bytes.length > (raw ? MAX_FILE_BYTES : MAX_BASE64_BYTES))
    throw new HttpError(bytes.length ? 413 : 400, `File size must be 1 byte to ${raw ? 25 : 5} MiB`);
  const fileName = requiredString(input.fileName, 'fileName', 180);
  if (/[\\/\u0000-\u001f\u007f]/.test(fileName) || fileName === '.' || fileName === '..')
    throw new HttpError(400, 'Invalid fileName');
  const fileType = requiredString(input.fileType, 'fileType', 100).toLowerCase();
  if (!FILE_TYPES.has(fileType)) throw new HttpError(415, 'Unsupported file type');
  const contentType = requiredString(input.contentType || 'sermon', 'contentType', 40);
  const contentId = optionalText(input.contentId, 'contentId', 100);
  if (!['sermon'].includes(contentType)) throw new HttpError(400, 'Unsupported contentType');
  const targetTables: Record<string, string> = { sermon: 'content_sermons' };
  if (
    !contentId ||
    !(await first(
      ctx,
      `SELECT id FROM ${targetTables[contentType]} WHERE churchId=? AND id=?`,
      ctx.principal.churchId,
      contentId,
    ))
  )
    throw new HttpError(404, 'Content target not found');
  const row = {
    id: id(),
    churchId: ctx.principal.churchId,
    contentType,
    contentId,
    fileName,
    fileType,
    size: bytes.length,
    dateModified: now(),
  };
  const objectKey = `churches/${encodeURIComponent(row.churchId)}/files/${row.id}`;
  // Persist pending metadata first. A failed put/commit remains discoverable by the cleanup job.
  await ctx.env.DB.prepare(
    'INSERT INTO content_files (id,churchId,contentType,contentId,fileName,fileType,size,objectKey,state,dateModified) VALUES (?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      row.id,
      row.churchId,
      contentType,
      contentId,
      fileName,
      fileType,
      bytes.length,
      objectKey,
      'pending',
      row.dateModified,
    )
    .run();
  try {
    await ctx.env.FILES.put(objectKey, bytes, {
      httpMetadata: { contentType: fileType },
      customMetadata: { churchId: row.churchId, fileId: row.id },
    });
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE content_files SET state='ready' WHERE churchId=? AND id=? AND state='pending'").bind(
        row.churchId,
        row.id,
      ),
      auditStatement(ctx, 'content.files.upload', row.id),
    ]);
  } catch (error) {
    // Best effort immediate compensation. If R2/D1 is unavailable, the pending row permits later retry.
    try {
      await ctx.env.FILES.delete(objectKey);
      await ctx.env.DB.prepare("DELETE FROM content_files WHERE churchId=? AND id=? AND state='pending'")
        .bind(row.churchId, row.id)
        .run();
    } catch {
      /* cleanupFiles retries this persisted operation after the grace period */
    }
    throw error;
  }
  return json([fileResponse(row)], 201);
}

async function files(ctx: Context): Promise<Response | undefined> {
  if (ctx.path === '/content/files/uploads' || ctx.path.startsWith('/content/files/uploads/')) return mediaUploads(ctx);
  const parts = ctx.path.split('/').filter(Boolean).slice(2);
  const method = ctx.request.method;
  const churchId = ctx.principal.churchId;
  if (method === 'POST' && (parts.length === 0 || (parts[0] === 'upload' && parts.length === 1)))
    return upload(ctx, parts[0] === 'upload');
  if (['GET', 'HEAD'].includes(method) && parts[0] === 'download' && parts.length === 2) {
    const row = await first(
      ctx,
      "SELECT * FROM content_files WHERE churchId=? AND id=? AND state='ready'",
      churchId,
      parts[1],
    );
    if (!row) throw new HttpError(404, 'File not found');
    if (
      ctx.principal.role === 'member' &&
      !(await first(
        ctx,
        "SELECT id FROM content_sermons WHERE churchId=? AND id=? AND visibility='public' AND publishedAt IS NOT NULL AND publishDate<=?",
        churchId,
        row.contentId,
        now(),
      ))
    )
      throw new HttpError(404, 'File not found');
    return downloadFile(ctx.request, ctx.env.FILES, row as FileRow & { objectKey: string });
  }
  if (method === 'GET' && parts.length === 0)
    return json(
      (
        await all(
          ctx,
          "SELECT * FROM content_files WHERE churchId=? AND state='ready' ORDER BY dateModified DESC LIMIT 500",
          churchId,
        )
      ).map((row) => fileResponse(row as FileRow)),
    );
  if (method === 'GET' && parts.length === 1) {
    const row = await first(
      ctx,
      "SELECT * FROM content_files WHERE churchId=? AND id=? AND state='ready'",
      churchId,
      parts[0],
    );
    if (!row) throw new HttpError(404, 'File not found');
    return json(fileResponse(row as FileRow));
  }
  if (method === 'GET' && parts.length === 2)
    return json(
      (
        await all(
          ctx,
          "SELECT * FROM content_files WHERE churchId=? AND contentType=? AND contentId=? AND state='ready' ORDER BY dateModified DESC LIMIT 500",
          churchId,
          parts[0],
          parts[1],
        )
      ).map((row) => fileResponse(row as FileRow)),
    );
  if (method === 'DELETE' && parts.length === 1) {
    requireAdmin(ctx);
    const row = await first(ctx, 'SELECT * FROM content_files WHERE churchId=? AND id=?', churchId, parts[0]);
    if (!row) throw new HttpError(404, 'File not found');
    if (
      await first(
        ctx,
        "SELECT id FROM media_uploads WHERE fileId=? AND churchId=? AND state IN ('creating','uploading','completing','aborting')",
        row.id,
        churchId,
      )
    )
      throw new HttpError(409, 'Abort the active upload session before deleting this pending file');
    // Hide immediately, then remove bytes. A failed deletion remains resumable and unreadable.
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE content_files SET state='deleting',dateModified=? WHERE churchId=? AND id=?").bind(
        now(),
        churchId,
        row.id,
      ),
      auditStatement(ctx, 'content.files.delete', row.id),
    ]);
    await ctx.env.FILES.delete(row.objectKey);
    await ctx.env.DB.prepare("DELETE FROM content_files WHERE churchId=? AND id=? AND state='deleting'")
      .bind(churchId, row.id)
      .run();
    return json({ id: row.id, deleted: true });
  }
  return undefined;
}

/** Retry incomplete R2 operations, with a grace period so active uploads are never collected. */
export async function cleanupFiles(env: Env): Promise<number> {
  const uploadsCleaned = await cleanupUploads(env);
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const rows = (
    await env.DB.prepare(
      "SELECT id,objectKey FROM content_files WHERE state IN ('pending','deleting') AND dateModified<? AND NOT EXISTS(SELECT 1 FROM media_uploads WHERE fileId=content_files.id AND state IN ('creating','uploading','completing','aborting')) LIMIT 100",
    )
      .bind(cutoff)
      .all<{ id: string; objectKey: string }>()
  ).results;
  let cleaned = 0;
  for (const row of rows) {
    await env.FILES.delete(row.objectKey);
    await env.DB.prepare("DELETE FROM content_files WHERE id=? AND state IN ('pending','deleting') AND dateModified<?")
      .bind(row.id, cutoff)
      .run();
    cleaned++;
  }
  return cleaned + uploadsCleaned;
}

export async function content(ctx: Context): Promise<Response | undefined> {
  if (
    ctx.principal.role === 'member' &&
    (ctx.path.startsWith('/content/sermons') ||
      ctx.path.startsWith('/content/playlists') ||
      ctx.path.startsWith('/content/files')) &&
    !(['GET', 'HEAD'].includes(ctx.request.method) && /^\/content\/files\/download\/[^/]+$/.test(ctx.path))
  )
    throw new HttpError(403, 'Use the member portal API');
  if (ctx.path === '/content/files' || ctx.path.startsWith('/content/files/')) return files(ctx);
  const match = /^\/content\/(sermons|playlists)(?:\/([^/]+))?(?:\/(publish|published))?\/?$/.exec(ctx.path);
  if (!match) return undefined;
  return contentRecords(ctx, match[1] as Resource, match[2], match[3]);
}
