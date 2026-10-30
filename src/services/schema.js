import { config } from '../config.js';
import { logger } from '../logger.js';
import { sleep } from '../lifecycle.js';
import { redis } from './redis.js';
import { K, AUTHORITATIVE_PATTERNS, DERIVED_PATTERNS, DERIVED_FIXED } from './keys.js';
import { generateToken } from './tokens.js';
import { parseMeta } from './files.js';
import { applyFileIndexes } from './indexing.js';
import { categorize } from '../utils/category.js';
import { shortRef, isRef } from '../utils/ids.js';
import { isValidToken } from './tokens.js';

export const CURRENT_SCHEMA = 3;

export class DatabaseGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DatabaseGuardError';
  }
}

// ---------------------------------------------------------------- helpers

async function* scanKeys(pattern, count = 500) {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    cursor = next;
    for (const key of keys) yield key;
  } while (cursor !== '0');
}

async function hasAnyKey(pattern) {
  for await (const key of scanKeys(pattern, 1000)) return Boolean(key);
  return false;
}

/** True when the database contains data written by this application (any version). */
export async function hasApplicationData() {
  if (await redis.exists(K.schema, K.users, K.downloadsTotal, K.audit)) return true;
  for (const pattern of AUTHORITATIVE_PATTERNS) if (await hasAnyKey(pattern)) return true;
  return false;
}

/** Railway-hosted Redis lives and dies with the Railway project — flag it. */
export function railwayHostWarning(url = config.redisUrl) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('.railway.internal') || host.endsWith('.rlwy.net') || host.endsWith('.railway.app')) return host;
  } catch { /* validated in config */ }
  return null;
}

export async function redisPersistenceInfo() {
  try {
    const info = await redis.info('persistence');
    const aof = /aof_enabled:(\d)/.exec(info)?.[1] === '1';
    const rdb = /rdb_last_save_time:(\d+)/.exec(info)?.[1];
    const saveCfg = await redis.config('GET', 'save').catch(() => null);
    return { known: true, aof, rdb: Boolean(rdb) && (!saveCfg || saveCfg[1] !== '' || aof) };
  } catch {
    return { known: false, aof: false, rdb: false }; // managed providers often hide INFO/CONFIG
  }
}

// ---------------------------------------------------------------- collections (schema v3)

/**
 * Rebuilds the derived collection indexes (per-owner and global lists, short refs, counters) from the
 * authoritative records coll:*, collf:* and the files' `coll` field. Counts/sizes of every collection are
 * recomputed from the files that really belong to it. Additive and idempotent: nothing is deleted except
 * stale membership entries that point to files which no longer exist.
 */
export async function rebuildCollectionIndexes() {
  let collections = 0;
  let collFiles = 0;
  let collBytes = 0;
  const perUser = new Map();
  for await (const key of scanKeys('coll:*')) {
    const id = key.slice('coll:'.length);
    if (!isValidToken(id)) continue;
    const h = await redis.hgetall(key);
    if (!h || !h.ownerId || !h.shareToken) continue;
    const ids = await redis.zrange(K.collFiles(id), 0, -1);
    const rows = ids.length ? await (() => { const p = redis.pipeline(); for (const fid of ids) p.hgetall(K.file(fid)); return p.exec(); })() : [];
    let n = 0;
    let bytes = 0;
    const stale = [];
    rows.forEach(([, fh], i) => {
      const meta = parseMeta(ids[i], fh);
      if (meta && meta.collectionId === id) { n += 1; bytes += meta.size; } else stale.push(ids[i]);
    });
    const created = Number(h.createdAt) || Date.now();
    const multi = redis.multi();
    if (stale.length) multi.zrem(K.collFiles(id), ...stale);
    multi.hset(key, { fileCount: String(n), totalSize: String(bytes) });
    if (h.ref && isRef(h.ref)) multi.set(K.collRef(h.ref), id, 'NX');
    multi.zadd(K.userColls(Number(h.ownerId)), created, id).zadd(K.allColls, created, id);
    await multi.exec();
    collections += 1; collFiles += n; collBytes += bytes;
    perUser.set(Number(h.ownerId), (perUser.get(Number(h.ownerId)) ?? 0) + 1);
  }
  const stats = redis.multi().hset(K.gstats, { colls: String(collections), collFiles: String(collFiles), collBytes: String(collBytes) });
  for (const [uid, n] of perUser) stats.hset(K.ustats(uid), 'colls', String(n));
  await stats.exec();
  return { collections, files: collFiles, bytes: collBytes };
}

// ---------------------------------------------------------------- derived index rebuild

