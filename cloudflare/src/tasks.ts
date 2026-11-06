import type { Context } from './types';
import {
  doingAllowed,
  doingScopes,
  doingScopeSql,
  doingSnapshot,
  doingWriteGuard,
  requireDoing,
} from './doing-permissions';
import { all, first, json, body, records, requiredString, HttpError, id, now } from './http';
const projection = `SELECT t.*, cp.firstName||' '||cp.lastName createdByLabel,
 COALESCE(ap.firstName||' '||ap.lastName,ag.name) assignedToLabel,
 COALESCE(sp.firstName||' '||sp.lastName,sg.name) associatedWithLabel
 FROM tasks t JOIN people cp ON cp.churchId=t.churchId AND cp.id=t.createdById
 LEFT JOIN people ap ON ap.churchId=t.churchId AND ap.id=t.assignedPersonId
 LEFT JOIN groups ag ON ag.churchId=t.churchId AND ag.id=t.assignedGroupId
 LEFT JOIN people sp ON sp.churchId=t.churchId AND sp.id=t.associatedPersonId
 LEFT JOIN groups sg ON sg.churchId=t.churchId AND sg.id=t.associatedGroupId`;
function dto(row: any) {
  const { assignedPersonId, assignedGroupId, associatedPersonId, associatedGroupId, ...data } = row;
  return {
    ...data,
    createdByType: 'person',
    assignedToType: assignedPersonId ? 'person' : 'group',
    assignedToId: assignedPersonId || assignedGroupId,
    associatedWithType: associatedPersonId ? 'person' : associatedGroupId ? 'group' : null,
    associatedWithId: associatedPersonId || associatedGroupId || null,
  };
}
async function access(ctx: Context, taskId: string) {
  const row = await first(ctx, projection + ' WHERE t.churchId=? AND t.id=?', ctx.principal.churchId, taskId);
  if (!row) throw new HttpError(404, 'Task not found');
  if (
    !doingAllowed(ctx, 'Tasks', 'View', row.assignedGroupId) &&
    row.createdById !== ctx.principal.personId &&
    row.assignedPersonId !== ctx.principal.personId &&
    row.associatedPersonId !== ctx.principal.personId &&
    !(await first(
      ctx,
      'SELECT id FROM group_members WHERE churchId=? AND groupId=? AND personId=?',
      ctx.principal.churchId,
      row.assignedGroupId || '',
      ctx.principal.personId,
    ))
  )
    throw new HttpError(403, 'Task access required');
  return row;
}
async function relation(
  ctx: Context,
  type: any,
  entity: any,
  optional = false,
): Promise<[string | null, string | null]> {
  if (optional && !entity) return [null, null];
  if (type !== 'person' && type !== 'group') throw new HttpError(400, 'Invalid task relation');
  const value = requiredString(entity, 'task relation');
  const target = await first(
    ctx,
    `SELECT id FROM ${type === 'person' ? 'people' : 'groups'} WHERE churchId=? AND id=? ${type === 'person' ? 'AND removed=0' : ''}`,
    ctx.principal.churchId,
    value,
  );
  if (!target) throw new HttpError(400, 'Unknown task relation');
  return type === 'person' ? [value, null] : [null, value];
}
function dueDate(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)
  )
    throw new HttpError(400, 'dueDate must be an ISO date or timestamp with an explicit offset');
  const day = value.slice(0, 10);
  if (!Number.isFinite(Date.parse(value)) || new Date(day).toISOString().slice(0, 10) !== day)
    throw new HttpError(400, 'Invalid dueDate');
  return new Date(value).toISOString();
}
function queryIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((v) => typeof v !== 'string' || !v || v.length > 100))
    throw new HttpError(400, 'Expected up to 100 IDs');
  return [...new Set(value)];
}
export async function tasks(ctx: Context): Promise<Response | undefined> {
  const path = ctx.path.toLowerCase(),
    method = ctx.request.method,
    cid = ctx.principal.churchId,
    pid = ctx.principal.personId;
  if (!path.startsWith('/doing/tasks')) return undefined;
  if (path === '/doing/tasks/timeline' && method === 'GET') {
    const value = ctx.url.searchParams.get('taskIds');
    const ids = queryIds(value ? value.split(',') : []);
    const staff = doingAllowed(ctx, 'Tasks', 'View');
    const scope = doingScopeSql(ctx, 'Tasks', 't.assignedGroupId');
    const accessSql = `(t.createdById=? OR t.assignedPersonId=? OR t.associatedPersonId=? OR t.assignedGroupId IN (SELECT groupId FROM group_members WHERE churchId=? AND personId=?) OR ${scope.sql})`;
    const rows = await all(
      ctx,
      projection +
        ` WHERE t.churchId=?
      AND ((t.status='Open' AND (t.createdById=? OR t.assignedPersonId=? OR t.associatedPersonId=?)) OR t.id IN (SELECT value FROM json_each(?)))
      ${staff ? '' : 'AND ' + accessSql} ORDER BY t.taskNumber,t.id`,
      cid,
      pid,
      pid,
      pid,
      JSON.stringify(ids),
      ...(staff ? [] : [pid, pid, pid, cid, pid, ...scope.values]),
    );
    return json(rows.map((row) => ({ ...dto(row), postType: 'task', postId: row.id })));
  }
  if (['/doing/tasks', '/doing/tasks/closed'].includes(path) && method === 'GET')
    return json(
      (
        await all(
          ctx,
          projection +
            ' WHERE t.churchId=? AND t.status=? AND (t.createdById=? OR t.assignedPersonId=? OR t.assignedGroupId IN (SELECT value FROM json_each(?))) ORDER BY t.taskNumber,t.id',
          cid,
          path.endsWith('/closed') ? 'Closed' : 'Open',
          pid,
          pid,
          JSON.stringify(doingScopes(ctx, 'Tasks', 'View')),
        )
      ).map(dto),
    );
  if (path === '/doing/tasks/loadforgroups' && method === 'POST') {
    const input = await body(ctx.request);
    if (!['Open', 'Closed'].includes(input.status)) throw new HttpError(400, 'Invalid group task query');
    const ids = queryIds(input.groupIds);
    if (!ids.length) return json([]);
    const scope = doingScopeSql(ctx, 'Tasks', 't.assignedGroupId');
    const own = ` AND (${scope.sql} OR t.assignedGroupId IN (SELECT groupId FROM group_members WHERE churchId=? AND personId=?))`;
    return json(
      (
        await all(
          ctx,
          projection +
            ` WHERE t.churchId=? AND t.status=? AND t.assignedGroupId IN (SELECT value FROM json_each(?))${own} ORDER BY t.taskNumber,t.id`,
          cid,
          input.status,
          JSON.stringify(ids),
          ...scope.values,
          cid,
          pid,
        )
      ).map(dto),
    );
  }
  if (path === '/doing/tasks' && method === 'POST') {
    if (ctx.url.searchParams.has('type')) throw new HttpError(501, 'Self-service workflow tasks are not ported');
    const input = await records(ctx.request),
      statements: D1PreparedStatement[] = [],
      ids: string[] = [];
    for (const item of input) {
      if (item.churchId && item.churchId !== cid) throw new HttpError(403, 'Church mismatch');
      if (
        item.workflowId ||
        item.stepId ||
        item.assignmentId ||
        item.followupKey ||
        item.conversationId ||
        item.automationId ||
        item.taskType ||
        item.memberRequestId ||
        item.profileRequestId
      )
        throw new HttpError(400, 'Only standalone manual tasks are supported');
      const taskId = item.id ? requiredString(item.id, 'id') : id();
      if (ids.includes(taskId)) throw new HttpError(400, 'Duplicate task ID in request');
      const exists = await first(ctx, 'SELECT churchId FROM tasks WHERE id=?', taskId);
      if (exists && exists.churchId !== cid) throw new HttpError(404, 'Task not found');
      const existingRow = exists ? await access(ctx, taskId) : null;
      if (existingRow?.taskType === 'directoryUpdate')
        throw new HttpError(409, 'Directory change tasks must be decided through the profile review actions');
      const existing = existingRow ? dto(existingRow) : null;
      const row = { ...existing, ...item };
      const title = requiredString(row.title, 'title', 500);
      const status = row.status || 'Open';
      if (!['Open', 'Closed'].includes(status)) throw new HttpError(400, 'Invalid task status');
      const [assignedPersonId, assignedGroupId] = await relation(ctx, row.assignedToType, row.assignedToId);
      requireDoing(ctx, 'Tasks', 'Edit', assignedGroupId);
      if (existingRow) requireDoing(ctx, 'Tasks', 'Edit', existingRow.assignedGroupId);
      const [associatedPersonId, associatedGroupId] = await relation(
        ctx,
        row.associatedWithType,
        row.associatedWithId,
        true,
      );
      const deadline = dueDate(row.dueDate);
      statements.push(
        ...doingWriteGuard(ctx, {
          grants: [
            { content: 'Tasks', scope: assignedGroupId },
            ...(existingRow ? [{ content: 'Tasks' as const, scope: existingRow.assignedGroupId }] : []),
          ],
          snapshots: [existingRow ? doingSnapshot('tasks', existingRow) : { table: 'tasks', id: taskId, absent: true }],
          checks: [
            ...(existingRow
              ? [
                  {
                    sql: 'EXISTS(SELECT 1 FROM tasks WHERE churchId=? AND id=? AND taskType IS NULL)',
                    values: [cid, taskId],
                  },
                ]
              : []),
            ...[assignedPersonId, associatedPersonId].filter(Boolean).map((personId) => ({
              sql: 'EXISTS(SELECT 1 FROM people WHERE churchId=? AND id=? AND removed=0)',
              values: [cid, personId!],
            })),
            ...[assignedGroupId, associatedGroupId].filter(Boolean).map((groupId) => ({
              sql: 'EXISTS(SELECT 1 FROM groups WHERE churchId=? AND id=?)',
              values: [cid, groupId!],
            })),
          ],
        }),
        ctx.env.DB.prepare(
          `INSERT INTO tasks(id,churchId,taskNumber,title,status,dateCreated,dateClosed,dueDate,createdById,assignedPersonId,assignedGroupId,associatedPersonId,associatedGroupId) VALUES(?,?,(SELECT COALESCE(MAX(taskNumber),0)+1 FROM tasks WHERE churchId=?),?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,status=excluded.status,dateClosed=excluded.dateClosed,dueDate=excluded.dueDate,assignedPersonId=excluded.assignedPersonId,assignedGroupId=excluded.assignedGroupId,associatedPersonId=excluded.associatedPersonId,associatedGroupId=excluded.associatedGroupId WHERE tasks.churchId=excluded.churchId`,
        ).bind(
          taskId,
          cid,
          cid,
          title,
          status,
          existing?.dateCreated || now(),
          status === 'Closed' ? existing?.dateClosed || now() : null,
          deadline,
          existing?.createdById || pid,
          assignedPersonId,
          assignedGroupId,
          associatedPersonId,
          associatedGroupId,
        ),
      );
      statements.push(
        ctx.env.DB.prepare(
          'INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) VALUES(?,?,?,?,?,?)',
        ).bind(id(), cid, ctx.principal.userId, 'tasks.save', taskId, now()),
      );
      ids.push(taskId);
    }
    await ctx.env.DB.batch(statements);
    const result = [];
    for (const taskId of ids) result.push(dto(await access(ctx, taskId)));
    return json(result);
  }
  if (/^\/doing\/tasks\/[^/]+$/.test(path) && method === 'GET')
    return json(dto(await access(ctx, ctx.path.split('/').pop()!)));
  if (/^\/doing\/tasks\/[^/]+$/.test(path) && method === 'DELETE') {
    const row = await access(ctx, ctx.path.split('/').pop()!);
    if (row.taskType === 'directoryUpdate') throw new HttpError(409, 'Directory change tasks cannot be deleted');
  }
  return undefined;
}
