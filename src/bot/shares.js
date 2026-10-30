import { InputFile } from 'grammy';
import { isAdmin } from '../config.js';
import { logger, shortToken } from '../logger.js';
import { audit, secCount } from '../services/audit.js';
import { getFileRecord } from '../services/files.js';
import { limiters } from '../services/rateLimit.js';
import { buildQrPng, buildQrSvg } from '../services/qr.js';
import { createReport } from '../services/reports.js';
import {
  createShare, deleteShare, getShare, revokeShare, setShareExpiry, setShareLimit, shareState,
} from '../services/shares.js';
import { getSettings } from '../services/users.js';
import { escapeHtml, sanitizeFilename } from '../utils/format.js';
import { formatSeconds } from '../utils/time.js';
import { shareLink } from '../utils/links.js';
import {
  expiryKeyboard, limitKeyboard, LIMIT_PRESETS, qrKeyboard, revokeConfirmKeyboard, shareDeleteConfirmKeyboard, shareDetailKeyboard,
  shareEditKeyboard, shareMenuKeyboard,
} from './keyboards.js';
import { renderLinksView, renderShareMenu, shareCreatedText, shareDetailText, htmlOpts } from './views.js';
import { codeForSeconds, editOrReply, expiryFromCode, loadOwnedFile, promptText } from './common.js';

const ID = '([A-Za-z0-9_-]{32})';
const EXP = '(n|1h|1d|7d|30d|c|d|m\\d{1,6})';
const LIM = '(u|1|5|10|25|c)';

/** Loads a share the caller owns (admins may manage any). */
async function loadOwnedShare(ctx, token) {
  const share = await getShare(token);
  if (!share || (share.ownerId !== ctx.from.id && !isAdmin(ctx.from.id))) {
    await ctx.answerCallbackQuery({ text: 'Link not found or no longer available.', show_alert: true }).catch(() => {});
    return null;
  }
  const record = await getFileRecord(share.fileId);
  const file = record.meta ?? null;
  return { share, file, state: shareState(share, file) };
}

export async function showShareDetail(ctx, token, opts = {}) {
  const loaded = await loadOwnedShare(ctx, token); // answers with an alert when the link is not available
  if (!loaded) return;
  await ctx.answerCallbackQuery(); // no-op when a handler already answered
  await editOrReply(ctx, shareDetailText(loaded.share, loaded.file, loaded.state, opts), shareDetailKeyboard(loaded.share, loaded.state));
}

export async function finishShareCreate(ctx, file, expiresAt, limit, { reply = false } = {}) {
  const rl = await limiters.shares(ctx.from.id);
  if (!rl.allowed) {
    const msg = `⏳ Too many links created. Try again in ${rl.retryAfter}s.`;
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: msg, show_alert: true });
    else await ctx.reply(msg);
    return;
  }
  const res = await createShare({ fileId: file.id, ownerId: file.uploaderId, expiresAt, limit });
  if (res.result === 'limit') {
    const msg = '⚠️ This file has too many links. Delete some old links first.';
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: msg, show_alert: true });
    else await ctx.reply(msg);
    return;
  }
  await audit('share_create', { actorId: ctx.from.id, file, share: res.share, detail: `exp ${expiresAt ? 'set' : 'never'}, limit ${limit || 'none'}` });
  logger.info('share link created', { userId: ctx.from.id, tokenId: shortToken(res.share.token) });
  const text = shareCreatedText(res.share, file);
  const kb = shareDetailKeyboard(res.share, 'active');
  if (reply || !ctx.callbackQuery) await ctx.reply(text, htmlOpts({ reply_markup: kb }));
  else {
    await ctx.answerCallbackQuery({ text: '🔗 Link created' });
    await editOrReply(ctx, text, kb);
  }
}

