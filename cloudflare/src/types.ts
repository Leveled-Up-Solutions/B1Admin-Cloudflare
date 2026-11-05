export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  REALTIME: DurableObjectNamespace;
  ASSETS?: Fetcher;
  APP_ENV: string;
  SESSION_SECRET?: string;
  AUTH_ENCRYPTION_KEY?: string;
  ALLOWED_ORIGINS?: string;
}
export interface Principal {
  userId: string;
  churchId: string;
  personId: string;
  role: 'admin' | 'viewer' | 'member';
  sessionId: string;
  permissions?: string[];
}
export interface Context {
  request: Request;
  url: URL;
  env: Env;
  principal: Principal;
  writeAuthorized?: boolean;
  path: string; // API path without /api prefix, e.g. /membership/people
}
export type RouteHandler = (ctx: Context) => Promise<Response | undefined>;
