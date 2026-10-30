import { randomBytes } from 'node:crypto';
import { GrammyError, HttpError } from 'grammy';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sleep } from '../lifecycle.js';
import { shortRef } from '../utils/ids.js';
import { audit } from './audit.js';
import { redis } from './redis.js';
import { K } from './keys.js';
import { bot } from './telegram.js';

// =====================================================================================================
//  Dynamic Force Subscribe: channel configuration (Redis) + real membership verification (getChatMember)
//
//  Storage:  fsub:ch:<id>  hash   one channel      [authoritative, included in backups]
//            fsub:ids      zset   channel ids      [authoritative]
//  Nothing is kept only in memory: restarts and redeploys keep every channel.
// =====================================================================================================

export const MAX_CHANNELS = 20;
export const CHANNEL_ID_RE = /^[A-HJKMNP-Z2-9]{8}$/;
const LIMITS = { name: 64, btn: 60, url: 256, desc: 300 };

// Writes health info of a channel only while it still exists (a deleted channel must never be resurrected).
redis.defineCommand('fsubTouch', {
  numberOfKeys: 1,
  lua: `if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'lastError', ARGV[1], 'lastCheckAt', ARGV[2])
return 1`,
});
redis.defineCommand('fsubUnlock', {
  numberOfKeys: 1,
  lua: `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
});

// ---------------------------------------------------------------- text + input validation

/** Removes control characters / zero-width tricks, collapses whitespace. Output is plain text (escape for HTML when displaying). */
export function cleanText(value, max) {
  const t = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(t).slice(0, max).join('');
}

const lengthOk = (text, max) => Array.from(text).length <= max;

export function parseName(input) {
  const raw = String(input ?? '');
  const v = cleanText(raw, LIMITS.name + 1);
  if (!v) return { ok: false, error: 'The name cannot be empty.' };
  if (!lengthOk(v, LIMITS.name)) return { ok: false, error: `Keep the name under ${LIMITS.name} characters.` };
  return { ok: true, value: v };
}

export function parseButtonLabel(input) {
  const v = cleanText(input, LIMITS.btn + 1);
  if (!v) return { ok: false, error: 'The button name cannot be empty.' };
  if (!lengthOk(v, LIMITS.btn)) return { ok: false, error: `Keep the button name under ${LIMITS.btn} characters.` };
  return { ok: true, value: v };
}

export function parseDescription(input) {
  const raw = String(input ?? '').trim();
  if (raw === '' || raw === '-' || /^skip$/i.test(raw)) return { ok: true, value: '' };
  const v = cleanText(raw, LIMITS.desc + 1);
  if (!lengthOk(v, LIMITS.desc)) return { ok: false, error: `Keep the description under ${LIMITS.desc} characters.` };
  return { ok: true, value: v };
}

/** Accepts @username, username, or a -100… chat id. Returns the normalised reference. */
export function parseChannelRef(input) {
  const raw = String(input ?? '').trim();
  if (/^-100\d{5,15}$/.test(raw)) return { ok: true, kind: 'id', value: raw, display: raw };
  const m = /^@?([A-Za-z][A-Za-z0-9_]{4,31})$/.exec(raw);
  if (m) return { ok: true, kind: 'username', value: `@${m[1]}`, display: `@${m[1]}` };
  return { ok: false, error: 'Send a public @username (for example @TheRoyalZone) or a channel ID that looks like -1001234567890.' };
}

const TG_HOSTS = new Set(['t.me', 'telegram.me', 'telegram.dog']);

/**
 * Only real Telegram invite links are accepted: https://t.me/<username>, https://t.me/+<hash>, https://t.me/joinchat/<hash>.
 * No other scheme (javascript:, tg:, http:, data: ...), host, credentials, port, query or fragment is kept.
 * Returns the normalised link.
 */
export function validateJoinUrl(input) {
  let raw = String(input ?? '').trim();
  if (!raw || raw.length > LIMITS.url) return { ok: false, error: 'Send a Telegram link such as https://t.me/TheRoyalZone or a private invite link https://t.me/+AbCdEf123.' };
  if (/^(t\.me|telegram\.me|telegram\.dog)\//i.test(raw)) raw = `https://${raw}`;
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: 'That is not a valid link. Example: https://t.me/TheRoyalZone' }; }
  if (u.protocol !== 'https:') return { ok: false, error: 'Only https:// Telegram links are accepted.' };
  if (!TG_HOSTS.has(u.hostname.toLowerCase()) || u.username || u.password || u.port) {
    return { ok: false, error: 'Only Telegram links are accepted (t.me, telegram.me or telegram.dog).' };
  }
  const path = u.pathname;
  if (/^\/[A-Za-z][A-Za-z0-9_]{4,31}\/?$/.test(path)) {
    return { ok: true, value: `https://t.me/${path.replace(/\//g, '')}`, kind: 'public' };
  }
  const priv = /^\/\+([A-Za-z0-9_-]{8,64})\/?$/.exec(path) ?? /^\/joinchat\/([A-Za-z0-9_-]{8,64})\/?$/.exec(path);
  if (priv) return { ok: true, value: `https://t.me/+${priv[1]}`, kind: 'private' };
  return { ok: false, error: 'This is not a channel link. Use https://t.me/<username> or an invite link like https://t.me/+AbCdEf123.' };
}

