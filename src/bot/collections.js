import { InlineKeyboard } from 'grammy';
import { config, isAdmin } from '../config.js';
import { logger, shortToken } from '../logger.js';
import { lifecycle, sleep } from '../lifecycle.js';
import { audit, secCount } from '../services/audit.js';
import {
  categoryCounts, cleanTitle, createCollection, deleteCollection, getCShare, getCollection, linkState, listUserCollections,
  loadCollectionFiles, publicFileState, recordCollectionAccess, renameCollection, resolveCollectionShare, setLinkExpiry, setLinkStatus,
} from '../services/collections.js';
import { getPolicy, trackDelivery } from '../services/autodelete.js';
import { canOwnerDownload, getFiles, recordDownload } from '../services/files.js';
import { clearAwait, setAwait } from '../services/inputState.js';
import { limiters } from '../services/rateLimit.js';
import { createCollectionReport } from '../services/reports.js';
import { bot, copyManyFromStorage } from '../services/telegram.js';
import {
  chunk, claimBatch, dueBatches, getBatch, batchSize, openBatch,
} from '../services/uploadBatch.js';
import { CATEGORIES, CATEGORY_LABELS } from '../utils/category.js';
import { escapeHtml, formatBytes, formatSize, truncate } from '../utils/format.js';
import { collectionLink, collectionShareUrl } from '../utils/links.js';
import { EXPIRY_PRESETS, describeExpiry, formatDay } from '../utils/time.js';
import { editOrReply, isNotModified } from './common.js';
import { expiryKeyboard, fileKeyboard } from './keyboards.js';
import { htmlOpts, rateLimitText, renderFileCard, unavailableText } from './views.js';

const ID = '([A-Za-z0-9_-]{32})';
const TITLE = escapeHtml(config.dashboardTitle);
const icon = (cat) => CATEGORY_LABELS[cat]?.icon ?? '📎';

export const STATE_TEXT = { active: '🟢 Active', disabled: '🚫 Disabled', expired: '⌛ Expired' };

// ---------------------------------------------------------------- shared rendering

