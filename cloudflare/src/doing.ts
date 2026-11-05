import type { Context } from './types';
import { allowed } from './permissions';
import { churchTimeZone, localDay, shiftServiceTime, validTimeZone } from './plan-time';
import { all, first, body, records, requiredString, requireAdmin, HttpError, id, now, json } from './http';
type Row = Record<string, any>;
const tables: Record<string, string> = {
  plans: 'doing_plans',
  plantypes: 'doing_plan_types',
  positions: 'doing_positions',
  times: 'doing_times',
  assignments: 'doing_assignments',
  planitems: 'doing_plan_items',
  planitemtimes: 'doing_plan_item_times',
  blockoutdates: 'doing_blockout_dates',
  schedulingpreferences: 'doing_scheduling_preferences',
};
const booleans = [
  'serviceOrder',
  'showVolunteerNames',
  'prepared',
  'autoReplaceOnDecline',
  'allowSelfSignup',
  'excluded',
];
function model(row: Row): Row {
  const result = { ...row };
  delete result.selfSignup;
  for (const key of booleans) if (key in result) result[key] = Boolean(result[key]);
  return result;
}
function optionalId(value: unknown): string | null {
  return value == null || value === '' ? null : requiredString(value, 'reference ID', 100);
}
function text(value: unknown, max = 2000): string {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, 'Invalid text');
  return value;
}
function integer(value: unknown, min = 0, max = 100): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new HttpError(400, 'Invalid number');
  return value;
}
function instant(value: unknown): string {
  const input = requiredString(value, 'date', 50);
  day(input);
  if (
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input) ||
    !Number.isFinite(Date.parse(input))
  )
    throw new HttpError(400, 'Service times must include a UTC Z or numeric offset');
  return new Date(input).toISOString();
}
function day(value: unknown): string {
  const full = requiredString(value, 'date', 50);
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(full) ||
    !Number.isFinite(Date.parse(full))
  )
    throw new HttpError(400, 'Invalid date');
  const input = full.slice(0, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input) ||
    !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString().slice(0, 10) !== input
  )
    throw new HttpError(400, 'Invalid date');
  return input;
}
function safeLink(value: unknown): string | null {
  if (!value) return null;
  const input = text(value, 2048);
  if (input.startsWith('/') && !input.startsWith('//')) return input;
  try {
    if (new URL(input).protocol === 'https:') return input;
  } catch {}
  throw new HttpError(400, 'Links must be HTTPS or installation-relative');
}
function audit(ctx: Context, action: string, entityId: string): D1PreparedStatement {
  return ctx.env.DB.prepare(
    'INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) VALUES(?,?,?,?,?,?)',
  ).bind(id(), ctx.principal.churchId, ctx.principal.userId, action, entityId, now());
}
async function batch(ctx: Context, statements: D1PreparedStatement[]) {
  try {
    return await ctx.env.DB.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/Signup is closed|Position is full|Service order cycle|Plan item time mismatch|Inactive assignee/.test(message))
      throw new HttpError(409, 'Scheduling conflicts with existing records or signup availability');
    throw error;
  }
}
async function load(ctx: Context, resource: string, recordId: string): Promise<Row> {
  const row = await first(
    ctx,
    `SELECT * FROM ${tables[resource]} WHERE churchId=? AND id=?`,
    ctx.principal.churchId,
    recordId,
  );
  if (!row) throw new HttpError(404, 'Record not found');
  return row;
}
function statement(ctx: Context, resource: string, row: Row, existing: boolean): D1PreparedStatement {
  const columns = Object.keys(row).filter((k) => !['id', 'churchId'].includes(k));
  return existing
    ? ctx.env.DB.prepare(
        `UPDATE ${tables[resource]} SET ${columns.map((k) => `${k}=?`).join(',')} WHERE churchId=? AND id=?`,
      ).bind(...columns.map((k) => row[k]), row.churchId, row.id)
    : ctx.env.DB.prepare(
        `INSERT INTO ${tables[resource]}(id,churchId,${columns.join(',')}) VALUES(${Array(columns.length + 2)
          .fill('?')
          .join(',')})`,
      ).bind(row.id, row.churchId, ...columns.map((k) => row[k]));
}
async function visiblePlan(ctx: Context, planId: string): Promise<Row> {
  const plan = await load(ctx, 'plans', planId);
  if (!allowed(ctx, 'DoingApi', 'Plans', 'View') && !allowed(ctx, 'DoingApi', 'Plans', 'Edit')) {
    if (plan.prepared) throw new HttpError(403, 'Plan access denied');
    const assigned = await first(
      ctx,
      'SELECT a.id FROM doing_assignments a JOIN doing_positions p ON p.churchId=a.churchId AND p.id=a.positionId WHERE a.churchId=? AND a.personId=? AND p.planId=?',
      ctx.principal.churchId,
      ctx.principal.personId,
      planId,
    );
    const today = localDay(Date.now(), await churchTimeZone(ctx));
    const associated = plan.planTypeId
      ? await first(
          ctx,
          `WITH RECURSIVE ancestors(id,parentId) AS (
             SELECT g.id,g.parentId FROM groups g JOIN group_members gm ON gm.churchId=g.churchId AND gm.groupId=g.id WHERE g.churchId=? AND gm.personId=?
             UNION SELECT g.id,g.parentId FROM groups g JOIN ancestors a ON g.id=a.parentId WHERE g.churchId=?
           ) SELECT ag.id FROM associated_groups ag JOIN ancestors a ON a.id=ag.groupId
           WHERE ag.churchId=? AND ag.contentType='planType' AND ag.contentId=?
           AND (ag.settings='both' OR ag.settings='past' AND ?<=? OR ag.settings='future' AND ?>=?) LIMIT 1`,
          ctx.principal.churchId,
          ctx.principal.personId,
          ctx.principal.churchId,
          ctx.principal.churchId,
          plan.planTypeId,
          plan.serviceDate,
          today,
          plan.serviceDate,
          today,
        )
      : null;
    if (!assigned && !associated) throw new HttpError(403, 'Plan access denied');
  }
  return plan;
}
/** The original group-page plan list. Parent links share published plans downward;
 * they do not confer membership, staff access, or visibility of siblings' plans. */