// ---------------------------------------------------------------- Telegram error classification

/** Turns a Telegram/network failure into a stable code and a message that is safe to show to an admin. */
export function describeTgError(err) {
  if (err instanceof HttpError) return { code: 'network', message: 'Could not reach Telegram (network problem). Try again in a moment.' };
  if (err instanceof GrammyError) {
    const d = String(err.description ?? '');
    if (err.error_code === 429) return { code: 'rate_limited', message: 'Telegram is rate limiting the bot. Try again in a moment.' };
    if (/chat not found|CHANNEL_INVALID|CHAT_ID_INVALID|PEER_ID_INVALID|invalid chat/i.test(d)) {
      return { code: 'not_found', message: 'Telegram cannot find that chat. Check the @username / ID, and for private channels add the bot as an administrator first.' };
    }
    if (/not enough rights|CHAT_ADMIN_REQUIRED|member list is inaccessible|bot was kicked|bot is not a member|forbidden|have no rights/i.test(d) || err.error_code === 403) {
      return { code: 'no_access', message: 'The bot has no access to that chat. Add the bot as an administrator.' };
    }
    if (/user not found|PARTICIPANT_ID_INVALID/i.test(d)) return { code: 'user_unknown', message: 'Telegram could not look up this user.' };
    return { code: 'telegram', message: `Telegram refused the request (${err.error_code}).` };
  }
  return { code: 'unknown', message: 'Unexpected error while talking to Telegram.' };
}

const errorLabel = {
  network: 'network problem',
  rate_limited: 'Telegram rate limit',
  not_found: 'chat not found',
  no_access: 'bot has no access',
  bot_not_admin: 'bot is not an administrator',
  user_unknown: 'user lookup failed',
  telegram: 'Telegram error',
  unknown: 'unexpected error',
};
export const labelForError = (code) => errorLabel[code] ?? code;

async function botId() {
  if (bot.botInfo?.id) return bot.botInfo.id;
  return (await bot.api.getMe()).id;
}

/**
 * Resolves a channel reference through Telegram and checks that the bot can really verify members there.
 * Returns { ok:true, chatId, username, title, type } or { ok:false, code, message }.
 */
export async function inspectChannel(ref) {
  let chat;
  try {
    chat = await bot.api.getChat(ref);
  } catch (err) {
    const d = describeTgError(err);
    return { ok: false, ...d };
  }
  if (!['channel', 'supergroup', 'group'].includes(chat.type)) {
    return { ok: false, code: 'not_a_channel', message: 'That is not a channel or group. Send a channel or group.' };
  }
  try {
    const me = await bot.api.getChatMember(chat.id, await botId());
    if (!['administrator', 'creator'].includes(me.status)) {
      return { ok: false, code: 'bot_not_admin', message: `The bot must be an administrator of “${cleanText(chat.title, 60)}” so it can check who joined. Add it as admin, then retry.` };
    }
  } catch (err) {
    return { ok: false, ...describeTgError(err) };
  }
  return { ok: true, chatId: String(chat.id), username: (chat.username ?? '').toLowerCase(), title: cleanText(chat.title, LIMITS.name), type: chat.type };
}

// ---------------------------------------------------------------- records

const num = (v) => Number(v) || 0;

function parse(h) {
  if (!h || !CHANNEL_ID_RE.test(h.id ?? '')) return null;
  return {
    id: h.id,
    name: h.name ?? '',
    ref: h.ref ?? '',
    chatId: h.chatId ?? '',
    username: h.username ?? '',
    type: h.type ?? 'channel',
    btn: h.btn ?? '',
    url: h.url ?? '',
    desc: h.desc ?? '',
    enabled: h.enabled === '1',
    createdAt: num(h.createdAt),
    updatedAt: num(h.updatedAt),
    lastError: h.lastError ?? '',
    lastCheckAt: num(h.lastCheckAt),
  };
}

