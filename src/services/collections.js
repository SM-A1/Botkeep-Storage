import { config } from '../config.js';
import { redis } from './redis.js';
import { K } from './keys.js';
import { generateToken, isValidToken } from './tokens.js';
import { deleteFile, getFiles, isExpired } from './files.js';
import { shortRef, isRef } from '../utils/ids.js';
import { formatDay } from '../utils/time.js';

// A collection is ONE upload batch: N files that share ONE public link.
//   coll:<id>     [A] hash  ownerId, title, ref, shareToken, fileCount, totalSize, createdAt, updatedAt, status
//   collf:<id>    [A] zset  file ids (score = position in the upload)
//   cshare:<tok>  [A] hash  collId, ownerId, createdAt, expiresAt, status (active|disabled), disabledBy, downloads, lastAccessAt
//   file:<id>.coll          the collection a file belongs to (files stay normal, private files of their owner)
// Derived: ucoll:<uid> / colls:all (lists), collref:<ref> (short id), gstats/ustats counters.
// Share tokens and collection ids are 192-bit random values (same generator as file links).

export function cleanTitle(input, fallback = '') {
  let s = String(input ?? '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  if (chars.length > config.collections.titleMax) s = chars.slice(0, config.collections.titleMax).join('').trim();
  return s || fallback;
}

export const defaultTitle = (now = Date.now()) => `Collection · ${formatDay(now)}`;

export function parseCollection(id, h) {
  if (!h || !h.ownerId || !h.shareToken) return null;
  return {
    id,
    ref: h.ref || '',
    ownerId: Number(h.ownerId),
    title: h.title || defaultTitle(Number(h.createdAt) || Date.now()),
    shareToken: h.shareToken,
    fileCount: Math.max(0, Number(h.fileCount) || 0),
    totalSize: Math.max(0, Number(h.totalSize) || 0),
    createdAt: Number(h.createdAt) || 0,
    updatedAt: Number(h.updatedAt) || 0,
    status: h.status || 'active',
  };
}

export function parseCShare(token, h) {
  if (!h || !h.collId || !h.ownerId) return null;
  return {
    token,
    collId: h.collId,
    ownerId: Number(h.ownerId),
    createdAt: Number(h.createdAt) || 0,
    expiresAt: Number(h.expiresAt) || 0,
    status: h.status === 'disabled' ? 'disabled' : 'active',
    disabledBy: h.disabledBy || '',
    downloads: Number(h.downloads) || 0,
    lastAccessAt: Number(h.lastAccessAt) || 0,
  };
}

/** active | disabled | expired */
export function linkState(share, now = Date.now()) {
  if (!share) return 'disabled';
  if (share.status === 'disabled') return 'disabled';
  if (share.expiresAt > 0 && now >= share.expiresAt) return 'expired';
  return 'active';
}

async function reserveRef(collId) {
  for (let i = 0; i < 12; i += 1) {
    const ref = shortRef();
    if ((await redis.set(K.collRef(ref), collId, 'NX')) === 'OK') return ref;
  }
  throw new Error('could not allocate a unique collection reference');
}

/**
 * Groups already-stored files of one owner into a new collection with ONE share link.
 * Files that are missing, foreign or already in a collection are ignored.
 */
export async function createCollection({ ownerId, fileIds, title = '', now = Date.now() }) {
  const metas = (await getFiles([...new Set(fileIds)].slice(0, config.collections.maxFiles)))
    .filter((m) => m && m.uploaderId === ownerId && !m.collectionId);
  if (metas.length === 0) return { result: 'empty' };

  const id = generateToken();
  const token = generateToken();
  const ref = await reserveRef(id);
  const total = metas.reduce((sum, m) => sum + m.size, 0);
  const fields = {
    ownerId: String(ownerId), title: cleanTitle(title, defaultTitle(now)), ref, shareToken: token,
    fileCount: String(metas.length), totalSize: String(total), createdAt: String(now), updatedAt: String(now), status: 'active',
  };
  try {
    const multi = redis.multi();
    multi.hset(K.coll(id), fields);
    metas.forEach((m, i) => {
      multi.zadd(K.collFiles(id), i + 1, m.id);
      multi.hsetIfExists(K.file(m.id), 'coll', id); // never resurrects a file deleted in the meantime
    });
    multi.hset(K.cshare(token), { collId: id, ownerId: String(ownerId), createdAt: String(now), expiresAt: '0', status: 'active', downloads: '0' });
    multi.zadd(K.userColls(ownerId), now, id).zadd(K.allColls, now, id);
    multi.hincrby(K.gstats, 'colls', 1).hincrby(K.gstats, 'collFiles', metas.length).hincrby(K.gstats, 'collBytes', total);
    multi.hincrby(K.ustats(ownerId), 'colls', 1);
    const res = await multi.exec();
    if (!res || res.some(([e]) => e)) throw new Error('collection transaction failed');
  } catch (err) {
    await redis.del(K.collRef(ref)).catch(() => {});
    throw err;
  }
  const collection = parseCollection(id, fields);
  const share = parseCShare(token, { collId: id, ownerId: String(ownerId), createdAt: String(now), expiresAt: '0', status: 'active', downloads: '0' });
  return { result: 'created', collection, share, files: metas };
}

export async function getCollection(id) {
  if (!isValidToken(id)) return null;
  return parseCollection(id, await redis.hgetall(K.coll(id)));
}

export async function getCollectionByRef(ref) {
  if (!isRef(ref)) return null;
  const id = await redis.get(K.collRef(ref));
  return id ? getCollection(id) : null;
}

export async function getCShare(token) {
  if (!isValidToken(token)) return null;
  return parseCShare(token, await redis.hgetall(K.cshare(token)));
}

/**
 * Public access check for a collection link. `reason` is for logs; the web page maps it to a message.
 * ok | invalid | not_found | disabled | expired
 */
export async function resolveCollectionShare(token) {
  if (!isValidToken(token)) return { ok: false, reason: 'invalid' };
  const share = await getCShare(token);
  if (!share) return { ok: false, reason: 'not_found' };
  const collection = await getCollection(share.collId);
  if (!collection) return { ok: false, reason: 'not_found' };
  const state = linkState(share);
  if (state !== 'active') return { ok: false, reason: state, share, collection };
  return { ok: true, share, collection };
}

/** Ordered file metadata of a collection. Stale members (files deleted behind our back) are pruned and counters fixed. */
export async function loadCollectionFiles(collection) {
  const ids = await redis.zrange(K.collFiles(collection.id), 0, -1);
  const metas = await getFiles(ids);
  const files = [];
  const stale = [];
  metas.forEach((m, i) => {
    if (m && m.collectionId === collection.id) files.push(m);
    else stale.push(ids[i]);
  });
  if (stale.length) {
    const total = files.reduce((s, f) => s + f.size, 0);
    await redis.multi()
      .zrem(K.collFiles(collection.id), ...stale)
      .hsetIfExists(K.coll(collection.id), 'fileCount', String(files.length))
      .hsetIfExists(K.coll(collection.id), 'totalSize', String(total))
      .exec();
    if (files.length === 0) await onCollectionFileRemoved(collection.id).catch(() => {});
  }
  return files;
}

/** True when `fileId` belongs to the collection (cheap membership test used by the public file routes). */
export async function isMember(collId, fileId) {
  return (await redis.zscore(K.collFiles(collId), fileId)) !== null;
}

export function publicFileState(file, now = Date.now()) {
  if (isExpired(file, now)) return 'expired';
  if (file.hasPassword) return 'protected';
  return 'ok';
}

async function loadCollections(ids) {
  if (ids.length === 0) return [];
  const pipe = redis.pipeline();
  for (const id of ids) pipe.hgetall(K.coll(id));
  const rows = await pipe.exec();
  const shares = redis.pipeline();
  const parsed = rows.map(([err, h], i) => (err ? null : parseCollection(ids[i], h)));
  for (const c of parsed) if (c) shares.hgetall(K.cshare(c.shareToken));
  const shareRows = parsed.some(Boolean) ? await shares.exec() : [];
  let k = 0;
  return parsed.map((c) => {
    if (!c) return null;
    const share = parseCShare(c.shareToken, shareRows[k][1]);
    k += 1;
    return { collection: c, share, state: linkState(share) };
  });
}

async function listFromIndex(zkey, page, pageSize, onStale) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const total = await redis.zcard(zkey);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const current = Math.min(Math.max(1, page), totalPages);
    if (total === 0) return { items: [], page: 1, totalPages: 1, total: 0 };
    const start = (current - 1) * pageSize;
    const ids = await redis.zrevrange(zkey, start, start + pageSize - 1);
    const loaded = await loadCollections(ids);
    const stale = ids.filter((_, i) => !loaded[i]);
    if (stale.length) { await onStale(stale); continue; }
    return { items: loaded, page: current, totalPages, total };
  }
  return { items: [], page: 1, totalPages: 1, total: 0 };
}

