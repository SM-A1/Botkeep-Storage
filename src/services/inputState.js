import { redis } from './redis.js';

// "What is this user typing next?" (rename, password, search, ...). Lives in Redis so it works
// across restarts and replicas; it is transient and expires on its own.
const key = (uid) => `await:${uid}`;
const TTL_SECONDS = 300;

export const setAwait = (uid, state) => redis.set(key(uid), JSON.stringify(state), 'EX', TTL_SECONDS);

export async function getAwait(uid) {
  const raw = await redis.get(key(uid));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const clearAwait = (uid) => redis.del(key(uid));
