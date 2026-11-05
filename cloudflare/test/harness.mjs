import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
export async function applySql(db, sql) {
  let statement = '';
  for (const line of sql.split('\n')) {
    if (!line.trim() || line.trim().startsWith('--')) continue;
    statement += line + '\n';
    if (line.trim().endsWith(';')) {
      await db.prepare(statement).run();
      statement = '';
    }
  }
  if (statement.trim()) throw new Error('Unterminated SQL fixture statement');
}
export async function createHarness({ seed = true } = {}) {
  const result = await build({
    entryPoints: [root + 'src/index.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: result.outputFiles[0].text,
      compatibilityDate: '2026-10-01',
      d1Databases: { DB: 'test-db' },
      r2Buckets: { FILES: 'test-files' },
      durableObjects: {
        REALTIME: { className: 'ChurchRealtime', useSQLite: true },
      },
      bindings: {
        APP_ENV: 'test',
        SESSION_SECRET: 'test-only-secret-never-for-deployment-123456789',
        ALLOWED_ORIGINS: 'http://localhost:3101',
      },
    }),
  );
  try {
    const db = await mf.getD1Database('DB');
    for (const file of (await readdir(root + 'migrations')).filter((f) => f.endsWith('.sql')).sort())
      await applySql(db, await readFile(root + 'migrations/' + file, 'utf8'));
    if (seed)
      for (const file of ['seed.sql', 'seed-calendar.sql', 'seed-sermons.sql', 'seed-doing.sql', 'seed-tasks.sql'])
        await applySql(db, await readFile(root + file, 'utf8'));
    async function req(path, options = {}) {
      const { token, json, ...rest } = options;
      const headers = new Headers(rest.headers);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      if (json !== undefined) headers.set('Content-Type', 'application/json');
      return mf.dispatchFetch('http://localhost/api' + path, {
        ...rest,
        headers,
        body: json === undefined ? rest.body : JSON.stringify(json),
      });
    }
    async function login(email = 'admin@example.test') {
      const response = await req('/membership/users/login', {
        method: 'POST',
        json: { email, password: 'LocalDemo2026!' },
      });
      if (!response.ok) throw new Error(`Login failed: ${response.status} ${await response.text()}`);
      const data = await response.json();
      return { token: data.userChurches[0].jwt, data };
    }
    return { mf, db, req, login, dispose: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
