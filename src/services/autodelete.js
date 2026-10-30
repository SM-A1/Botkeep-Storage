import { config } from '../config.js';
import { lifecycle } from '../lifecycle.js';
import { logger } from '../logger.js';
import { redis } from './redis.js';
import { bot, copyFromStorage, copyManyFromStorage, isBlockedError } from './telegram.js';

// Delivery policy for files delivered through a PUBLIC link:
//   forwardLock  - seconds the delivered files are sent with protect_content (no forward / save). 0 = off.
//   autoDelete   - seconds after delivery the delivered messages are deleted from the user's chat. 0 = off.
// Telegram cannot "unlock" an already sent message, so after the lock the bot deletes the locked copies and
// re-sends forwardable copies from the storage channel (which is never touched).
// Redis keys (transient, not part of backups): dj:due (zset jobId by run time), dj:d:<id> (job JSON), settings:delivery (hash).

const DUE = 'dj:due';
const DATA = (id) => `dj:d:${id}`;
const SETTINGS = 'settings:delivery';
const LEASE_MS = 120_000; // a job being processed is invisible for this long; if we crash it simply runs again
const MAX_ATTEMPTS = 3;

export const AUTO_DELETE_PRESETS = [0, 60, 300, 600, 1800, 3600, 21_600];
export const FORWARD_LOCK_PRESETS = [0, 60, 120, 300];
export const MAX_AUTO_DELETE = 7 * 86_400;
export const MAX_FORWARD_LOCK = 86_400;

