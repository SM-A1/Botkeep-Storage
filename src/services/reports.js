import { redis } from './redis.js';
import { K } from './keys.js';
import { generateToken } from './tokens.js';
import { getShare } from './shares.js';
import { parseMeta } from './files.js';
import { getCShare, getCollection } from './collections.js';

// Abuse reports: a recipient can report a file delivered through a share link; admins review them.
const idOf = () => generateToken().slice(0, 12);
export const REPORT_ID_RE = /^[A-Za-z0-9_-]{12}$/;

export async function createReport({ reporterId, shareToken }) {
  const share = await getShare(shareToken);
  if (!share) return { result: 'not_found' };
  const once = await redis.set(`rpt:${reporterId}:${share.ref}`, '1', 'EX', 7 * 86_400, 'NX');
  if (once !== 'OK') return { result: 'duplicate' };
  const file = parseMeta(share.fileId, await redis.hgetall(K.file(share.fileId)));
  const id = idOf();
  const now = Date.now();
  await redis.multi()
    .hset(K.report(id), {
      id, fileId: share.fileId, fileRef: file?.ref ?? '', shareRef: share.ref, ownerId: String(share.ownerId),
      reporterId: String(reporterId), createdAt: String(now), status: 'open',
    })
    .zadd(K.reportsOpen, now, id)
    .exec();
  return { result: 'created', id };
}

/** A recipient reports a whole collection (by its public share token). */
export async function createCollectionReport({ reporterId, token }) {
  const share = await getCShare(token);
  const collection = share ? await getCollection(share.collId) : null;
  if (!collection) return { result: 'not_found' };
  const once = await redis.set(`rpt:${reporterId}:c${collection.ref}`, '1', 'EX', 7 * 86_400, 'NX');
  if (once !== 'OK') return { result: 'duplicate' };
  const id = idOf();
  const now = Date.now();
  await redis.multi()
    .hset(K.report(id), {
      id, fileId: '', fileRef: '', shareRef: collection.ref, collId: collection.id, ownerId: String(collection.ownerId),
      reporterId: String(reporterId), createdAt: String(now), status: 'open',
    })
    .zadd(K.reportsOpen, now, id)
    .exec();
  return { result: 'created', id };
}

const parseReport = (h) => (h && h.id ? {
  id: h.id, fileId: h.fileId, collId: h.collId || '', fileRef: h.fileRef || '', shareRef: h.shareRef || '', ownerId: Number(h.ownerId) || 0,
  reporterId: Number(h.reporterId) || 0, createdAt: Number(h.createdAt) || 0, status: h.status || 'open',
} : null);

export async function listOpenReports(page = 1, pageSize = 5) {
  const total = await redis.zcard(K.reportsOpen);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const ids = await redis.zrevrange(K.reportsOpen, (current - 1) * pageSize, current * pageSize - 1);
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.hgetall(K.report(id));
  const items = (await pipeline.exec()).map(([, h]) => parseReport(h)).filter(Boolean);
  return { items, page: current, totalPages, total };
}

export async function getReport(id) {
  return REPORT_ID_RE.test(id) ? parseReport(await redis.hgetall(K.report(id))) : null;
}

export async function closeReport(id, status, adminId) {
  const r = await getReport(id);
  if (!r) return null;
  await redis.multi()
    .hset(K.report(id), { status, closedBy: String(adminId), closedAt: String(Date.now()) })
    .zrem(K.reportsOpen, id)
    .exec();
  return { ...r, status };
}
