import type { Env, Context } from './types';
import { authorizeStaffRoute } from './permissions';
import { roles } from './roles';
import { authRoutes, authenticate } from './auth';
import { membership } from './membership';
import { calendar } from './calendar';
import { member } from './member';
import { groupRequests } from './group-requests';
import { doing } from './doing';
import { tasks } from './tasks';
import { associatedGroups } from './associated-groups';
import { content } from './content';
import { publicRoutes } from './public';
import { routeRealtime } from './realtime';
import { scheduledCleanup } from './scheduled';
import { json, HttpError } from './http';
export { ChurchRealtime } from './realtime';
const supported = [
  'membership.people',
  'membership.households',
  'membership.peopleAdvancedSearch',
  'membership.groupJoinRequests',
  'membership.groupScopedPermissions',
  'membership.manualInvitations',
  'membership.passwordChange',
  'membership.groups',
  'content.calendars',
  'content.events',
  'content.calendarRecurrence',
  'member.portal',
  'doing.plans',
  'doing.manualTasks',
  'content.sermons',
  'content.files',
  'messaging.refresh',
];
const unsupported = [
  'payments',
  'donationWebhooks',
  'childCheckin',
  'oauth',
  'sso',
  'mfa',
  'registration',
  'passwordReset',
  'email',
  'sms',
  'push',
  'advertising',
  'workflowExecution',
  'reportDefinitions',
  'commons',
  'lessons',
  'ai',
];
function cors(request: Request, env: Env) {
  const origin = request.headers.get('origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim());
  if (origin && origin !== new URL(request.url).origin && !allowed.includes(origin))
    throw new HttpError(403, 'Origin is not allowed');
  return origin;
}
function decorate(response: Response, origin: string | null): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cache-Control', 'no-store');
  headers.set('Vary', 'Origin');
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-File-Name,X-Content-Type,X-Content-Id');
    headers.set('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,DELETE,OPTIONS');
  }
  return new Response(response.body, { status: response.status, headers });
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/'))
      return env.ASSETS ? env.ASSETS.fetch(request) : json({ errors: ['Not found'] }, 404);
    let origin: string | null = null;
    try {
      origin = cors(request, env);
      if (request.method === 'OPTIONS') return decorate(new Response(null, { status: 204 }), origin);
      const path = url.pathname.slice(4).replace(/\/$/, '');
      if (path === '/health') {
        await env.DB.prepare('SELECT 1').first();
        return decorate(
          json({
            status: 'ok',
            runtime: 'cloudflare-workers',
            database: 'D1',
            files: 'R2',
            environment: env.APP_ENV,
          }),
          origin,
        );
      }
      if (path === '/capabilities' || path === '/instance')
        return decorate(
          json({
            version: '0.2.0',
            stage: 'development-milestone',
            apiBase: '/api',
            apis: Object.fromEntries(
              ['membership', 'attendance', 'giving', 'content', 'messaging', 'doing', 'reporting', 'commons'].map(
                (k) => [k, `/api/${k}`],
              ),
            ),
            realtime: {
              url: '/api/messaging/realtime',
              transport: 'websocket',
              protocol: 'refresh-only',
              authentication: 'Authorization Bearer (non-browser clients)',
            },
            publicApi: '/api/public/v1',
            supported,
            unsupported,
          }),
          origin,
        );
      const auth = await authRoutes(request, env, path);
      if (auth) return decorate(auth, origin);
      const publicResponse = await publicRoutes(request, env, path);
      if (publicResponse) return decorate(publicResponse, origin);
      const principal = await authenticate(request, env);
      const ctx: Context = { request, url, env, principal, path };
      authorizeStaffRoute(ctx);
      const associatedResponse = await associatedGroups(ctx);
      if (associatedResponse) return decorate(associatedResponse, origin);
      const roleResponse = await roles(ctx);
      if (roleResponse) return decorate(roleResponse, origin);
      const taskResponse = await tasks(ctx);
      if (taskResponse) return decorate(taskResponse, origin);
      const schedulingResponse = await doing(ctx);
      if (schedulingResponse) return decorate(schedulingResponse, origin);
      const groupRequestResponse = await groupRequests(ctx);
      if (groupRequestResponse) return decorate(groupRequestResponse, origin);
      const memberResponse = await member(ctx);
      if (memberResponse) return decorate(memberResponse, origin);
      if (principal.role === 'member') throw new HttpError(403, 'Use the member API for this account');
      for (const handler of [membership, calendar, content, routeRealtime]) {
        const response = await handler(ctx);
        if (response) return decorate(response, origin);
      }
      return decorate(
        json(
          {
            errors: ['This route is not implemented in the Cloudflare port'],
            code: 'NOT_PORTED',
            path,
          },
          501,
        ),
        origin,
      );
    } catch (error) {
      if (error instanceof HttpError) return decorate(json({ errors: [error.message] }, error.status), origin);
      const message = error instanceof Error ? error.message : '';
      if (
        /UNIQUE constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed|Batch is closed|Allocations exceed donation|Complete fund allocations/i.test(
          message,
        )
      )
        return decorate(
          json(
            {
              errors: ['The operation conflicts with existing records or data constraints'],
            },
            409,
          ),
          origin,
        );
      console.error('Request failed', url.pathname, 'unhandled error');
      return decorate(json({ errors: ['Unexpected server error'] }, 500), origin);
    }
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(scheduledCleanup(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
