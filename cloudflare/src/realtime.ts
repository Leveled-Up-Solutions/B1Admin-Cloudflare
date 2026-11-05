import { HttpError, body, requireAdmin } from './http';
import type { Context, Env, Principal } from './types';

const MAX_EVENT_BYTES = 4096;
const HISTORY_SIZE = 100;
const MAX_SOCKETS = 100;
interface EventInput {
  action: 'refresh';
  data: { resource: string; id?: string };
  conversationId?: string;
}
interface TenantEvent extends EventInput {
  churchId: string;
  actorId: string;
  sequence: number;
  timestamp: string;
}
interface SocketIdentity {
  churchId: string;
  userId: string;
  sessionId: string;
  socketId: string;
}

function validatedEvent(value: unknown): EventInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Invalid event');
  const input = value as Record<string, unknown>;
  if (input.churchId !== undefined || input.actorId !== undefined || input.sequence !== undefined)
    throw new HttpError(400, 'Event identity is assigned by the server');
  const data = input.data as Record<string, unknown> | undefined;
  if (
    input.action !== 'refresh' ||
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    typeof data.resource !== 'string' ||
    !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(data.resource) ||
    Object.keys(data).some((key) => key !== 'resource' && key !== 'id') ||
    (data.id !== undefined && (typeof data.id !== 'string' || data.id.length > 128)) ||
    (input.conversationId !== undefined &&
      (typeof input.conversationId !== 'string' || input.conversationId.length > 128))
  ) {
    throw new HttpError(400, 'Only bounded refresh events are supported');
  }
  const event: EventInput = { action: 'refresh', data: { resource: data.resource } };
  if (typeof data.id === 'string') event.data.id = data.id;
  if (typeof input.conversationId === 'string') event.conversationId = input.conversationId;
  if (new TextEncoder().encode(JSON.stringify(event)).length > MAX_EVENT_BYTES)
    throw new HttpError(413, 'Event too large');
  return event;
}

function tenantStub(env: Env, principal: Principal): DurableObjectStub {
  return env.REALTIME.get(env.REALTIME.idFromName(`church:${principal.churchId}`));
}

function identityHeaders(principal: Principal): Headers {
  // Build fresh headers: never forward caller-provided tenant or identity headers.
  return new Headers({
    'X-Church-Id': principal.churchId,
    'X-User-Id': principal.userId,
    'X-Session-Id': principal.sessionId,
  });
}

/** Called only after the outer Worker has authenticated and authorized the operation. */
export async function publishRealtime(env: Env, principal: Principal, input: EventInput): Promise<Response> {
  const event = validatedEvent(input);
  const headers = identityHeaders(principal);
  headers.set('Content-Type', 'application/json');
  return tenantStub(env, principal).fetch(
    new Request('https://realtime.internal/publish', { method: 'POST', headers, body: JSON.stringify(event) }),
  );
}

