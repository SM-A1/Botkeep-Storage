import { createGzip, gunzipSync } from 'node:zlib';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { lifecycle } from '../lifecycle.js';
import { redis } from './redis.js';
import { K, AUTHORITATIVE_PATTERNS, AUTHORITATIVE_FIXED } from './keys.js';
import { CURRENT_SCHEMA, rebuildIndexes } from './schema.js';

// A backup is a gzip'd NDJSON export of the AUTHORITATIVE keys only (files, share links, profiles,
// folders, history, reports, audit stream, legacy state). Derived indexes are rebuilt on restore.
// It contains password HASHES (never plain text) and Telegram storage references, so treat it as secret:
// set BACKUP_ENCRYPTION_KEY to encrypt it, and send it only to a private chat.
const FORMAT = 'vault-backup';
const FORMAT_VERSION = 1;
const TELEGRAM_LIMIT_BYTES = 45 * 1024 * 1024; // Bot API upload limit is 50 MB
const MAGIC = Buffer.from('VBK1');

async function* scanAuthoritative() {
  for (const key of AUTHORITATIVE_FIXED) if ((await redis.exists(key)) === 1) yield key;
  for (const pattern of AUTHORITATIVE_PATTERNS) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      for (const key of keys) yield key;
    } while (cursor !== '0');
  }
}

async function readKey(key, type) {
  switch (type) {
    case 'string': return await redis.get(key);
    case 'hash': return await redis.hgetall(key);
    case 'set': return await redis.smembers(key);
    case 'list': return await redis.lrange(key, 0, -1);
    case 'zset': {
      const flat = await redis.zrange(key, 0, -1, 'WITHSCORES');
      const out = [];
      for (let i = 0; i < flat.length; i += 2) out.push([flat[i], Number(flat[i + 1])]);
      return out;
    }
    case 'stream': {
      const entries = [];
      let start = '-';
      for (;;) {
        const rows = await redis.xrange(key, start, '+', 'COUNT', 1000);
        if (rows.length === 0) break;
        entries.push(...rows);
        const last = rows[rows.length - 1][0];
        if (rows.length < 1000) break;
        start = `(${last}`;
      }
      return entries;
    }
    default: return undefined;
  }
}

/** Builds the (optionally encrypted) backup in memory. Returns { buffer, counts, filename, encrypted }. */
export async function createBackup({ reason = 'manual' } = {}) {
  const gzip = createGzip({ level: 9 });
  const chunks = [];
  gzip.on('data', (c) => chunks.push(c));
  const counts = {};
  const write = async (obj) => { if (!gzip.write(`${JSON.stringify(obj)}\n`)) await once(gzip, 'drain'); };

  await write({
    format: FORMAT, version: FORMAT_VERSION, createdAt: new Date().toISOString(), reason,
    schema: Number(await redis.get(K.schema)) || CURRENT_SCHEMA, dbId: (await redis.get(K.dbId)) || '',
  });
  for await (const key of scanAuthoritative()) {
    const type = await redis.type(key);
    const value = await readKey(key, type);
    if (value === undefined || value === null) continue;
    await write({ k: key, t: type, v: value });
    const family = key.split(':')[0];
    counts[family] = (counts[family] ?? 0) + 1;
  }
  gzip.end();
  await once(gzip, 'end');
  let buffer = Buffer.concat(chunks);

  const encrypted = Boolean(config.backup.encryptionKey);
  if (encrypted) buffer = encrypt(buffer, config.backup.encryptionKey);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  return { buffer, counts, encrypted, filename: `vault-backup-${stamp}.ndjson.gz${encrypted ? '.enc' : ''}` };
}

export function encrypt(buffer, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export function decryptIfNeeded(buffer, passphrase) {
  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(MAGIC)) return buffer;
  if (!passphrase) throw new Error('This backup is encrypted: set BACKUP_ENCRYPTION_KEY to the key used when it was created.');
  const salt = buffer.subarray(4, 20);
  const iv = buffer.subarray(20, 32);
  const tag = buffer.subarray(32, 48);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(buffer.subarray(48)), decipher.final()]);
  } catch {
    throw new Error('Could not decrypt the backup (wrong BACKUP_ENCRYPTION_KEY or corrupted file).');
  }
}