/** "🖼 3 · 🎥 2 · 📕 1" */
export function mixLine(files) {
  const counts = categoryCounts(files);
  return CATEGORIES.filter((c) => counts[c]).map((c) => `${icon(c)} ${counts[c]}`).join(' · ');
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function problemLines({ failed = 0, skipped = 0, dup = 0, errRef = '' } = {}) {
  const out = [];
  if (failed) out.push(`⚠️ ${plural(failed, 'file')} could not be uploaded${errRef ? ` — Reference ID <code>${escapeHtml(errRef)}</code>` : ''}.`);
  if (skipped) out.push(`⚠️ ${plural(skipped, 'file')} skipped (too large, protected or not supported).`);
  if (dup) out.push(`ℹ️ ${plural(dup, 'duplicate')} ignored.`);
  return out;
}

export function uploadCompleteText(collection, files, problems = {}) {
  const lines = [
    `🔐 <b>${TITLE}</b>`, '',
    '✅ <b>Upload Complete</b>', '',
    `📁 <b>${plural(collection.fileCount, 'File')}</b>`,
    `💾 ${formatBytes(collection.totalSize)}`,
  ];
  const mix = mixLine(files);
  if (mix) lines.push(mix);
  lines.push('', `🗂 ${escapeHtml(truncate(collection.title, 60))}`, '', '🔗 <b>Your Share Link:</b>', collectionLink(collection.shareToken));
  const warn = problemLines(problems);
  if (warn.length) lines.push('', ...warn);
  return lines.join('\n');
}

/** Url + copy + share buttons for an active link. */
function addLinkButtons(kb, token) {
  const link = collectionLink(token);
  kb.url('🔗 Open Link', link).add({ text: '📋 Copy Link', copy_text: { text: link } }).row()
    .url('📤 Share', collectionShareUrl(link));
  return kb;
}

export function uploadCompleteKeyboard(collection) {
  const kb = new InlineKeyboard();
  addLinkButtons(kb, collection.shareToken).text('📁 My Files', 'files:1').row()
    .text('🗂 Manage Collection', `co:${collection.id}`);
  return kb;
}

async function showResult(uid, statusId, text, reply_markup) {
  if (statusId) {
    try {
      await bot.api.editMessageText(uid, statusId, text, htmlOpts({ reply_markup }));
      return;
    } catch (err) {
      if (isNotModified(err)) return;
    }
  }
  try {
    await bot.api.sendMessage(uid, text, htmlOpts({ reply_markup }));
  } catch (err) {
    logger.error('could not deliver collection result', { userId: uid, err });
  }
}

// ---------------------------------------------------------------- batch lifecycle

const timers = new Map(); // uid -> timeout that ends an auto batch after the quiet window

function cancelTimer(uid) {
  const t = timers.get(uid);
  if (t) clearTimeout(t);
  timers.delete(uid);
}

/** (Re)starts the quiet-window timer of an auto batch. */
export function scheduleFinalize(uid, ms) {
  cancelTimer(uid);
  const t = setTimeout(() => {
    timers.delete(uid);
    finalizeBatch(uid).catch((err) => logger.error('batch finalize failed', { userId: uid, err }));
  }, ms);
  t.unref?.();
  timers.set(uid, t);
}

/**
 * Ends the user's open upload batch (quiet window over, "Create link" pressed, or idle timeout).
 * 1 stored file -> normal file card (already on screen for auto batches), 2+ -> ONE collection with ONE link.
 */
export async function finalizeBatch(uid) {
  cancelTimer(uid);
  const batch = await claimBatch(uid);
  if (!batch) return;
  const problems = { failed: batch.failed, skipped: batch.skipped, dup: batch.dup, errRef: batch.errRef };
  const hasProblems = problems.failed + problems.skipped + problems.dup > 0;

  if (batch.fileIds.length === 0) {
    if (batch.mode === 'manual' || hasProblems) {
      const text = ['📦 <b>Multi-file upload closed</b>', '', 'No files were stored.', ...problemLines(problems)].join('\n');
      await showResult(uid, batch.status, text, new InlineKeyboard().text('🏠 Menu', 'menu:home'));
    }
    return;
  }
  // The common case — a single file: its card is already on screen.
  if (batch.fileIds.length === 1 && batch.mode === 'auto' && !hasProblems) return;

  const files = (await getFiles(batch.fileIds)).filter((f) => f && f.uploaderId === uid);
  if (files.length === 0) return;
  if (files.length === 1) {
    const warn = problemLines(problems);
    const card = await renderFileCard(files[0], { title: '✅ <b>Uploaded</b>' });
    await showResult(uid, batch.status, warn.length ? `${card}\n\n${warn.join('\n')}` : card, fileKeyboard(files[0]));
    return;
  }

  const parts = chunk(files.map((f) => f.id));
  for (let i = 0; i < parts.length; i += 1) {
    const res = await createCollection({ ownerId: uid, fileIds: parts[i] });
    if (res.result !== 'created') continue;
    await audit('collection_create', { actorId: uid, detail: `#${res.collection.ref} ${res.collection.fileCount} files ${res.collection.totalSize}B` });
    logger.info('collection created', { userId: uid, tokenId: shortToken(res.share.token), files: res.collection.fileCount });
    const text = uploadCompleteText(res.collection, res.files, i === 0 ? problems : {});
    const kb = uploadCompleteKeyboard(res.collection);
    await showResult(uid, i === 0 ? batch.status : null, text, kb);
  }
}

/** Recovers batches whose timer was lost (restart, crash) so no file stays in limbo. */
export function startBatchSweeper() {
  const run = async () => {
    if (lifecycle.shuttingDown) return;
    try {
      for (const uid of await dueBatches()) await finalizeBatch(uid).catch((err) => logger.error('batch recovery failed', { userId: uid, err }));
    } catch (err) {
      logger.warn('batch sweep failed', { err });
    }
  };
  const timer = setInterval(run, 15_000);
  const first = setTimeout(run, 5_000);
  timer.unref();
  first.unref();
  return () => { clearInterval(timer); clearTimeout(first); };
}

// ---- progress messages (throttled: Telegram limits message edits) ----
const lastEdit = new Map();
export async function progressEdit(uid, statusId, text, reply_markup, minGapMs = 1200) {
  if (!statusId) return;
  const now = Date.now();
  if (now - (lastEdit.get(uid) ?? 0) < minGapMs) return;
  lastEdit.set(uid, now);
  if (lastEdit.size > 5000) lastEdit.clear();
  try {
    await bot.api.editMessageText(uid, statusId, text, htmlOpts({ reply_markup }));
  } catch (err) {
    if (!isNotModified(err)) logger.debug('progress edit failed', { err });
  }
}

export const progressText = (n) => `⏳ <b>Processing ${plural(n, 'file')}…</b>\nSaving them to secure storage.`;

// ---- manual "Multiple files" session ----
export const manualText = (n, bytes) => [
  '📦 <b>Multiple files</b>', '',
  'Send me all your files — photos, videos, PDFs, audio, documents, any mix. They go into <b>one collection</b> with <b>one link</b>.', '',
  n ? `📥 Received: <b>${plural(n, 'file')}</b> · ${formatBytes(bytes)}` : '📥 Waiting for your files…', '',
  'Tap <b>Create link</b> when you are done.',
].join('\n');

export const manualKeyboard = (n) => new InlineKeyboard()
  .text(n ? `✅ Create link (${n})` : '✅ Create link', 'mb:done').text('✖️ Cancel', 'mb:cancel');

async function startManual(ctx) {
  const uid = ctx.from.id;
  const existing = await getBatch(uid);
  if (existing) await finalizeBatch(uid);
  let statusId;
  if (ctx.callbackQuery) {
    await editOrReply(ctx, manualText(0, 0), manualKeyboard(0));
    statusId = ctx.callbackQuery.message?.message_id;
  } else {
    statusId = (await ctx.reply(manualText(0, 0), htmlOpts({ reply_markup: manualKeyboard(0) }))).message_id;
  }
  await openBatch(uid, { mode: 'manual', statusMessageId: statusId });
}

// ---------------------------------------------------------------- My Collections

function collectionLine(item, n) {
  const c = item.collection;
  return `<b>${n}.</b> 🗂 ${escapeHtml(truncate(c.title, 40))}\n      ${plural(c.fileCount, 'file')} · ${formatSize(c.totalSize)} · ${formatDay(c.createdAt)} · ${STATE_TEXT[item.state]}`;
}

export async function renderCollectionsView(userId, page = 1) {
  const list = await listUserCollections(userId, page);
  if (list.total === 0) {
    return {
      text: ['🗂 <b>My Collections</b>', '', 'No collections yet.', '', 'Send several files at once — or tap <b>Multiple files</b> in Upload — and I will give you ONE link for all of them.'].join('\n'),
      reply_markup: new InlineKeyboard().text('📦 Multiple files', 'mb:start').row().text('📁 My Files', 'files:1').text('🏠 Menu', 'menu:home'),
    };
  }
  const offset = (list.page - 1) * config.filesPerPage;
  const text = [
    '🗂 <b>My Collections</b>', `${plural(list.total, 'collection')} · Page ${list.page}/${list.totalPages}`, '',
    list.items.map((it, i) => collectionLine(it, offset + i + 1)).join('\n\n'), '', '<i>Tap a number to open a collection.</i>',
  ].join('\n');
  const kb = new InlineKeyboard();
  list.items.forEach((it, i) => kb.text(String(offset + i + 1), `co:${it.collection.id}`));
  kb.row()
    .text('⬅️', list.page > 1 ? `colls:${list.page - 1}` : 'noop').text(`${list.page}/${list.totalPages}`, 'noop').text('➡️', list.page < list.totalPages ? `colls:${list.page + 1}` : 'noop')
    .row().text('📦 Multiple files', 'mb:start').row().text('📁 My Files', 'files:1').text('🏠 Menu', 'menu:home');
  return { text, reply_markup: kb };
}

export function collectionDetailText(collection, share, state, files, { title = '🗂 <b>Collection</b>' } = {}) {
  const lines = [
    title, '', `<b>${escapeHtml(truncate(collection.title, 60))}</b>`,
    `📁 ${plural(collection.fileCount, 'file')} · 💾 ${formatBytes(collection.totalSize)}`,
  ];
  const mix = mixLine(files);
  if (mix) lines.push(mix);
  lines.push(`📅 Created: ${formatDay(collection.createdAt)}`, `🔗 Link: ${STATE_TEXT[state]}`, `⏳ Expires: ${describeExpiry(share?.expiresAt ?? 0)}`, `📥 Downloads: ${share?.downloads ?? 0}`, `🆔 #${collection.ref || '------'}`);
  if (files.length) {
    lines.push('');
    for (const f of files.slice(0, 6)) lines.push(`${icon(f.cat)} ${escapeHtml(truncate(f.name, 36))} · ${formatSize(f.size)}`);
    if (files.length > 6) lines.push(`… and ${files.length - 6} more`);
  }
  if (state === 'active') lines.push('', collectionLink(collection.shareToken));
  return lines.join('\n');
}

export function collectionDetailKeyboard(collection, state, share) {
  const kb = new InlineKeyboard();
  if (state === 'active') addLinkButtons(kb, collection.shareToken).text('⬇ Download All', `cdl:${collection.id}`).row();
  else kb.text('⬇ Download All', `cdl:${collection.id}`).row();
  kb.text('📂 Files', `cof:${collection.id}:1`).text('✏️ Rename', `crn:${collection.id}`).row();
  const locked = share?.status === 'disabled' && share.disabledBy === 'admin';
  if (!locked) kb.text(share?.status === 'disabled' ? '✅ Enable link' : '🚫 Disable link', `ctg:${collection.id}`);
  kb.text('⏳ Expiry', `cex:${collection.id}`).row()
    .text('🗑 Delete', `cdel:${collection.id}`).text('⬅️ Back', 'colls:1');
  return kb;
}

export async function renderCollectionDetail(collection, opts = {}) {
  const share = await getCShare(collection.shareToken);
  const state = linkState(share);
  const files = await loadCollectionFiles(collection);
  return { text: collectionDetailText(collection, share, state, files, opts), reply_markup: collectionDetailKeyboard(collection, state, share) };
}

export async function renderCollectionFiles(collection, page = 1) {
  const all = await loadCollectionFiles(collection);
  const pageSize = config.filesPerPage;
  const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const items = all.slice((current - 1) * pageSize, current * pageSize);
  const offset = (current - 1) * pageSize;
  const body = items.map((f, i) => `<b>${offset + i + 1}.</b> ${icon(f.cat)} ${escapeHtml(truncate(f.name, 44))}\n      ${formatSize(f.size)}`).join('\n\n') || 'No files.';
  const text = [`📂 <b>${escapeHtml(truncate(collection.title, 50))}</b>`, `${plural(all.length, 'file')} · Page ${current}/${totalPages}`, '', body, '', '<i>Tap a number to open a file.</i>'].join('\n');
  const kb = new InlineKeyboard();
  items.forEach((f, i) => kb.text(String(offset + i + 1), `open:${f.id}`));
  if (items.length) kb.row();
  kb.text('⬅️', current > 1 ? `cof:${collection.id}:${current - 1}` : 'noop').text(`${current}/${totalPages}`, 'noop').text('➡️', current < totalPages ? `cof:${collection.id}:${current + 1}` : 'noop')
    .row().text('⬅️ Back', `co:${collection.id}`).text('🏠 Menu', 'menu:home');
  return { text, reply_markup: kb };
}

/** Loads a collection the caller may manage (owner or admin), or answers with a generic alert. */
async function loadOwned(ctx, id) {
  const collection = await getCollection(id);
  if (!collection || (collection.ownerId !== ctx.from.id && !isAdmin(ctx.from.id))) {
    await ctx.answerCallbackQuery({ text: 'Collection not found or no longer available.', show_alert: true }).catch(() => {});
    return null;
  }
  return collection;
}

const actor = (ctx, collection) => (isAdmin(ctx.from.id) && collection.ownerId !== ctx.from.id ? 'admin' : 'owner');

export async function showCollectionDetail(ctx, collection, opts) {
  const view = await renderCollectionDetail(collection, opts);
  await editOrReply(ctx, view.text, view.reply_markup);
}

/** Reply (not edit) variant used after a text prompt. */
export async function replyCollectionDetail(ctx, collection, opts) {
  const view = await renderCollectionDetail(collection, opts);
  await ctx.reply(view.text, htmlOpts({ reply_markup: view.reply_markup }));
}

// ---------------------------------------------------------------- sending files into the chat

/** Copies stored files into a chat in groups of 10 (never one message per request spam from our side). */
async function sendFiles(chatId, files, { protect = false, collect = null } = {}) {
  const ids = files.map((f) => f.messageId).sort((a, b) => a - b);
  const extra = protect ? { protect_content: true } : {};
  let sent = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const part = ids.slice(i, i + 10);
    try {
      const res = await copyManyFromStorage(chatId, part, extra);
      if (collect && Array.isArray(res)) collect.push(...res.map((m) => m.message_id));
      sent += part.length;
    } catch (err) {
      logger.error('collection delivery failed for a group', { err });
      for (const id of part) {
        try {
          const one = await bot.api.copyMessage(chatId, config.storageChannelId, id, extra);
          if (collect) collect.push(one.message_id);
          sent += 1;
        } catch (e) { logger.warn('single copy failed', { err: e }); }
      }
    }
    if (i + 10 < ids.length) await sleep(400);
  }
  return sent;
}

