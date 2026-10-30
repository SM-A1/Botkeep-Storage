import { config } from '../config.js';
import { redis } from './redis.js';

// An "upload batch" groups the files a user sends in one go. Two modes:
//   auto    files that arrive together (an album, a multi-select, several messages within the quiet window)
//   manual  the user pressed "Multiple files" and sends files at their own pace, then taps "Create link"
// Every file is stored immediately as a normal file (so nothing is lost if the process restarts); the batch only
// remembers WHICH files belong together. When it ends (quiet period / Create link / idle timeout):
//   1 file -> the usual file card,  2+ files -> ONE collection with ONE share link.
//
//   upl:<uid>      hash  status (message id of the status message), mode, group (album id), failed, skipped, dup, errRef
//   upl:<uid>:f    list  stored file ids in arrival order
//   upl:<uid>:u    set   Telegram file_unique_ids already in this batch (duplicate protection)
//   upl:open       zset  user ids with an open batch, scored by the time the sweeper may finalize it
//   updup:<uid>:<message_id>  string  update already processed (Telegram re-delivery protection)
// All of it is transient (never backed up) and expires on its own.

const hkey = (uid) => `upl:${uid}`;
const fkey = (uid) => `upl:${uid}:f`;
const ukey = (uid) => `upl:${uid}:u`;
export const OPEN_SET = 'upl:open';
const TTL = 6 * 3600;
export const MANUAL_IDLE_MS = 30 * 60_000; // a manual session nobody finishes is closed after 30 idle minutes
const dueAt = (mode) => Date.now() + (mode === 'manual' ? MANUAL_IDLE_MS : config.collections.batchStaleSeconds * 1000);

/** True the first time a message is seen; false for a re-delivered update. */
export async function claimMessage(uid, messageId) {
  return (await redis.set(`updup:${uid}:${messageId}`, '1', 'EX', 3600, 'NX')) === 'OK';
}

/** { status, mode, group, bytes } of the open batch, or null. */
export async function getBatch(uid) {
  const [status, mode, group, bytes] = await redis.hmget(hkey(uid), 'status', 'mode', 'group', 'bytes');
  if (!status && !mode) return null;
  return { status: status ? Number(status) : null, mode: mode || 'auto', group: group || '', bytes: Number(bytes) || 0 };
}

/**
 * Duplicate protection: the same Telegram file (file_unique_id) is only accepted once per batch.
 * Returns false when it is already in the batch (the caller counts it as a duplicate and stores nothing).
 */
export async function claimUnique(uid, uniqueId) {
  if (!uniqueId) return true;
  const added = (await redis.sadd(ukey(uid), uniqueId)) === 1;
  if (added) await redis.expire(ukey(uid), TTL);
  return added;
}

export const releaseUnique = (uid, uniqueId) => (uniqueId ? redis.srem(ukey(uid), uniqueId) : null);

export async function addDuplicate(uid, { mode = 'auto', group = '' } = {}) {
  const m = redis.multi().hincrby(hkey(uid), 'dup', 1);
  touch(m, uid, mode, group);
  await m.exec();
}

export async function openBatch(uid, { mode = 'auto', statusMessageId = null, group = '' } = {}) {
  const now = Date.now();
  const fields = { mode, startedAt: String(now), lastAt: String(now), group };
  if (statusMessageId) fields.status = String(statusMessageId);
  await redis.multi().hset(hkey(uid), fields).expire(hkey(uid), TTL).zadd(OPEN_SET, dueAt(mode), String(uid)).exec();
}

export const setBatchStatus = (uid, statusMessageId) => redis.hset(hkey(uid), 'status', String(statusMessageId));

/** Number of files waiting in the open batch. */
export const batchSize = (uid) => redis.llen(fkey(uid));

function touch(multi, uid, mode, group) {
  multi.hset(hkey(uid), 'lastAt', String(Date.now()));
  if (group) multi.hset(hkey(uid), 'group', group);
  multi.expire(hkey(uid), TTL).zadd(OPEN_SET, dueAt(mode), String(uid));
}

/** Remembers a stored file. Returns the number of files now in the batch. */
export async function addToBatch(uid, fileId, size, { mode = 'auto', group = '' } = {}) {
  const m = redis.multi().rpush(fkey(uid), fileId).expire(fkey(uid), TTL).hincrby(hkey(uid), 'bytes', Math.max(0, size));
  touch(m, uid, mode, group);
  const res = await m.exec();
  return Number(res?.[0]?.[1]) || 1;
}

/** Counts a file that could not be stored (reported once, in the batch summary). kind: 'failed' | 'skipped' */
export async function addProblem(uid, kind, errRef = '', { mode = 'auto', group = '' } = {}) {
  const m = redis.multi().hincrby(hkey(uid), kind === 'failed' ? 'failed' : 'skipped', 1);
  if (errRef) m.hset(hkey(uid), 'errRef', errRef);
  touch(m, uid, mode, group);
  await m.exec();
}

/**
 * Atomically takes the batch (the DEL inside the transaction is the claim): returns null when somebody else
 * already finalized it, otherwise { fileIds, status, mode, failed, skipped, dup, errRef }.
 */
export async function claimBatch(uid) {
  const res = await redis.multi()
    .hgetall(hkey(uid)).lrange(fkey(uid), 0, -1)
    .del(hkey(uid), fkey(uid), ukey(uid)).zrem(OPEN_SET, String(uid))
    .exec();
  if (!res) return null;
  const h = res[0][1] ?? {};
  const fileIds = res[1][1] ?? [];
  if ((Number(res[2][1]) || 0) === 0 && fileIds.length === 0) return null;
  return {
    fileIds,
    status: h.status ? Number(h.status) : null,
    mode: h.mode === 'manual' ? 'manual' : 'auto',
    failed: Number(h.failed) || 0,
    skipped: Number(h.skipped) || 0,
    dup: Number(h.dup) || 0,
    errRef: h.errRef || '',
  };
}

/** Users whose batch is overdue (crash recovery: a lost timer must never strand files in a half-open batch). */
export async function dueBatches(limit = 20) {
  const ids = await redis.zrangebyscore(OPEN_SET, '-inf', Date.now(), 'LIMIT', 0, limit);
  return ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
}

/** Splits file ids into collections of at most config.collections.maxFiles. */
export function chunk(ids, size = config.collections.maxFiles) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
