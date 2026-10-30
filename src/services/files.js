import { config } from '../config.js';
import { logger } from '../logger.js';
import { redis } from './redis.js';
import { K } from './keys.js';
import { generateToken, isValidToken } from './tokens.js';
import { incrementDownloads } from './state.js';
import { getSettings } from './users.js';
import { applyFileIndexes, applySearchIndex, applyStats } from './indexing.js';
import { audit } from './audit.js';
import { categorize, isCategory } from '../utils/category.js';
import { shortRef } from '../utils/ids.js';

// Redis layout: see keys.js. The metadata hash `file:<id>` keeps the original v1 fields
// (messageId, fileId, name, type, size, mime, uploaderId, uploadedAt, downloads, expiresAt, purged)
// and adds: ref, cat, folder, pwHash, pwAt, expiredAt.
// Nothing here ever deletes or touches messages in the storage channel.
const MAX_FOLDERS = 30;

export function parseMeta(id, hash) {
  if (!hash || !hash.fileId || !hash.messageId || !hash.name || !hash.uploaderId) return null;
  const name = hash.name;
  const mime = hash.mime || '';
  const type = hash.type || 'document';
  return {
    id,
    ref: hash.ref || '',
    messageId: Number(hash.messageId),
    fileId: hash.fileId, // Telegram's file_id — internal, never shown to users
    name,
    type,
    size: Number(hash.size) || 0,
    mime,
    uploaderId: Number(hash.uploaderId),
    uploadedAt: Number(hash.uploadedAt) || 0,
    downloads: Number(hash.downloads) || 0,
    expiresAt: Number(hash.expiresAt) || 0,
    purged: hash.purged === '1', // legacy flag: channel copy was removed by an older version
    cat: isCategory(hash.cat) ? hash.cat : categorize({ type, mime, name }),
    folder: hash.folder || '',
    hasPassword: Boolean(hash.pwHash),
    collectionId: hash.coll || '', // set when the file belongs to a collection (see collections.js)
  };
}

export const isExpired = (meta, now = Date.now()) => meta.purged || (meta.expiresAt > 0 && now >= meta.expiresAt);

/** Owner/admin download rule: expired files stay accessible unless EXPIRED_OWNER_ACCESS=false. */
export const canOwnerDownload = (meta, now = Date.now()) => !meta.purged && (!isExpired(meta, now) || config.expiredOwnerAccess);

function assertExec(results) {
  if (!results) throw new Error('Redis transaction aborted');
  for (const [err] of results) if (err) throw err;
}

async function reserveRef(fileId) {
  for (let i = 0; i < 12; i += 1) {
    const ref = shortRef();
    if ((await redis.set(K.ref(ref), fileId, 'NX')) === 'OK') return ref;
  }
  throw new Error('could not allocate a unique file reference');
}

export async function createFile({ fileId, messageId, name, type, size, mime, uploaderId }) {
  const id = generateToken();
  const now = Date.now();
  const { fileExp } = await getSettings(uploaderId);
  const expiresAt = fileExp > 0 ? now + fileExp * 1000 : 0;
  const ref = await reserveRef(id);
  const cat = categorize({ type, mime, name });

  const fields = {
    messageId: String(messageId), fileId, name, type, size: String(size), mime,
    uploaderId: String(uploaderId), uploadedAt: String(now), downloads: '0', expiresAt: String(expiresAt),
    ref, cat, folder: '',
  };
  const meta = parseMeta(id, fields);
  try {
    const multi = redis.multi().hset(K.file(id), fields);
    applyFileIndexes(multi, meta, 'add');
    applyStats(multi, meta, 1);
    assertExec(await multi.exec());
  } catch (err) {
    await redis.del(K.ref(ref)).catch(() => {});
    throw err;
  }
  return meta;
}

/** Resolve a file id to { status: 'ok' | 'expired' | 'not_found' | 'invalid', meta? }. */
export async function getFileRecord(id) {
  if (!isValidToken(id)) return { status: 'invalid' };
  const meta = parseMeta(id, await redis.hgetall(K.file(id)));
  if (!meta) return { status: 'not_found' };
  if (isExpired(meta)) return { status: 'expired', meta };
  return { status: 'ok', meta };
}

export async function getFileByRef(ref) {
  const id = await redis.get(K.ref(ref));
  if (!id) return null;
  const meta = parseMeta(id, await redis.hgetall(K.file(id)));
  return meta;
}

