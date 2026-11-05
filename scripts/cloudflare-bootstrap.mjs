import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const cwd = fileURLToPath(new URL('../cloudflare', import.meta.url));
const usage = 'node scripts/cloudflare-bootstrap.mjs --church "Synthetic Church" --slug synthetic --email admin@example.test --first Admin --last Example [--persist-to /tmp/b1-empty-local]';
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
 const key = process.argv[i];
 if (key === '--help') { console.log(usage); process.exit(0); }
 if (!['--church', '--slug', '--email', '--first', '--last', '--persist-to'].includes(key) || !process.argv[i + 1] || options[key]) throw new Error(usage);
 options[key] = process.argv[i + 1];
}
for (const key of ['--church', '--slug', '--email', '--first', '--last']) if (!options[key]?.trim() || options[key].length > 254 || /[\x00-\x1f]/.test(options[key])) throw new Error(usage);
const email = options['--email'].trim().toLowerCase();
if (!/^[\x21-\x7e]+$/.test(email) || !/^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,63}$/.test(email)) throw new Error('A valid ASCII email address is required');
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(options['--slug'])) throw new Error('Slug must contain lowercase letters, numbers and hyphens');
if (!existsSync(`${cwd}/.dev.vars`)) writeFileSync(`${cwd}/.dev.vars`, `SESSION_SECRET=${randomBytes(48).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
const storage = options['--persist-to'] ? ['--persist-to', resolve(options['--persist-to'])] : [];
function run(args) {
 const result = spawnSync(process.execPath, [`${cwd}/node_modules/wrangler/bin/wrangler.js`, ...args, '--local', ...storage], { cwd, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(tmpdir(), 'b1-wrangler-logs') } });
 if (result.status !== 0) throw new Error('Local bootstrap stopped; no invitation link was emitted');
}
// Deliberately hardcoded --local: this command cannot provision or modify a remote database.
run(['d1', 'migrations', 'apply', 'DB']);
const token = randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(token).digest('base64url');
const created = new Date().toISOString(), expires = new Date(Date.now() + 24 * 3600000).toISOString();
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const values = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), options['--church'].trim(), options['--slug'], email, options['--first'].trim(), options['--last'].trim(), hash, created, expires];
const directory = mkdtempSync(join(tmpdir(), 'b1-local-bootstrap-'));
try {
 const path = join(directory, 'bootstrap.sql');
 writeFileSync(path, `INSERT INTO auth_bootstrap(id,churchId,personId,userId,invitationId,churchName,subDomain,email,firstName,lastName,tokenHash,createdAt,expiresAt) VALUES(1,${values.map(quote).join(',')});\n`, { mode: 0o600 });
 run(['d1', 'execute', 'DB', '--file', path]);
} finally { rmSync(directory, { recursive: true, force: true }); }
console.log(`Local administrator is pending. This single-use link expires at ${expires}. Keep it private:\nhttp://localhost:8787/login?auth=${token}`);
if (storage.length) console.log(`Start Wrangler with the same local --persist-to directory: ${storage[1]}`);
