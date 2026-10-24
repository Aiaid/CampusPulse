import { scryptSync, timingSafeEqual } from 'node:crypto';
import { IngestError } from './ingest-validation';

// OWASP's scrypt N=2^15,r=8,p=3 equivalent baseline. Native workerd crypto has
// been exercised with these exact parameters. Require sufficient Worker CPU;
// never silently lower the work factor to fit a free-tier budget.
const N = 32768, R = 8, P = 3, KEY_BYTES = 32, MAX_MEMORY = 64 * 1024 * 1024;
const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const fromHex = (value: string) => Uint8Array.from(value.match(/../g)!, b => parseInt(b, 16));
export const DUMMY_PASSWORD_HASH = `scrypt-v1$${N}$${R}$${P}$${'4d'.repeat(32)}$${'00'.repeat(KEY_BYTES)}`;

export function validatePassword(value: unknown): string {
  if (typeof value !== 'string' || Array.from(value).length < 12 || Array.from(value).length > 256 || encoder.encode(value).byteLength > 1024 ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value))
    throw new IngestError(422, 'invalid_password', 'Use a password of 12–256 Unicode characters, at most 1024 UTF-8 bytes.');
  return value;
}
function derive(password: string, salt: Uint8Array): Uint8Array {
  return scryptSync(encoder.encode(password), salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAX_MEMORY });
}
export function hashPassword(password: string): string {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  return `scrypt-v1$${N}$${R}$${P}$${hex(salt)}$${hex(derive(validatePassword(password), salt))}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const match = /^scrypt-v1\$32768\$8\$3\$([0-9a-f]{64})\$([0-9a-f]{64})$/.exec(stored);
  if (!match) throw new IngestError(503, 'password_storage_invalid', 'Administrator authentication is unavailable.');
  return timingSafeEqual(derive(password, fromHex(match[1])), fromHex(match[2]));
}