export async function getFiles(ids) {
  if (ids.length === 0) return [];
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.hgetall(K.file(id));
  const rows = await pipeline.exec();
  return rows.map(([err, h], i) => (err ? null : parseMeta(ids[i], h)));
}

export async function recordDownload(id) {
  try {
    await Promise.all([redis.incrDownloadsIfExists(K.file(id)), incrementDownloads()]);
  } catch (err) {
    logger.warn('failed to record download', { err });
  }
}

/**
 * Paginated listing from an index: cat = 'all' | category name, or folder = folderId.
 * Expired files are listed (and marked by the caller); stale index entries are pruned as we go.
 */
export async function listFiles(userId, { cat = 'all', folder = null, page = 1, pageSize = config.filesPerPage, prefetch = null } = {}) {
  const zkey = folder ? K.userFolder(userId, folder) : cat === 'all' ? K.userFiles(userId) : K.userCat(userId, cat);
  let result = { items: [], page: 1, totalPages: 1, total: 0, extra: null };
  let wanted = Math.max(1, page);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    // One round trip: total count and the requested page together.
    const start = (wanted - 1) * pageSize;
    const [[, total], [, ids]] = await redis.pipeline().zcard(zkey).zrevrange(zkey, start, start + pageSize - 1).exec();
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (wanted > totalPages) { wanted = totalPages; continue; } // asked for a page past the end
    result = { items: [], page: wanted, totalPages, total, extra: null };
    if (total === 0 || ids.length === 0) return result;

    // Metadata and any caller-supplied lookups (e.g. share links) travel together.
    const [metas, extra] = await Promise.all([getFiles(ids), prefetch ? prefetch(ids) : null]);
    const stale = [];
    metas.forEach((meta, i) => {
      if (!meta) stale.push(ids[i]);
      else result.items.push(meta);
    });
    result.extra = extra;
    if (stale.length === 0) return result;
    const multi = redis.multi();
    for (const id of stale) multi.zrem(K.userFiles(userId), id).zrem(zkey, id);
    await multi.exec(); // counts changed: recompute the page
  }
  return result;
}

/** Backwards-compatible alias of the v1 API. */
export const listUserFiles = (userId, page, pageSize) => listFiles(userId, { page, pageSize });

/**
 * Delete a file for the user: metadata, list entries, search index and ALL its share links are removed
 * permanently. The copy in the storage channel is intentionally left untouched.
 * The DEL on the metadata hash is the atomic claim: only one caller wins.
 */
export async function deleteFile(id, { id: actorId, isAdmin = false }) {
  if (!isValidToken(id)) return { result: 'invalid' };
  const meta = parseMeta(id, await redis.hgetall(K.file(id)));
  if (!meta) return { result: 'not_found' };
  if (meta.uploaderId !== actorId && !isAdmin) return { result: 'forbidden' };

  const removed = await redis.del(K.file(id));
  if (removed === 0) return { result: 'not_found' };

  const tokens = await redis.smembers(K.fileShares(id));
  const multi = redis.multi();
  applyFileIndexes(multi, meta, 'remove');
  applyStats(multi, meta, -1);
  for (const token of tokens) multi.del(K.share(token)).zrem(K.userShares(meta.uploaderId), token);
  multi.del(K.fileShares(id));
  if (meta.ref) multi.del(K.ref(meta.ref));
  if (meta.collectionId) {
    // The file leaves its collection; the collection's counters follow (only while the collection exists).
    multi.zrem(K.collFiles(meta.collectionId), id);
    multi.collAdjust(K.coll(meta.collectionId), -1, -meta.size, Date.now());
    multi.hincrby(K.gstats, 'collFiles', -1).hincrby(K.gstats, 'collBytes', -meta.size);
  }
  multi.expire(K.hist(id), 180 * 86_400); // history of a deleted file is kept for 6 months, then ages out
  await multi.exec();
  if (meta.collectionId) {
    // A collection without files disappears together with its share link (dynamic import: no import cycle).
    const { onCollectionFileRemoved } = await import('./collections.js');
    await onCollectionFileRemoved(meta.collectionId).catch((err) => logger.warn('collection cleanup failed', { err }));
  }
  return { result: 'deleted', meta, linksRemoved: tokens.length };
}

