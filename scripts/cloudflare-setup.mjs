import { ensureLocalSecrets } from './cloudflare-local-secrets.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../cloudflare', import.meta.url));
ensureLocalSecrets(cwd);
const stateArgs = process.env.B1_LOCAL_STATE_PATH ? ['--persist-to', process.env.B1_LOCAL_STATE_PATH] : [];
function run(args) {
  const r = spawnSync(process.execPath, [`${cwd}/node_modules/wrangler/bin/wrangler.js`, ...args], {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_LOG_PATH: '/tmp/b1-wrangler-logs',
    },
  });
  if (r.status !== 0) process.exit(r.status || 1);
}
run(['d1', 'migrations', 'apply', 'DB', '--local', ...stateArgs]);
for (const file of ['seed.sql', 'seed-calendar.sql', 'seed-sermons.sql', 'seed-doing.sql', 'seed-tasks.sql'])
  run(['d1', 'execute', 'DB', '--local', `--file=${file}`, ...stateArgs]);
console.log('Local D1 seeded. Run yarn dev:cloudflare. Demo: admin@example.test / LocalDemo2026!');