/** Parses a backup buffer into { header, entries[] } and validates the format. */
export function parseBackup(buffer, passphrase = config.backup.encryptionKey) {
  const text = gunzipSync(decryptIfNeeded(buffer, passphrase)).toString('utf8');
  const lines = text.split('\n').filter(Boolean);
  if (lines.length === 0) throw new Error('Backup is empty.');
  const header = JSON.parse(lines[0]);
  if (header.format !== FORMAT || header.version !== FORMAT_VERSION) throw new Error('Not a valid vault backup (unknown format).');
  if (header.schema > CURRENT_SCHEMA) throw new Error(`Backup schema v${header.schema} is newer than this code (v${CURRENT_SCHEMA}).`);
  return { header, entries: lines.slice(1).map((l) => JSON.parse(l)) };
}

/**
 * Restores a backup into an EMPTY database only. It never overwrites or merges into existing data.
 * Derived indexes are rebuilt afterwards.
 */
export async function restoreBackup(buffer, { passphrase = config.backup.encryptionKey } = {}) {
  if (await redis.dbsize() > 0) {
    throw new Error('Refusing to restore: the target database is not empty. Point REDIS_URL at a new, empty Redis (never restore over production data).');
  }
  const { header, entries } = parseBackup(buffer, passphrase);
  const restored = {};
  for (const { k, t, v } of entries) {
    if (typeof k !== 'string') continue;
    const multi = redis.multi();
    switch (t) {
      case 'string': multi.set(k, v); break;
      case 'hash': if (Object.keys(v).length) multi.hset(k, v); break;
      case 'set': if (v.length) multi.sadd(k, ...v); break;
      case 'list': if (v.length) multi.rpush(k, ...v); break;
      case 'zset': for (const [member, score] of v) multi.zadd(k, score, member); break;
      case 'stream': for (const [id, flat] of v) multi.xadd(k, id, ...flat); break;
      default: continue;
    }
    const res = await multi.exec();
    if (!res || res.some(([e]) => e)) throw new Error(`Restore failed on a ${t} key; the target database may be partially filled — wipe it and retry.`);
    const family = k.split(':')[0];
    restored[family] = (restored[family] ?? 0) + 1;
  }
  await redis.set(K.schema, String(header.schema));
  const rebuilt = await rebuildIndexes({ clean: false });
  return { header, restored, rebuilt };
}

/** Sends a backup file to the private backup chat. Returns true on success. */
export async function sendBackupToTelegram({ reason }) {
  const { buffer, counts, filename, encrypted } = await createBackup({ reason });
  if (buffer.length > TELEGRAM_LIMIT_BYTES) {
    logger.error('backup too large for Telegram; use `npm run backup` and store it elsewhere', { bytes: buffer.length });
    return false;
  }
  const { bot } = await import('./telegram.js');
  const { InputFile } = await import('grammy');
  const dbId = ((await redis.get(K.dbId)) || '').slice(0, 6);
  const caption = [
    `💾 Vault backup (${reason})`,
    `🗄 DB ${dbId} · schema v${CURRENT_SCHEMA}${encrypted ? ' · 🔒 encrypted' : ' · ⚠️ not encrypted'}`,
    `📁 files ${counts.file ?? 0} · 🔗 links ${counts.share ?? 0} · 🗂 collections ${counts.coll ?? 0} · 👥 profiles ${counts.u ?? 0}`,
  ].join('\n');
  await bot.api.sendDocument(config.backup.chatId, new InputFile(buffer, filename), { caption });
  await redis.set('state:lastBackup', JSON.stringify({ at: Date.now(), reason, bytes: buffer.length }));
  logger.info('backup sent to Telegram', { bytes: buffer.length, encrypted });
  return true;
}

export async function lastBackupInfo() {
  const raw = await redis.get('state:lastBackup');
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/** Scheduled backups, safe with multiple instances (lock) and restarts (last-run timestamp in Redis). */
export function startBackupScheduler() {
  const hours = config.backup.intervalHours;
  if (hours <= 0) return () => {};
  const intervalMs = hours * 3_600_000;
  const run = async () => {
    if (lifecycle.shuttingDown) return;
    try {
      const last = await lastBackupInfo();
      if (last && Date.now() - last.at < intervalMs - 60_000) return;
      if ((await redis.set('lock:backup', '1', 'EX', 600, 'NX')) !== 'OK') return;
      await sendBackupToTelegram({ reason: 'scheduled' });
    } catch (err) {
      logger.error('scheduled backup failed', { err });
    }
  };
  const first = setTimeout(run, 90_000);
  const timer = setInterval(run, 30 * 60_000);
  first.unref();
  timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}