async function denyCollection(ctx, reason, token) {
  await secCount('link_denied');
  await audit('link_denied', { actorId: ctx.from.id, detail: `collection ${reason}` });
  logger.info('collection access denied', { userId: ctx.from.id, tokenId: shortToken(token), reason });
  await ctx.reply(unavailableText(), htmlOpts());
}

/**
 * Public access path of a collection link opened in Telegram (t.me/<bot>?start=c_<token>[_<fileRef>]).
 * Owners/admins get everything; everyone else only files that are shareable (not expired, not password protected).
 */
export async function deliverCollection(ctx, token, fileRef = '') {
  const viewerId = ctx.from.id;
  const rl = await limiters.downloadUser(viewerId);
  if (!rl.allowed) {
    await secCount('rate_limited');
    await ctx.reply(rateLimitText(rl.retryAfter), htmlOpts());
    return;
  }
  const resolved = await resolveCollectionShare(token);
  const privileged = resolved.collection && (resolved.collection.ownerId === viewerId || isAdmin(viewerId));
  if (!resolved.ok && !(privileged && resolved.reason !== 'invalid' && resolved.reason !== 'not_found')) return denyCollection(ctx, resolved.reason, token);
  const { collection } = resolved;

  let files = await loadCollectionFiles(collection);
  if (fileRef) files = files.filter((f) => f.ref === fileRef);
  const eligible = files.filter((f) => (privileged ? canOwnerDownload(f) : publicFileState(f) === 'ok'));
  if (eligible.length === 0) return denyCollection(ctx, 'no_eligible_files', token);

  const policy = privileged ? { autoDelete: 0, forwardLock: 0 } : await getPolicy();
  const deliveredIds = [];
  const sent = await sendFiles(ctx.chat.id, eligible, { protect: policy.forwardLock > 0, collect: deliveredIds });
  if (sent === 0) {
    await ctx.reply('⚠️ <b>Files unavailable</b>\n\nWe could not retrieve these files right now. Please try again later.', htmlOpts());
    return;
  }
  void recordCollectionAccess(token);
  for (const f of eligible) void recordDownload(f.id);
  await audit('collection_download', { actorId: viewerId, detail: `#${collection.ref} ${sent} files ${privileged ? 'owner' : 'link'}` });
  const skipped = files.length - eligible.length;
  const extras = [];
  if (skipped > 0) extras.push(`ℹ️ ${plural(skipped, 'file')} not available (expired or protected).`);
  const kb = privileged ? undefined : new InlineKeyboard().text('🚨 Report', `crp:${token}`);
  if (extras.length || kb) {
    const trailing = await ctx.reply(extras.join('\n') || '✅ Done.', htmlOpts({ reply_markup: kb }));
    deliveredIds.push(trailing.message_id);
  }
  await trackDelivery({ chatId: ctx.chat.id, ids: deliveredIds, src: eligible.map((f) => f.messageId), policy, markup: kb ?? null, markupOn: 'notice' })
    .catch((err) => logger.error('could not schedule auto-delete', { err }));
}