export async function groupPlans(ctx: Context, groupId: string): Promise<Response> {
  const cid = ctx.principal.churchId;
  if (!(await first(ctx, 'SELECT id FROM groups WHERE churchId=? AND id=?', cid, groupId)))
    throw new HttpError(404, 'Group not found');
  const staff =
    allowed(ctx, 'DoingApi', 'Plans', 'View') ||
    allowed(ctx, 'DoingApi', 'Plans', 'Edit') ||
    allowed(ctx, 'MembershipApi', 'Groups', 'Edit');
  if (
    !staff &&
    !(await first(
      ctx,
      'SELECT id FROM group_members WHERE churchId=? AND groupId=? AND personId=?',
      cid,
      groupId,
      ctx.principal.personId,
    ))
  )
    throw new HttpError(403, 'Group membership required');
  const today = localDay(Date.now(), await churchTimeZone(ctx));
  return json(
    (
      await all(
        ctx,
        `WITH RECURSIVE ancestors(id,parentId) AS (
    SELECT id,parentId FROM groups WHERE churchId=? AND id=?
    UNION SELECT g.id,g.parentId FROM groups g JOIN ancestors a ON g.id=a.parentId WHERE g.churchId=?
  ) SELECT DISTINCT pl.* FROM doing_plans pl JOIN associated_groups ag ON ag.churchId=pl.churchId AND ag.contentId=pl.planTypeId AND ag.contentType='planType'
  JOIN ancestors a ON a.id=ag.groupId WHERE pl.churchId=? AND pl.prepared=0
  AND (ag.settings='both' OR ag.settings='past' AND pl.serviceDate<=? OR ag.settings='future' AND pl.serviceDate>=?)
  ORDER BY pl.serviceDate DESC,pl.id`,
        cid,
        groupId,
        cid,
        cid,
        today,
        today,
      )
    ).map(model),
  );
}
function listIds(value: unknown): string[] {
  if (typeof value !== 'string' || value.length > 10000) throw new HttpError(400, 'IDs required');
  const ids = value.split(',').filter(Boolean);
  if (!ids.length || ids.length > 100) throw new HttpError(400, 'Expected 1 to 100 IDs');
  return ids;
}
function tree(rows: Row[], parentId: string | null = null, seen = new Set<string>()): Row[] {
  return rows
    .filter((r) => (r.parentId || null) === parentId)
    .map((r) => {
      if (seen.has(r.id)) throw new HttpError(409, 'Service order cycle');
      const next = new Set(seen);
      next.add(r.id);
      return { ...model(r), children: tree(rows, r.id, next) };
    });
}
async function clean(ctx: Context, resource: string, input: Row, previous: Row | null): Promise<Row> {
  const x = { ...previous, ...input };
  const row: Row = {
    id: previous?.id || id(),
    churchId: ctx.principal.churchId,
  };
  if (input.churchId && input.churchId !== row.churchId) throw new HttpError(403, 'Church mismatch');
  if (
    previous &&
    ['positions', 'times', 'planitems'].includes(resource) &&
    input.planId &&
    input.planId !== previous.planId
  )
    throw new HttpError(400, 'Move across plans by copying instead');
  for (const key of booleans)
    if (input[key] != null && typeof input[key] !== 'boolean' && input[key] !== 0 && input[key] !== 1)
      throw new HttpError(400, 'Invalid boolean');
  for (const key of [
    'providerId',
    'providerPlanId',
    'providerPath',
    'providerContentPath',
    'confirmationWorkflowId',
    'autofillRunId',
    'lastAutofillRunId',
  ])
    if (input[key]) throw new HttpError(501, 'Provider and automated workflow fields are not ported');
  if (resource === 'plantypes') {
    row.ministryId = requiredString(x.ministryId, 'ministryId');
    row.name = requiredString(x.name, 'name');
    row.lessonTrim = null;
  }
  if (resource === 'plans') {
    row.ministryId = requiredString(x.ministryId, 'ministryId');
    row.planTypeId = optionalId(x.planTypeId);
    row.campusId = optionalId(x.campusId);
    row.name = requiredString(x.name, 'name');
    row.serviceDate = day(x.serviceDate);
    row.notes = text(x.notes, 20000);
    for (const key of ['serviceOrder', 'showVolunteerNames', 'prepared']) row[key] = x[key] ? 1 : 0;
    row.signupDeadlineHours = x.signupDeadlineHours == null ? null : integer(x.signupDeadlineHours, 0, 720);
    if (x.autoReplaceOnDecline) throw new HttpError(501, 'Automatic replacement is not ported');
    row.autoReplaceOnDecline = 0;
    row.lessonTrimWarning = null;
    if (row.planTypeId) {
      const type = await load(ctx, 'plantypes', row.planTypeId);
      if (type.ministryId !== row.ministryId) throw new HttpError(400, 'Plan type belongs to another ministry');
    }
  }
  if (resource === 'positions') {
    row.planId = requiredString(x.planId, 'planId');
    row.name = requiredString(x.name, 'name');
    row.categoryName = text(x.categoryName, 255);
    row.count = integer(x.count ?? 1);
    row.groupId = optionalId(x.groupId);
    row.allowSelfSignup = x.allowSelfSignup ? 1 : 0;
    row.description = text(x.description, 5000);
  }
  if (resource === 'times') {
    row.planId = requiredString(x.planId, 'planId');
    row.displayName = requiredString(x.displayName, 'displayName');
    row.startTime = instant(x.startTime);
    row.endTime = instant(x.endTime);
    if (row.endTime <= row.startTime) throw new HttpError(400, 'Time must end after it starts');
    row.teams = text(x.teams, 2000);
    row.serviceTimeType = text(x.serviceTimeType || 'service', 40);
  }
  if (resource === 'assignments') {
    row.positionId = requiredString(x.positionId, 'positionId');
    row.personId = requiredString(x.personId, 'personId');
    row.status = x.status || 'Unconfirmed';
    if (!['Unconfirmed', 'Accepted', 'Declined'].includes(row.status)) throw new HttpError(400, 'Invalid status');
    row.notified = previous?.notified || null;
  }
  if (resource === 'planitems') {
    row.planId = requiredString(x.planId, 'planId');
    row.parentId = optionalId(x.parentId);
    row.positionId = optionalId(x.positionId);
    row.label = requiredString(x.label, 'label', 500);
    row.sort = Number(x.sort ?? 0);
    if (!Number.isFinite(row.sort) || Math.abs(row.sort) > 1e6) throw new HttpError(400, 'Invalid sort');
    row.itemType = text(x.itemType || 'item', 40);
    row.actionType = text(x.actionType, 40) || null;
    row.relatedId = optionalId(x.relatedId);
    row.description = text(x.description, 20000);
    row.seconds = integer(x.seconds ?? 0, 0, 86400);
    row.link = safeLink(x.link);
    row.thumbnailUrl = safeLink(x.thumbnailUrl);
  }
  if (resource === 'planitemtimes') {
    row.planItemId = requiredString(x.planItemId, 'planItemId');
    row.timeId = requiredString(x.timeId, 'timeId');
    row.excluded = x.excluded ? 1 : 0;
    row.positionId = optionalId(x.positionId);
  }
  if (resource === 'blockoutdates') {
    row.personId = optionalId(x.personId) || ctx.principal.personId;
    row.startDate = day(x.startDate);
    row.endDate = day(x.endDate);
    if (row.endDate < row.startDate) throw new HttpError(400, 'Blockout must end on or after start');
  }
  if (resource === 'schedulingpreferences') {
    row.personId = optionalId(x.personId) || ctx.principal.personId;
    row.maxPerMonth = integer(x.maxPerMonth ?? 0);
    row.preferredTimes = text(x.preferredTimes, 2000);
    row.householdScheduling = x.householdScheduling || 'none';
    if (!['none', 'together', 'apart'].includes(row.householdScheduling))
      throw new HttpError(400, 'Invalid household scheduling');
  }
  return row;
}
async function save(ctx: Context, resource: string, inputs: Row[]): Promise<Response> {
  const ownResource = ['blockoutdates', 'schedulingpreferences'].includes(resource);
  if (!ownResource) requireAdmin(ctx);
  const statements: D1PreparedStatement[] = [];
  const output: Row[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    let previous = input.id ? await load(ctx, resource, requiredString(input.id, 'id')) : null;
    if (resource === 'schedulingpreferences' && !previous)
      previous = await first(
        ctx,
        'SELECT * FROM doing_scheduling_preferences WHERE churchId=? AND personId=?',
        ctx.principal.churchId,
        input.personId || ctx.principal.personId,
      );
    const row = await clean(ctx, resource, input, previous);
    if (
      ownResource &&
      !allowed(ctx, 'DoingApi', 'Plans', 'Edit') &&
      (row.personId !== ctx.principal.personId || (previous && previous.personId !== ctx.principal.personId))
    )
      throw new HttpError(403, 'Own records only');
    if (seen.has(row.id)) throw new HttpError(400, 'Duplicate ID in request');
    seen.add(row.id);
    statements.push(statement(ctx, resource, row, !!previous), audit(ctx, `doing.${resource}.save`, row.id));
    output.push(model(row));
  }
  await batch(ctx, statements);
  return json(output);
}
async function copyPlan(ctx: Context, sourceId: string): Promise<Response> {
  requireAdmin(ctx);
  const source = await load(ctx, 'plans', sourceId);
  const input = await body(ctx.request);
  const copyMode = input.copyMode || 'all';
  if (!['none', 'positions', 'all'].includes(copyMode)) throw new HttpError(400, 'Invalid copy mode');
  const target = input.targetPlanId ? await load(ctx, 'plans', input.targetPlanId) : null;
  const row =
    target ||
    (await clean(ctx, 'plans', { ...source, ...input, id: undefined, prepared: input.prepared ?? true }, null));
  if (target && target.id === source.id) throw new HttpError(400, 'Cannot copy a plan into itself');
  const statements: D1PreparedStatement[] = [];
  if (!target) statements.push(statement(ctx, 'plans', row, false));
  const timeMap = new Map<string, string>();
  const posMap = new Map<string, string>();
  const itemMap = new Map<string, string>();
  const delta = (Date.parse(row.serviceDate) - Date.parse(source.serviceDate)) / 86400000;
  const zone = input.timeZone === undefined ? await churchTimeZone(ctx) : validTimeZone(input.timeZone);
  if (copyMode !== 'none') {
    for (const time of await all(
      ctx,
      'SELECT * FROM doing_times WHERE churchId=? AND planId=?',
      ctx.principal.churchId,
      source.id,
    )) {
      const old = time.id;
      time.id = id();
      time.planId = row.id;
      time.startTime = shiftServiceTime(time.startTime, delta, zone);
      time.endTime = shiftServiceTime(time.endTime, delta, zone);
      if (time.endTime <= time.startTime) throw new HttpError(409, 'Copied time must end after it starts');
      timeMap.set(old, time.id);
      statements.push(statement(ctx, 'times', time, false));
    }
    for (const position of await all(
      ctx,
      'SELECT * FROM doing_positions WHERE churchId=? AND planId=?',
      ctx.principal.churchId,
      source.id,
    )) {
      const old = position.id;
      position.id = id();
      position.planId = row.id;
      posMap.set(old, position.id);
      statements.push(statement(ctx, 'positions', position, false));
    }
    if (copyMode === 'all')
      for (const assignment of await all(
        ctx,
        'SELECT a.* FROM doing_assignments a JOIN doing_positions p ON p.churchId=a.churchId AND p.id=a.positionId WHERE a.churchId=? AND p.planId=?',
        ctx.principal.churchId,
        source.id,
      )) {
        assignment.id = id();
        assignment.positionId = posMap.get(assignment.positionId);
        assignment.status = 'Unconfirmed';
        assignment.selfSignup = 0;
        assignment.notified = null;
        assignment.autofillRunId = null;
        assignment.confirmationWorkflowId = null;
        statements.push(statement(ctx, 'assignments', assignment, false));
      }
  }
  if (input.copyServiceOrder) {
    let pending = await all(
      ctx,
      'SELECT * FROM doing_plan_items WHERE churchId=? AND planId=? ORDER BY sort',
      ctx.principal.churchId,
      source.id,
    );
    while (pending.length) {
      const ready = pending.filter((i) => !i.parentId || itemMap.has(i.parentId));
      if (!ready.length) throw new HttpError(409, 'Service order contains a cycle');
      for (const item of ready) {
        const old = item.id;
        item.id = id();
        item.planId = row.id;
        item.parentId = item.parentId ? itemMap.get(item.parentId) : null;
        item.positionId = posMap.get(item.positionId) || null;
        itemMap.set(old, item.id);
        statements.push(statement(ctx, 'planitems', item, false));
      }
      pending = pending.filter((i) => !ready.includes(i));
    }
    if (timeMap.size)
      for (const pit of await all(
        ctx,
        'SELECT pit.* FROM doing_plan_item_times pit JOIN doing_plan_items i ON i.churchId=pit.churchId AND i.id=pit.planItemId WHERE pit.churchId=? AND i.planId=?',
        ctx.principal.churchId,
        source.id,
      )) {
        pit.id = id();
        pit.planItemId = itemMap.get(pit.planItemId);
        pit.timeId = timeMap.get(pit.timeId);
        pit.positionId = posMap.get(pit.positionId) || null;
        statements.push(statement(ctx, 'planitemtimes', pit, false));
      }
  }
  if (statements.length > 800) throw new HttpError(413, 'Plan is too large to copy in one operation');
  statements.push(audit(ctx, 'doing.plans.copy', row.id));
  await batch(ctx, statements);
  return json(model(row));
}
export async function doing(ctx: Context): Promise<Response | undefined> {
  const groupRoute = /^\/membership\/groups\/([^/]+)\/plans$/i.exec(ctx.path);
  if (groupRoute && ctx.request.method === 'GET') return groupPlans(ctx, groupRoute[1]);
  if (!ctx.path.startsWith('/doing/')) return undefined;
  const parts = ctx.path.slice(7).split('/').filter(Boolean);
  const resource = parts[0]?.toLowerCase();
  const action = parts[1]?.toLowerCase();
  const recordId = parts[1];
  const method = ctx.request.method;
  const table = tables[resource];
  if (!table) return undefined;
  if (resource === 'plans' && action === 'copy' && parts[2] && method === 'POST') return copyPlan(ctx, parts[2]);
  if (resource === 'assignments' && ['accept', 'decline'].includes(action) && parts[2] && method === 'POST') {
    const assignment = await load(ctx, resource, parts[2]);
    if (assignment.personId !== ctx.principal.personId)
      throw new HttpError(403, 'Only the assigned person can respond');
    const position = await load(ctx, 'positions', assignment.positionId);
    const plan = await load(ctx, 'plans', position.planId);
    if (plan.prepared) throw new HttpError(409, 'Plan is not published');
    const status = action === 'accept' ? 'Accepted' : 'Declined';
    const result = await batch(ctx, [
      ctx.env.DB.prepare(
        'UPDATE doing_assignments SET status=? WHERE churchId=? AND id=? AND personId=? AND EXISTS(SELECT 1 FROM doing_positions p JOIN doing_plans pl ON pl.churchId=p.churchId AND pl.id=p.planId WHERE p.churchId=doing_assignments.churchId AND p.id=doing_assignments.positionId AND pl.prepared=0)',
      ).bind(status, ctx.principal.churchId, assignment.id, ctx.principal.personId),
      ctx.env.DB.prepare(
        'INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) SELECT ?,?,?,?,?,? WHERE changes()>0',
      ).bind(id(), ctx.principal.churchId, ctx.principal.userId, `doing.assignments.${action}`, assignment.id, now()),
    ]);
    if (!result[0].meta.changes) throw new HttpError(409, 'Assignment changed; reload your schedule');
    return json(model({ ...assignment, status }));
  }
  if (resource === 'assignments' && action === 'signup' && method === 'POST') {
    const input = await body(ctx.request);
    const positionId = requiredString(input.positionId, 'positionId');
    const assignmentId = id();
    await batch(ctx, [
      ctx.env.DB.prepare(
        "INSERT INTO doing_assignments(id,churchId,positionId,personId,status,selfSignup) VALUES(?,?,?,?,'Accepted',1)",
      ).bind(assignmentId, ctx.principal.churchId, positionId, ctx.principal.personId),
      audit(ctx, 'doing.assignments.signup', assignmentId),
    ]);
    return json(model(await load(ctx, 'assignments', assignmentId)));
  }
  if (resource === 'assignments' && action === 'signup' && parts[2] && method === 'DELETE') {
    const assignment = await load(ctx, 'assignments', parts[2]);
    if (assignment.personId !== ctx.principal.personId) throw new HttpError(403, 'Own assignments only');
    const position = await load(ctx, 'positions', assignment.positionId);
    if (!position.allowSelfSignup) throw new HttpError(403, 'Self-signup is not enabled');
    const plan = await load(ctx, 'plans', position.planId);
    const time = await first(
      ctx,
      'SELECT MIN(startTime) AS startTime FROM doing_times WHERE churchId=? AND planId=?',
      ctx.principal.churchId,
      plan.id,
    );
    if (Date.parse(time?.startTime || plan.serviceDate) - (plan.signupDeadlineHours || 0) * 3600000 <= Date.now())
      throw new HttpError(409, 'Removal deadline has passed');
    await batch(ctx, [
      ctx.env.DB.prepare('DELETE FROM doing_assignments WHERE churchId=? AND id=? AND personId=?').bind(
        ctx.principal.churchId,
        assignment.id,
        ctx.principal.personId,
      ),
      audit(ctx, 'doing.assignments.withdraw', assignment.id),
    ]);
    return json({});
  }
  if (resource === 'planitems' && action === 'sort' && method === 'POST') {
    requireAdmin(ctx);
    const input = await body(ctx.request);
    const previous = await load(ctx, resource, requiredString(input.id, 'id', 100));
    const row = await clean(ctx, resource, input, previous);
    // Rank in SQL after moving the item, so simultaneous moves cannot leave stale
    // sibling numbers. Both affected parent lists and the audit share one batch.
    const normalize = (parentId: string | null) =>
      ctx.env.DB.prepare(
        `WITH ranks AS MATERIALIZED (
      SELECT id,ROW_NUMBER() OVER(ORDER BY sort,id) n FROM doing_plan_items WHERE churchId=? AND planId=? AND parentId IS ?
    ) UPDATE doing_plan_items SET sort=(SELECT n FROM ranks WHERE ranks.id=doing_plan_items.id)
    WHERE churchId=? AND planId=? AND parentId IS ?`,
      ).bind(row.churchId, row.planId, parentId, row.churchId, row.planId, parentId);
    const statements = [statement(ctx, resource, row, true), normalize(row.parentId)];
    if (previous.parentId !== row.parentId) statements.push(normalize(previous.parentId));
    statements.push(audit(ctx, 'doing.planitems.sort', row.id));
    await batch(ctx, statements);
    return json([]);
  }
  if (method === 'POST' && !action) return save(ctx, resource, await records(ctx.request));
  if (method === 'DELETE' && resource === 'positions' && recordId && parts.length === 2) {
    requireAdmin(ctx);
    await load(ctx, resource, recordId);
    await batch(ctx, [
      ctx.env.DB.prepare('UPDATE doing_plan_items SET positionId=NULL WHERE churchId=? AND positionId=?').bind(
        ctx.principal.churchId,
        recordId,
      ),
      ctx.env.DB.prepare('UPDATE doing_plan_item_times SET positionId=NULL WHERE churchId=? AND positionId=?').bind(
        ctx.principal.churchId,
        recordId,
      ),
      ctx.env.DB.prepare('DELETE FROM doing_positions WHERE churchId=? AND id=?').bind(
        ctx.principal.churchId,
        recordId,
      ),
      audit(ctx, 'doing.positions.delete', recordId),
    ]);
    return json({});
  }
  if (method === 'DELETE' && recordId && parts.length === 2) {
    const previous = await load(ctx, resource, recordId);
    if (['blockoutdates', 'schedulingpreferences'].includes(resource)) {
      if (!allowed(ctx, 'DoingApi', 'Plans', 'Edit') && previous.personId !== ctx.principal.personId)
        throw new HttpError(403, 'Own records only');
    } else requireAdmin(ctx);
    await batch(ctx, [
      ctx.env.DB.prepare(`DELETE FROM ${table} WHERE churchId=? AND id=?`).bind(ctx.principal.churchId, recordId),
      audit(ctx, `doing.${resource}.delete`, recordId),
    ]);
    return json({});
  }
  if (method !== 'GET') return undefined;
  const churchId = ctx.principal.churchId;
  const isMember = !allowed(ctx, 'DoingApi', 'Plans', 'View') && !allowed(ctx, 'DoingApi', 'Plans', 'Edit');
  if (resource === 'plans' && action === 'public' && parts[2] === 'signup' && parts[3]) {
    if (parts[3] !== churchId) throw new HttpError(403, 'Church mismatch');
    const plans = await all(
      ctx,
      "SELECT * FROM doing_plans WHERE churchId=? AND prepared=0 AND serviceDate>=date('now') ORDER BY serviceDate LIMIT 100",
      churchId,
    );
    const result = [];
    for (const plan of plans) {
      const positions = await all(
        ctx,
        "SELECT p.*,(SELECT COUNT(*) FROM doing_assignments a WHERE a.churchId=p.churchId AND a.positionId=p.id AND a.status<>'Declined') AS filledCount FROM doing_positions p WHERE p.churchId=? AND p.planId=? AND p.allowSelfSignup=1",
        churchId,
        plan.id,
      );
      if (positions.length) {
        const times = await all(
          ctx,
          'SELECT * FROM doing_times WHERE churchId=? AND planId=? ORDER BY startTime',
          churchId,
          plan.id,
        );
        const deadline = plan.signupDeadlineHours
          ? new Date(
              Date.parse(times[0]?.startTime || plan.serviceDate) - plan.signupDeadlineHours * 3600000,
            ).toISOString()
          : null;
        result.push({
          plan: { ...model(plan), signupDeadline: deadline },
          positions: positions.map(model),
          times,
        });
      }
    }
    return json(result);
  }
  if (resource === 'assignments' && action === 'my') {
    const rows = await all(
      ctx,
      `SELECT a.*,p.planId,p.name AS positionName,pl.name AS planName,pl.serviceDate FROM doing_assignments a JOIN doing_positions p ON p.churchId=a.churchId AND p.id=a.positionId JOIN doing_plans pl ON pl.churchId=p.churchId AND pl.id=p.planId WHERE a.churchId=? AND a.personId=? AND pl.prepared=0 ${parts[2] === 'upcoming' ? "AND pl.serviceDate>=date('now','-1 day')" : ''} ORDER BY pl.serviceDate LIMIT 500`,
      churchId,
      ctx.principal.personId,
    );
    return json(
      parts[2] === 'upcoming'
        ? rows.slice(0, 20).map((r) => ({
            assignmentId: r.id,
            status: r.status,
            positionName: r.positionName,
            planId: r.planId,
            planName: r.planName,
            serviceDate: r.serviceDate,
          }))
        : rows.map(model),
    );
  }
  if (resource === 'assignments' && action === 'monthcounts') {
    if (isMember) throw new HttpError(403, 'Staff access required');
    const month = day(ctx.url.searchParams.get('date') || now()).slice(0, 7);
    return json(
      await all(
        ctx,
        "SELECT a.personId,COUNT(*) AS count FROM doing_assignments a JOIN doing_positions p ON p.churchId=a.churchId AND p.id=a.positionId JOIN doing_plans pl ON pl.churchId=p.churchId AND pl.id=p.planId WHERE a.churchId=? AND a.status<>'Declined' AND substr(pl.serviceDate,1,7)=? GROUP BY a.personId",
        churchId,
        month,
      ),
    );
  }
  if (['blockoutdates', 'schedulingpreferences'].includes(resource)) {
    if (action === 'my' || (!action && isMember))
      return json(
        resource === 'schedulingpreferences'
          ? await first(ctx, `SELECT * FROM ${table} WHERE churchId=? AND personId=?`, churchId, ctx.principal.personId)
          : await all(ctx, `SELECT * FROM ${table} WHERE churchId=? AND personId=?`, churchId, ctx.principal.personId),
      );
    if (action === 'people' || action === 'ids') {
      if (isMember) throw new HttpError(403, 'Staff access required');
      const ids = listIds(ctx.url.searchParams.get('ids'));
      return json(
        await all(
          ctx,
          `SELECT * FROM ${table} WHERE churchId=? AND ${action === 'people' ? 'personId' : 'id'} IN (SELECT value FROM json_each(?))`,
          churchId,
          JSON.stringify(ids),
        ),
      );
    }
    if (action === 'upcoming' && resource === 'blockoutdates') {
      if (isMember) throw new HttpError(403, 'Staff access required');
      return json(
        await all(ctx, `SELECT * FROM ${table} WHERE churchId=? AND endDate>=date('now') ORDER BY startDate`, churchId),
      );
    }
    if (recordId) {
      const row = await load(ctx, resource, recordId);
      if (isMember && row.personId !== ctx.principal.personId) throw new HttpError(403, 'Own records only');
      return json(row);
    }
  }
  if (action === 'ids') {
    const ids = listIds(ctx.url.searchParams.get('ids'));
    const rows = await all(
      ctx,
      `SELECT * FROM ${table} WHERE churchId=? AND id IN (SELECT value FROM json_each(?))`,
      churchId,
      JSON.stringify(ids),
    );
    if (isMember)
      for (const row of rows) {
        if (resource === 'plans') await visiblePlan(ctx, row.id);
        else if (row.planId) await visiblePlan(ctx, row.planId);
        else throw new HttpError(403, 'Staff access required');
      }
    return json(rows.map(model));
  }
  if (
    (action === 'plan' && ['positions', 'times', 'assignments', 'planitems', 'planitemtimes'].includes(resource)) ||
    (resource === 'times' && action === 'plans')
  ) {
    const planIds =
      parts[2] === 'ids' || action === 'plans'
        ? listIds(ctx.url.searchParams.get('planIds'))
        : [requiredString(parts[2], 'planId')];
    if (isMember) for (const planId of planIds) await visiblePlan(ctx, planId);
    let sql: string;
    if (resource === 'assignments') {
      if (isMember) throw new HttpError(403, 'Use your own assignments');
      sql = `SELECT a.*,p.planId FROM doing_assignments a JOIN doing_positions p ON p.churchId=a.churchId AND p.id=a.positionId WHERE a.churchId=? AND p.planId IN (SELECT value FROM json_each(?))`;
    } else if (resource === 'planitemtimes')
      sql = `SELECT pit.* FROM doing_plan_item_times pit JOIN doing_plan_items i ON i.churchId=pit.churchId AND i.id=pit.planItemId WHERE pit.churchId=? AND i.planId IN (SELECT value FROM json_each(?))`;
    else
      sql = `SELECT * FROM ${table} WHERE churchId=? AND planId IN (SELECT value FROM json_each(?))${resource === 'planitems' ? ' ORDER BY sort,id' : ''}`;
    const rows = await all(ctx, sql, churchId, JSON.stringify(planIds));
    return json(resource === 'planitems' ? tree(rows) : rows.map(model));
  }
  if (resource === 'planitemtimes' && action === 'planitem') {
    const item = await load(ctx, 'planitems', requiredString(parts[2], 'planItemId'));
    await visiblePlan(ctx, item.planId);
    return json(
      (await all(ctx, 'SELECT * FROM doing_plan_item_times WHERE churchId=? AND planItemId=?', churchId, item.id)).map(
        model,
      ),
    );
  }
  if (resource === 'plans' && action === 'types') {
    if (isMember) throw new HttpError(403, 'Staff access required');
    return json(
      (
        await all(
          ctx,
          'SELECT * FROM doing_plans WHERE churchId=? AND planTypeId=? ORDER BY serviceDate DESC',
          churchId,
          parts[2],
        )
      ).map(model),
    );
  }
  if (resource === 'plantypes' && action === 'ministryid') {
    if (isMember) throw new HttpError(403, 'Staff access required');
    return json(
      await all(
        ctx,
        'SELECT * FROM doing_plan_types WHERE churchId=? AND ministryId=? ORDER BY name',
        churchId,
        parts[2],
      ),
    );
  }
  if (!action || (resource === 'times' && action === 'all')) {
    if (isMember) throw new HttpError(403, 'Staff access required');
    const ministry = ctx.url.searchParams.get('ministryId');
    const filter = ['plans', 'plantypes'].includes(resource) && ministry;
    return json(
      (
        await all(
          ctx,
          `SELECT * FROM ${table} WHERE churchId=? ${filter ? 'AND ministryId=?' : ''} ORDER BY ${resource === 'plans' ? 'serviceDate DESC' : 'id'} LIMIT 1000`,
          churchId,
          ...(filter ? [ministry] : []),
        )
      ).map(model),
    );
  }
  if (parts.length === 2) {
    const row = await load(ctx, resource, recordId);
    if (isMember) {
      if (resource === 'plans') await visiblePlan(ctx, row.id);
      else if (row.planId) await visiblePlan(ctx, row.planId);
      else if (resource === 'assignments' && row.personId === ctx.principal.personId) {
        const position = await load(ctx, 'positions', row.positionId);
        await visiblePlan(ctx, position.planId);
      } else throw new HttpError(403, 'Staff access required');
    }
    return json(model(row));
  }
  return undefined;
}
