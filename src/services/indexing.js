import { K } from './keys.js';

const WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;
const MAX_PREFIX = 8;

/** Lower-cased filename words (max 12 words, 24 chars each). */
export function searchWords(text) {
  const words = String(text ?? '').normalize('NFC').toLowerCase().match(WORD_RE) ?? [];
  return words.map((w) => Array.from(w).slice(0, 24).join('')).slice(0, 12);
}

/** Index prefixes of one word: lengths 2..8 (or the single character itself). */
export function prefixesOf(word) {
  const chars = Array.from(word);
  if (chars.length < 2) return [word];
  const out = [];
  for (let i = 2; i <= Math.min(chars.length, MAX_PREFIX); i += 1) out.push(chars.slice(0, i).join(''));
  return out;
}

/** The single index key a query word is looked up under. */
export const queryPrefix = (word) => Array.from(word).slice(0, MAX_PREFIX).join('');

function searchPrefixes(name) {
  return [...new Set(searchWords(name).flatMap(prefixesOf))];
}

export function applySearchIndex(multi, meta, name, op) {
  for (const prefix of searchPrefixes(name)) {
    if (op === 'add') multi.sadd(K.search(meta.uploaderId, prefix), meta.id);
    else multi.srem(K.search(meta.uploaderId, prefix), meta.id);
  }
}

/** Adds or removes a file in every derived index (everything except the short-ref key). */
export function applyFileIndexes(multi, meta, op) {
  const uid = meta.uploaderId;
  if (op === 'add') {
    multi.zadd(K.userFiles(uid), meta.uploadedAt, meta.id);
    multi.zadd(K.userCat(uid, meta.cat), meta.uploadedAt, meta.id);
    if (meta.folder) multi.zadd(K.userFolder(uid, meta.folder), meta.uploadedAt, meta.id);
    if (meta.expiresAt > 0) multi.zadd(K.expFiles, meta.expiresAt, meta.id);
  } else {
    multi.zrem(K.userFiles(uid), meta.id);
    multi.zrem(K.userCat(uid, meta.cat), meta.id);
    if (meta.folder) multi.zrem(K.userFolder(uid, meta.folder), meta.id);
    multi.zrem(K.expFiles, meta.id);
  }
  applySearchIndex(multi, meta, meta.name, op);
}

/** Per-user and global counters (files / bytes, in total and per category). sign = +1 or -1. */
export function applyStats(multi, meta, sign) {
  const files = sign;
  const bytes = sign * meta.size;
  for (const key of [K.ustats(meta.uploaderId), K.gstats]) {
    multi.hincrby(key, 'files', files).hincrby(key, 'bytes', bytes);
    multi.hincrby(key, `c:${meta.cat}`, files).hincrby(key, `b:${meta.cat}`, bytes);
  }
  multi.hincrby(K.profile(meta.uploaderId), 'fileCount', files).hincrby(K.profile(meta.uploaderId), 'storageUsed', bytes);
}
