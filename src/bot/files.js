import { isAdmin } from '../config.js';
import { logger, shortToken } from '../logger.js';
import {
  canOwnerDownload, deleteFile, getFolderName, listFolders, moveFile, recordDownload, setFileExpiry, setFilePassword, isExpired,
} from '../services/files.js';
import { audit } from '../services/audit.js';
import { limiters } from '../services/rateLimit.js';
import { copyFromStorage } from '../services/telegram.js';
import { updateSettings } from '../services/users.js';
import { runSearch, parseQuery, saveLastSearch, loadLastSearch, SEARCH_HELP } from '../services/search.js';
import { escapeHtml } from '../utils/format.js';
import { formatSeconds, EXPIRY_PRESETS } from '../utils/time.js';
import {
  afterDeleteKeyboard, backMenu, deleteConfirmKeyboard, expiryKeyboard, fileKeyboard, mainMenu,
  moveKeyboard, passwordKeyboard, passwordRemoveKeyboard, settingsExpiryKeyboard, uploadKeyboard,
} from './keyboards.js';
import {
  developerView, helpText, htmlOpts, privacyText, renderFileCard, renderFilesView, renderFolderView, renderFoldersView,
  renderListView, renderRecentView, renderSettingsView, renderStorageView, searchPromptText, uploadPromptText, welcomeText,
} from './views.js';
import { clearAwait, editOrReply, expiryFromCode, loadOwnedFile, promptText } from './common.js';

const ID = '([A-Za-z0-9_-]{32})';

export async function showFileCard(ctx, meta, title) {
  await editOrReply(ctx, await renderFileCard(meta, title ? { title } : {}), fileKeyboard(meta));
}

export async function showSearchResults(ctx, queryText, page = 1, { edit = false } = {}) {
  const userId = ctx.from.id;
  const query = parseQuery(queryText);
  const result = await runSearch(query, { viewerId: userId, isAdmin: isAdmin(userId), page });
  if (result.error) return { error: result.message };
  const view = await renderListView(result, {
    title: `🔍 <b>Results</b> · <code>${escapeHtml(query.text)}</code>`,
    ctx: { kind: 'search' },
    emptyText: `🔍 <b>No results</b>\n\nNothing matched <code>${escapeHtml(query.text)}</code>.`,
  });
  if (result.truncated) view.text += '\n<i>Very many matches — refine your search.</i>';
  await saveLastSearch(userId, query.text);
  if (edit) await editOrReply(ctx, view.text, view.reply_markup);
  else await ctx.reply(view.text, htmlOpts({ reply_markup: view.reply_markup }));
  return { ok: true };
}