/**
 * Rebuilds every derived index (category/folder timelines, search index, share indexes, counters,
 * profiles' counters, username/ref lookups, expiry queue) from the authoritative records.
 * clean=true first deletes the derived keys (safe: they are rebuilt right here). Idempotent.
 */
export async function rebuildIndexes({ clean = false, onProgress = () => {} } = {}) {
  if (clean) {
    for (const pattern of DERIVED_PATTERNS) {
      const batch = [];
      for await (const key of scanKeys(pattern)) {
        batch.push(key);
        if (batch.length >= 500) { await redis.unlink(...batch); batch.length = 0; }
      }
      if (batch.length) await redis.unlink(...batch);
    }
    await redis.unlink(...DERIVED_FIXED);
  }

  const perUser = new Map(); // uid -> { files, bytes, cats }
  const global = { files: 0, bytes: 0, cats: {} };
  const firstUpload = new Map();
  let files = 0;
  let batch = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const pipe = redis.pipeline();
    for (const key of batch) pipe.hgetall(key);
    const rows = await pipe.exec();
    const multi = redis.multi();
    for (let i = 0; i < batch.length; i += 1) {
      const id = batch[i].slice('file:'.length);
      let hash = rows[i][1];
      let meta = parseMeta(id, hash);
      if (!meta) continue;
      const fixes = {};
      if (!meta.ref || !isRef(meta.ref)) {
        let ref = null;
        for (let t = 0; t < 12 && !ref; t += 1) { const c = shortRef(); if ((await redis.set(K.ref(c), id, 'NX')) === 'OK') ref = c; }
        if (!ref) throw new Error('could not allocate file reference');
        fixes.ref = ref;
      } else {
        await redis.set(K.ref(meta.ref), id, 'NX');
      }
      const cat = categorize({ type: meta.type, mime: meta.mime, name: meta.name });
      if (hash.cat !== cat) fixes.cat = cat;
      if (hash.folder === undefined) fixes.folder = '';
      if (Object.keys(fixes).length) { multi.hset(batch[i], fixes); hash = { ...hash, ...fixes }; meta = parseMeta(id, hash); }
      applyFileIndexes(multi, meta, 'add');

      const u = perUser.get(meta.uploaderId) ?? { files: 0, bytes: 0, cats: {} };
      u.files += 1; u.bytes += meta.size;
      u.cats[meta.cat] = u.cats[meta.cat] ?? { c: 0, b: 0 };
      u.cats[meta.cat].c += 1; u.cats[meta.cat].b += meta.size;
      perUser.set(meta.uploaderId, u);
      global.files += 1; global.bytes += meta.size;
      global.cats[meta.cat] = global.cats[meta.cat] ?? { c: 0, b: 0 };
      global.cats[meta.cat].c += 1; global.cats[meta.cat].b += meta.size;
      const prev = firstUpload.get(meta.uploaderId);
      if (!prev || meta.uploadedAt < prev) firstUpload.set(meta.uploaderId, meta.uploadedAt);
      files += 1;
    }
    await multi.exec();
    batch = [];
    onProgress({ stage: 'files', files });
  };

  for await (const key of scanKeys('file:*')) {
    batch.push(key);
    if (batch.length >= 200) await flush();
  }
  await flush();

  // Share links -> per-user list and per-file set.
  let shares = 0;
  let sbatch = [];
  const flushShares = async () => {
    if (sbatch.length === 0) return;
    const pipe = redis.pipeline();
    for (const key of sbatch) pipe.hgetall(key);
    const rows = await pipe.exec();
    const multi = redis.multi();
    sbatch.forEach((key, i) => {
      const h = rows[i][1];
      if (!h || !h.fileId || !h.ownerId) return;
      const token = key.slice('share:'.length);
      if (!h.ref) multi.hset(key, 'ref', shortRef());
      multi.zadd(K.userShares(h.ownerId), Number(h.createdAt) || Date.now(), token).sadd(K.fileShares(h.fileId), token);
      shares += 1;
    });
    await multi.exec();
    sbatch = [];
  };
  for await (const key of scanKeys('share:*')) {
    sbatch.push(key);
    if (sbatch.length >= 200) await flushShares();
  }
  await flushShares();

  // Counters.
  const stats = redis.multi();
  stats.del(K.gstats);
  stats.hset(K.gstats, 'files', String(global.files), 'bytes', String(global.bytes));
  for (const [cat, v] of Object.entries(global.cats)) stats.hset(K.gstats, `c:${cat}`, String(v.c), `b:${cat}`, String(v.b));
  for (const [uid, u] of perUser) {
    stats.del(K.ustats(uid));
    stats.hset(K.ustats(uid), 'files', String(u.files), 'bytes', String(u.bytes));
    for (const [cat, v] of Object.entries(u.cats)) stats.hset(K.ustats(uid), `c:${cat}`, String(v.c), `b:${cat}`, String(v.b));
  }
  await stats.exec();

  // Profiles: every known user (legacy set + file owners + existing profiles) gets a profile with fresh counters.
  const uids = new Set(perUser.keys());
  for await (const key of scanKeys('u:*')) uids.add(Number(key.slice(2)));
  let cursor = '0';
  do {
    const [next, members] = await redis.sscan(K.users, cursor, 'COUNT', 500);
    cursor = next;
    members.forEach((m) => uids.add(Number(m)));
  } while (cursor !== '0');

  let users = 0;
  for (const uid of uids) {
    if (!Number.isSafeInteger(uid) || uid <= 0) continue;
    const u = perUser.get(uid) ?? { files: 0, bytes: 0 };
    const created = firstUpload.get(uid) ?? Date.now();
    const multi = redis.multi();
    multi.sadd(K.users, String(uid));
    multi.hsetnx(K.profile(uid), 'createdAt', String(created));
    multi.hset(K.profile(uid), { id: String(uid), fileCount: String(u.files), storageUsed: String(u.bytes) });
    await multi.exec();
    const [username, createdAt, lastActive] = await redis.hmget(K.profile(uid), 'username', 'createdAt', 'lastActive');
    const m2 = redis.multi().zadd(K.usersCreated, Number(createdAt) || created, String(uid));
    if (lastActive) m2.zadd(K.usersActive, Number(lastActive), String(uid));
    if (username && /^[a-z0-9_]{3,32}$/.test(username)) m2.set(K.uname(username), String(uid));
    await m2.exec();
    users += 1;
  }

  // Open abuse reports.
  for await (const key of scanKeys('report:*')) {
    const [id, status, createdAt] = await redis.hmget(key, 'id', 'status', 'createdAt');
    if (id && status === 'open') await redis.zadd(K.reportsOpen, Number(createdAt) || Date.now(), id);
  }

  const coll = await rebuildCollectionIndexes();
  return { files, shares, users, collections: coll.collections };
}

