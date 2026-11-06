import { scrypt } from '@noble/hashes/scrypt.js';
import { HttpError } from './http';
const encoder = new TextEncoder();
const options = { N: 32768, r: 8, p: 3, dkLen: 32, maxmem: 40 * 1024 * 1024 };
export function encode64(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
function decode64(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}
export function passwordPolicy(value: unknown): string {
  if (
    typeof value !== 'string' ||
    [...value].length < 12 ||
    [...value].length > 128 ||
    encoder.encode(value).length > 512
  )
    throw new HttpError(400, 'Use a password or passphrase between 12 and 128 characters');
  return value;
}
export function hashPassword(password: string): string {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  // Synchronous scrypt avoids overlapping large allocations within one isolate.
  const hash = scrypt(encoder.encode(password), salt, options);
  return `scrypt$32768$8$3$${encode64(salt)}$${encode64(hash)}`;
}
export async function checkPassword(password: string, encoded: string): Promise<boolean> {
  try {
    const fields = encoded.split('$');
    let actual: Uint8Array;
    let expected: Uint8Array;
    if (
      fields[0] === 'scrypt' &&
      fields.length === 6 &&
      fields[1] === '32768' &&
      fields[2] === '8' &&
      fields[3] === '3'
    ) {
      const salt = decode64(fields[4]);
      expected = decode64(fields[5]);
      if (salt.length !== 16 || expected.length !== 32) return false;
      actual = scrypt(encoder.encode(password), salt, options);
    } else if (fields[0] === 'pbkdf2' && fields.length === 4 && fields[1] === '100000') {
      // Read compatibility for synthetic development fixtures. New writes use scrypt.
      const salt = decode64(fields[2]);
      expected = decode64(fields[3]);
      if (salt.length < 16 || salt.length > 64 || expected.length !== 32) return false;
      const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
      actual = new Uint8Array(
        await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, material, 256),
      );
    } else return false;
    let difference = actual.length ^ expected.length;
    for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ (expected[i] || 0);
    actual.fill(0);
    return difference === 0;
  } catch {
    return false;
  }
}
export async function tokenHash(value: string): Promise<string> {
  return encode64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
export function randomToken(): string {
  return encode64(crypto.getRandomValues(new Uint8Array(32)));
}
