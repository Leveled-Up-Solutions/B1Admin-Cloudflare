import type { Context, Env } from './types';
import { requireSermonAccess, resourceSnapshot, resourceWriteGuard } from './resource-permissions';
import { all, body, first, HttpError, id, json, now, requiredString } from './http';
import { boundedBytes, fileMetadata, fileResponse, MAX_MULTIPART_BYTES, PART_BYTES } from './media';

type Session = {
  id: string;
  churchId: string;
  userId: string;
  fileId: string | null;
  contentId: string;
  fileName: string;
  fileType: string;
  size: number;
  partSize: number;
  totalParts: number;
  objectKey: string;
  uploadId: string | null;
  idempotencyKey: string;
  state: 'creating' | 'uploading' | 'completing' | 'complete' | 'aborting' | 'aborted';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  finishedAt: string | null;
};
type Part = {
  sessionId: string;
  partNumber: number;
  size: number;
  sha256: string;
  attempts: number;
  providerPartNumber: number | null;
  etag: string | null;
  state: string;
};
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const OPEN_STATES = ['creating', 'uploading', 'completing'];
async function guarded(ctx: Context, contentId: string, statements: D1PreparedStatement[], session?: Session) {
  const sermon = await requireSermonAccess(ctx, contentId, 'Edit');
  const guard = resourceWriteGuard(ctx, {
    requirements: [{ resource: 'Sermons', row: sermon }],
    snapshots: [resourceSnapshot('content_sermons', sermon)],
    checks: session
      ? [
          {
            sql: 'EXISTS(SELECT 1 FROM media_uploads WHERE id=? AND churchId=? AND userId=? AND contentId=?)',
            values: [session.id, ctx.principal.churchId, ctx.principal.userId, contentId],
          },
        ]
      : [],
  });
  return (await ctx.env.DB.batch([...guard, ...statements])).slice(guard.length);
}
async function guardedRun(ctx: Context, session: Session, statement: D1PreparedStatement) {
  return (await guarded(ctx, session.contentId, [statement], session))[0];
}
async function load(ctx: Context, sessionId: string): Promise<Session> {
  const session = await first<Session>(
    ctx,
    'SELECT * FROM media_uploads WHERE id=? AND churchId=? AND userId=?',
    sessionId,
    ctx.principal.churchId,
    ctx.principal.userId,
  );
  if (!session) throw new HttpError(404, 'Upload session not found');
  return session;
}
function expired(session: Session) {
  return session.expiresAt <= now();
}
function partDto(part: Part) {
  return { partNumber: part.partNumber, size: part.size, sha256: part.sha256 };
}
async function dto(env: Env, session: Session) {
  const parts = (
    await env.DB.prepare("SELECT * FROM media_upload_parts WHERE sessionId=? AND state='ready' ORDER BY partNumber")
      .bind(session.id)
      .all<Part>()
  ).results;
  const file =
    session.state === 'complete' && session.fileId
      ? await env.DB.prepare("SELECT * FROM content_files WHERE id=? AND churchId=? AND state='ready'")
          .bind(session.fileId, session.churchId)
          .first<any>()
      : null;
  return {
    id: session.id,
    fileId: session.fileId,
    contentId: session.contentId,
    fileName: session.fileName,
    fileType: session.fileType,
    size: session.size,
    partSize: session.partSize,
    totalParts: session.totalParts,
    state: session.state,
    expiresAt: session.expiresAt,
    parts: parts.map(partDto),
    ...(file ? { file: fileResponse(file) } : {}),
  };
}
function audit(env: Env, session: Session, action: string) {
  return env.DB.prepare(
    'INSERT OR IGNORE INTO audit_log(id,churchId,userId,action,entityId,createdAt) VALUES(?,?,?,?,?,?)',
  ).bind(`${session.id}:${action}`, session.churchId, session.userId, action, session.fileId || session.id, now());
}
function validateObject(object: R2Object, session: Session) {
  if (
    object.size !== session.size ||
    object.customMetadata?.uploadSessionId !== session.id ||
    object.customMetadata?.churchId !== session.churchId ||
    object.customMetadata?.fileId !== session.fileId
  )
    throw new HttpError(409, 'Completed upload metadata does not match this session');
}
async function finalize(ctx: Context, session: Session, object: R2Object): Promise<Session> {
  const env = ctx.env;
  validateObject(object, session);
  const completedAt = now();
  await guarded(
    ctx,
    session.contentId,
    [
      env.DB.prepare(
        "UPDATE content_files SET state='ready',dateModified=? WHERE id=? AND churchId=? AND state='pending' AND EXISTS(SELECT 1 FROM media_uploads WHERE id=? AND state='completing')",
      ).bind(completedAt, session.fileId, session.churchId, session.id),
      env.DB.prepare(
        "UPDATE media_uploads SET state='complete',finishedAt=?,updatedAt=? WHERE id=? AND state='completing' AND EXISTS(SELECT 1 FROM content_files WHERE id=? AND state='ready')",
      ).bind(completedAt, completedAt, session.id, session.fileId),
      env.DB.prepare(
        "INSERT OR IGNORE INTO audit_log(id,churchId,userId,action,entityId,createdAt) SELECT ?,churchId,userId,'content.files.multipart.complete',fileId,? FROM media_uploads WHERE id=? AND state='complete'",
      ).bind(`${session.id}:complete`, completedAt, session.id),
    ],
    session,
  );
  const current = await env.DB.prepare('SELECT * FROM media_uploads WHERE id=?').bind(session.id).first<Session>();
  if (!current || current.state !== 'complete') throw new HttpError(409, 'Upload completion was cancelled');
  return current;
}
async function create(ctx: Context): Promise<Response> {
  const input = await body(ctx.request);
  if (Array.isArray(input)) throw new HttpError(400, 'Expected one upload object');
  if (input.churchId && input.churchId !== ctx.principal.churchId) throw new HttpError(403, 'Church mismatch');
  const metadata = fileMetadata(input),
    size = input.size;
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MULTIPART_BYTES)
    throw new HttpError(400, 'Multipart size must be 1 byte to 1 GiB');
  const key = requiredString(input.idempotencyKey, 'idempotencyKey', 100);
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(key))
    throw new HttpError(400, 'Use a random idempotency key of 16–100 characters');
  if (
    !(await first(
      ctx,
      'SELECT id FROM content_sermons WHERE churchId=? AND id=?',
      ctx.principal.churchId,
      metadata.contentId,
    ))
  )
    throw new HttpError(404, 'Sermon not found');
  await requireSermonAccess(ctx, metadata.contentId, 'Edit');
  const previous = await first<Session>(
    ctx,
    'SELECT * FROM media_uploads WHERE churchId=? AND userId=? AND idempotencyKey=?',
    ctx.principal.churchId,
    ctx.principal.userId,
    key,
  );
  if (previous) {
    if (
      previous.size !== size ||
      previous.fileName !== metadata.fileName ||
      previous.fileType !== metadata.fileType ||
      previous.contentId !== metadata.contentId
    )
      throw new HttpError(409, 'Idempotency key already belongs to a different upload');
    return json(await dto(ctx.env, previous), 200);
  }
  const fileId = id(),
    sessionId = id(),
    createdAt = now();
  const objectKey = `churches/${encodeURIComponent(ctx.principal.churchId)}/files/${fileId}`;
  const session: Session = {
    id: sessionId,
    churchId: ctx.principal.churchId,
    userId: ctx.principal.userId,
    fileId,
    ...metadata,
    size,
    partSize: PART_BYTES,
    totalParts: Math.ceil(size / PART_BYTES),
    objectKey,
    uploadId: null,
    idempotencyKey: key,
    state: 'creating',
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    finishedAt: null,
  };
  // The pending file blocks deletion of its sermon and is hidden from every file/public/member read.
  try {
    await guarded(ctx, session.contentId, [
      ctx.env.DB.prepare(
        "INSERT INTO content_files(id,churchId,contentId,fileName,fileType,size,objectKey,state,dateModified) VALUES(?,?,?,?,?,?,?,'pending',?)",
      ).bind(
        fileId,
        session.churchId,
        session.contentId,
        session.fileName,
        session.fileType,
        size,
        objectKey,
        createdAt,
      ),
      ctx.env.DB.prepare(
        'INSERT INTO media_uploads(id,churchId,userId,fileId,contentId,fileName,fileType,size,partSize,totalParts,objectKey,idempotencyKey,state,createdAt,updatedAt,expiresAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).bind(
        sessionId,
        session.churchId,
        session.userId,
        fileId,
        session.contentId,
        session.fileName,
        session.fileType,
        size,
        PART_BYTES,
        session.totalParts,
        objectKey,
        key,
        'creating',
        createdAt,
        createdAt,
        session.expiresAt,
      ),
      audit(ctx.env, session, 'content.files.multipart.start'),
    ]);
  } catch (error) {
    if ((error instanceof HttpError && error.status === 403) || String(error).includes('authorized_write_snapshot'))
      throw error;
    const raced = await first<Session>(
      ctx,
      'SELECT * FROM media_uploads WHERE churchId=? AND userId=? AND idempotencyKey=?',
      session.churchId,
      session.userId,
      key,
    );
    if (raced) {
      if (
        raced.size !== size ||
        raced.fileName !== metadata.fileName ||
        raced.fileType !== metadata.fileType ||
        raced.contentId !== metadata.contentId
      )
        throw new HttpError(409, 'Idempotency key already belongs to a different upload');
      return json(await dto(ctx.env, raced));
    }
    throw error;
  }
  let upload: R2MultipartUpload;
  try {
    upload = await ctx.env.FILES.createMultipartUpload(objectKey, {
      httpMetadata: { contentType: session.fileType },
      customMetadata: { churchId: session.churchId, fileId, uploadSessionId: session.id },
    });
  } catch {
    await ctx.env.DB.prepare("UPDATE media_uploads SET state='aborting' WHERE id=? AND state='creating'")
      .bind(sessionId)
      .run();
    await abortSession(ctx.env, session);
    throw new HttpError(503, 'Upload creation failed; start again with a new idempotency key');
  }
  try {
    const saved = await guardedRun(
      ctx,
      session,
      ctx.env.DB.prepare(
        "UPDATE media_uploads SET uploadId=?,state='uploading',updatedAt=? WHERE id=? AND state='creating'",
      ).bind(upload.uploadId, now(), sessionId),
    );
    if (!saved.meta.changes) {
      await upload.abort();
      throw new HttpError(409, 'Upload was cancelled during creation');
    }
  } catch (error) {
    // Distinguish an uncertain committed write from a confirmed failure before compensating R2.
    const current = await load(ctx, sessionId);
    if (current.uploadId === upload.uploadId && ['uploading', 'completing', 'complete'].includes(current.state))
      return json(await dto(ctx.env, current));
    if (['creating', 'aborting', 'aborted'].includes(current.state)) {
      await upload.abort();
      await ctx.env.DB.prepare("UPDATE media_uploads SET state='aborting' WHERE id=? AND state='creating'")
        .bind(sessionId)
        .run();
      await abortSession(ctx.env, { ...current, uploadId: upload.uploadId });
    }
    throw error;
  }
  session.uploadId = upload.uploadId;
  session.state = 'uploading';
  return json(await dto(ctx.env, session), 201);
}
async function uploadPart(ctx: Context, session: Session, partNumber: number): Promise<Response> {
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > session.totalParts)
    throw new HttpError(400, 'Invalid part number');
  if (expired(session)) throw new HttpError(410, 'Upload session expired; abort it and start again');
  if (!['uploading', 'completing', 'complete'].includes(session.state) || !session.uploadId)
    throw new HttpError(409, 'Upload is not ready for parts');
  const expected =
    partNumber === session.totalParts ? session.size - (session.totalParts - 1) * PART_BYTES : PART_BYTES;
  const bytes = await boundedBytes(ctx.request, expected);
  if (bytes.length !== expected) throw new HttpError(400, `This part must contain exactly ${expected} bytes`);
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  let part = await first<Part>(
    ctx,
    'SELECT * FROM media_upload_parts WHERE sessionId=? AND partNumber=?',
    session.id,
    partNumber,
  );
  if (part && part.sha256 !== sha256)
    throw new HttpError(409, 'Part bytes differ from the original upload; choose the same file or start a new session');
  if (part?.state === 'ready') return json(partDto(part));
  if (session.state !== 'uploading') throw new HttpError(409, 'Upload manifest is frozen');
  if (!part) {
    try {
      await guardedRun(
        ctx,
        session,
        ctx.env.DB.prepare(
          "INSERT INTO media_upload_parts(sessionId,partNumber,size,sha256,state) VALUES(?,?,?,?,'pending')",
        ).bind(session.id, partNumber, bytes.length, sha256),
      );
    } catch (error) {
      if ((error instanceof HttpError && error.status === 403) || String(error).includes('authorized_write_snapshot'))
        throw error;
      part = await first<Part>(
        ctx,
        'SELECT * FROM media_upload_parts WHERE sessionId=? AND partNumber=?',
        session.id,
        partNumber,
      );
      if (!part) throw error;
      if (part.sha256 !== sha256) throw new HttpError(409, 'Part bytes differ from the original upload');
      if (part.state === 'ready') return json(partDto(part));
    }
  }
  // Each in-flight attempt gets a distinct R2 part number. A late retry can never overwrite the selected manifest.
  const attemptResult = await guardedRun(
    ctx,
    session,
    ctx.env.DB.prepare(
      "UPDATE media_upload_parts SET attempts=attempts+1 WHERE sessionId=? AND partNumber=? AND state='pending' AND attempts<8 AND EXISTS(SELECT 1 FROM media_uploads WHERE id=? AND state='uploading' AND expiresAt>?) RETURNING attempts",
    ).bind(session.id, partNumber, session.id, now()),
  );
  const attempt = attemptResult.results[0] as { attempts: number } | undefined;
  if (!attempt) {
    part = await first<Part>(
      ctx,
      'SELECT * FROM media_upload_parts WHERE sessionId=? AND partNumber=?',
      session.id,
      partNumber,
    );
    if (part?.state === 'ready') return json(partDto(part));
    throw new HttpError(
      409,
      'Part is frozen or has reached its eight-attempt limit; retry status or start a new session',
    );
  }
  const physical = (partNumber - 1) * 8 + attempt.attempts;
  let uploaded: R2UploadedPart;
  try {
    uploaded = await ctx.env.FILES.resumeMultipartUpload(session.objectKey, session.uploadId).uploadPart(
      physical,
      bytes,
    );
  } catch {
    throw new HttpError(503, 'R2 part upload did not complete; retry this part using the same file');
  }
  await guardedRun(
    ctx,
    session,
    ctx.env.DB.prepare(
      "UPDATE media_upload_parts SET providerPartNumber=?,etag=?,state='ready' WHERE sessionId=? AND partNumber=? AND state='pending' AND EXISTS(SELECT 1 FROM media_uploads WHERE id=? AND state='uploading' AND expiresAt>?)",
    ).bind(uploaded.partNumber, uploaded.etag, session.id, partNumber, session.id, now()),
  );
  part = await first<Part>(
    ctx,
    'SELECT * FROM media_upload_parts WHERE sessionId=? AND partNumber=?',
    session.id,
    partNumber,
  );
  if (!part || part.state !== 'ready')
    throw new HttpError(409, 'Upload was cancelled or expired while receiving this part');
  return json(partDto(part));
}
async function complete(ctx: Context, session: Session): Promise<Response> {
  if (session.state === 'complete') return json(await dto(ctx.env, session));
  if (expired(session)) throw new HttpError(410, 'Upload session expired; abort it and start again');
  if (!session.uploadId || !['uploading', 'completing'].includes(session.state))
    throw new HttpError(409, 'Upload cannot be completed in this state');
  const parts = await all<Part>(
    ctx,
    "SELECT * FROM media_upload_parts WHERE sessionId=? AND state='ready' ORDER BY partNumber",
    session.id,
  );
  if (
    parts.length !== session.totalParts ||
    parts.some((part, index) => part.partNumber !== index + 1) ||
    parts.reduce((sum, part) => sum + part.size, 0) !== session.size
  )
    throw new HttpError(409, 'Upload every part before completing');
  const frozen = await guardedRun(
    ctx,
    session,
    ctx.env.DB.prepare(
      "UPDATE media_uploads SET state='completing',updatedAt=? WHERE id=? AND state='uploading' AND expiresAt>?",
    ).bind(now(), session.id, now()),
  );
  if (!frozen.meta.changes) {
    session = await load(ctx, session.id);
    if (session.state === 'complete') return json(await dto(ctx.env, session));
    if (session.state !== 'completing') throw new HttpError(409, 'Upload cannot be completed in this state');
  }
  const existing = await ctx.env.FILES.head(session.objectKey);
  if (existing) return json(await dto(ctx.env, await finalize(ctx, session, existing)));
  try {
    const object = await ctx.env.FILES.resumeMultipartUpload(session.objectKey, session.uploadId!).complete(
      parts.map((part) => ({ partNumber: part.providerPartNumber!, etag: part.etag! })),
    );
    return json(await dto(ctx.env, await finalize(ctx, session, object)));
  } catch (error) {
    // A negative HEAD cannot disprove an in-flight completion. Never reopen this frozen manifest.
    const object = await ctx.env.FILES.head(session.objectKey);
    if (object) return json(await dto(ctx.env, await finalize(ctx, session, object)));
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'Completion is pending; retry completion with this same session');
  }
}
async function abortSession(env: Env, session: Session): Promise<void> {
  if (session.uploadId) await env.FILES.resumeMultipartUpload(session.objectKey, session.uploadId).abort();
  // Aborting a completed R2 multipart upload does not remove its object. Cancellation must delete it too.
  await env.FILES.delete(session.objectKey);
  const finishedAt = now();
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM content_files WHERE id=? AND state='pending' AND EXISTS(SELECT 1 FROM media_uploads WHERE id=? AND state='aborting')",
    ).bind(session.fileId, session.id),
    env.DB.prepare(
      "UPDATE media_uploads SET state='aborted',finishedAt=coalesce(finishedAt,?),updatedAt=? WHERE id=? AND state='aborting'",
    ).bind(finishedAt, finishedAt, session.id),
    audit(env, session, 'content.files.multipart.abort'),
  ]);
}
async function abort(ctx: Context, session: Session): Promise<Response> {
  if (session.state === 'complete') throw new HttpError(409, 'Upload is complete; delete the archived file instead');
  if (session.state !== 'aborted') {
    await guardedRun(
      ctx,
      session,
      ctx.env.DB.prepare(
        "UPDATE media_uploads SET state='aborting',updatedAt=? WHERE id=? AND state IN ('creating','uploading','completing')",
      ).bind(now(), session.id),
    );
    session = await load(ctx, session.id);
    if (session.state === 'complete') throw new HttpError(409, 'Upload is complete; delete the archived file instead');
    if (session.state === 'aborting') await abortSession(ctx.env, session);
  }
  return json({ id: session.id, state: 'aborted' });
}
/** Repeated deletion tombstones cover unknown/in-flight R2 completions without ever publishing them. */
export async function cleanupUploads(env: Env): Promise<number> {
  const timestamp = now(),
    retentionCutoff = new Date(Date.now() - RETENTION_MS).toISOString();
  const rows = (
    await env.DB.prepare(
      "SELECT * FROM media_uploads WHERE (state IN ('creating','uploading','completing') AND expiresAt<?) OR state IN ('aborting','aborted') ORDER BY updatedAt LIMIT 100",
    )
      .bind(timestamp)
      .all<Session>()
  ).results;
  let cleaned = 0;
  for (let session of rows) {
    if (OPEN_STATES.includes(session.state)) {
      await env.DB.prepare(
        "UPDATE media_uploads SET state='aborting' WHERE id=? AND state IN ('creating','uploading','completing') AND expiresAt<?",
      )
        .bind(session.id, timestamp)
        .run();
      session = (await env.DB.prepare('SELECT * FROM media_uploads WHERE id=?').bind(session.id).first<Session>())!;
    }
    if (session.state === 'complete') continue;
    if (session.state === 'aborting') await abortSession(env, session);
    else if (session.state === 'aborted') {
      await env.FILES.delete(session.objectKey);
      if (session.finishedAt && session.finishedAt < retentionCutoff)
        await env.DB.prepare("DELETE FROM media_uploads WHERE id=? AND state='aborted'").bind(session.id).run();
      else
        await env.DB.prepare("UPDATE media_uploads SET updatedAt=? WHERE id=? AND state='aborted'")
          .bind(timestamp, session.id)
          .run();
    }
    cleaned++;
  }
  return cleaned;
}
export async function mediaUploads(ctx: Context): Promise<Response | undefined> {
  const route = /^\/content\/files\/uploads(?:\/([^/]+)(?:\/parts\/(\d+)|\/(complete))?)?$/.exec(ctx.path);
  if (!route) return undefined;
  const [, sessionId, part, operation] = route,
    method = ctx.request.method;
  if (!sessionId) {
    if (method === 'POST') return create(ctx);
    if (method === 'GET') {
      const contentId = requiredString(ctx.url.searchParams.get('contentId'), 'contentId', 100);
      await requireSermonAccess(ctx, contentId, 'Edit');
      const sessions = await all<Session>(
        ctx,
        "SELECT * FROM media_uploads WHERE churchId=? AND userId=? AND contentId=? AND state IN ('creating','uploading','completing','aborting') ORDER BY createdAt DESC LIMIT 20",
        ctx.principal.churchId,
        ctx.principal.userId,
        contentId,
      );
      return json(await Promise.all(sessions.map((session) => dto(ctx.env, session))));
    }
    return undefined;
  }
  const session = await load(ctx, sessionId);
  try {
    await requireSermonAccess(ctx, session.contentId, 'Edit');
    if (part && method === 'PUT') return await uploadPart(ctx, session, Number(part));
    if (operation === 'complete' && method === 'POST') return await complete(ctx, session);
    if (!part && !operation) {
      if (method === 'GET') return json(await dto(ctx.env, session));
      if (method === 'DELETE') return await abort(ctx, session);
    }
    return undefined;
  } catch (error) {
    if (
      (error instanceof HttpError && error.status === 403) ||
      (error instanceof Error && error.message.includes('authorized_write_snapshot'))
    ) {
      // Compensation may discard only this owner's still-pending upload. Never
      // publish bytes after authorization is lost, including across R2 I/O.
      try {
        await ctx.env.DB.prepare(
          "UPDATE media_uploads SET state='aborting',updatedAt=? WHERE id=? AND churchId=? AND userId=? AND state IN ('creating','uploading','completing')",
        )
          .bind(now(), session.id, ctx.principal.churchId, ctx.principal.userId)
          .run();
        const current = await load(ctx, session.id);
        if (current.state === 'aborting') await abortSession(ctx.env, current);
      } catch {
        /* persisted pending/aborting metadata remains private; cleanup retries */
      }
    }
    throw error;
  }
}