// ---------------------------------------------------------------- migrations

/** v1 (original bot) -> v2 (Vault): purely additive. No key is deleted; no file data is rewritten. */
async function migrateV1toV2({ log }) {
  let migrated = 0;
  let persisted = 0;
  for await (const key of scanKeys('file:*')) {
    const h = await redis.hgetall(key);
    if (!h || !h.fileId) continue;
    const id = key.slice('file:'.length);
    if (h.ref) continue; // already v2
    // The original public link token WAS the file id: keep every old link working as a share record.
    if (!(await redis.exists(K.share(id)))) {
      await redis.hset(K.share(id), {
        fileId: id, ownerId: h.uploaderId, createdAt: h.uploadedAt || String(Date.now()), expiresAt: '0', limit: '0',
        downloads: h.downloads || '0', status: 'active', ref: shortRef(), legacy: '1',
      });
    }
    // v1 could put a Redis TTL on file metadata, which would silently drop the record. Never expire records.
    if ((await redis.pttl(key)) > 0) { await redis.persist(key); persisted += 1; }
    migrated += 1;
  }
  log('legacy files prepared', { migrated, ttlRemoved: persisted });
  const result = await rebuildIndexes({ clean: false, onProgress: (p) => log('indexing', p) });
  log('indexes built', result);
}

/** v2 -> v3: file collections (multi-file upload + one share link). Purely additive: new key families only. */
async function migrateV2toV3({ log }) {
  const result = await rebuildCollectionIndexes();
  log('collection indexes built', result);
}

export const MIGRATIONS = [
  { version: 2, name: 'file-vault-v2', destructive: false, up: migrateV1toV2 },
  { version: 3, name: 'file-collections', destructive: false, up: migrateV2toV3 },
];

async function acquireMigrationLock() {
  return (await redis.set('lock:migrate', String(process.pid), 'EX', 900, 'NX')) === 'OK';
}

/**
 * Called once at startup, before the bot accepts updates.
 *  - NEVER creates a fresh database implicitly (needs ALLOW_EMPTY_DB_INIT=true for a brand-new one)
 *  - refuses a database from a newer schema or one with the wrong fingerprint
 *  - runs versioned migrations under a lock, with a backup attempt first (mandatory if destructive)
 * `backupFn(reason)` should resolve true when a backup was stored somewhere safe.
 */
