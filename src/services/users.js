import { config } from '../config.js';
import { logger } from '../logger.js';
import { redis } from './redis.js';
import { K } from './keys.js';

// Persistent user profile keyed by the numeric Telegram user ID (usernames are only an alias).
const touchCache = new Map(); // uid -> { at, username, name }  (throttles writes: ≤ 1 per minute per user)
const TOUCH_INTERVAL_MS = 60_000;
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;

const cleanName = (from) => [from.first_name, from.last_name].filter(Boolean).join(' ').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64);

/** Creates or refreshes the profile. Returns { isNew }. Never throws into the caller's flow. */
export async function touchUser(from) {
  const uid = from.id;
  const username = (from.username ?? '').toLowerCase();
  const name = cleanName(from);
  const now = Date.now();
  const cached = touchCache.get(uid);
  if (cached && now - cached.at < TOUCH_INTERVAL_MS && cached.username === username && cached.name === name) return { isNew: false };
  if (cached) {
    // Known user: refresh in the background so the update is not delayed by two Redis round trips.
    cached.at = now;
    writeProfile(from, uid, username, name, now).catch(logUserError);
    return { isNew: false };
  }
  return writeProfile(from, uid, username, name, now);
}

async function writeProfile(from, uid, username, name, now) {
  const [prevUsername, createdAt] = await redis.hmget(K.profile(uid), 'username', 'createdAt');
  const isNew = !createdAt;
  const multi = redis.multi();
  multi.sadd(K.users, String(uid)); // legacy index, still used by /broadcast
  multi.hsetnx(K.profile(uid), 'createdAt', String(now));
  multi.hset(K.profile(uid), { id: String(uid), username, name, lastActive: String(now) });
  multi.zadd(K.usersActive, now, String(uid));
  if (isNew) multi.zadd(K.usersCreated, now, String(uid));
  if (prevUsername && prevUsername !== username) multi.del(K.uname(prevUsername));
  if (USERNAME_RE.test(username)) multi.set(K.uname(username), String(uid));
  const results = await multi.exec();
  if (!results) throw new Error('profile transaction aborted');
  touchCache.set(uid, { at: now, username, name });
  if (touchCache.size > 20_000) touchCache.clear();
  return { isNew };
}

export async function getProfile(uid) {
  const h = await redis.hgetall(K.profile(uid));
  if (!h || !h.id) return null;
  return {
    id: Number(h.id),
    username: h.username || '',
    name: h.name || '',
    createdAt: Number(h.createdAt) || 0,
    lastActive: Number(h.lastActive) || 0,
    fileCount: Math.max(0, Number(h.fileCount) || 0),
    storageUsed: Math.max(0, Number(h.storageUsed) || 0),
    settings: {
      fileExp: h['set:fileExp'] !== undefined ? Number(h['set:fileExp']) || 0 : config.fileTtlSeconds,
      shareExp: Number(h['set:shareExp']) || 0,
    },
  };
}

export async function getSettings(uid) {
  const [fileExp, shareExp] = await redis.hmget(K.profile(uid), 'set:fileExp', 'set:shareExp');
  return {
    fileExp: fileExp !== null ? Number(fileExp) || 0 : config.fileTtlSeconds,
    shareExp: Number(shareExp) || 0,
  };
}

export async function updateSettings(uid, patch) {
  const fields = {};
  if (patch.fileExp !== undefined) fields['set:fileExp'] = String(Math.max(0, Math.floor(patch.fileExp)));
  if (patch.shareExp !== undefined) fields['set:shareExp'] = String(Math.max(0, Math.floor(patch.shareExp)));
  if (Object.keys(fields).length) await redis.hset(K.profile(uid), fields);
}

export async function resolveUserId(input) {
  const raw = String(input ?? '').trim();
  if (/^\d{1,15}$/.test(raw)) return Number(raw);
  const name = raw.replace(/^@/, '').toLowerCase();
  if (!USERNAME_RE.test(name)) return null;
  const id = await redis.get(K.uname(name));
  return id ? Number(id) : null;
}

export async function userCounts() {
  const now = Date.now();
  const [total, day, week, month] = await Promise.all([
    redis.scard(K.users),
    redis.zcount(K.usersActive, now - 86_400_000, '+inf'),
    redis.zcount(K.usersActive, now - 7 * 86_400_000, '+inf'),
    redis.zcount(K.usersActive, now - 30 * 86_400_000, '+inf'),
  ]);
  return { total, day, week, month };
}

export async function recentUsers(limit = 10) {
  const ids = await redis.zrevrange(K.usersCreated, 0, limit - 1);
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.hgetall(K.profile(id));
  const rows = await pipeline.exec();
  return rows.map(([, h]) => h).filter((h) => h && h.id).map((h) => ({
    id: Number(h.id), username: h.username || '', name: h.name || '', createdAt: Number(h.createdAt) || 0,
    fileCount: Number(h.fileCount) || 0, storageUsed: Number(h.storageUsed) || 0,
  }));
}

export function logUserError(err) {
  logger.warn('profile update failed', { err });
}
