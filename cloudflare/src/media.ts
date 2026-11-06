import { HttpError, requiredString } from './http';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_BASE64_BYTES = 5 * 1024 * 1024;
export const PART_BYTES = 8 * 1024 * 1024;
export const MAX_MULTIPART_BYTES = 1024 * 1024 * 1024;
export const FILE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'video/mp4',
  'application/zip',
  'application/octet-stream',
]);
export type FileRow = {
  id: string;
  churchId: string;
  contentType: string;
  contentId: string;
  fileName: string;
  fileType: string;
  size: number;
  dateModified: string;
  objectKey?: string;
};
export function fileResponse(row: FileRow) {
  return {
    id: row.id,
    churchId: row.churchId,
    contentType: row.contentType,
    contentId: row.contentId,
    fileName: row.fileName,
    fileType: row.fileType,
    size: row.size,
    dateModified: row.dateModified,
    provider: 'r2',
    contentPath: `/api/content/files/download/${encodeURIComponent(row.id)}`,
  };
}
export function fileMetadata(input: Record<string, any>) {
  const fileName = requiredString(input.fileName, 'fileName', 180);
  if (/[\\/\u0000-\u001f\u007f]/.test(fileName) || fileName === '.' || fileName === '..')
    throw new HttpError(400, 'Invalid fileName');
  const fileType = requiredString(input.fileType, 'fileType', 100).toLowerCase();
  if (!FILE_TYPES.has(fileType)) throw new HttpError(415, 'Unsupported file type');
  if (input.contentType && input.contentType !== 'sermon') throw new HttpError(400, 'Unsupported contentType');
  const contentId = requiredString(input.contentId, 'contentId', 100);
  return { fileName, fileType, contentType: 'sermon', contentId };
}
export async function boundedBytes(request: Request, max: number): Promise<Uint8Array> {
  const advertised = request.headers.get('Content-Length');
  if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > max)) throw new HttpError(413, 'File too large');
  if (!request.body) throw new HttpError(400, 'File is empty');
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > max) {
        await reader.cancel();
        throw new HttpError(413, 'File too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

type ByteRange = { offset: number; length: number } | 'unsatisfiable' | undefined;
function parseRange(value: string | null, size: number): ByteRange {
  if (!value || value.length > 512) return undefined;
  // RFC 9110 permits ignoring unsupported range units, malformed fields and multi-range requests.
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  const total = BigInt(size);
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (!suffix || !total) return 'unsatisfiable';
    const length = Number(suffix > total ? total : suffix);
    return { offset: size - length, length };
  }
  const start = BigInt(match[1]),
    end = match[2] ? BigInt(match[2]) : total - 1n;
  if (start >= total || end < start) return 'unsatisfiable';
  const last = end < total ? end : total - 1n;
  return { offset: Number(start), length: Number(last - start + 1n) };
}
function validDate(value: string | null): number | undefined {
  if (!value || !/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : undefined;
}
/** Authorization and publication checks MUST happen before this helper or any object lookup. */
export async function downloadFile(
  request: Request,
  bucket: R2Bucket,
  row: FileRow & { objectKey: string },
  options: { inline?: boolean } = {},
): Promise<Response> {
  const metadata = await bucket.head(row.objectKey);
  if (!metadata) throw new HttpError(404, 'File data not found');
  if (metadata.size !== row.size) throw new HttpError(503, 'File metadata is inconsistent; retry after archive repair');
  const headers = new Headers({
    'Content-Type': row.fileType,
    'Content-Length': String(metadata.size),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${options.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.fileName)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, no-store, no-transform',
    ETag: metadata.httpEtag,
    'Last-Modified': metadata.uploaded.toUTCString(),
  });
  const noneMatch = request.headers.get('If-None-Match');
  const modifiedSince = validDate(request.headers.get('If-Modified-Since'));
  if (
    (noneMatch &&
      noneMatch
        .split(',')
        .some((item) => item.trim() === '*' || item.trim().replace(/^W\//, '') === metadata.httpEtag)) ||
    (!noneMatch &&
      modifiedSince !== undefined &&
      Math.floor(metadata.uploaded.getTime() / 1000) * 1000 <= modifiedSince)
  ) {
    headers.delete('Content-Length');
    return new Response(null, { status: 304, headers });
  }
  // Range only changes GET; HEAD returns the same full representation metadata as an ordinary GET.
  if (request.method === 'HEAD') return new Response(null, { headers });
  const ifRange = request.headers.get('If-Range');
  const ifRangeDate = validDate(ifRange);
  const range =
    !ifRange ||
    ifRange === metadata.httpEtag ||
    (!ifRange.startsWith('W/') &&
      ifRangeDate !== undefined &&
      Math.floor(metadata.uploaded.getTime() / 1000) * 1000 === ifRangeDate)
      ? parseRange(request.headers.get('Range'), metadata.size)
      : undefined;
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${metadata.size}`);
    headers.set('Content-Length', '0');
    return new Response(null, { status: 416, headers });
  }
  const object = await bucket.get(row.objectKey, {
    ...(range ? { range } : {}),
    onlyIf: { etagMatches: metadata.etag },
  });
  if (!object) throw new HttpError(404, 'File data not found');
  if (!('body' in object)) throw new HttpError(409, 'File changed during download; retry');
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
    headers.set('Content-Length', String(range.length));
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
