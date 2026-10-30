import { config } from '../config.js';
import { redis } from './redis.js';
import { K } from './keys.js';
import { generateToken, isValidToken } from './tokens.js';
import { parseMeta, isExpired } from './files.js';
import { shortRef } from '../utils/ids.js';

// A share link is a separate record from the file: its own cryptographically random token (192 bits),
// expiry, download limit and status. The file itself is never addressed by the public token.

export function parseShare(token, h) {
  if (!h || !h.fileId || !h.ownerId) return null;
  return {
    token,
    ref: h.ref || '',
    fileId: h.fileId,
    ownerId: Number(h.ownerId),
    createdAt: Number(h.createdAt) || 0,
    expiresAt: Number(h.expiresAt) || 0,
    limit: Number(h.limit) || 0, // 0 = unlimited
    downloads: Number(h.downloads) || 0,
    status: h.status === 'revoked' ? 'revoked' : 'active',
    revokedAt: Number(h.revokedAt) || 0,
    legacy: h.legacy === '1',
  };
}

/** active | revoked | expired | limit | file_expired | deleted */
export function shareState(share, file, now = Date.now()) {
  if (!file) return 'deleted';
  if (share.status === 'revoked') return 'revoked';
  if (share.expiresAt > 0 && now >= share.expiresAt) return 'expired';
  if (share.limit > 0 && share.downloads >= share.limit) return 'limit';
  if (isExpired(file, now)) return 'file_expired';
  return 'active';
}

export async function getShare(token) {
  if (!isValidToken(token)) return null;
  return parseShare(token, await redis.hgetall(K.share(token)));
}

export async function createShare({ fileId, ownerId, expiresAt = 0, limit = 0 }) {
  const total = await redis.scard(K.fileShares(fileId));
  if (total >= config.maxLinksPerFile) return { result: 'limit' };
  const token = generateToken();
  const ref = shortRef();
  const now = Date.now();
  const multi = redis.multi()
    .hset(K.share(token), {
      fileId, ownerId: String(ownerId), createdAt: String(now), expiresAt: String(expiresAt),
      limit: String(limit), downloads: '0', status: 'active', ref,
    })
    .zadd(K.userShares(ownerId), now, token)
    .sadd(K.fileShares(fileId), token);
  const res = await multi.exec();
  if (!res || res.some(([e]) => e)) throw new Error('could not create share link');
  return { result: 'created', share: parseShare(token, { fileId, ownerId: String(ownerId), createdAt: String(now), expiresAt: String(expiresAt), limit: String(limit), downloads: '0', status: 'active', ref }) };
}

/**
 * Public access check. `reason` is for logs/metrics only — users always see the same generic message.
 * Checks: token format, link exists, not revoked, not expired, file exists and not expired.
 * (The download limit is enforced atomically by consumeShare.)
 */
export async function resolveShare(token) {
  if (!isValidToken(token)) return { ok: false, reason: 'invalid' };
  const share = await getShare(token);
  if (!share) return { ok: false, reason: 'not_found' };
  const file = parseMeta(share.fileId, await redis.hgetall(K.file(share.fileId)));
  const state = shareState(share, file);
  if (state !== 'active') return { ok: false, reason: state, share, file };
  return { ok: true, share, file };
}

const CONSUME_REASONS = { '-1': 'not_found', '-2': 'revoked', '-3': 'expired', '-4': 'limit' };

/** Atomically claims one download (enforces revoke / expiry / limit under concurrency). */
export async function consumeShare(token) {
  const n = Number(await redis.consumeShare(K.share(token), Date.now()));
  if (n < 0) return { ok: false, reason: CONSUME_REASONS[String(n)] ?? 'denied' };
  return { ok: true, downloads: n };
}

export const refundShare = (token) => redis.refundShare(K.share(token));

export async function revokeShare(token) {
  const share = await getShare(token);
  if (!share) return null;
  if (share.status !== 'revoked') await redis.hset(K.share(token), { status: 'revoked', revokedAt: String(Date.now()) });
  return { ...share, status: 'revoked' };
}

export async function deleteShare(token) {
  const share = await getShare(token);
  if (!share) return null;
  await redis.multi().del(K.share(token)).zrem(K.userShares(share.ownerId), token).srem(K.fileShares(share.fileId), token).exec();
  return share;
}

