import type { Context } from './types';
import { all, body, first, HttpError, id, json, now, requiredString } from './http';
import { approvalGroup, birthDate, clean, contactFields, nameFields, self, writeGuard } from './member-profile';
import { doingWriteGuard } from './doing-permissions';
import { memberPageOptions, memberPageResult } from './member-pagination';

const base = '/member/v1/profile-requests';
const selection = `SELECT r.*,p.firstName requesterFirst,p.lastName requesterLast,p.nickName requesterNick,
 t.firstName targetFirst,t.lastName targetLast,t.nickName targetNick
 FROM member_change_requests r JOIN people p ON p.churchId=r.churchId AND p.id=r.requesterPersonId
 LEFT JOIN people t ON t.churchId=r.churchId AND t.id=r.targetPersonId`;
type Check = { sql: string; values: (string | number | null)[] };

function object(input: unknown, fields: string[]) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !fields.includes(key))
  )
    throw new HttpError(400, 'Unexpected request fields');
  return input as Record<string, any>;
}
function changes(input: unknown, kind: string, actor: Record<string, any>) {
  const result: Record<string, string | null> = {};
  if (kind === 'family-add') {
    const data = object(input, ['first', 'last', 'mobilePhone', 'householdRole']);
    result.first = clean(data.first, 'first', 100, true);
    result.last = data.last === undefined || data.last === '' ? actor.lastName : clean(data.last, 'last', 100, true);
    result.householdRole = data.householdRole ?? 'Other';
    if (!['Head', 'Spouse', 'Child', 'Other'].includes(result.householdRole!))
      throw new HttpError(400, 'Invalid householdRole');
    if (data.mobilePhone !== undefined) result.mobilePhone = clean(data.mobilePhone, 'mobilePhone', 40);
  } else {
    const data = object(input, [...nameFields, ...contactFields, 'birthDate']);
    if (!Object.keys(data).length) throw new HttpError(400, 'Supply at least one proposed personal field');
    for (const field of Object.keys(data).sort()) {
      result[field] =
        field === 'birthDate'
          ? birthDate(data[field])
          : clean(
              data[field],
              field,
              nameFields.includes(field) ? 100 : field.endsWith('Phone') ? 40 : 200,
              ['firstName', 'lastName'].includes(field),
            );
    }
  }
  return result;
}
function personalValue(row: Record<string, any>, field: string) {
  return contactFields.includes(field) ? (JSON.parse(row.contactInfo || '{}')[field] ?? '') : (row[field] ?? null);
}
async function links(ctx: Context, personId: string) {
  return (
    await all(
      ctx,
      'SELECT userId FROM user_churches WHERE churchId=? AND personId=? ORDER BY userId',
      ctx.principal.churchId,
      personId,
    )
  ).map((row) => row.userId);
}
function linkCheck(ctx: Context, personId: string, users: string[]): Check {
  return {
    sql: `NOT EXISTS(SELECT 1 FROM user_churches uc WHERE uc.churchId=? AND uc.personId=? AND uc.userId NOT IN(SELECT value FROM json_each(?)))
    AND (SELECT count(*) FROM user_churches uc WHERE uc.churchId=? AND uc.personId=?)=?`,
    values: [ctx.principal.churchId, personId, JSON.stringify(users), ctx.principal.churchId, personId, users.length],
  };
}
function targetCheck(ctx: Context, row: Record<string, any>, snapshot: Record<string, any>): Check {
  const entries = Object.entries(snapshot.fields || {});
  return {
    sql: `EXISTS(SELECT 1 FROM people target WHERE target.churchId=? AND target.id=? AND target.removed=0
    AND target.householdId IS ? AND target.householdRole IS ?${entries
      .map(([field]) =>
        contactFields.includes(field)
          ? ` AND COALESCE(json_extract(target.contactInfo,'$.${field}'),'') IS ?`
          : ` AND target.${field} IS ?`,
      )
      .join('')})`,
    values: [
      ctx.principal.churchId,
      row.targetPersonId,
      snapshot.householdId,
      snapshot.householdRole,
      ...entries.map(([, value]) => value as string | null),
    ],
  };
}
function policyCheck(ctx: Context, settings: string): Check {
  return {
    sql: 'EXISTS(SELECT 1 FROM churches WHERE id=? AND settings=?)',
    values: [ctx.principal.churchId, settings],
  };
}
async function currentPolicy(ctx: Context) {
  const church = await first(ctx, 'SELECT settings FROM churches WHERE id=?', ctx.principal.churchId);
  if (!church) throw new HttpError(404, 'Church not found');
  return { settings: church.settings as string, groupId: approvalGroup(church.settings) };
}
/** Review-group membership supplies routing context, never People Edit authority. */
function reviewerCheck(ctx: Context, groupId: string | null): Check {
  const globalGrant = (
    api: string,
    content: string,
  ) => `EXISTS(SELECT 1 FROM role_members rm JOIN role_permissions rp ON rp.churchId=rm.churchId AND rp.roleId=rm.roleId
    WHERE rm.churchId=uc.churchId AND rm.userId=uc.userId AND rp.apiName='${api}' AND rp.contentType='${content}' AND rp.contentId='' AND rp.action='Edit')`;
  return {
    sql: `EXISTS(SELECT 1 FROM user_churches uc WHERE uc.churchId=? AND uc.userId=? AND uc.personId=?
    AND (uc.role='admin' OR ${globalGrant('MembershipApi', 'People')})
    ${groupId ? `AND (uc.role='admin' OR ${globalGrant('DoingApi', 'Tasks')} OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.churchId=uc.churchId AND gm.personId=uc.personId AND gm.groupId=?))` : ''})`,
    values: [ctx.principal.churchId, ctx.principal.userId, ctx.principal.personId, ...(groupId ? [groupId] : [])],
  };
}
async function canReview(ctx: Context, groupId: string | null) {
  const check = reviewerCheck(ctx, groupId);
  return !!(await first(ctx, `SELECT 1 ok WHERE ${check.sql}`, ...check.values));
}
function display(first: string, last: string, nick?: string) {
  return [nick || first, last].filter(Boolean).join(' ');
}
function dto(row: Record<string, any>, review: boolean) {
  const proposed = JSON.parse(row.changes);
  return {
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    status: row.status,
    target: {
      id: row.targetPersonId || row.resultPersonId || null,
      name: {
        display:
          row.kind === 'family-add'
            ? display(proposed.first, proposed.last)
            : display(row.targetFirst, row.targetLast, row.targetNick),
      },
    },
    requester: {
      id: row.requesterPersonId,
      name: { display: display(row.requesterFirst, row.requesterLast, row.requesterNick) },
    },
    changes: proposed,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    reason: row.reason,
    canReview: review && row.status === 'pending',
  };
}
async function load(ctx: Context, requestId: string, task = false) {
  const row = await first(
    ctx,
    `${selection} WHERE r.churchId=? AND r.${task ? 'taskId' : 'id'}=?`,
    ctx.principal.churchId,
    requestId,
  );
  if (!row) throw new HttpError(404, 'Profile request not found');
  return row;
}
async function transaction(ctx: Context, statements: D1PreparedStatement[]) {
  try {
    return await ctx.env.DB.batch(statements);
  } catch (error) {
    if (/constraint failed/i.test(String(error)))
      throw new HttpError(409, 'Request, person, household, policy or permission changed; refresh before continuing');
    throw error;
  }
}
function audit(ctx: Context, action: string, requestId: string) {
  return ctx.env.DB.prepare(
    'INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) VALUES(?,?,?,?,?,?)',
  ).bind(id(), ctx.principal.churchId, ctx.principal.userId, action, requestId, now());
}