export async function routeRealtime(ctx: Context): Promise<Response | undefined> {
  if (ctx.path !== '/messaging/realtime' && ctx.path !== '/messaging/realtime/events') return undefined;
  if (ctx.path.endsWith('/events') && ctx.request.method === 'POST') {
    requireAdmin(ctx);
    return publishRealtime(ctx.env, ctx.principal, validatedEvent(await body(ctx.request)));
  }
  if (ctx.request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  const headers = identityHeaders(ctx.principal);
  let internalPath = '/events';
  if (!ctx.path.endsWith('/events')) {
    if (ctx.request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      throw new HttpError(426, 'WebSocket upgrade required');
    headers.set('Upgrade', 'websocket');
    internalPath = '/socket';
  }
  return tenantStub(ctx.env, ctx.principal).fetch(new Request(`https://realtime.internal${internalPath}`, { headers }));
}

/** One hibernating object per church. It owns sequence ordering and socket fan-out. */
export class ChurchRealtime {
  private churchId: string | undefined;
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    state.blockConcurrencyWhile(async () => {
      this.churchId = await state.storage.get<string>('churchId');
    });
  }

  private async sessionValid(identity: Pick<SocketIdentity, 'sessionId' | 'userId' | 'churchId'>): Promise<boolean> {
    return !!(await this.env.DB.prepare(
      'SELECT s.id FROM sessions s JOIN users u ON u.id = s.userId JOIN user_churches uc ON uc.userId = u.id WHERE s.id = ? AND s.userId = ? AND uc.churchId = ? AND u.disabled = 0 AND s.expiresAt > ?',
    )
      .bind(identity.sessionId, identity.userId, identity.churchId, new Date().toISOString())
      .first());
  }

  async fetch(request: Request): Promise<Response> {
    const churchId = request.headers.get('X-Church-Id');
    const userId = request.headers.get('X-User-Id');
    const sessionId = request.headers.get('X-Session-Id');
    if (!churchId || !userId || !sessionId || !(await this.sessionValid({ churchId, userId, sessionId })))
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (this.churchId && churchId !== this.churchId)
      return Response.json({ error: 'Tenant mismatch' }, { status: 403 });
    if (!this.churchId) {
      await this.state.storage.put('churchId', churchId);
      this.churchId = churchId;
    }
    const path = new URL(request.url).pathname;
    if (path === '/socket' && request.method === 'GET') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
        return new Response('WebSocket upgrade required', { status: 426 });
      if (this.state.getWebSockets().length >= MAX_SOCKETS)
        return Response.json({ error: 'Connection limit reached' }, { status: 429 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const identity: SocketIdentity = { churchId, userId, sessionId, socketId: crypto.randomUUID() };
      this.state.acceptWebSocket(server);
      server.serializeAttachment(identity);
      if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + 60_000);
      server.send(JSON.stringify({ churchId, conversationId: '', action: 'socketId', data: identity.socketId }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path === '/events' && request.method === 'GET') {
      const entries = await this.state.storage.list<TenantEvent>({ prefix: 'event:', limit: HISTORY_SIZE });
      return Response.json({
        events: [...entries.values()],
        sequence: (await this.state.storage.get<number>('sequence')) || 0,
      });
    }
    if (path === '/publish' && request.method === 'POST') {
      let input: EventInput;
      try {
        input = validatedEvent(await body(request));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : 'Invalid event' },
          { status: error instanceof HttpError ? error.status : 400 },
        );
      }
      const event = await this.state.storage.transaction(async (storage) => {
        const sequence = ((await storage.get<number>('sequence')) || 0) + 1;
        const entry: TenantEvent = {
          ...input,
          churchId,
          actorId: userId,
          sequence,
          timestamp: new Date().toISOString(),
        };
        await storage.put({ sequence, [`event:${String(sequence).padStart(20, '0')}`]: entry });
        if (sequence > HISTORY_SIZE) await storage.delete(`event:${String(sequence - HISTORY_SIZE).padStart(20, '0')}`);
        return entry;
      });
      const payload = JSON.stringify(event);
      // A session revoked after connecting cannot receive another application event.
      const validity = new Map<string, Promise<boolean>>();
      await Promise.all(
        this.state.getWebSockets().map(async (socket) => {
          try {
            const identity = socket.deserializeAttachment() as SocketIdentity;
            if (!validity.has(identity.sessionId)) validity.set(identity.sessionId, this.sessionValid(identity));
            if (identity.churchId !== churchId || !(await validity.get(identity.sessionId)))
              socket.close(1008, 'Session expired');
            else socket.send(payload);
          } catch {
            socket.close(1011, 'Delivery failed');
          }
        }),
      );
      return Response.json(event, { status: 201 });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || new TextEncoder().encode(message).length > 1024) {
      socket.close(1009, 'Message too large');
      return;
    }
    const identity = socket.deserializeAttachment() as SocketIdentity;
    if (!identity || identity.churchId !== this.churchId || !(await this.sessionValid(identity))) {
      socket.close(1008, 'Session expired');
      return;
    }
    if (message === 'getId')
      socket.send(
        JSON.stringify({
          churchId: identity.churchId,
          conversationId: '',
          action: 'socketId',
          data: identity.socketId,
        }),
      );
    else if (message === 'ping') socket.send(JSON.stringify({ action: 'pong' }));
    else socket.close(1008, 'Only getId and ping messages are supported');
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason);
  }
  webSocketError(socket: WebSocket): void {
    socket.close(1011, 'Socket error');
  }

  async alarm(): Promise<void> {
    await Promise.all(
      this.state.getWebSockets().map(async (socket) => {
        const identity = socket.deserializeAttachment() as SocketIdentity;
        if (!identity || !(await this.sessionValid(identity))) socket.close(1008, 'Session expired');
      }),
    );
    if (this.state.getWebSockets().length) await this.state.storage.setAlarm(Date.now() + 60_000);
  }
}
