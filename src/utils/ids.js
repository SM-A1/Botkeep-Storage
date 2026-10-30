import { randomInt } from 'node:crypto';

// Crockford-style alphabet without look-alikes (no 0/O/1/I/L). 31^6 ≈ 887 million combinations.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Short human-friendly reference such as ABC123. Used for display only — it never grants access. */
export function shortRef(length = 6) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export const REF_RE = /^[A-HJKMNP-Z2-9]{6}$/;
export const isRef = (value) => typeof value === 'string' && REF_RE.test(value);