async function create(ctx: Context) {
  const input = object(await body(ctx.request), ['kind', 'personId', 'changes']);
  if (!['profile', 'family-add', 'family-edit'].includes(input.kind))
    throw new HttpError(400, 'Invalid profile request kind');
  const actor = await self(ctx),
    groupId = approvalGroup(actor.churchSettings),
    cid = ctx.principal.churchId;
  if (input.kind !== 'family-edit' && !groupId)
    throw new HttpError(409, 'This change can be saved directly without a review request');
  if (input.kind !== 'profile' && !actor.householdId)
    throw new HttpError(409, 'Ask church staff to link your household first');
  if (input.kind !== 'family-edit' && input.personId !== undefined)
    throw new HttpError(400, 'The server chooses the target person');
  const targetId =
    input.kind === 'profile'
      ? actor.id
      : input.kind === 'family-edit'
        ? requiredString(input.personId, 'personId', 128)
        : null;
  if (input.kind === 'family-edit' && targetId === actor.id) throw new HttpError(400, 'Use your own profile form');
  const target = targetId
    ? await first(ctx, 'SELECT * FROM people WHERE churchId=? AND id=? AND removed=0', cid, targetId)
    : null;
  if (targetId && (!target || (input.kind === 'family-edit' && target.householdId !== actor.householdId)))
    throw new HttpError(404, 'Household member not found');
  const proposed = changes(input.changes, input.kind, actor);
  // Only self values are already visible to this caller. Rejecting an unchanged
  // relative's value would turn this endpoint into a private-field guessing oracle.
  if (
    input.kind === 'profile' &&
    target &&
    Object.entries(proposed).every(([field, value]) => personalValue(target, field) === value)
  )
    throw new HttpError(400, 'The proposed fields are unchanged');
  const targetKey = targetId || 'new';
  const existing = await first(
    ctx,
    `${selection} WHERE r.churchId=? AND r.requesterUserId=? AND r.kind=? AND r.targetKey=? AND r.status='pending'`,
    cid,
    ctx.principal.userId,
    input.kind,
    targetKey,
  );
  if (existing) {
    if (
      existing.changes === JSON.stringify(proposed) &&
      existing.requesterPersonId === actor.id &&
      existing.requesterHouseholdId === actor.householdId
    )
      return json(dto(existing, await canReview(ctx, groupId)));
    throw new HttpError(409, 'A pending request already exists for this person; cancel it before submitting another');
  }
  let assignedPersonId: string | null = null;
  const checks: Check[] = [writeGuard(ctx, actor)];
  if (groupId) {
    const group = await first(ctx, 'SELECT id FROM groups WHERE churchId=? AND id=? AND archived=0', cid, groupId);
    if (!group)
      throw new HttpError(409, 'The directory review group is unavailable; ask church staff to fix the setting');
    checks.push({
      sql: 'EXISTS(SELECT 1 FROM groups WHERE churchId=? AND id=? AND archived=0)',
      values: [cid, groupId],
    });
  } else {
    const admin = await first(
      ctx,
      `SELECT uc.personId FROM user_churches uc JOIN users u ON u.id=uc.userId JOIN people p ON p.churchId=uc.churchId AND p.id=uc.personId
      WHERE uc.churchId=? AND uc.role='admin' AND u.disabled=0 AND u.passwordState='active' AND p.removed=0 ORDER BY uc.personId LIMIT 1`,
      cid,
    );
    if (!admin) throw new HttpError(409, 'No active administrator is available to review family changes');
    assignedPersonId = admin.personId;
    checks.push({
      sql: `EXISTS(SELECT 1 FROM user_churches uc JOIN users u ON u.id=uc.userId JOIN people p ON p.churchId=uc.churchId AND p.id=uc.personId
      WHERE uc.churchId=? AND uc.personId=? AND uc.role='admin' AND u.disabled=0 AND u.passwordState='active' AND p.removed=0)`,
      values: [cid, assignedPersonId],
    });
  }
  const snapshot = target
    ? {
        householdId: target.householdId,
        householdRole: target.householdRole,
        fields: Object.fromEntries(Object.keys(proposed).map((field) => [field, personalValue(target, field)])),
        links: await links(ctx, target.id),
      }
    : {};
  if (target)
    checks.push(targetCheck(ctx, { targetPersonId: target.id }, snapshot), linkCheck(ctx, target.id, snapshot.links!));
  else
    checks.push({
      sql: '(SELECT count(*) FROM people WHERE churchId=? AND householdId=? AND removed=0)<100',
      values: [cid, actor.householdId],
    });
  const requestId = id(),
    taskId = id(),
    stamp = now();
  try {
    await transaction(ctx, [
      ...doingWriteGuard(ctx, { checks }),
      ctx.env.DB.prepare(
        `INSERT INTO tasks(id,churchId,taskNumber,title,status,dateCreated,createdById,assignedPersonId,assignedGroupId,associatedPersonId,taskType)
      VALUES(?,?,(SELECT COALESCE(MAX(taskNumber),0)+1 FROM tasks WHERE churchId=?),'Directory change request','Open',?,?,?,?,?,'directoryUpdate')`,
      ).bind(taskId, cid, cid, stamp, actor.id, assignedPersonId, groupId, actor.id),
      ctx.env.DB.prepare(
        `INSERT INTO member_change_requests(id,churchId,taskId,kind,requesterUserId,requesterPersonId,requesterHouseholdId,targetPersonId,targetKey,reviewGroupId,changes,snapshot,createdAt)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        requestId,
        cid,
        taskId,
        input.kind,
        ctx.principal.userId,
        actor.id,
        actor.householdId,
        targetId,
        targetKey,
        groupId,
        JSON.stringify(proposed),
        JSON.stringify(snapshot),
        stamp,
      ),
      audit(ctx, 'member.profileRequest.create', requestId),
    ]);
  } catch (error) {
    const pending = await first(
      ctx,
      `${selection} WHERE r.churchId=? AND r.requesterUserId=? AND r.kind=? AND r.targetKey=? AND r.status='pending'`,
      cid,
      ctx.principal.userId,
      input.kind,
      targetKey,
    );
    if (
      !pending ||
      pending.changes !== JSON.stringify(proposed) ||
      pending.requesterPersonId !== actor.id ||
      pending.requesterHouseholdId !== actor.householdId
    )
      throw error;
    // A duplicate request may have won while this batch queued. Revalidate the
    // caller before returning it so idempotency cannot bypass session revocation.
    await transaction(ctx, doingWriteGuard(ctx, { checks }));
    return json(dto(pending, await canReview(ctx, groupId)));
  }
  return json(dto(await load(ctx, requestId), await canReview(ctx, groupId)), 201);
}

async function decide(ctx: Context, requestId: string, action: string) {
  const row = await load(ctx, requestId),
    policy = await currentPolicy(ctx);
  const cancel = action === 'cancel',
    review = await canReview(ctx, policy.groupId);
  if (
    cancel ? row.requesterUserId !== ctx.principal.userId || row.requesterPersonId !== ctx.principal.personId : !review
  )
    throw new HttpError(403, 'Profile request permission required');
  const input = cancel ? {} : object(await body(ctx.request), action === 'decline' ? ['reason'] : []);
  const reason = action === 'decline' && input.reason !== undefined ? clean(input.reason, 'reason', 500) : null;
  const status = action === 'approve' ? 'approved' : action === 'decline' ? 'declined' : 'cancelled';
  if (row.status !== 'pending') {
    if (row.status === status) return json(dto(row, review));
    throw new HttpError(409, 'This request has already been decided');
  }
  const checks: Check[] = [
    policyCheck(ctx, policy.settings),
    {
      sql: "EXISTS(SELECT 1 FROM member_change_requests WHERE churchId=? AND id=? AND status='pending' AND changes=? AND snapshot=?)",
      values: [ctx.principal.churchId, row.id, row.changes, row.snapshot],
    },
    {
      sql: "EXISTS(SELECT 1 FROM tasks WHERE churchId=? AND id=? AND taskType='directoryUpdate' AND status='Open')",
      values: [ctx.principal.churchId, row.taskId],
    },
  ];
  if (!cancel) checks.push(reviewerCheck(ctx, policy.groupId));
  if (cancel)
    checks.push({
      sql: 'EXISTS(SELECT 1 FROM member_change_requests WHERE churchId=? AND id=? AND requesterUserId=? AND requesterPersonId=?)',
      values: [ctx.principal.churchId, row.id, ctx.principal.userId, ctx.principal.personId],
    });
  const statements: D1PreparedStatement[] = [],
    proposed = JSON.parse(row.changes),
    snapshot = JSON.parse(row.snapshot);
  let resultPersonId: string | null = null;
  if (action === 'approve') {
    if (policy.groupId !== row.reviewGroupId)
      throw new HttpError(409, 'The review policy changed; cancel or decline this request and submit it again');
    if (policy.groupId)
      checks.push({
        sql: 'EXISTS(SELECT 1 FROM groups WHERE churchId=? AND id=? AND archived=0)',
        values: [ctx.principal.churchId, policy.groupId],
      });
    checks.push({
      sql: `EXISTS(SELECT 1 FROM people p JOIN user_churches uc ON uc.churchId=p.churchId AND uc.personId=p.id JOIN users u ON u.id=uc.userId
      WHERE p.churchId=? AND p.id=? AND p.removed=0 AND p.householdId IS ? AND uc.userId=? AND u.disabled=0 AND u.passwordState='active')`,
      values: [ctx.principal.churchId, row.requesterPersonId, row.requesterHouseholdId, row.requesterUserId],
    });
    if (row.kind === 'family-add') {
      resultPersonId = id();
      checks.push({
        sql: 'EXISTS(SELECT 1 FROM households WHERE churchId=? AND id=?) AND (SELECT count(*) FROM people WHERE churchId=? AND householdId=? AND removed=0)<100',
        values: [ctx.principal.churchId, row.requesterHouseholdId, ctx.principal.churchId, row.requesterHouseholdId],
      });
      statements.push(
        ctx.env.DB.prepare(
          `INSERT INTO people(id,churchId,firstName,lastName,contactInfo,householdId,householdRole,dateAdded) VALUES(?,?,?,?,?,?,?,?)`,
        ).bind(
          resultPersonId,
          ctx.principal.churchId,
          proposed.first,
          proposed.last,
          JSON.stringify(proposed.mobilePhone === undefined ? {} : { mobilePhone: proposed.mobilePhone }),
          row.requesterHouseholdId,
          proposed.householdRole,
          now(),
        ),
      );
    } else {
      checks.push(targetCheck(ctx, row, snapshot), linkCheck(ctx, row.targetPersonId, snapshot.links));
      const columns: string[] = [],
        values: (string | number | null)[] = [],
        contacts: Record<string, string> = {};
      for (const [field, value] of Object.entries(proposed)) {
        if (contactFields.includes(field)) contacts[field] = value as string;
        else {
          columns.push(`${field}=?`);
          values.push(value as string | null);
        }
      }
      if (Object.keys(contacts).length) {
        columns.push('contactInfo=json_patch(contactInfo,?)');
        values.push(JSON.stringify(contacts));
      }
      statements.push(
        ctx.env.DB.prepare(`UPDATE people SET ${columns.join(',')} WHERE churchId=? AND id=?`).bind(
          ...values,
          ctx.principal.churchId,
          row.targetPersonId,
        ),
      );
    }
  }
  try {
    await transaction(ctx, [
      ...doingWriteGuard(ctx, { checks }),
      ...statements,
      ctx.env.DB.prepare(
        "UPDATE member_change_requests SET status=?,decidedAt=?,decidedBy=?,reason=?,resultPersonId=? WHERE churchId=? AND id=? AND status='pending'",
      ).bind(status, now(), ctx.principal.personId, reason, resultPersonId, ctx.principal.churchId, row.id),
      ctx.env.DB.prepare(
        "UPDATE tasks SET status='Closed',dateClosed=? WHERE churchId=? AND id=? AND taskType='directoryUpdate'",
      ).bind(now(), ctx.principal.churchId, row.taskId),
      audit(ctx, `member.profileRequest.${action}`, row.id),
    ]);
  } catch (error) {
    // A simultaneous identical decision is a successful replay, never a second application.
    const latest = await load(ctx, requestId);
    if (latest.status !== status) throw error;
    await transaction(
      ctx,
      doingWriteGuard(ctx, {
        checks: [policyCheck(ctx, policy.settings), ...(!cancel ? [reviewerCheck(ctx, policy.groupId)] : [])],
      }),
    );
  }
  return json(dto(await load(ctx, requestId), review));
}

export async function memberApprovals(ctx: Context): Promise<Response | undefined> {
  if (ctx.path !== base && !ctx.path.startsWith(base + '/')) return undefined;
  const suffix = ctx.path.slice(base.length),
    method = ctx.request.method;
  if (method === 'POST' && suffix === '') return create(ctx);
  const policy = await currentPolicy(ctx),
    review = await canReview(ctx, policy.groupId);
  if (method === 'GET' && ['/my', '/review'].includes(suffix)) {
    const options = memberPageOptions(ctx),
      reviewing = suffix === '/review';
    if (reviewing && !review) return memberPageResult([], options);
    const rows = await all(
      ctx,
      `${selection} WHERE r.churchId=? ${reviewing ? "AND r.status='pending'" : 'AND r.requesterUserId=? AND r.requesterPersonId=?'}
      ORDER BY r.createdAt ${reviewing ? 'ASC' : 'DESC'},r.id LIMIT ? OFFSET ?`,
      ctx.principal.churchId,
      ...(reviewing ? [] : [ctx.principal.userId, ctx.principal.personId]),
      options.limit + 1,
      options.offset,
    );
    return memberPageResult(
      rows.map((row) => dto(row, review)),
      options,
    );
  }
  const detail = /^\/(?:task\/)?([^/]+)$/.exec(suffix);
  if (method === 'GET' && detail) {
    const row = await load(ctx, detail[1], suffix.startsWith('/task/'));
    if (!review && (row.requesterUserId !== ctx.principal.userId || row.requesterPersonId !== ctx.principal.personId))
      throw new HttpError(403, 'Profile request access required');
    return json(dto(row, review));
  }
  const decision = /^\/([^/]+)\/(approve|decline)$/.exec(suffix);
  if (method === 'POST' && decision) return decide(ctx, decision[1], decision[2]);
  if (method === 'DELETE' && detail && !suffix.startsWith('/task/')) return decide(ctx, detail[1], 'cancel');
  throw new HttpError(405, 'Unsupported profile request action');
}
