import { randomBytes } from 'node:crypto';

// 24 random bytes -> exactly 32 base64url characters (192 bits of entropy), no padding.
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export const generateToken = () => randomBytes(24).toString('base64url');

/** Strict validation: anything that fails can never reach a Redis key. */
export const isValidToken = (value) => typeof value === 'string' && TOKEN_RE.test(value);

export const isValidTelegramId = (id) => Number.isSafeInteger(id) && id > 0;