export async function initDatabase({ backupFn = async () => false } = {}) {
  const log = (msg, fields) => logger.info(`db: ${msg}`, fields);

  const railwayHost = railwayHostWarning();
  if (railwayHost) {
    const text = 'REDIS_URL points to a Railway-hosted Redis. Your data is tied to that Railway project/account and will NOT survive moving or deleting it. Move it to an external Redis (see README "Railway migration").';
    if (config.requireExternalDb) throw new DatabaseGuardError(`${text} (REQUIRE_EXTERNAL_DB=true)`);
    logger.warn(text, { host: railwayHost });
  }

  const persistence = await redisPersistenceInfo();
  if (persistence.known && !persistence.aof && !persistence.rdb) logger.warn('db: this Redis reports NO persistence (no AOF, no snapshots). A restart would lose all data — enable persistence or use a managed Redis.');

  let schema = Number(await redis.get(K.schema)) || 0;
  const dbId = await redis.get(K.dbId);

  if (config.dbFingerprint) {
    if (!dbId) throw new DatabaseGuardError('DB_FINGERPRINT is set but this database has no fingerprint — this is not the database you expect. Refusing to start.');
    if (dbId !== config.dbFingerprint) throw new DatabaseGuardError('DB_FINGERPRINT does not match this database. Refusing to start so no data is mixed up.');
  }

  if (schema === 0) {
    if (await hasApplicationData()) {
      schema = 1; // original bot layout: adopt it, never wipe it
      log('existing v1 data found; it will be upgraded in place');
    } else if (!config.allowEmptyDbInit) {
      throw new DatabaseGuardError(
        'The database is EMPTY. Refusing to create a new one automatically (this protects existing users/files if REDIS_URL was wrong or Redis was reset). ' +
        'If this is a genuinely new installation, set ALLOW_EMPTY_DB_INIT=true once. To recover data, restore a backup first (npm run restore).',
      );
    } else {
      const id = generateToken().slice(0, 16);
      await redis.multi().set(K.schema, String(CURRENT_SCHEMA)).set(K.dbId, id).set(K.dbCreated, String(Date.now())).exec();
      logger.warn('db: initialised a NEW empty database (ALLOW_EMPTY_DB_INIT=true). You can remove that variable now.', { dbId: id });
      return { schema: CURRENT_SCHEMA, dbId: id, created: true };
    }
  }

  if (schema > CURRENT_SCHEMA) {
    throw new DatabaseGuardError(`The database schema (v${schema}) is newer than this code (v${CURRENT_SCHEMA}). Refusing to start to avoid corrupting data — deploy the newer version.`);
  }

  if (schema < CURRENT_SCHEMA) {
    const pending = MIGRATIONS.filter((m) => m.version > schema).sort((a, b) => a.version - b.version);
    if (!(await acquireMigrationLock())) {
      log('another instance is migrating; waiting');
      for (let i = 0; i < 120; i += 1) {
        await sleep(1000);
        if ((Number(await redis.get(K.schema)) || 0) >= CURRENT_SCHEMA) return { schema: CURRENT_SCHEMA, dbId: await redis.get(K.dbId), migrated: false };
      }
      throw new DatabaseGuardError('Timed out waiting for another instance to finish the database migration.');
    }
    try {
      for (const m of pending) {
        if ((Number(await redis.get(K.schema)) || 0) >= m.version) continue;
        log(`migration ${m.version} (${m.name}) starting`, { destructive: m.destructive });
        let backedUp = false;
        try { backedUp = await backupFn(`before migration v${m.version}`); } catch (err) { logger.warn('db: pre-migration backup failed', { err }); }
        if (m.destructive) {
          if (!backedUp) throw new DatabaseGuardError(`Migration v${m.version} is destructive and no backup could be stored. Aborting.`);
          if (process.env.CONFIRM_DESTRUCTIVE_MIGRATION !== String(m.version)) {
            throw new DatabaseGuardError(`Migration v${m.version} is destructive. A backup was stored; set CONFIRM_DESTRUCTIVE_MIGRATION=${m.version} to proceed.`);
          }
        } else if (!backedUp) {
          logger.warn('db: no pre-migration backup stored; continuing because this migration is additive-only');
        }
        await m.up({ log });
        await redis.set(K.schema, String(m.version));
        log(`migration ${m.version} complete`);
      }
    } finally {
      await redis.del('lock:migrate').catch(() => {});
    }
  }

  let id = await redis.get(K.dbId);
  if (!id) {
    id = generateToken().slice(0, 16);
    await redis.multi().set(K.dbId, id, 'NX').setnx(K.dbCreated, String(Date.now())).exec();
    id = await redis.get(K.dbId);
  }
  return { schema: CURRENT_SCHEMA, dbId: id, created: false };
}

export async function databaseInfo() {
  const [schema, dbId, created] = await Promise.all([redis.get(K.schema), redis.get(K.dbId), redis.get(K.dbCreated)]);
  return { schema: Number(schema) || 0, dbId: dbId || '', createdAt: Number(created) || 0 };
}
