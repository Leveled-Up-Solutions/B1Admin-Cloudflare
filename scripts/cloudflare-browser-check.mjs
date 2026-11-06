import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// CI and contributors use an isolated loopback listener, never an external installation.
const root = fileURLToPath(new URL('../', import.meta.url));
const apiRoot = path.join(root, 'cloudflare');
// Keep the real login throttle intact as the suite grows. Each bounded batch gets
// a complete fresh synthetic installation; explicit CLI selections keep one state.
if (process.argv.length === 2) {
  const files = readdirSync(path.join(root, 'tests/cloudflare'))
    .filter((name) => name.endsWith('.spec.ts'))
    .sort();
  for (let start = 0; start < files.length; start += 3) {
    const batch = files.slice(start, start + 3).map((name) => 'tests/cloudflare/' + name);
    console.log(`Browser batch ${Math.floor(start / 3) + 1}/${Math.ceil(files.length / 3)}: ${batch.join(', ')}`);
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...batch], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    });
    if (result.status !== 0) process.exit(result.status || 1);
  }
  console.log(`All ${Math.ceil(files.length / 3)} isolated browser batches passed (${files.length} spec files).`);
  process.exit(0);
}
const baseURL = 'http://127.0.0.1:8790';
const statePath = mkdtempSync(path.join(tmpdir(), 'b1-browser-check-'));
const setup = spawnSync(process.execPath, [path.join(root, 'scripts/cloudflare-setup.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, B1_LOCAL_STATE_PATH: statePath },
});
if (setup.status !== 0) process.exit(setup.status || 1);
console.log('Isolated synthetic browser state:', statePath);
const server = spawn(
  process.execPath,
  [
    path.join(apiRoot, 'node_modules/wrangler/bin/wrangler.js'),
    'dev',
    '--local',
    '--port',
    '8790',
    '--persist-to',
    statePath,
  ],
  {
    cwd: apiRoot,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  },
);
let stopping = false;
let browser;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of [browser, server]) {
    if (!child?.pid) continue;
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already exited */
    }
  }
}
process.on('SIGINT', () => {
  stop();
  process.exit(130);
});
process.on('SIGTERM', () => {
  stop();
  process.exit(143);
});
process.on('exit', stop);
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error('Local Worker exited before becoming ready');
    try {
      ready = (
        await fetch(baseURL + '/api/health', {
          signal: AbortSignal.timeout(1000),
        })
      ).ok;
    } catch {
      /* startup */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Local Worker health check did not become ready');
  browser = spawn(
    process.execPath,
    [
      path.join(root, 'node_modules/@playwright/test/cli.js'),
      'test',
      '--config',
      'cloudflare.playwright.config.ts',
      ...process.argv.slice(2),
    ],
    {
      cwd: root,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      env: { ...process.env, B1_TEST_BASE_URL: baseURL, B1_LOCAL_STATE_PATH: statePath },
    },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    browser.once('error', reject);
    browser.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  stop();
}