async function sendQr(ctx, token, format) {
  const userId = ctx.from.id;
  const loaded = await loadOwnedShare(ctx, token);
  if (!loaded || loaded.state !== 'active') {
    if (loaded) await ctx.answerCallbackQuery({ text: 'This link is no longer active.', show_alert: true });
    return;
  }
  const rl = await limiters.qr(userId);
  if (!rl.allowed) {
    await ctx.answerCallbackQuery({ text: `⏳ Please wait ${rl.retryAfter}s before generating another QR code.`, show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery({ text: '🔳 Generating QR code…' });
  await ctx.replyWithChatAction('upload_document').catch(() => {});
  const link = shareLink(token);
  const base = sanitizeFilename(loaded.file.name).replace(/\.[^.]{1,10}$/, '').slice(0, 40) || 'file';
  const name = escapeHtml(loaded.file.name);
  if (format === 'svg') {
    const { svg } = buildQrSvg(link);
    await ctx.replyWithDocument(new InputFile(Buffer.from(svg, 'utf8'), `qr-${base}.svg`), { caption: `📐 <b>Vector QR code</b>\n📄 ${name}`, parse_mode: 'HTML' });
  } else {
    const { png, size } = await buildQrPng(link);
    await ctx.replyWithDocument(new InputFile(png, `qr-${base}.png`), {
      caption: `🔳 <b>QR code</b> · ${size}×${size} px\n📄 ${name}\n\nScan to open the file in Telegram. Sent as a file so you can download it in full resolution.`,
      parse_mode: 'HTML',
      reply_markup: qrKeyboard(token),
    });
  }
  await audit('qr_generate', { actorId: userId, file: loaded.file, share: loaded.share, detail: format });
}

export function registerShareHandlers(bot) {
  // ---- per-file share menu & creation wizard (expiry -> download limit -> create) --------
  bot.callbackQuery(new RegExp(`^sh:${ID}$`), async (ctx) => {
    const file = await loadOwnedFile(ctx, ctx.match[1]);
    if (!file) return;
    await ctx.answerCallbackQuery();
    const { text, entries } = await renderShareMenu(file);
    await editOrReply(ctx, text, shareMenuKeyboard(file.id, entries));
  });

  bot.callbackQuery(new RegExp(`^shn:${ID}$`), async (ctx) => {
    const file = await loadOwnedFile(ctx, ctx.match[1]);
    if (!file) return;
    await ctx.answerCallbackQuery();
    const { shareExp } = await getSettings(ctx.from.id);
    await editOrReply(ctx, '⏳ <b>Link expiry</b>\n\nWhen should this link stop working?', expiryKeyboard(`shx:${file.id}`, `sh:${file.id}`, { defaultLabel: shareExp ? formatSeconds(shareExp) : null }));
  });

  bot.callbackQuery(new RegExp(`^shx:${ID}:${EXP}$`), async (ctx) => {
    const file = await loadOwnedFile(ctx, ctx.match[1]);
    if (!file) return;
    const choice = ctx.match[2];
    if (choice === 'c') {
      await ctx.answerCallbackQuery();
      await promptText(ctx, { kind: 'shexp', id: file.id }, '⏳ <b>Custom expiry</b>\n\nSend a duration like <code>45m</code>, <code>12h</code>, <code>10d</code> or <code>2w</code> (5 minutes – 365 days).', file.id);
      return;
    }
    const seconds = choice === 'd' ? (await getSettings(ctx.from.id)).shareExp : expiryFromCode(choice);
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, '🔢 <b>Download limit</b>\n\nHow many times can this link be used?', limitKeyboard(`shl:${file.id}:${codeForSeconds(seconds)}`, `shn:${file.id}`));
  });

  bot.callbackQuery(new RegExp(`^shl:${ID}:(n|1h|1d|7d|30d|m\\d{1,6}):${LIM}$`), async (ctx) => {
    const file = await loadOwnedFile(ctx, ctx.match[1]);
    if (!file) return;
    const seconds = expiryFromCode(ctx.match[2]);
    if (ctx.match[3] === 'c') {
      await ctx.answerCallbackQuery();
      await promptText(ctx, { kind: 'shlim', id: file.id, exp: seconds }, '🔢 <b>Custom download limit</b>\n\nSend a number from 1 to 10000.', file.id);
      return;
    }
    await finishShareCreate(ctx, file, seconds > 0 ? Date.now() + seconds * 1000 : 0, LIMIT_PRESETS[ctx.match[3]].value);
  });

  // ---- link detail / revoke / delete / edit ---------------------------------------------
  bot.callbackQuery(new RegExp(`^sd:${ID}$`), async (ctx) => {
    await showShareDetail(ctx, ctx.match[1]);
  });

  bot.callbackQuery(new RegExp(`^srv:${ID}$`), async (ctx) => {
    const loaded = await loadOwnedShare(ctx, ctx.match[1]);
    if (!loaded) return;
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, '🚫 <b>Revoke this link?</b>\n\nIt stops working immediately. This cannot be undone — you can create a new link at any time.', revokeConfirmKeyboard(loaded.share.token));
  });
  bot.callbackQuery(new RegExp(`^srvok:${ID}$`), async (ctx) => {
    const loaded = await loadOwnedShare(ctx, ctx.match[1]);
    if (!loaded) return;
    await revokeShare(loaded.share.token);
    await audit('share_revoke', { actorId: ctx.from.id, file: loaded.file, share: loaded.share });
    await ctx.answerCallbackQuery({ text: '🚫 Link revoked' });
    await showShareDetail(ctx, loaded.share.token, { title: '🚫 <b>Link revoked</b>' });
  });

  bot.callbackQuery(new RegExp(`^sdel:${ID}$`), async (ctx) => {
    const loaded = await loadOwnedShare(ctx, ctx.match[1]);
    if (!loaded) return;
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, '🗑 <b>Delete this link?</b>\n\nThe link record is removed and the link stops working. The file itself is not deleted.', shareDeleteConfirmKeyboard(loaded.share.token));
  });
  bot.callbackQuery(new RegExp(`^sdelok:${ID}$`), async (ctx) => {
    const loaded = await loadOwnedShare(ctx, ctx.match[1]);
    if (!loaded) return;
    await deleteShare(loaded.share.token);
    await audit('share_delete', { actorId: ctx.from.id, file: loaded.file, share: loaded.share });
    await ctx.answerCallbackQuery({ text: '🗑 Link deleted' });
    const view = await renderLinksView(loaded.share.ownerId, 1);
    await editOrReply(ctx, view.text, view.reply_markup);
  });

  bot.callbackQuery(new RegExp(`^se:${ID}$`), async (ctx) => {
    const loaded = await loadOwnedShare(ctx, ctx.match[1]);
    if (!loaded) return;
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, '✏️ <b>Edit link</b>\n\nWhat do you want to change?', shareEditKeyboard(loaded.share.token));
  });
  bot.callbackQuery(new RegExp(`^sex:${ID}$`), async (ctx) => {
    const loaded = await loadOwnedShare(ctx, ctx.match[1]);
    if (!loaded) return;
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, '⏳ <b>Link expiry</b>\n\nThe new time counts from now.', expiryKeyboard(`sey:${loaded.share.token}`, `se:${loaded.share.token}`));
  });
  bot.callbackQuery(new RegExp(`^sey:${ID}:${EXP}$`), async (ctx) => {
    const loaded = await loadOwnedShare(ctx, ctx.match[1]);
    if (!loaded) return;
    if (ctx.match[2] === 'c') {
      await ctx.answerCallbackQuery();
      await promptText(ctx, { kind: 'sexp', token: loaded.share.token }, '⏳ <b>Custom expiry</b>\n\nSend a duration like <code>45m</code>, <code>12h</code>, <code>10d</code> or <code>2w</code>.');
      return;
    }
    const seconds = expiryFromCode(ctx.match[2]);
    if (seconds === null) { await ctx.answerCallbackQuery(); return; }
    await applyShareExpiry(ctx, loaded, seconds);
  });
  bot.callbackQuery(new RegExp(`^sel:${ID}$`), async (ctx) => {
    const loaded = await loadOwnedShare(ctx, ctx.match[1]);
    if (!loaded) return;
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, '🔢 <b>Download limit</b>\n\nTotal downloads allowed for this link (already used downloads count).', limitKeyboard(`sem:${loaded.share.token}`, `se:${loaded.share.token}`));
  });
  bot.callbackQuery(new RegExp(`^sem:${ID}:${LIM}$`), async (ctx) => {
    const loaded = await loadOwnedShare(ctx, ctx.match[1]);
    if (!loaded) return;
    if (ctx.match[2] === 'c') {
      await ctx.answerCallbackQuery();
      await promptText(ctx, { kind: 'slim', token: loaded.share.token }, '🔢 <b>Custom download limit</b>\n\nSend a number from 1 to 10000.');
      return;
    }
    await applyShareLimit(ctx, loaded, LIMIT_PRESETS[ctx.match[2]].value);
  });

  // ---- QR -------------------------------------------------------------------------------------
  bot.callbackQuery(new RegExp(`^qr:${ID}$`), (ctx) => sendQr(ctx, ctx.match[1], 'png'));
  bot.callbackQuery(new RegExp(`^qrsvg:${ID}$`), (ctx) => sendQr(ctx, ctx.match[1], 'svg'));

  // ---- Report abuse (button under files delivered through a link) --------------------------
  bot.callbackQuery(new RegExp(`^rp:${ID}$`), async (ctx) => {
    const rl = await limiters.reports(ctx.from.id);
    if (!rl.allowed) {
      await ctx.answerCallbackQuery({ text: '⏳ Too many reports. Please try again later.', show_alert: true });
      return;
    }
    const res = await createReport({ reporterId: ctx.from.id, shareToken: ctx.match[1] });
    if (res.result === 'created') {
      await secCount('reports');
      await audit('report', { actorId: ctx.from.id, detail: 'abuse report' });
      await ctx.answerCallbackQuery({ text: '🚨 Thanks — an admin will review this file.', show_alert: true });
    } else if (res.result === 'duplicate') {
      await ctx.answerCallbackQuery({ text: 'You already reported this file.', show_alert: true });
    } else {
      await ctx.answerCallbackQuery({ text: 'This file is no longer available.', show_alert: true });
    }
  });

  // ---- Shared Links list ---------------------------------------------------------------------------
  bot.callbackQuery(/^links:(\d{1,4})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const view = await renderLinksView(ctx.from.id, Number(ctx.match[1]));
    await editOrReply(ctx, view.text, view.reply_markup);
  });
}