/** "My Collections": newest first. items: [{ collection, share, state }] */
export const listUserCollections = (userId, page = 1, pageSize = config.filesPerPage) =>
  listFromIndex(K.userColls(userId), page, pageSize, (stale) => redis.zrem(K.userColls(userId), ...stale));

/** Admin: every collection, newest first. */
export const listAllCollections = (page = 1, pageSize = config.filesPerPage) =>
  listFromIndex(K.allColls, page, pageSize, (stale) => redis.zrem(K.allColls, ...stale));

export const countUserCollections = (userId) => redis.zcard(K.userColls(userId));

export async function getCollectionStats() {
  const h = (await redis.hgetall(K.gstats)) ?? {};
  return { collections: Math.max(0, Number(h.colls) || 0), files: Math.max(0, Number(h.collFiles) || 0), bytes: Math.max(0, Number(h.collBytes) || 0) };
}

export async function renameCollection(id, title) {
  const clean = cleanTitle(title);
  if (!clean) return null;
  const applied = await redis.hsetIfExists(K.coll(id), 'title', clean);
  if (!applied) return null;
  await redis.hsetIfExists(K.coll(id), 'updatedAt', String(Date.now()));
  return clean;
}

/**
 * Enables/disables the public link. A link disabled by an admin can only be re-enabled by an admin.
 * by: 'owner' | 'admin'
 */
