import type { Context } from './types';
import { all, first, body, json, HttpError, id, now, requiredString } from './http';
import { allowed } from './permissions';

const base = '/membership/groupjoinrequests';
const select = `SELECT r.*,g.name groupName,p.firstName,p.lastName,p.nickName FROM group_join_requests r
 JOIN groups g ON g.churchId=r.churchId AND g.id=r.groupId
 JOIN people p ON p.churchId=r.churchId AND p.id=r.personId`;
function dto(row: Record<string, any>, review = false) {
  const result: Record<string, any> = {
    id: row.id,
    churchId: row.churchId,
    groupId: row.groupId,
    personId: row.personId,
    message: row.message,
    requestDate: row.requestDate,
    status: row.status,
    decidedBy: row.decidedBy,
    decidedDate: row.decidedDate,
    declineReason: row.declineReason,
    group: { id: row.groupId, name: row.groupName },
  };
  // Request reviewers need the requester's name, not their withheld directory contacts.
  if (review)
    result.person = {
      id: row.personId,
      name: {
        display: [row.nickName || row.firstName, row.lastName].filter(Boolean).join(' '),
      },
      contactInfo: {},
      photo: '',
    };
  return result;
}
function paging(ctx: Context) {
  const limit = ctx.url.searchParams.get('limit') || '100',
    offset = ctx.url.searchParams.get('offset') || '0';
  if (
    !/^\d+$/.test(limit) ||
    Number(limit) < 1 ||
    Number(limit) > 100 ||
    !/^\d+$/.test(offset) ||
    Number(offset) > 10000
  )
    throw new HttpError(400, 'Invalid pagination');
  return [Number(limit), Number(offset)];
}
function inputFields(input: Record<string, any>, keys: string[]) {
  if (Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key)))
    throw new HttpError(400, 'Unexpected request fields');
}
function optionalText(value: unknown, field: string, limit: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
    throw new HttpError(400, `Invalid ${field}`);
  return value.trim();
}
async function canReview(ctx: Context, groupId: string): Promise<boolean> {
  return (
    allowed(ctx, 'MembershipApi', 'Group Members', 'Edit', groupId) ||
    !!(await first(
      ctx,
      'SELECT id FROM group_members WHERE churchId=? AND groupId=? AND personId=? AND leader=1',
      ctx.principal.churchId,
      groupId,
      ctx.principal.personId,
    ))
  );
}
async function load(ctx: Context, requestId: string) {
  const row = await first(ctx, `${select} WHERE r.churchId=? AND r.id=?`, ctx.principal.churchId, requestId);
  if (!row) throw new HttpError(404, 'Join request not found');
  return row;
}
async function create(ctx: Context) {
  const input = await body(ctx.request);
  inputFields(input, ['groupId', 'message']);
  const groupId = requiredString(input.groupId, 'groupId', 128),
    message = optionalText(input.message, 'message', 1000);
  const group = await first(
    ctx,
    'SELECT id,joinPolicy FROM groups WHERE churchId=? AND id=? AND archived=0',
    ctx.principal.churchId,
    groupId,
  );
  if (!group) throw new HttpError(404, 'Group not found');
  if (group.joinPolicy !== 'request') throw new HttpError(409, 'This group does not accept join requests');
  if (
    await first(
      ctx,
      'SELECT id FROM group_members WHERE churchId=? AND groupId=? AND personId=?',
      ctx.principal.churchId,
      groupId,
      ctx.principal.personId,
    )
  )
    throw new HttpError(409, 'Already a member');
  const requestId = id(),
    timestamp = now();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO group_join_requests(id,churchId,groupId,personId,message,requestDate)
      SELECT ?,g.churchId,g.id,p.id,?,? FROM groups g JOIN people p ON p.churchId=g.churchId AND p.id=? AND p.removed=0
      WHERE g.churchId=? AND g.id=? AND g.joinPolicy='request' AND g.archived=0
      AND NOT EXISTS(SELECT 1 FROM group_members gm WHERE gm.churchId=g.churchId AND gm.groupId=g.id AND gm.personId=p.id)
      ON CONFLICT DO NOTHING`,
    ).bind(requestId, message, timestamp, ctx.principal.personId, ctx.principal.churchId, groupId),
    ctx.env.DB.prepare(
      `INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt)
      SELECT ?,churchId,?,'groupJoinRequest.create',id,? FROM group_join_requests WHERE churchId=? AND id=?`,
    ).bind(id(), ctx.principal.userId, timestamp, ctx.principal.churchId, requestId),
  ]);
  const row = await first(
    ctx,
    `${select} WHERE r.churchId=? AND r.groupId=? AND r.personId=? AND r.status='pending'`,
    ctx.principal.churchId,
    groupId,
    ctx.principal.personId,
  );
  if (!row) throw new HttpError(409, 'Group or membership changed; refresh before requesting');
  return json(dto(row));
}
async function decide(ctx: Context, requestId: string, action: string) {
  const row = await load(ctx, requestId);
  const cancel = action === 'cancel',
    globalEdit = allowed(ctx, 'MembershipApi', 'Group Members', 'Edit');
  if (cancel ? row.personId !== ctx.principal.personId && !globalEdit : !(await canReview(ctx, row.groupId)))
    throw new HttpError(403, 'Join request permission required');
  const input = cancel ? {} : await body(ctx.request);
  inputFields(input, action === 'decline' ? ['declineReason'] : []);
  const reason = action === 'decline' ? optionalText(input.declineReason, 'declineReason', 500) : null;
  const status = action === 'approve' ? 'approved' : action === 'decline' ? 'declined' : 'cancelled';
  if (row.status !== 'pending') {
    if (cancel) return json({});
    if (row.status === status) return json(dto(row, true));
    throw new HttpError(409, 'The request has already been decided');
  }
  const decisionId = id(),
    timestamp = now();
  const permitted = cancel || allowed(ctx, 'MembershipApi', 'Group Members', 'Edit', row.groupId);
  const approvalClause =
    action === 'approve'
      ? `AND EXISTS(SELECT 1 FROM groups g JOIN people p ON p.churchId=g.churchId WHERE g.churchId=group_join_requests.churchId AND g.id=group_join_requests.groupId AND g.joinPolicy='request' AND g.archived=0 AND p.id=group_join_requests.personId AND p.removed=0)`
      : '';
  const statements = [
    ctx.env.DB.prepare(
      `UPDATE group_join_requests SET status=?,decidedBy=?,decidedDate=?,declineReason=?,decisionId=?
    WHERE churchId=? AND id=? AND status='pending' ${approvalClause}
    AND (?=1 OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.churchId=group_join_requests.churchId AND gm.groupId=group_join_requests.groupId AND gm.personId=? AND gm.leader=1))`,
    ).bind(
      status,
      ctx.principal.personId,
      timestamp,
      reason,
      decisionId,
      ctx.principal.churchId,
      requestId,
      permitted ? 1 : 0,
      ctx.principal.personId,
    ),
  ];
  if (action === 'approve')
    statements.push(
      ctx.env.DB.prepare(
        `INSERT INTO group_members(id,churchId,groupId,personId,leader)
    SELECT ?,churchId,groupId,personId,0 FROM group_join_requests WHERE churchId=? AND id=? AND status='approved' AND decisionId=?
    ON CONFLICT(churchId,groupId,personId) DO NOTHING`,
      ).bind(id(), ctx.principal.churchId, requestId, decisionId),
    );
  statements.push(
    ctx.env.DB.prepare(
      `INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt)
    SELECT ?,churchId,?,?,id,? FROM group_join_requests WHERE churchId=? AND id=? AND decisionId=?`,
    ).bind(
      id(),
      ctx.principal.userId,
      `groupJoinRequest.${action}`,
      timestamp,
      ctx.principal.churchId,
      requestId,
      decisionId,
    ),
  );
  await ctx.env.DB.batch(statements);
  const result = await load(ctx, requestId);
  if (result.status !== status)
    throw new HttpError(409, 'Request, group or reviewer permission changed; refresh before deciding');
  return json(cancel ? {} : dto(result, true));
}
/** Ownership and current group-leader authorization are enforced here, before the staff-only dispatch gate. */
export async function groupRequests(ctx: Context): Promise<Response | undefined> {
  const review = ctx.path === '/member/v1/group-requests/review';
  if (!review && ctx.path !== base && !ctx.path.startsWith(`${base}/`)) return undefined;
  const path = ctx.path.slice(base.length),
    method = ctx.request.method;
  if (method === 'POST' && path === '') return create(ctx);
  if (method === 'GET' && (path === '/my' || path === '/pending' || review)) {
    const args: any[] = [ctx.principal.churchId];
    let where = 'r.churchId=?';
    if (path === '/my') {
      where += ' AND r.personId=?';
      args.push(ctx.principal.personId);
    } else {
      where += " AND r.status='pending' AND p.removed=0";
      if (!allowed(ctx, 'MembershipApi', 'Group Members', 'Edit')) {
        if (!review) throw new HttpError(403, 'Group Members edit permission required');
        const prefix = 'MembershipApi_Group Members_',
          suffix = '_Edit';
        const scoped = (ctx.principal.permissions || [])
          .filter((value) => value.startsWith(prefix) && value.endsWith(suffix))
          .map((value) => value.slice(prefix.length, -suffix.length))
          .filter(Boolean);
        where += ` AND (EXISTS(SELECT 1 FROM group_members gm WHERE gm.churchId=r.churchId AND gm.groupId=r.groupId AND gm.personId=? AND gm.leader=1) OR r.groupId IN (SELECT value FROM json_each(?)))`;
        args.push(ctx.principal.personId, JSON.stringify(scoped));
      }
    }
    return json(
      (
        await all(
          ctx,
          `${select} WHERE ${where} ORDER BY r.requestDate ${path === '/my' ? 'DESC' : 'ASC'},r.id LIMIT ? OFFSET ?`,
          ...args,
          ...paging(ctx),
        )
      ).map((row) => dto(row, path !== '/my')),
    );
  }
  const groupMatch = /^\/group\/([^/]+)$/.exec(path);
  if (groupMatch && method === 'GET') {
    if (!(await first(ctx, 'SELECT id FROM groups WHERE churchId=? AND id=?', ctx.principal.churchId, groupMatch[1])))
      throw new HttpError(404, 'Group not found');
    if (!(await canReview(ctx, groupMatch[1])))
      throw new HttpError(403, 'Group leader or Group Members edit permission required');
    return json(
      (
        await all(
          ctx,
          `${select} WHERE r.churchId=? AND r.groupId=? AND r.status='pending' AND p.removed=0 ORDER BY r.requestDate,r.id LIMIT ? OFFSET ?`,
          ctx.principal.churchId,
          groupMatch[1],
          ...paging(ctx),
        )
      ).map((row) => dto(row, true)),
    );
  }
  const decision = /^\/([^/]+)\/(approve|decline)$/.exec(path);
  if (decision && method === 'POST') return decide(ctx, decision[1], decision[2]);
  const cancel = /^\/([^/]+)$/.exec(path);
  if (cancel && method === 'DELETE' && !['my', 'pending'].includes(cancel[1])) return decide(ctx, cancel[1], 'cancel');
  throw new HttpError(405, 'Unsupported join-request action');
}
