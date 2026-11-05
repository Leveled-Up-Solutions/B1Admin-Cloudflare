import type { Context, Env } from './types';
import { HttpError } from './http';
export interface Grant {
  apiName: string;
  contentType: string;
  contentId: string;
  action: string;
}
export function permissionKey(g: Grant): string {
  return `${g.apiName}_${g.contentType}_${g.contentId || ''}_${g.action}`;
}
export const builtinGrants: Record<string, [string, string][]> = {
  MembershipApi: [
    ['Roles', 'View'],
    ['Roles', 'Edit'],
    ['Settings', 'Edit'],
    ['People', 'View'],
    ['People', 'View Names'],
    ['People', 'Edit'],
    ['Groups', 'View'],
    ['Groups', 'Edit'],
    ['Group Members', 'View'],
    ['Group Members', 'Edit'],
  ],
  ContentApi: [
    ['Content', 'View'],
    ['Content', 'Edit'],
    ['StreamingServices', 'Edit'],
  ],
  DoingApi: [
    ['Plans', 'View'],
    ['Plans', 'Edit'],
    ['Tasks', 'View'],
    ['Tasks', 'Edit'],
  ],
  MessagingApi: [],
  AttendanceApi: [],
  GivingApi: [],
  ReportingApi: [],
};
export async function loadGrants(env: Env, userId: string, churchId: string, role: string): Promise<Grant[]> {
  const base = Object.entries(builtinGrants).flatMap(([apiName, pairs]) =>
    pairs
      .filter(([, action]) => role === 'admin' || (role === 'viewer' && action.startsWith('View')))
      .map(([contentType, action]) => ({
        apiName,
        contentType,
        action,
        contentId: '',
      })),
  );
  const extra = (
    await env.DB.prepare(
      'SELECT DISTINCT p.apiName,p.contentType,p.contentId,p.action FROM role_permissions p JOIN role_members m ON m.churchId=p.churchId AND m.roleId=p.roleId WHERE m.userId=? AND m.churchId=?',
    )
      .bind(userId, churchId)
      .all<Grant>()
  ).results;
  return [...new Map([...base, ...extra].map((g) => [permissionKey(g), g])).values()];
}
export function allowed(ctx: Context, api: string, content: string, action: string, contentId?: string): boolean {
  if (ctx.principal.role === 'admin') return true;
  const values = ctx.principal.permissions || [];
  return (
    values.includes(`${api}_${content}__${action}`) ||
    !!(contentId && values.includes(`${api}_${content}_${contentId}_${action}`))
  );
}
function scopedDoingGrant(ctx: Context, content: string, read: boolean): boolean {
  const prefix = `DoingApi_${content}_`;
  const actions = read ? ['View', 'Edit'] : ['Edit'];
  return (ctx.principal.permissions || []).some((key) =>
    actions.some((action) => {
      const suffix = `_${action}`;
      return key.startsWith(prefix) && key.endsWith(suffix) && key.length > prefix.length + suffix.length;
    }),
  );
}
/** A scoped grant admits only its implemented resource family. The handler must still
 * authorize the concrete resource; scoped admission never grants writeAuthorized. */