export async function applyShareExpiry(ctx, loaded, seconds, { reply = false } = {}) {
  const expiresAt = seconds > 0 ? Date.now() + seconds * 1000 : 0;
  const share = await setShareExpiry(loaded.share.token, expiresAt);
  if (!share) { if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: 'This link can no longer be edited.', show_alert: true }); return; }
  await audit('share_edit', { actorId: ctx.from.id, file: loaded.file, share, detail: `expiry ${seconds ? formatSeconds(seconds) : 'never'}` });
  await afterShareEdit(ctx, share, loaded.file, reply);
}

export async function applyShareLimit(ctx, loaded, limit, { reply = false } = {}) {
  const share = await setShareLimit(loaded.share.token, limit);
  if (!share) { if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: 'This link can no longer be edited.', show_alert: true }); return; }
  await audit('share_edit', { actorId: ctx.from.id, file: loaded.file, share, detail: `limit ${limit || 'none'}` });
  await afterShareEdit(ctx, share, loaded.file, reply);
}

async function afterShareEdit(ctx, share, file, reply) {
  const state = shareState(share, file);
  const text = shareDetailText(share, file, state, { title: '✅ <b>Link updated</b>' });
  const kb = shareDetailKeyboard(share, state);
  if (reply || !ctx.callbackQuery) await ctx.reply(text, htmlOpts({ reply_markup: kb }));
  else {
    await ctx.answerCallbackQuery({ text: '✅ Updated' });
    await editOrReply(ctx, text, kb);
  }
}

export { loadOwnedShare };