export function formatSecs(s) {
  if (!s) return 'Off';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round((s / 3600) * 10) / 10} h`;
}

/** "off", "0", "90", "90s", "2m", "10 min", "1h" -> seconds, or null when invalid. */
export function parseSeconds(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'never' || raw === 'none') return 0;
  const m = /^(\d{1,6})\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/.exec(raw);
  if (!m) return null;
  const mult = !m[2] || m[2].startsWith('s') ? 1 : m[2].startsWith('m') ? 60 : 3600;
  return Number(m[1]) * mult;
}

export const nextPreset = (presets, current) => presets[(Math.max(presets.indexOf(current), -1) + 1) % presets.length];

const toSeconds = (v, fallback) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
};

export async function getPolicy() {
  const h = await redis.hgetall(SETTINGS);
  return {
    autoDelete: toSeconds(h.autoDelete, config.delivery.autoDeleteSeconds),
    forwardLock: toSeconds(h.forwardLock, config.delivery.forwardLockSeconds),
  };
}

export async function setPolicy(patch) {
  const fields = {};
  if (patch.autoDelete !== undefined) fields.autoDelete = String(patch.autoDelete);
  if (patch.forwardLock !== undefined) fields.forwardLock = String(patch.forwardLock);
  if (Object.keys(fields).length) await redis.hset(SETTINGS, fields);
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const html = { parse_mode: 'HTML' };

async function addJob(runAtMs, job) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const ttl = Math.max(60, Math.ceil((runAtMs - Date.now()) / 1000)) + 7 * 86_400;
  await redis.multi().set(DATA(id), JSON.stringify(job), 'EX', ttl).zadd(DUE, runAtMs, id).exec();
}

async function deleteMessages(chatId, ids) {
  for (const part of chunk(ids, 100)) {
    try {
      await bot.api.deleteMessages(chatId, part);
    } catch {
      for (const id of part) await bot.api.deleteMessage(chatId, id).catch(() => {});
    }
  }
}

/**
 * Call right after files were delivered to a user. Sends one short notice and schedules the unlock / delete job.
 * ids: Telegram message IDs in the user's chat (files + any trailing message), src: storage-channel message IDs
 * (needed to re-send forwardable copies). markupOn: where the Report button lives ('file' | 'notice').
 */
export async function trackDelivery({ chatId, ids, src, policy, markup = null, markupOn = 'file', now = Date.now() }) {
  const { autoDelete, forwardLock } = policy;
  if (!autoDelete && !forwardLock) return;
  const all = ids.filter(Boolean);
  const lines = [];
  if (forwardLock) lines.push(`🔒 Forwarding and saving are locked for <b>${formatSecs(forwardLock)}</b>. After that you can forward these files.`);
  if (autoDelete) lines.push(`🗑 These messages are deleted automatically in <b>${formatSecs(autoDelete)}</b>. Save them now!`);
  try {
    const notice = await bot.api.sendMessage(chatId, lines.join('\n'), html);
    all.push(notice.message_id);
  } catch (err) {
    logger.warn('delivery notice failed', { err });
  }
  const deleteAt = autoDelete ? now + autoDelete * 1000 : 0;
  const unlockAt = now + forwardLock * 1000;
  if (forwardLock && (!deleteAt || deleteAt > unlockAt)) {
    await addJob(unlockAt, { t: 'unlock', chatId, ids: all, src, deleteAt, markup, markupOn });
  } else if (deleteAt) {
    await addJob(deleteAt, { t: 'delete', chatId, ids: all });
  }
}

async function resend(job) {
  const src = [...job.src].sort((a, b) => a - b);
  const onFile = job.markup && job.markupOn === 'file' ? { reply_markup: job.markup } : {};
  const sent = [];
  if (src.length === 1) {
    sent.push((await copyFromStorage(job.chatId, src[0], onFile)).message_id);
    return sent;
  }
  for (const part of chunk(src, 10)) {
    try {
      const res = await copyManyFromStorage(job.chatId, part);
      if (Array.isArray(res)) sent.push(...res.map((m) => m.message_id));
    } catch (err) {
      if (isBlockedError(err)) throw err;
      for (const id of part) {
        try { sent.push((await copyFromStorage(job.chatId, id)).message_id); } catch (e) { logger.warn('single re-send failed', { err: e }); }
      }
    }
  }
  return sent;
}

async function runJob(job) {
  if (job.t === 'delete') {
    await deleteMessages(job.chatId, job.ids);
    return;
  }
  if (job.t !== 'unlock') return;
  await deleteMessages(job.chatId, job.ids);
  if (job.deleteAt && job.deleteAt <= Date.now()) return;
  let sent;
  try {
    sent = await resend(job);
    let text = '🔓 <b>Forwarding is now allowed.</b>';
    if (job.deleteAt) text += `\n🗑 Deleted automatically in <b>${formatSecs(Math.max(1, Math.round((job.deleteAt - Date.now()) / 1000)))}</b>.`;
    const extra = job.markup && job.markupOn === 'notice' ? { ...html, reply_markup: job.markup } : html;
    sent.push((await bot.api.sendMessage(job.chatId, text, extra)).message_id);
  } catch (err) {
    if (isBlockedError(err)) return; // user blocked the bot: nothing left to do
    throw err;
  }
  if (job.deleteAt) await addJob(job.deleteAt, { t: 'delete', chatId: job.chatId, ids: sent });
}

export async function sweepOnce() {
  const ids = await redis.zrangebyscore(DUE, '-inf', Date.now(), 'LIMIT', 0, 25);
  for (const id of ids) {
    await redis.zadd(DUE, Date.now() + LEASE_MS, id); // lease
    const raw = await redis.get(DATA(id));
    const finish = () => redis.multi().zrem(DUE, id).del(DATA(id)).exec();
    if (!raw) { await redis.zrem(DUE, id); continue; }
    const job = JSON.parse(raw);
    try {
      await runJob(job);
      await finish();
    } catch (err) {
      job.attempts = (job.attempts ?? 0) + 1;
      if (job.attempts >= MAX_ATTEMPTS) {
        logger.error('delivery job gave up', { err, action: job.t });
        await finish();
      } else {
        logger.warn('delivery job failed; will retry', { err, attempt: job.attempts });
        await redis.set(DATA(id), JSON.stringify(job), 'KEEPTTL');
        await redis.zadd(DUE, Date.now() + 30_000, id);
      }
    }
  }
}

export function startDeliverySweeper() {
  let busy = false;
  const run = async () => {
    if (busy || lifecycle.shuttingDown) return;
    busy = true;
    try { await sweepOnce(); } catch (err) { logger.warn('delivery sweep failed', { err }); } finally { busy = false; }
  };
  const timer = setInterval(run, 2_000);
  const first = setTimeout(run, 3_000);
  timer.unref();
  first.unref();
  return () => { clearInterval(timer); clearTimeout(first); };
}
