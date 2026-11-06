import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const cwd = fileURLToPath(new URL('../cloudflare', import.meta.url));
const usage =
  'node scripts/cloudflare-recover.mjs --user-id <exact-id> --email synthetic@example.test [--reset-mfa] [--persist-to /tmp/local-state]';
const options = {};
let resetMfa = false;
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === '--help') {
    console.log(usage);
    process.exit(0);
  }
  if (key === '--reset-mfa' && !resetMfa) {
    resetMfa = true;
    continue;
  }
  if (!['--user-id', '--email', '--persist-to'].includes(key) || options[key] || !process.argv[i + 1])
    throw new Error(usage);
  options[key] = process.argv[++i];
}
if (!options['--user-id'] || options['--user-id'].length > 255 || /[\x00-\x1f]/.test(options['--user-id']))
  throw new Error(usage);
const email = options['--email']?.trim().toLowerCase();
if (!email || email.length > 254 || !/^[\x21-\x7e]+$/.test(email) || !/^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,63}$/.test(email))
  throw new Error(usage);
const storage = options['--persist-to'] ? ['--persist-to', resolve(options['--persist-to'])] : [];
function run(args) {
  const result = spawnSync(
    process.execPath,
    [`${cwd}/node_modules/wrangler/bin/wrangler.js`, ...args, '--local', ...storage],
    {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(tmpdir(), 'b1-wrangler-logs') },
    },
  );
  if (result.status !== 0) throw new Error('Local recovery stopped; no recovery link was emitted');
}
run(['d1', 'migrations', 'apply', 'DB']);
const token = randomBytes(32).toString('base64url'),
  tokenHash = createHash('sha256').update(token).digest('base64url');
const created = new Date().toISOString(),
  expires = new Date(Date.now() + 30 * 60000).toISOString();
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
const userId = quote(options['--user-id']),
  address = quote(email);
const sql = `INSERT INTO auth_local_recoveries(id,tokenHash,userId,email,passwordVersion,resetMfa,createdAt,expiresAt) VALUES(${quote(randomUUID())},${quote(tokenHash)},${userId},${address},(SELECT passwordVersion FROM users WHERE id=${userId} AND lower(email)=${address}),${resetMfa ? 1 : 0},${quote(created)},${quote(expires)});\n`;
const directory = mkdtempSync(join(tmpdir(), 'b1-local-recovery-'));
try {
  const path = join(directory, 'recovery.sql');
  writeFileSync(path, sql, { mode: 0o600 });
  run(['d1', 'execute', 'DB', '--file', path]);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log(
  `Single-use local recovery expires at ${expires}. ${resetMfa ? 'MFA will be removed on completion.' : 'Existing MFA remains required.'} Keep this link private:\nhttp://localhost:8787/login?recovery=${token}`,
);