export async function setShareExpiry(token, expiresAt) {
  const share = await getShare(token);
  if (!share || share.status === 'revoked') return null;
  await redis.hset(K.share(token), 'expiresAt', String(expiresAt));
  return { ...share, expiresAt };
}

export async function setShareLimit(token, limit) {
  const share = await getShare(token);
  if (!share || share.status === 'revoked') return null;
  await redis.hset(K.share(token), 'limit', String(limit));
  return { ...share, limit };
}

async function loadShares(tokens) {
  if (tokens.length === 0) return [];
  const pipeline = redis.pipeline();
  for (const t of tokens) pipeline.hgetall(K.share(t));
  const rows = await pipeline.exec();
  return rows.map(([err, h], i) => (err ? null : parseShare(tokens[i], h)));
}

/** Paginated "Shared Links" list for a user, newest first, with the file each link points to. */
export async function listUserShares(userId, page = 1, pageSize = config.filesPerPage) {
  const zkey = K.userShares(userId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const total = await redis.zcard(zkey);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const current = Math.min(Math.max(1, page), totalPages);
    if (total === 0) return { items: [], page: 1, totalPages: 1, total: 0 };
    const start = (current - 1) * pageSize;
    const tokens = await redis.zrevrange(zkey, start, start + pageSize - 1);
    const shares = await loadShares(tokens);
    const stale = tokens.filter((t, i) => !shares[i]);
    if (stale.length) { await redis.zrem(zkey, ...stale); continue; }

    const pipeline = redis.pipeline();
    for (const s of shares) pipeline.hgetall(K.file(s.fileId));
    const files = (await pipeline.exec()).map(([, h], i) => parseMeta(shares[i].fileId, h));
    const now = Date.now();
    return {
      page: current, totalPages, total,
      items: shares.map((share, i) => ({ share, file: files[i], state: shareState(share, files[i], now) })),
    };
  }
  return { items: [], page: 1, totalPages: 1, total: 0 };
}

export async function listFileShares(fileId, file) {
  const tokens = (await redis.smembers(K.fileShares(fileId))).slice(0, config.maxLinksPerFile);
  const shares = (await loadShares(tokens)).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  const now = Date.now();
  return shares.map((share) => ({ share, file, state: shareState(share, file, now) }));
}

/** Step 1 of shareSummaries: which links belong to these files. Can run while file metadata is being fetched. */
export async function fetchShareSets(fileIds) {
  if (fileIds.length === 0) return [];
  const p1 = redis.pipeline();
  for (const id of fileIds) p1.smembers(K.fileShares(id));
  return (await p1.exec()).map(([, v]) => v ?? []);
}

/** { fileId -> { active, total } } for a page of files. Pass `sets` from fetchShareSets to save a round trip. */
export async function shareSummaries(files, sets = null) {
  const out = new Map();
  if (files.length === 0) return out;
  const memberSets = sets ?? await fetchShareSets(files.map((f) => f.id));
  const all = [...new Set(memberSets.flat())];
  const byToken = new Map();
  if (all.length) (await loadShares(all)).forEach((s) => { if (s) byToken.set(s.token, s); });
  const now = Date.now();
  files.forEach((f, i) => {
    let active = 0;
    for (const t of memberSets[i]) {
      const s = byToken.get(t);
      if (s && shareState(s, f, now) === 'active') active += 1;
    }
    out.set(f.id, { active, total: memberSets[i].length });
  });
  return out;
}

/** Revoke every link of a file (used by admin abuse handling). Returns how many links changed. */
export async function revokeAllForFile(fileId) {
  const tokens = await redis.smembers(K.fileShares(fileId));
  let changed = 0;
  for (const t of tokens) {
    const s = await getShare(t);
    if (s && s.status !== 'revoked') { await redis.hset(K.share(t), { status: 'revoked', revokedAt: String(Date.now()) }); changed += 1; }
  }
  return changed;
}

export async function countShares() {
  let cursor = '0';
  let total = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'share:*', 'COUNT', 500);
    cursor = next;
    total += keys.length;
  } while (cursor !== '0');
  return total;
}
