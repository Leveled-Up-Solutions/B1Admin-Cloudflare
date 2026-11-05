import type { Env } from './types';
import { HttpError } from './http';
import { encode64, tokenHash } from './passwords';
const encoder = new TextEncoder();
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Uint8Array): string {
  let result = '',
    buffer = 0,
    bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits) result += alphabet[(buffer << (5 - bits)) & 31];
  return result;
}
function unbase32(value: string): Uint8Array {
  let buffer = 0,
    bits = 0;
  const output: number[] = [];
  for (const char of value) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Invalid authenticator secret');
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >>> bits) & 255);
    }
  }
  return new Uint8Array(output);
}
function decode64(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}
export async function totp(secret: string, step: number, digits = 6): Promise<string> {
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const key = await crypto.subtle.importKey('raw', unbase32(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const offset = hmac[hmac.length - 1] & 15;
  const binary = ((hmac[offset] & 127) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}
export async function matchedStep(secret: string, code: unknown, timestamp = Date.now()): Promise<number | null> {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(timestamp / 30000);
  let matched: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    const expected = await totp(secret, step);
    let difference = 0;
    for (let i = 0; i < 6; i++) difference |= expected.charCodeAt(i) ^ code.charCodeAt(i);
    if (difference === 0) matched = step;
  }
  return matched;
}
async function encryptionKey(env: Env): Promise<CryptoKey> {
  if (!env.AUTH_ENCRYPTION_KEY || !/^[A-Za-z0-9_-]{43}$/.test(env.AUTH_ENCRYPTION_KEY))
    throw new HttpError(503, 'Authenticator encryption key is not configured');
  return crypto.subtle.importKey('raw', decode64(env.AUTH_ENCRYPTION_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptSecret(env: Env, userId: string, factorId: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(`b1-mfa-v1:${userId}:${factorId}`) },
    await encryptionKey(env),
    encoder.encode(secret),
  );
  return `v1.${encode64(iv)}.${encode64(new Uint8Array(ciphertext))}`;
}
export async function decryptSecret(env: Env, userId: string, factorId: string, value: string): Promise<string> {
  const key = await encryptionKey(env);
  try {
    const [version, nonce, ciphertext] = value.split('.');
    if (version !== 'v1') throw new Error();
    return new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: decode64(nonce), additionalData: encoder.encode(`b1-mfa-v1:${userId}:${factorId}`) },
        key,
        decode64(ciphertext),
      ),
    );
  } catch {
    throw new HttpError(503, 'Authenticator secret cannot be opened');
  }
}
export function recoveryCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .match(/.{8}/g)!
    .join('-');
}
export async function recoveryHash(userId: string, code: unknown): Promise<string | null> {
  if (typeof code !== 'string' || code.length > 80) return null;
  const normalized = code.toLowerCase().replace(/[ -]/g, '');
  if (!/^[a-f0-9]{32}$/.test(normalized)) return null;
  return tokenHash(`mfa-recovery:${userId}:${normalized}`);
}