export async function setLinkStatus(collection, status, by) {
  const share = await getCShare(collection.shareToken);
  if (!share) return { result: 'not_found' };
  if (status === 'active' && share.status === 'disabled' && share.disabledBy === 'admin' && by !== 'admin') return { result: 'locked' };
  const fields = status === 'active' ? { status: 'active', disabledBy: '' } : { status: 'disabled', disabledBy: by };
  await redis.multi().hset(K.cshare(share.token), fields).hsetIfExists(K.coll(collection.id), 'updatedAt', String(Date.now())).exec();
  return { result: 'ok', share: { ...share, ...fields } };
}

export async function setLinkExpiry(collection, expiresAt) {
  const share = await getCShare(collection.shareToken);
  if (!share) return null;
  await redis.multi().hset(K.cshare(share.token), 'expiresAt', String(expiresAt)).hsetIfExists(K.coll(collection.id), 'updatedAt', String(Date.now())).exec();
  return { ...share, expiresAt };
}

/** Counts one download action of the collection link (a file, or the whole ZIP) and stamps the last activity. */
export async function recordCollectionAccess(token) {
  await Promise.all([redis.incrDownloadsIfExists(K.cshare(token)), redis.hsetIfExists(K.cshare(token), 'lastAccessAt', String(Date.now()))]);
}

/** Removes every record of a collection. The DEL of the main hash is the atomic claim: only one caller wins. */
async function dropCollection(collection) {
  const removed = await redis.del(K.coll(collection.id));
  if (removed === 0) return null;
  const ids = await redis.zrange(K.collFiles(collection.id), 0, -1);
  const metas = await getFiles(ids);
  const present = metas.filter(Boolean);
  const bytes = present.reduce((s, m) => s + m.size, 0);
  const multi = redis.multi();
  for (const m of present) if (m.collectionId === collection.id) multi.hdel(K.file(m.id), 'coll');
  multi.del(K.collFiles(collection.id), K.cshare(collection.shareToken), K.collRef(collection.ref));
  multi.zrem(K.userColls(collection.ownerId), collection.id).zrem(K.allColls, collection.id);
  multi.hincrby(K.gstats, 'colls', -1).hincrby(K.gstats, 'collFiles', -present.length).hincrby(K.gstats, 'collBytes', -bytes);
  multi.hincrby(K.ustats(collection.ownerId), 'colls', -1);
  await multi.exec();
  return present;
}

/**
 * Deletes a collection and its share link. withFiles=false keeps the files (they become normal files again);
 * withFiles=true also deletes every file with the normal file deletion (indexes, counters, file links).
 * The copies in the storage channel are never touched.
 */
export async function deleteCollection(id, { actorId, isAdmin = false, withFiles = false }) {
  const collection = await getCollection(id);
  if (!collection) return { result: 'not_found' };
  if (collection.ownerId !== actorId && !isAdmin) return { result: 'forbidden' };
  const files = await dropCollection(collection);
  if (!files) return { result: 'not_found' };
  let filesDeleted = 0;
  if (withFiles) {
    for (const f of files) {
      const out = await deleteFile(f.id, { id: actorId, isAdmin: true });
      if (out.result === 'deleted') filesDeleted += 1;
    }
  }
  return { result: 'deleted', collection, fileCount: files.length, filesDeleted };
}

/** Called after a file left a collection: an empty collection is removed together with its link. */
export async function onCollectionFileRemoved(collId) {
  if ((await redis.zcard(K.collFiles(collId))) > 0) return;
  const collection = await getCollection(collId);
  if (collection) await dropCollection(collection);
}

/** Per-category counts of a file list, e.g. { photo: 3, video: 2 } (for the summary line). */
export function categoryCounts(files) {
  const out = {};
  for (const f of files) out[f.cat] = (out[f.cat] ?? 0) + 1;
  return out;
}
