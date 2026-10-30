import { config } from '../config.js';
import { logger } from '../logger.js';
import { redis } from './redis.js';
import { K } from './keys.js';

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);

// Audit/security writes are best-effort and must never slow a user down: they run in the background
// (one Redis round trip) and reads wait for pending writes so the log is always consistent.
const pending = new Set();
const track = (promise) => {
  const p = promise.catch((err) => logger.warn('audit write failed', { err })).finally(() => pending.delete(p));
  pending.add(p);
};
export const flushAudit = () => Promise.all([...pending]);

/**
 * Appends an event to the audit log (a capped Redis stream, included in backups).
 * Only short references are recorded — never passwords, tokens, bot secrets or storage IDs.
 * Returns immediately; the write happens in the background.
 */
export function audit(type, { actorId = 0, file = null, share = null, detail = '' } = {}) {
  const multi = redis.multi().xadd(
    K.audit, 'MAXLEN', '~', config.auditMaxEvents, '*',
    't', clean(type, 32), 'a', String(actorId), 'f', clean(file?.ref, 8), 's', clean(share?.ref, 8), 'd', clean(detail, 120),
  );
  if (file?.id) {
    const key = K.hist(file.id);
    multi.lpush(key, JSON.stringify({ t: Date.now(), e: clean(type, 32), a: actorId })).ltrim(key, 0, 199);
  }
  track(multi.exec());
  return Promise.resolve();
}

export async function recentAudit(count = 15, { types = null, scan = 300 } = {}) {
  await flushAudit();
  const rows = await redis.xrevrange(K.audit, '+', '-', 'COUNT', types ? scan : count);
  const events = [];
  for (const [id, flat] of rows) {
    const f = {};
    for (let i = 0; i < flat.length; i += 2) f[flat[i]] = flat[i + 1];
    if (types && !types.includes(f.t)) continue;
    events.push({ time: Number(id.split('-')[0]), type: f.t, actorId: Number(f.a) || 0, fileRef: f.f || '', shareRef: f.s || '', detail: f.d || '' });
    if (events.length >= count) break;
  }
  return events;
}

export async function fileHistory(fileId, count = 20) {
  await flushAudit();
  const rows = await redis.lrange(K.hist(fileId), 0, count - 1);
  return rows.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}

// ---- Daily security counters (transient; the audit stream is the durable record) ----
const day = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

export function secCount(kind) {
  const key = `sec:${day()}`;
  track(redis.multi().hincrby(key, kind, 1).expire(key, 15 * 86_400).exec());
  return Promise.resolve();
}

export async function securityToday() {
  await flushAudit();
  return (await redis.hgetall(`sec:${day()}`)) ?? {};
}
