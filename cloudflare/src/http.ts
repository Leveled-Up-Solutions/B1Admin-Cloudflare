import type { Context } from './types';
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}
export function requireAdmin(ctx: Context): void {
  if (ctx.principal.role !== 'admin' && !ctx.writeAuthorized)
    throw new HttpError(403, 'Administrator permission required');
}
export async function body<T = Record<string, any>>(request: Request): Promise<T> {
  const maxBytes = 1048576;
  const declaredLength = request.headers.get('Content-Length');
  if (declaredLength && Number(declaredLength) > maxBytes) throw new HttpError(413, 'Request body too large');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Invalid JSON');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, 'Request body too large');
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
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  if (parsed === null || typeof parsed !== 'object') throw new HttpError(400, 'Expected a JSON object or array');
  return parsed as T;
}
export async function records(request: Request): Promise<Record<string, any>[]> {
  const data = await body<unknown>(request);
  if (
    !Array.isArray(data) ||
    data.length < 1 ||
    data.length > 100 ||
    data.some((x) => !x || typeof x !== 'object' || Array.isArray(x))
  )
    throw new HttpError(400, 'Expected an array of 1 to 100 records');
  return data;
}
export function requiredString(value: unknown, field: string, max = 255): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `Invalid ${field}`);
  return value.trim();
}
export async function all<T = Record<string, any>>(ctx: Context, sql: string, ...args: any[]): Promise<T[]> {
  return (
    await ctx.env.DB.prepare(sql)
      .bind(...args)
      .all<T>()
  ).results;
}
export async function first<T = Record<string, any>>(ctx: Context, sql: string, ...args: any[]): Promise<T | null> {
  return ctx.env.DB.prepare(sql)
    .bind(...args)
    .first<T>();
}
export function id(): string {
  return crypto.randomUUID();
}
export function now(): string {
  return new Date().toISOString();
}
export async function audit(ctx: Context, action: string, entityId: string): Promise<void> {
  await ctx.env.DB.prepare(
    'INSERT INTO audit_log (id, churchId, userId, action, entityId, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id(), ctx.principal.churchId, ctx.principal.userId, action, entityId, now())
    .run();
}