export async function listChannels({ onlyActive = false } = {}) {
  const ids = await redis.zrange(K.fsubIds, 0, -1);
  if (ids.length === 0) return [];
  const pipe = redis.pipeline();
  for (const id of ids) pipe.hgetall(K.fsubChannel(id));
  const rows = await pipe.exec();
  const out = [];
  for (const [err, h] of rows) {
    if (err) throw err;
    const ch = parse(h);
    if (ch && (!onlyActive || (ch.enabled && ch.chatId))) out.push(ch);
  }
  return out;
}

export async function getChannel(id) {
  if (!CHANNEL_ID_RE.test(id ?? '')) return null;
  return parse(await redis.hgetall(K.fsubChannel(id)));
}

export const countChannels = () => redis.zcard(K.fsubIds);

async function withLock(fn) {
  const token = randomBytes(8).toString('hex');
  let got = false;
  for (let i = 0; i < 40 && !got; i += 1) {
    got = (await redis.set('lock:fsub', token, 'EX', 15, 'NX')) === 'OK';
    if (!got) await sleep(100);
  }
  if (!got) return { ok: false, code: 'busy', message: 'Another change is in progress. Try again.' };
  try {
    return await fn();
  } finally {
    await redis.fsubUnlock('lock:fsub', token).catch(() => {});
  }
}

/** Duplicate detection uses the NORMALISED identifiers: the numeric chat id Telegram resolved, and the lower-case username. */
function findDuplicate(all, info, exceptId = '') {
  return all.find((c) => c.id !== exceptId && ((c.chatId && c.chatId === info.chatId) || (info.username && c.username === info.username)));
}

const fail = (code, message) => ({ ok: false, code, message });

/** Validates through Telegram, then stores. `draft` = { name, ref, btn, url, desc }. */
export async function createChannel(draft, { actorId = 0, enabled = true, skipTelegram = null } = {}) {
  const name = parseName(draft.name); const ref = parseChannelRef(draft.ref); const btn = parseButtonLabel(draft.btn);
  const url = validateJoinUrl(draft.url); const desc = parseDescription(draft.desc);
  const bad = [name, ref, btn, url, desc].find((r) => !r.ok);
  if (bad) return fail('invalid', bad.error);
  if ((await countChannels()) >= MAX_CHANNELS) return fail('limit', `You can configure at most ${MAX_CHANNELS} channels.`);

  let info = skipTelegram;
  if (!info) {
    info = await inspectChannel(ref.value);
    if (!info.ok) return info;
  }
  return withLock(async () => {
    const all = await listChannels();
    const dup = findDuplicate(all, info);
    if (dup) return fail('duplicate', `That chat is already configured as “${dup.name}”.`);
    let id = '';
    for (let i = 0; i < 12 && !id; i += 1) {
      const candidate = shortRef(8);
      if ((await redis.exists(K.fsubChannel(candidate))) === 0) id = candidate;
    }
    if (!id) return fail('id', 'Could not allocate an id. Try again.');
    const now = Date.now();
    await redis.multi()
      .hset(K.fsubChannel(id), {
        id, name: name.value, ref: ref.value, chatId: info.chatId, username: info.username, type: info.type,
        btn: btn.value, url: url.value, desc: desc.value, enabled: enabled ? '1' : '0',
        createdAt: String(now), updatedAt: String(now), lastError: '', lastCheckAt: String(now),
      })
      .zadd(K.fsubIds, now, id)
      .exec();
    audit('admin_action', { actorId, detail: `fsub add ${id} ${info.chatId}` });
    return { ok: true, channel: await getChannel(id) };
  });
}

/**
 * Edits one field. patch keys: name | ref | btn | url | desc. Changing `ref` is re-validated against Telegram
 * (and rejected when the bot cannot verify members there, so an edit can never silently break verification).
 */