export function registerFileHandlers(bot) {
  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());

  // ---- navigation ---------------------------------------------------------
  const nav = (name, render) => bot.callbackQuery(name, async (ctx) => {
    await ctx.answerCallbackQuery();
    clearAwait(ctx.from.id).catch(() => {});
    const view = await render(ctx);
    await editOrReply(ctx, view.text, view.reply_markup);
  });
  nav('menu:home', (ctx) => ({ text: welcomeText(), reply_markup: mainMenu(isAdmin(ctx.from.id)) }));
  nav('menu:upload', () => ({ text: uploadPromptText(), reply_markup: uploadKeyboard() }));
  nav('menu:help', () => ({ text: helpText(), reply_markup: backMenu() }));
  nav('menu:privacy', () => ({ text: privacyText(), reply_markup: backMenu() }));
  nav('menu:dev', () => developerView());
  nav('menu:recent', (ctx) => renderRecentView(ctx.from.id));
  nav('menu:storage', (ctx) => renderStorageView(ctx.from.id));
  nav('menu:settings', (ctx) => renderSettingsView(ctx.from.id));
  bot.callbackQuery('cancel', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    clearAwait(ctx.from.id).catch(() => {});
    await editOrReply(ctx, welcomeText(), mainMenu(isAdmin(ctx.from.id)));
  });
  bot.callbackQuery(new RegExp(`^cancel:${ID}$`), async (ctx) => {
    clearAwait(ctx.from.id).catch(() => {});
    const meta = await loadOwnedFile(ctx, ctx.match[1]);
    if (!meta) return;
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    await showFileCard(ctx, meta);
  });

  // ---- My Files -------------------------------------------------------------
  bot.callbackQuery(/^files:(\d{1,4})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const view = await renderFilesView(ctx.from.id, Number(ctx.match[1]));
    await editOrReply(ctx, view.text, view.reply_markup);
  });
  bot.callbackQuery(/^fc:(photo|video|audio|pdf|doc|archive|other):(\d{1,4})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const view = await renderFilesView(ctx.from.id, Number(ctx.match[2]), ctx.match[1]);
    await editOrReply(ctx, view.text, view.reply_markup);
  });
  bot.callbackQuery('fo:list', async (ctx) => {
    await ctx.answerCallbackQuery();
    const view = await renderFoldersView(ctx.from.id);
    await editOrReply(ctx, view.text, view.reply_markup);
  });
  bot.callbackQuery(/^fo:([A-Za-z0-9_-]{8}):(\d{1,4})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const view = await renderFolderView(ctx.from.id, ctx.match[1], Number(ctx.match[2]));
    await editOrReply(ctx, view.text, view.reply_markup);
  });

  bot.callbackQuery(new RegExp(`^open:${ID}$`), async (ctx) => {
    const meta = await loadOwnedFile(ctx, ctx.match[1]);
    if (!meta) return;
    await ctx.answerCallbackQuery();
    clearAwait(ctx.from.id).catch(() => {});
    await showFileCard(ctx, meta);
  });

  // ---- Search ---------------------------------------------------------------
  bot.callbackQuery('menu:search', async (ctx) => {
    await ctx.answerCallbackQuery();
    await promptText(ctx, { kind: 'search' }, searchPromptText(SEARCH_HELP));
  });
  bot.callbackQuery(/^srp:(\d{1,4})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const last = await loadLastSearch(ctx.from.id);
    if (!last) { await promptText(ctx, { kind: 'search' }, searchPromptText(SEARCH_HELP)); return; }
    const r = await showSearchResults(ctx, last, Number(ctx.match[1]), { edit: true });
    if (r.error) await editOrReply(ctx, `⚠️ ${escapeHtml(r.error)}`, backMenu());
  });

  // ---- Download (owner / admin) ---------------------------------------------
  bot.callbackQuery(new RegExp(`^dl:${ID}$`), async (ctx) => {
    const meta = await loadOwnedFile(ctx, ctx.match[1]);
    if (!meta) return;
    if (!canOwnerDownload(meta)) {
      await ctx.answerCallbackQuery({ text: '⌛ This file has expired. Renew its expiry to download it again.', show_alert: true });
      return;
    }
    const rl = await limiters.downloadUser(ctx.from.id);
    if (!rl.allowed) {
      await ctx.answerCallbackQuery({ text: `⏳ Please wait ${rl.retryAfter}s and try again.`, show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: '📥 Sending your file…' });
    try {
      await copyFromStorage(ctx.chat.id, meta.messageId);
      void recordDownload(meta.id);
      await audit('download', { actorId: ctx.from.id, file: meta, detail: 'owner' });
    } catch (err) {
      logger.error('owner download failed', { userId: ctx.from.id, tokenId: shortToken(meta.id), err });
      await ctx.reply('⚠️ <b>File unavailable</b>\n\nWe could not retrieve this file right now. Please try again later.', htmlOpts());
    }
  });

  // ---- Rename -----------------------------------------------------------------
  bot.callbackQuery(new RegExp(`^rn:${ID}$`), async (ctx) => {
    const meta = await loadOwnedFile(ctx, ctx.match[1]);
    if (!meta) return;
    await ctx.answerCallbackQuery();
    await promptText(ctx, { kind: 'rename', id: meta.id }, `✏️ <b>Rename</b>\n\nCurrent: ${escapeHtml(meta.name)}\n\nSend the new file name.`, meta.id);
  });

  // ---- Move / folders ------------------------------------------------------------
  bot.callbackQuery(new RegExp(`^mv:${ID}$`), async (ctx) => {
    const meta = await loadOwnedFile(ctx, ctx.match[1]);
    if (!meta) return;
    await ctx.answerCallbackQuery();
    const folders = await listFolders(meta.uploaderId);
    await editOrReply(ctx, `📂 <b>Move</b>\n\n📄 ${escapeHtml(meta.name)}\n\nChoose a folder:`, moveKeyboard(meta.id, folders, meta.folder));
  });
  bot.callbackQuery(new RegExp(`^mvt:${ID}:([A-Za-z0-9_-]{8}|0)$`), async (ctx) => {
    const meta = await loadOwnedFile(ctx, ctx.match[1]);
    if (!meta) return;
    const target = ctx.match[2] === '0' ? '' : ctx.match[2];
    if (target && !(await getFolderName(meta.uploaderId, target))) {
      await ctx.answerCallbackQuery({ text: 'Folder not found.', show_alert: true });
      return;
    }
    const moved = await moveFile(meta.id, target);
    await audit('file_move', { actorId: ctx.from.id, file: meta, detail: target ? 'folder' : 'root' });
    await ctx.answerCallbackQuery({ text: target ? '📂 Moved' : '📁 Removed from folder' });
    await showFileCard(ctx, moved);
  });
  bot.callbackQuery(new RegExp(`^mvn:${ID}$`), async (ctx) => {
    const meta = await loadOwnedFile(ctx, ctx.match[1]);
    if (!meta) return;
    await ctx.answerCallbackQuery();
    await promptText(ctx, { kind: 'mvnew', id: meta.id }, '📂 <b>New folder</b>\n\nSend a name (up to 30 characters).', meta.id);
  });

  // ---- Password ----------------------------------------------------------------
  bot.callbackQuery(new RegExp(`^pw:${ID}$`), async (ctx) => {
    const meta = await loadOwnedFile(ctx, ctx.match[1]);
    if (!meta) return;
    await ctx.answerCallbackQuery();
    clearAwait(ctx.from.id).catch(() => {});
    await editOrReply(ctx, `🔐 <b>Password</b>\n\n📄 ${escapeHtml(meta.name)}\n\n${meta.hasPassword ? '🔐 Protected — recipients must enter the password.' : '🔓 Not protected. Set a password that recipients must enter.'}`, passwordKeyboard(meta));
  });
  bot.callbackQuery(new RegExp(`^pws:${ID}$`), async (ctx) => {
    const meta = await loadOwnedFile(ctx, ctx.match[1]);
    if (!meta) return;
    await ctx.answerCallbackQuery();
    await promptText(ctx, { kind: 'pwset', id: meta.id }, '🔐 <b>Send the password</b>\n\n6–64 characters. Your message is deleted right after it is read, and only a salted hash is stored.', meta.id);
  });
  bot.callbackQuery(new RegExp(`^pwr:${ID}$`), async (ctx) => {
    const meta = await loadOwnedFile(ctx, ctx.match[1]);
    if (!meta) return;
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, '🔓 <b>Remove password?</b>\n\nAnyone with a valid link will be able to download without a password.', passwordRemoveKeyboard(meta.id));
  });
  bot.callbackQuery(new RegExp(`^pwrok:${ID}$`), async (ctx) => {
    const meta = await loadOwnedFile(ctx, ctx.match[1]);
    if (!meta) return;
    await setFilePassword(meta.id, null);
    await audit('password_remove', { actorId: ctx.from.id, file: meta });
    await ctx.answerCallbackQuery({ text: '🔓 Password removed' });
    await showFileCard(ctx, { ...meta, hasPassword: false });
  });

  // ---- Expiry --------------------------------------------------------------------
  bot.callbackQuery(new RegExp(`^ex:${ID}$`), async (ctx) => {
    const meta = await loadOwnedFile(ctx, ctx.match[1]);
    if (!meta) return;
    await ctx.answerCallbackQuery();
    clearAwait(ctx.from.id).catch(() => {});
    const state = isExpired(meta) ? '⌛ This file has expired. Pick a new expiry to renew it.' : 'After expiry its links stop working. The record is kept until you delete it.';
    await editOrReply(ctx, `⏳ <b>Expiry</b>\n\n📄 ${escapeHtml(meta.name)}\n\n${state}`, expiryKeyboard(`exs:${meta.id}`, `open:${meta.id}`));
  });
  bot.callbackQuery(new RegExp(`^exs:${ID}:(n|1h|1d|7d|30d|c|m\\d{1,6})$`), async (ctx) => {
    const meta = await loadOwnedFile(ctx, ctx.match[1]);
    if (!meta) return;
    if (ctx.match[2] === 'c') {
      await ctx.answerCallbackQuery();
      await promptText(ctx, { kind: 'fexp', id: meta.id }, '⏳ <b>Custom expiry</b>\n\nSend a duration like <code>45m</code>, <code>12h</code>, <code>10d</code> or <code>2w</code> (5 minutes – 365 days).', meta.id);
      return;
    }
    const seconds = expiryFromCode(ctx.match[2]);
    await applyFileExpiry(ctx, meta, seconds);
  });

  // ---- Delete ----------------------------------------------------------------------
  bot.callbackQuery(new RegExp(`^del:${ID}$`), async (ctx) => {
    const meta = await loadOwnedFile(ctx, ctx.match[1]);
    if (!meta) return;
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, ['🗑 <b>Delete this file?</b>', '', `📄 ${escapeHtml(meta.name)}`, '', 'It will be removed permanently from your files and all its share links will stop working immediately. This cannot be undone.'].join('\n'), deleteConfirmKeyboard(meta.id));
  });
  bot.callbackQuery(new RegExp(`^delok:${ID}$`), async (ctx) => {
    const id = ctx.match[1];
    const userId = ctx.from.id;
    const outcome = await deleteFile(id, { id: userId, isAdmin: isAdmin(userId) });
    switch (outcome.result) {
      case 'deleted':
        await audit('file_delete', { actorId: userId, file: outcome.meta, detail: outcome.meta.uploaderId !== userId ? 'by admin' : `links removed: ${outcome.linksRemoved}` });
        logger.info(outcome.meta.uploaderId !== userId ? 'admin deleted file' : 'file deleted', { userId, tokenId: shortToken(id) });
        await ctx.answerCallbackQuery({ text: '🗑 File deleted' });
        await editOrReply(ctx, `🗑 <b>File deleted permanently</b>\n\n📄 ${escapeHtml(outcome.meta.name)}\n\nIt is gone from your files and its links are no longer valid.`, afterDeleteKeyboard());
        break;
      case 'forbidden':
        logger.warn('delete attempt on foreign file blocked', { userId, tokenId: shortToken(id) });
        await ctx.answerCallbackQuery({ text: "You can't delete this file.", show_alert: true });
        break;
      default:
        await ctx.answerCallbackQuery({ text: 'This file was already deleted.' });
        await editOrReply(ctx, '🗑 <b>File deleted</b>\n\nThis file no longer exists.', afterDeleteKeyboard());
    }
  });

  // ---- Settings -----------------------------------------------------------------------
  bot.callbackQuery('set:f', async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, '⏳ <b>Default file expiry</b>\n\nApplied to files you upload from now on.', settingsExpiryKeyboard('setf'));
  });
  bot.callbackQuery('set:s', async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, '🔗 <b>Default link expiry</b>\n\nPre-selected when you create new links.', settingsExpiryKeyboard('sets'));
  });
  bot.callbackQuery(/^set([fs]):(n|1h|1d|7d|30d)$/, async (ctx) => {
    const seconds = EXPIRY_PRESETS[ctx.match[2]].seconds;
    await updateSettings(ctx.from.id, ctx.match[1] === 'f' ? { fileExp: seconds } : { shareExp: seconds });
    await ctx.answerCallbackQuery({ text: '✅ Saved' });
    const view = await renderSettingsView(ctx.from.id);
    await editOrReply(ctx, view.text, view.reply_markup);
  });
}

/** Shared by the button flow and the custom-duration text flow. */
export async function applyFileExpiry(ctx, meta, seconds, { reply = false } = {}) {
  const expiresAt = seconds > 0 ? Date.now() + seconds * 1000 : 0;
  await setFileExpiry(meta.id, expiresAt);
  await audit('file_expiry', { actorId: ctx.from.id, file: meta, detail: seconds ? formatSeconds(seconds) : 'never' });
  const fresh = { ...meta, expiresAt, purged: false };
  if (reply) await ctx.reply(await renderFileCard(fresh, { title: '⏳ <b>Expiry updated</b>' }), htmlOpts({ reply_markup: fileKeyboard(fresh) }));
  else {
    await ctx.answerCallbackQuery({ text: seconds ? `⏳ Expires in ${formatSeconds(seconds)}` : '⏳ Never expires' });
    await showFileCard(ctx, fresh);
  }
}