export async function renameFile(id, newName) {
  const meta = parseMeta(id, await redis.hgetall(K.file(id)));
  if (!meta) return null;
  const multi = redis.multi().hset(K.file(id), 'name', newName);
  applySearchIndex(multi, meta, meta.name, 'remove');
  applySearchIndex(multi, { ...meta, name: newName }, newName, 'add');
  assertExec(await multi.exec());
  return { ...meta, name: newName };
}

export async function moveFile(id, folderId) {
  const meta = parseMeta(id, await redis.hgetall(K.file(id)));
  if (!meta) return null;
  const multi = redis.multi().hset(K.file(id), 'folder', folderId || '');
  if (meta.folder) multi.zrem(K.userFolder(meta.uploaderId, meta.folder), id);
  if (folderId) multi.zadd(K.userFolder(meta.uploaderId, folderId), meta.uploadedAt, id);
  assertExec(await multi.exec());
  return { ...meta, folder: folderId || '' };
}

export async function setFileExpiry(id, expiresAt) {
  const applied = await redis.hsetIfExists(K.file(id), 'expiresAt', String(expiresAt));
  if (!applied) return false;
  const multi = redis.multi().hdel(K.file(id), 'expiredAt');
  if (expiresAt > 0) multi.zadd(K.expFiles, expiresAt, id);
  else multi.zrem(K.expFiles, id);
  await multi.exec();
  return true;
}

export async function setFilePassword(id, hashOrNull) {
  if (!(await redis.exists(K.file(id)))) return false;
  if (hashOrNull) await redis.hset(K.file(id), { pwHash: hashOrNull, pwAt: String(Date.now()) });
  else await redis.hdel(K.file(id), 'pwHash', 'pwAt');
  return true;
}

export const getPasswordHash = async (id) => (await redis.hget(K.file(id), 'pwHash')) || null;

// ---- Folders ----
export async function listFolders(userId) {
  const raw = await redis.hgetall(K.folders(userId));
  const entries = Object.entries(raw).sort((a, b) => a[1].localeCompare(b[1]));
  const pipeline = redis.pipeline();
  for (const [fid] of entries) pipeline.zcard(K.userFolder(userId, fid));
  const counts = entries.length ? await pipeline.exec() : [];
  return entries.map(([fid, name], i) => ({ id: fid, name, count: Number(counts[i]?.[1]) || 0 }));
}

export async function createFolder(userId, name) {
  if ((await redis.hlen(K.folders(userId))) >= MAX_FOLDERS) return { result: 'limit' };
  const existing = await redis.hgetall(K.folders(userId));
  const dup = Object.entries(existing).find(([, n]) => n.toLowerCase() === name.toLowerCase());
  if (dup) return { result: 'exists', id: dup[0] };
  const fid = generateToken().slice(0, 8);
  await redis.hset(K.folders(userId), fid, name);
  return { result: 'created', id: fid };
}

export const getFolderName = async (userId, fid) => (await redis.hget(K.folders(userId), fid)) || null;

export async function countFiles() {
  const fromStats = await redis.hget(K.gstats, 'files');
  if (fromStats !== null) return Math.max(0, Number(fromStats));
  let cursor = '0';
  let total = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'file:*', 'COUNT', 500);
    cursor = next;
    total += keys.length;
  } while (cursor !== '0');
  return total;
}

/** Marks files whose expiry passed (audit + index cleanup). Links/availability are enforced at access time. */
export async function sweepExpiredFiles(limit = 200) {
  const lock = await redis.set('lock:expiry', '1', 'EX', 50, 'NX');
  if (lock !== 'OK') return 0;
  const now = Date.now();
  const ids = await redis.zrangebyscore(K.expFiles, '-inf', now, 'LIMIT', 0, limit);
  let marked = 0;
  for (const id of ids) {
    const meta = parseMeta(id, await redis.hgetall(K.file(id)));
    if (!meta) { await redis.zrem(K.expFiles, id); continue; }
    if (meta.expiresAt > 0 && meta.expiresAt <= now) {
      await redis.multi().hset(K.file(id), 'expiredAt', String(now)).zrem(K.expFiles, id).exec();
      await audit('file_expired', { actorId: 0, file: meta });
      marked += 1;
    } else {
      await redis.zadd(K.expFiles, meta.expiresAt, id); // expiry was extended meanwhile
    }
  }
  return marked;
}

export function startExpirySweeper() {
  const run = () => sweepExpiredFiles().catch((err) => logger.error('expiry sweep failed', { err }));
  const first = setTimeout(run, 20_000);
  const timer = setInterval(run, 60_000);
  first.unref();
  timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}