export async function updateChannel(id, patch, { actorId = 0 } = {}) {
  const current = await getChannel(id);
  if (!current) return fail('gone', 'That channel no longer exists.');
  const set = {};
  if ('name' in patch) { const r = parseName(patch.name); if (!r.ok) return fail('invalid', r.error); set.name = r.value; }
  if ('btn' in patch) { const r = parseButtonLabel(patch.btn); if (!r.ok) return fail('invalid', r.error); set.btn = r.value; }
  if ('url' in patch) { const r = validateJoinUrl(patch.url); if (!r.ok) return fail('invalid', r.error); set.url = r.value; }
  if ('desc' in patch) { const r = parseDescription(patch.desc); if (!r.ok) return fail('invalid', r.error); set.desc = r.value; }
  let info = null;
  if ('ref' in patch) {
    const r = parseChannelRef(patch.ref);
    if (!r.ok) return fail('invalid', r.error);
    info = await inspectChannel(r.value);
    if (!info.ok) return info;
    set.ref = r.value; set.chatId = info.chatId; set.username = info.username; set.type = info.type; set.lastError = ''; set.lastCheckAt = String(Date.now());
  }
  return withLock(async () => {
    if (!(await redis.exists(K.fsubChannel(id)))) return fail('gone', 'That channel no longer exists.');
    if (info) {
      const dup = findDuplicate(await listChannels(), info, id);
      if (dup) return fail('duplicate', `That chat is already configured as “${dup.name}”.`);
    }
    await redis.hset(K.fsubChannel(id), { ...set, updatedAt: String(Date.now()) });
    audit('admin_action', { actorId, detail: `fsub edit ${id} ${Object.keys(patch).join(',')}` });
    return { ok: true, channel: await getChannel(id) };
  });
}

/** Enabling is refused while the bot cannot verify members (that would lock every user out). Disabling is always allowed and immediate. */
export async function setChannelEnabled(id, enabled, { actorId = 0 } = {}) {
  const ch = await getChannel(id);
  if (!ch) return fail('gone', 'That channel no longer exists.');
  if (enabled) {
    const info = await inspectChannel(ch.chatId);
    await touchHealth(ch.id, info.ok ? '' : info.code);
    if (!info.ok) return info;
  }
  return withLock(async () => {
    if (!(await redis.exists(K.fsubChannel(id)))) return fail('gone', 'That channel no longer exists.');
    await redis.hset(K.fsubChannel(id), { enabled: enabled ? '1' : '0', updatedAt: String(Date.now()) });
    audit('admin_action', { actorId, detail: `fsub ${enabled ? 'enable' : 'disable'} ${id}` });
    return { ok: true, channel: await getChannel(id) };
  });
}

/** Removes only this channel's configuration (other channels and all bot data are untouched). */
export async function deleteChannel(id, { actorId = 0 } = {}) {
  return withLock(async () => {
    const ch = await getChannel(id);
    if (!ch) return fail('gone', 'That channel no longer exists.');
    await redis.multi().del(K.fsubChannel(id)).zrem(K.fsubIds, id).exec();
    audit('admin_action', { actorId, detail: `fsub delete ${id} ${ch.chatId}` });
    return { ok: true, channel: ch };
  });
}

async function touchHealth(id, code) {
  try { await redis.fsubTouch(K.fsubChannel(id), code ?? '', String(Date.now())); } catch (err) { logger.debug('fsub health write failed', { err }); }
}

/** Live health check used by the admin screens. Returns the inspect result and stores the outcome. */
export async function probeChannel(ch) {
  const info = await inspectChannel(ch.chatId);
  await touchHealth(ch.id, info.ok ? '' : info.code);
  return info;
}

// ---------------------------------------------------------------- admin wizard draft (one per admin, short-lived)

