import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt (memory-hard, built into Node — no native dependency to break on deploy).
// Stored as: scrypt$N$r$p$salt$hash  (salt and hash are base64url). Plain-text passwords are never stored or logged.
const N = 32_768;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 128 * 1024 * 1024;

export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 64;

const derive = (password, salt, n, r, p) =>
  new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });

export function validatePassword(password) {
  if (typeof password !== 'string') return 'Please send the password as text.';
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (!password.trim()) return 'The password cannot be empty.';
  return null;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const nn = Number(n); const rr = Number(r); const pp = Number(p);
    if (!(nn >= 1024 && nn <= 1_048_576) || rr > 16 || pp > 4) return false;
    const expected = Buffer.from(hash, 'base64url');
    const actual = await derive(String(password), Buffer.from(salt, 'base64url'), nn, rr, pp);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