// ---------------------------------------------------------------- handlers

export function registerCollectionHandlers(bot_) {
  const b = bot_;

  b.command('multi', startManual);
  b.command('collections', async (ctx) => {
    const view = await renderCollectionsView(ctx.from.id, 1);
    await ctx.reply(view.text, htmlOpts({ reply_markup: view.reply_markup }));
  });

  // ---- manual multi-file session ----
  b.callbackQuery('mb:start', async (ctx) => {
    await ctx.answerCallbackQuery();
    await startManual(ctx);
  });
  b.callbackQuery('mb:done', async (ctx) => {
    const uid = ctx.from.id;
    const n = await batchSize(uid);
    if (!(await getBatch(uid))) {
      await ctx.answerCallbackQuery({ text: 'This upload session has ended.', show_alert: true });
      return;
    }
    if (n === 0) {
      await ctx.answerCallbackQuery({ text: 'Send at least one file first.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: '⏳ Creating your link…' });
    await finalizeBatch(uid);
  });
  b.callbackQuery('mb:cancel', async (ctx) => {
    const uid = ctx.from.id;
    cancelTimer(uid);
    const batch = await claimBatch(uid);
    await ctx.answerCallbackQuery({ text: 'Closed' });
    const n = batch?.fileIds.length ?? 0;
    await editOrReply(ctx, n
      ? `📦 <b>Multi-file upload closed</b>\n\n${plural(n, 'file')} stay in <b>My Files</b> — no collection was created.`
      : '📦 <b>Multi-file upload closed</b>', new InlineKeyboard().text('📁 My Files', 'files:1').text('🏠 Menu', 'menu:home'));
  });

  // ---- list / detail ----
  b.callbackQuery(/^colls:(\d{1,4})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    clearAwait(ctx.from.id).catch(() => {});
    const view = await renderCollectionsView(ctx.from.id, Number(ctx.match[1]));
    await editOrReply(ctx, view.text, view.reply_markup);
  });
  b.callbackQuery(new RegExp(`^co:${ID}$`), async (ctx) => {
    const collection = await loadOwned(ctx, ctx.match[1]);
    if (!collection) return;
    await ctx.answerCallbackQuery();
    clearAwait(ctx.from.id).catch(() => {});
    await showCollectionDetail(ctx, collection);
  });
  b.callbackQuery(new RegExp(`^cof:${ID}:(\\d{1,4})$`), async (ctx) => {
    const collection = await loadOwned(ctx, ctx.match[1]);
    if (!collection) return;
    await ctx.answerCallbackQuery();
    const view = await renderCollectionFiles(collection, Number(ctx.match[2]));
    await editOrReply(ctx, view.text, view.reply_markup);
  });

  // ---- download everything into the chat (owner / admin) ----
  b.callbackQuery(new RegExp(`^cdl:${ID}$`), async (ctx) => {
    const collection = await loadOwned(ctx, ctx.match[1]);
    if (!collection) return;
    const rl = await limiters.downloadUser(ctx.from.id);
    if (!rl.allowed) {
      await ctx.answerCallbackQuery({ text: `⏳ Please wait ${rl.retryAfter}s and try again.`, show_alert: true });
      return;
    }
    const files = (await loadCollectionFiles(collection)).filter((f) => canOwnerDownload(f));
    if (files.length === 0) {
      await ctx.answerCallbackQuery({ text: 'No downloadable files in this collection.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: `📥 Sending ${plural(files.length, 'file')}…` });
    const sent = await sendFiles(ctx.chat.id, files);
    for (const f of files) void recordDownload(f.id);
    await audit('collection_download', { actorId: ctx.from.id, detail: `#${collection.ref} ${sent} files owner` });
    if (sent < files.length) await ctx.reply(`⚠️ ${files.length - sent} file(s) could not be sent. Please try again later.`, htmlOpts());
  });

  // ---- rename ----
  b.callbackQuery(new RegExp(`^crn:${ID}$`), async (ctx) => {
    const collection = await loadOwned(ctx, ctx.match[1]);
    if (!collection) return;
    await ctx.answerCallbackQuery();
    await setAwait(ctx.from.id, { kind: 'crn', id: collection.id });
    await editOrReply(ctx, `✏️ <b>Rename collection</b>\n\nCurrent: ${escapeHtml(collection.title)}\n\nSend the new name (up to ${config.collections.titleMax} characters).`,
      new InlineKeyboard().text('✖️ Cancel', `co:${collection.id}`));
  });

  // ---- link on/off ----
  b.callbackQuery(new RegExp(`^ctg:${ID}$`), async (ctx) => {
    const collection = await loadOwned(ctx, ctx.match[1]);
    if (!collection) return;
    const share = await getCShare(collection.shareToken);
    const enable = share?.status === 'disabled';
    const res = await setLinkStatus(collection, enable ? 'active' : 'disabled', actor(ctx, collection));
    if (res.result === 'locked') {
      await ctx.answerCallbackQuery({ text: 'This link was disabled by an administrator.', show_alert: true });
      return;
    }
    await audit(enable ? 'collection_link_enable' : 'collection_link_disable', { actorId: ctx.from.id, detail: `#${collection.ref}` });
    await ctx.answerCallbackQuery({ text: enable ? '✅ Link enabled' : '🚫 Link disabled' });
    await showCollectionDetail(ctx, collection);
  });

  // ---- link expiry ----
  b.callbackQuery(new RegExp(`^cex:${ID}$`), async (ctx) => {
    const collection = await loadOwned(ctx, ctx.match[1]);
    if (!collection) return;
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, '⏳ <b>Link expiry</b>\n\nWhen should the collection link stop working? The new time counts from now.',
      expiryKeyboard(`cey:${collection.id}`, `co:${collection.id}`, { custom: false }));
  });
  b.callbackQuery(new RegExp(`^cey:${ID}:(n|1h|1d|7d|30d)$`), async (ctx) => {
    const collection = await loadOwned(ctx, ctx.match[1]);
    if (!collection) return;
    const seconds = EXPIRY_PRESETS[ctx.match[2]].seconds;
    await setLinkExpiry(collection, seconds > 0 ? Date.now() + seconds * 1000 : 0);
    await audit('collection_link_expiry', { actorId: ctx.from.id, detail: `#${collection.ref} ${seconds ? `${seconds}s` : 'never'}` });
    await ctx.answerCallbackQuery({ text: seconds ? '⏳ Expiry set' : '⏳ Never expires' });
    await showCollectionDetail(ctx, collection);
  });

  // ---- delete ----
  b.callbackQuery(new RegExp(`^cdel:${ID}$`), async (ctx) => {
    const collection = await loadOwned(ctx, ctx.match[1]);
    if (!collection) return;
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, [
      '🗑 <b>Delete this collection?</b>', '', `🗂 ${escapeHtml(collection.title)} · ${plural(collection.fileCount, 'file')}`, '',
      'The share link stops working immediately. Choose what happens to the files:',
      '• <b>Collection only</b> — the files stay in My Files',
      '• <b>Collection + files</b> — the files are deleted permanently too',
    ].join('\n'), new InlineKeyboard()
      .text('🗑 Collection only', `cdok:${collection.id}:c`).row()
      .text('🗑 Collection + files', `cdok:${collection.id}:f`).row()
      .text('❌ Cancel', `co:${collection.id}`));
  });
  b.callbackQuery(new RegExp(`^cdok:${ID}:(c|f)$`), async (ctx) => {
    const collection = await loadOwned(ctx, ctx.match[1]);
    if (!collection) return;
    const withFiles = ctx.match[2] === 'f';
    const out = await deleteCollection(collection.id, { actorId: ctx.from.id, isAdmin: isAdmin(ctx.from.id), withFiles });
    if (out.result !== 'deleted') {
      await ctx.answerCallbackQuery({ text: 'This collection was already deleted.' });
      const view = await renderCollectionsView(ctx.from.id, 1);
      await editOrReply(ctx, view.text, view.reply_markup);
      return;
    }
    await audit('collection_delete', { actorId: ctx.from.id, detail: `#${collection.ref} ${withFiles ? `files deleted ${out.filesDeleted}` : 'files kept'}` });
    await ctx.answerCallbackQuery({ text: '🗑 Collection deleted' });
    await editOrReply(ctx, `🗑 <b>Collection deleted</b>\n\n🗂 ${escapeHtml(collection.title)}\n${withFiles ? `${plural(out.filesDeleted, 'file')} deleted permanently.` : 'The files are still in My Files.'}`,
      new InlineKeyboard().text('🗂 My Collections', 'colls:1').text('📁 My Files', 'files:1'));
  });

  // ---- report a collection (button under files delivered through a collection link) ----
  b.callbackQuery(new RegExp(`^crp:${ID}$`), async (ctx) => {
    const rl = await limiters.reports(ctx.from.id);
    if (!rl.allowed) {
      await ctx.answerCallbackQuery({ text: '⏳ Too many reports. Please try again later.', show_alert: true });
      return;
    }
    const res = await createCollectionReport({ reporterId: ctx.from.id, token: ctx.match[1] });
    if (res.result === 'created') {
      await secCount('reports');
      await audit('report', { actorId: ctx.from.id, detail: 'abuse report (collection)' });
      await ctx.answerCallbackQuery({ text: '🚨 Thanks — an admin will review this collection.', show_alert: true });
    } else if (res.result === 'duplicate') {
      await ctx.answerCallbackQuery({ text: 'You already reported this collection.', show_alert: true });
    } else {
      await ctx.answerCallbackQuery({ text: 'This collection is no longer available.', show_alert: true });
    }
  });
}

/** Text prompt answer: new collection name. Returns true when it consumed the message. */
export async function handleRenameText(ctx, state, text) {
  const userId = ctx.from.id;
  const collection = await getCollection(state.id);
  if (!collection || (collection.ownerId !== userId && !isAdmin(userId))) {
    await clearAwait(userId);
    await ctx.reply('❌ <b>Collection unavailable</b>\n\nThat collection no longer exists.', htmlOpts());
    return true;
  }
  const title = cleanTitle(text);
  if (!title || text.length > 300) {
    await ctx.reply(`⚠️ Please send a name of 1–${config.collections.titleMax} characters.`, htmlOpts({ reply_markup: new InlineKeyboard().text('✖️ Cancel', `co:${collection.id}`) }));
    return true;
  }
  await renameCollection(collection.id, title);
  await clearAwait(userId);
  await audit('collection_rename', { actorId: userId, detail: `#${collection.ref}` });
  await replyCollectionDetail(ctx, { ...collection, title }, { title: '✏️ <b>Renamed</b>' });
  return true;
}