const DRAFT_TTL = 1800;
export async function getDraft(adminId) {
  const raw = await redis.get(K.fsubDraft(adminId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
export const saveDraft = (adminId, draft) => redis.set(K.fsubDraft(adminId), JSON.stringify(draft), 'EX', DRAFT_TTL);
export const clearDraft = (adminId) => redis.del(K.fsubDraft(adminId));

// ---------------------------------------------------------------- membership verification

/**
 * Decides one user x one channel with a REAL getChatMember call.
 *   member / administrator / creator -> allowed
 *   restricted                       -> allowed only when is_member === true
 *   left / kicked / anything else    -> denied
 *   API / network / permission error -> state 'error' (access is NEVER granted when membership cannot be confirmed)
 */
export async function checkMembership(userId, channel, { fresh = false } = {}) {
  const ttl = config.forceSub.cacheSeconds;
  const cacheKey = K.fsubOk(userId, channel.id);
  if (ttl > 0 && !fresh) {
    try {
      if ((await redis.get(cacheKey)) === channel.chatId) return { state: 'member', channel };
    } catch { /* cache is optional */ }
  }
  try {
    const m = await bot.api.getChatMember(channel.chatId, userId);
    const ok = ['creator', 'administrator', 'member'].includes(m.status) || (m.status === 'restricted' && m.is_member === true);
    if (ok) {
      if (ttl > 0) redis.set(cacheKey, channel.chatId, 'EX', ttl).catch(() => {});
      if (channel.lastError) touchHealth(channel.id, '');
      return { state: 'member', channel };
    }
    redis.del(cacheKey).catch(() => {});
    return { state: 'not_member', channel };
  } catch (err) {
    const d = describeTgError(err);
    if (d.code === 'user_unknown') return { state: 'not_member', channel }; // never confirmed -> stays restricted
    logger.warn('force subscribe: membership check failed', { channelId: channel.id, code: d.code, err });
    touchHealth(channel.id, d.code);
    return { state: 'error', code: d.code, channel };
  }
}

/** Checks every active mandatory channel. allowed === true only when ALL of them confirm membership. */
export async function checkAll(userId, channels, opts = {}) {
  const results = await Promise.all(channels.map((c) => checkMembership(userId, c, opts)));
  return { allowed: results.every((r) => r.state === 'member'), results };
}

// ---------------------------------------------------------------- deep link waiting for verification

export const savePending = (userId, payload) => redis.set(K.fsubPending(userId), payload, 'EX', 3600);
export async function takePending(userId) {
  const key = K.fsubPending(userId);
  const v = await redis.get(key);
  if (v) await redis.del(key);
  return v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : '';
}

// ---------------------------------------------------------------- one-time import of FORCE_SUB_SEED

/**
 * Optional migration step: FORCE_SUB_SEED=@TheRoyalZone|The Royal Zone|📢 Join The Royal Zone|https://t.me/TheRoyalZone
 * Runs once. A channel the bot can verify is imported ACTIVE; one it cannot verify yet (bot not admin) is imported
 * DISABLED so the rollout can never lock every user out. Fix the access in the Admin Panel, then enable it.
 */
export async function seedFromConfig() {
  const entries = config.forceSub.seed;
  if (entries.length === 0) return { seeded: 0, skipped: 'no seed configured' };
  if (await redis.get(K.fsubSeeded)) return { seeded: 0, skipped: 'already applied' };
  let created = 0; let retry = false;
  for (const e of entries) {
    const ref = parseChannelRef(e.ref);
    if (!ref.ok) continue;
    const info = await inspectChannel(ref.value);
    const usable = info.ok;
    if (!usable && ['network', 'rate_limited', 'telegram', 'unknown'].includes(info.code)) { retry = true; logger.warn('force subscribe seed: will retry on next start', { ref: ref.value, code: info.code }); continue; }
    let resolved = info;
    if (!usable) {
      // Resolve the chat id without requiring admin rights, so the entry still exists (disabled) for the admin to fix.
      try {
        const chat = await bot.api.getChat(ref.value);
        resolved = { ok: true, chatId: String(chat.id), username: (chat.username ?? '').toLowerCase(), title: cleanText(chat.title, LIMITS.name), type: chat.type };
      } catch (err) {
        logger.error('force subscribe seed: chat not found, add it from the Admin Panel instead', { ref: ref.value, code: describeTgError(err).code });
        continue;
      }
    }
    const username = resolved.username || (ref.kind === 'username' ? ref.value.slice(1).toLowerCase() : '');
    const name = parseName(e.name || resolved.title || ref.value);
    const btn = parseButtonLabel(e.btn || `📢 Join ${name.value}`);
    const link = validateJoinUrl(e.url || (username ? `https://t.me/${username}` : ''));
    if (!name.ok || !btn.ok || !link.ok) { logger.error('force subscribe seed: invalid entry (button/url); add it from the Admin Panel', { ref: ref.value }); continue; }
    const res = await createChannel({ name: name.value, ref: ref.value, btn: btn.value, url: link.value, desc: '' }, { enabled: usable, skipTelegram: resolved });
    if (res.ok) {
      created += 1;
      if (!usable) await touchHealth(res.channel.id, info.code);
      logger.info('force subscribe seed: channel imported', { id: res.channel.id, enabled: usable });
      if (!usable) logger.warn('force subscribe seed: imported DISABLED because the bot cannot verify members yet — add the bot as admin, then enable it in Admin → Force Subscribe', { ref: ref.value });
    } else if (res.code !== 'duplicate') {
      logger.error('force subscribe seed failed', { ref: ref.value, code: res.code });
    }
  }
  if (!retry) await redis.set(K.fsubSeeded, String(Date.now()));
  return { seeded: created, retry };
}
