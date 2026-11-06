import type { Context } from './types';
import { HttpError, json } from './http';

export interface MemberPageOptions {
  limit: number;
  offset: number;
  paged: boolean;
}
const maximumOffset = 10000;

export function memberPageOptions(ctx: Context, maximumLimit = 100): MemberPageOptions {
  const limit = ctx.url.searchParams.get('limit') || String(maximumLimit);
  const offset = ctx.url.searchParams.get('offset') || '0';
  const paged = ctx.url.searchParams.get('paged');
  if (
    !/^\d+$/.test(limit) ||
    !/^\d+$/.test(offset) ||
    Number(limit) < 1 ||
    Number(limit) > maximumLimit ||
    Number(offset) > maximumOffset ||
    (paged !== null && !['0', '1'].includes(paged))
  )
    throw new HttpError(400, 'Invalid pagination');
  return { limit: Number(limit), offset: Number(offset), paged: paged === '1' };
}

/** Pass at most limit+1 authorized results, with filtering and offset already applied. */
export function memberPageResult<T>(rows: T[], options: MemberPageOptions): Response {
  const items = rows.slice(0, options.limit);
  if (!options.paged) return json(items);
  const more = rows.length > options.limit;
  const next = options.offset + items.length;
  const truncated = more && next > maximumOffset;
  const hasMore = more && !truncated;
  return json({
    items,
    pagination: {
      limit: options.limit,
      offset: options.offset,
      count: items.length,
      hasMore,
      nextOffset: hasMore ? next : null,
      truncated,
    },
  });
}

export function memberSearch(ctx: Context): { query: string } {
  const query = (ctx.url.searchParams.get('q') || '').trim();
  if ([...query].length > 100 || /[\x00-\x1f\x7f]/.test(query))
    throw new HttpError(400, 'Search must contain at most 100 characters without control characters');
  return { query };
}
