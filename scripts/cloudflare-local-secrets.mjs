import { existsSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
/** Add missing development keys only. Repeated setup must never rotate stored-factor encryption. */
export function ensureLocalSecrets(directory) {
  const path = `${directory}/.dev.vars`;
  if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
  const existing = readFileSync(path, 'utf8'),
    missing = [];
  if (!/^\s*SESSION_SECRET\s*=/m.test(existing)) missing.push(`SESSION_SECRET=${randomBytes(48).toString('hex')}`);
  if (!/^\s*AUTH_ENCRYPTION_KEY\s*=/m.test(existing))
    missing.push(`AUTH_ENCRYPTION_KEY=${randomBytes(32).toString('base64url')}`);
  if (missing.length)
    appendFileSync(path, (existing && !existing.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
  chmodSync(path, 0o600);
}