function scopedDoingRoute(path: string, method: string, content: string): boolean {
  if (method === 'GET' && path === (content === 'Tasks' ? '/doing/taskgroupscopes' : '/doing/ministryscopes'))
    return true;
  if (
    content === 'Plans' &&
    method === 'GET' &&
    /^\/doing\/(ministryteams|planteams|planpeople|positionmembers)\/[^/]+$/.test(path)
  )
    return true;
  const family =
    content === 'Tasks'
      ? /^\/doing\/tasks(?:\/|$)/
      : /^\/doing\/(plantypes|plans|positions|times|planitems|planitemtimes|assignments)(?:\/|$)/;
  return (
    ['GET', 'POST', 'DELETE'].includes(method) &&
    (family.test(path) || (content === 'Plans' && /^\/membership\/associatedgroups(?:\/|$)/.test(path)))
  );
}
/** These exact routes have their own ownership/publication checks; this never grants staff writes. */
function selfServiceRoute(method: string, path: string): boolean {
  if (method === 'POST')
    return (
      path === '/doing/tasks/loadforgroups' ||
      /^\/doing\/assignments\/(accept|decline)\/[^/]+$/.test(path) ||
      path === '/doing/assignments/signup' ||
      /^\/doing\/(blockoutdates|schedulingpreferences)$/.test(path)
    );
  if (method === 'DELETE')
    return (
      /^\/doing\/assignments\/signup\/[^/]+$/.test(path) ||
      /^\/doing\/(blockoutdates|schedulingpreferences)\/(?!my$|people$|ids$|upcoming$)[^/]+$/.test(path)
    );
  if (method !== 'GET') return false;
  if (/^\/membership\/groups\/[^/]+\/plans$/.test(path)) return true;
  if (/^\/doing\/tasks(?:\/[^/]+)?$/.test(path)) return true;
  if (/^\/doing\/plans\/public\/signup\/[^/]+$/.test(path)) return true;
  if (/^\/doing\/assignments\/my(?:\/upcoming)?$/.test(path)) return true;
  if (/^\/doing\/assignments\/(?!accept$|decline$|signup$|monthcounts$|ids$|plan$)[^/]+$/.test(path)) return true;
  if (/^\/doing\/(blockoutdates|schedulingpreferences)(?:\/(?!people$|ids$|upcoming$)[^/]+)?$/.test(path)) return true;
  if (/^\/doing\/plans\/(?!types$|public$|copy$)[^/]+$/.test(path)) return true;
  if (/^\/doing\/(positions|times|planitems)\/(?!all$|sort$|plan$)[^/]+$/.test(path)) return true;
  if (/^\/doing\/(positions|times|planitems|planitemtimes)\/plan\/[^/]+$/.test(path)) return true;
  return /^\/doing\/planitemtimes\/planitem\/[^/]+$/.test(path);
}
/** Dispatch policy for staff routes. Handlers still validate tenant relationships and self-service ownership. */
export function authorizeStaffRoute(ctx: Context): void {
  if (ctx.path.startsWith('/member/') || /^\/membership\/groupjoinrequests(?:\/|$)/i.test(ctx.path)) return;
  const path = ctx.path.toLowerCase(),
    method = ctx.request.method;
  // Group handlers authorize every returned or mutated group, including both sides of moves.
  // Do not turn one scoped grant into writeAuthorized for an entire bulk request.
  if (
    (method === 'GET' && /^\/membership\/groups(?:\/[^/]+|\/(?:my|tag|categories)\/[^/]+)?$/.test(path)) ||
    (['POST', 'DELETE'].includes(method) && /^\/membership\/groups(?:\/[^/]+)?$/.test(path)) ||
    (['GET', 'POST', 'DELETE'].includes(method) && /^\/membership\/groupmembers(?:\/[^/]+)?$/.test(path))
  )
    return;
  const read =
    ['GET', 'HEAD'].includes(method) ||
    (method === 'POST' &&
      [
        '/membership/people/search',
        '/membership/people/duplicates',
        '/membership/people/advancedsearch',
        '/doing/tasks/loadforgroups',
      ].includes(path));
  let api = '',
    content = '',
    resourceId: string | undefined;
  if (/^\/membership\/auditlogs?/.test(path)) {
    if (!allowed(ctx, 'MembershipApi', 'Settings', 'Edit'))
      throw new HttpError(403, 'Settings edit permission required');
    return;
  }
  if (/^\/membership\/(roles|rolepermissions|rolemembers)/.test(path)) {
    api = 'MembershipApi';
    content = 'Roles';
  } else if (path.startsWith('/membership/associatedgroups')) {
    api = 'DoingApi';
    content = 'Plans';
  } else if (/^\/membership\/(people|households)/.test(path)) {
    api = 'MembershipApi';
    content = 'People';
  } else if (path.startsWith('/membership/groupmembers')) {
    api = 'MembershipApi';
    content = 'Group Members';
    resourceId = ctx.url.searchParams.get('groupId') || undefined;
  } else if (path.startsWith('/membership/groups')) {
    api = 'MembershipApi';
    content = 'Groups';
    resourceId = /^\/membership\/groups\/[^/]+$/.test(path) ? ctx.path.split('/').pop() : undefined;
  } else if (path.startsWith('/content/')) {
    api = 'ContentApi';
    content = 'Content';
  } else if (path.startsWith('/doing/tasks') || path === '/doing/taskgroupscopes') {
    api = 'DoingApi';
    content = 'Tasks';
  } else if (path.startsWith('/doing/')) {
    api = 'DoingApi';
    content = 'Plans';
  } else if (path.startsWith('/messaging/realtime')) {
    if (!read && ctx.principal.role !== 'admin') throw new HttpError(403, 'Administrator permission required');
    return;
  }
  if (!api) return;
  let pass =
    allowed(ctx, api, content, read ? 'View' : 'Edit', resourceId) ||
    (read && allowed(ctx, api, content, 'Edit', resourceId));
  if (content === 'People' && read && path.startsWith('/membership/people'))
    pass ||= allowed(ctx, api, 'People', 'View Names');
  if (content === 'Groups' && read)
    pass ||= allowed(ctx, api, 'People', 'View') || allowed(ctx, api, 'Group Members', 'View');
  if (content === 'Group Members') pass ||= allowed(ctx, api, 'Groups', 'Edit', resourceId);
  if (api === 'ContentApi' && /^\/content\/(sermons|playlists|files)/.test(path))
    pass ||= allowed(ctx, api, 'StreamingServices', 'Edit');
  const scopedPass =
    !pass && api === 'DoingApi' && scopedDoingRoute(path, method, content) && scopedDoingGrant(ctx, content, read);
  pass ||= scopedPass;
  if (!pass && selfServiceRoute(method, path)) return;
  if (!pass) throw new HttpError(403, `${content} ${read ? 'view' : 'edit'} permission required`);
  ctx.writeAuthorized = !read && !scopedPass;
}
