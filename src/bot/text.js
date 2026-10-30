import { isAdmin } from '../config.js';
import { logger } from '../logger.js';
import { audit } from '../services/audit.js';
import { createFolder, getFileRecord, moveFile, renameFile, setFilePassword } from '../services/files.js';
import { clearAwait, getAwait } from '../services/inputState.js';
import { hashPassword, validatePassword } from '../services/password.js';
import { limiters } from '../services/rateLimit.js';
import { SEARCH_HELP } from '../services/search.js';
import { escapeHtml, sanitizeFilename } from '../utils/format.js';
import { parseDuration } from '../utils/time.js';
import { cancelKeyboard } from './keyboards.js';
import { handlePasswordReply } from './delivery.js';
import { applyFileExpiry, showSearchResults } from './files.js';
import { applyShareExpiry, applyShareLimit, finishShareCreate, loadOwnedShare } from './shares.js';
import { fileKeyboard } from './keyboards.js';
import { htmlOpts, rateLimitText, renderFileCard } from './views.js';
import { deleteQuietly } from './common.js';
import { handleRenameText } from './collections.js';
import { handleFsubText } from './forceSubscribe.js';

const reply = (ctx, text, extra) => ctx.reply(text, htmlOpts(extra));
const again = (ctx, text, cancelTarget) => reply(ctx, text, { reply_markup: cancelKeyboard(cancelTarget) });

async function ownedFile(ctx, id) {
  const record = await getFileRecord(id);
  const meta = record.meta;
  if (!meta || (meta.uploaderId !== ctx.from.id && !isAdmin(ctx.from.id))) {
    await clearAwait(ctx.from.id);
    await reply(ctx, '❌ <b>File unavailable</b>\n\nThat file no longer exists.');
    return null;
  }
  return meta;
}

const cardReply = async (ctx, meta, title) =>
  reply(ctx, await renderFileCard(meta, { title }), { reply_markup: fileKeyboard(meta) });

/** Handles a plain text message while the user is "in a prompt". Returns true when it consumed the message. */
export async function handleAwaitedText(ctx) {
  const userId = ctx.from.id;
  const state = await getAwait(userId);
  if (!state) return false;
  const text = (ctx.msg.text ?? '').trim();
  const secret = state.kind === 'pw' || state.kind === 'pwset';

  const rl = await limiters.texts(userId);
  if (!rl.allowed) {
    if (secret) await deleteQuietly(ctx, ctx.msg.message_id);
    await reply(ctx, rateLimitText(rl.retryAfter));
    return true;
  }

  if (state.kind === 'fs') return handleFsubText(ctx, state); // Force Subscribe add/edit conversation (admins only, re-checked inside)

  switch (state.kind) {
    case 'pw': // recipient entering a password for a protected link
      await deleteQuietly(ctx, ctx.msg.message_id);
      await handlePasswordReply(ctx, state.token, ctx.msg.text ?? '');
      return true;

    case 'pwset': {
      await deleteQuietly(ctx, ctx.msg.message_id);
      const problem = validatePassword(ctx.msg.text ?? '');
      if (problem) { await again(ctx, `⚠️ ${problem}\n\nSend another password, or cancel.`, state.id); return true; }
      const meta = await ownedFile(ctx, state.id);
      if (!meta) return true;
      await setFilePassword(meta.id, await hashPassword(ctx.msg.text));
      await clearAwait(userId);
      await audit(meta.hasPassword ? 'password_change' : 'password_set', { actorId: userId, file: meta });
      await cardReply(ctx, { ...meta, hasPassword: true }, '🔐 <b>Password saved</b>');
      return true;
    }

    case 'rename': {
      const name = sanitizeFilename(text, '');
      if (!name || text.length > 200) { await again(ctx, '⚠️ Please send a valid file name (1–120 characters).', state.id); return true; }
      const meta = await ownedFile(ctx, state.id);
      if (!meta) return true;
      const updated = await renameFile(meta.id, name);
      await clearAwait(userId);
      await audit('file_rename', { actorId: userId, file: updated });
      await cardReply(ctx, updated, '✏️ <b>Renamed</b>');
      return true;
    }

    case 'mvnew': {
      const name = text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
      if (!name || name.length > 30) { await again(ctx, '⚠️ Folder names are 1–30 characters.', state.id); return true; }
      const meta = await ownedFile(ctx, state.id);
      if (!meta) return true;
      const folder = await createFolder(meta.uploaderId, name);
      if (folder.result === 'limit') { await clearAwait(userId); await reply(ctx, '⚠️ You reached the folder limit (30).'); return true; }
      const moved = await moveFile(meta.id, folder.id);
      await clearAwait(userId);
      await audit('file_move', { actorId: userId, file: meta, detail: 'new folder' });
      await cardReply(ctx, moved, `📂 <b>Moved to</b> ${escapeHtml(name)}`);
      return true;
    }

    case 'fexp': {
      const seconds = parseDuration(text);
      if (!seconds) { await again(ctx, '⚠️ Use a duration like <code>45m</code>, <code>12h</code>, <code>10d</code> or <code>2w</code> (5 minutes – 365 days).', state.id); return true; }
      const meta = await ownedFile(ctx, state.id);
      if (!meta) return true;
      await clearAwait(userId);
      await applyFileExpiry(ctx, meta, seconds, { reply: true });
      return true;
    }

    case 'shexp': {
      const seconds = parseDuration(text);
      if (!seconds) { await again(ctx, '⚠️ Use a duration like <code>45m</code>, <code>12h</code>, <code>10d</code> or <code>2w</code> (5 minutes – 365 days).', state.id); return true; }
      const meta = await ownedFile(ctx, state.id);
      if (!meta) return true;
      await clearAwait(userId);
      const { limitKeyboard } = await import('./keyboards.js');
      const { codeForSeconds } = await import('./common.js');
      await reply(ctx, '🔢 <b>Download limit</b>\n\nHow many times can this link be used?', { reply_markup: limitKeyboard(`shl:${meta.id}:${codeForSeconds(seconds)}`, `shn:${meta.id}`) });
      return true;
    }

    case 'shlim': {
      const limit = /^\d{1,5}$/.test(text) ? Number(text) : 0;
      if (limit < 1 || limit > 10_000) { await again(ctx, '⚠️ Send a number from 1 to 10000.', state.id); return true; }
      const meta = await ownedFile(ctx, state.id);
      if (!meta) return true;
      await clearAwait(userId);
      await finishShareCreate(ctx, meta, state.exp > 0 ? Date.now() + state.exp * 1000 : 0, limit, { reply: true });
      return true;
    }

    case 'sexp': {
      const seconds = parseDuration(text);
      if (!seconds) { await again(ctx, '⚠️ Use a duration like <code>45m</code>, <code>12h</code>, <code>10d</code> or <code>2w</code>.'); return true; }
      const loaded = await loadOwnedShare(ctx, state.token).catch(() => null);
      await clearAwait(userId);
      if (loaded) await applyShareExpiry(ctx, loaded, seconds, { reply: true });
      else await reply(ctx, '❌ <b>Link unavailable</b>\n\nThat link no longer exists.');
      return true;
    }

    case 'slim': {
      const limit = /^\d{1,5}$/.test(text) ? Number(text) : 0;
      if (limit < 1 || limit > 10_000) { await again(ctx, '⚠️ Send a number from 1 to 10000.'); return true; }
      const loaded = await loadOwnedShare(ctx, state.token).catch(() => null);
      await clearAwait(userId);
      if (loaded) await applyShareLimit(ctx, loaded, limit, { reply: true });
      else await reply(ctx, '❌ <b>Link unavailable</b>\n\nThat link no longer exists.');
      return true;
    }

    case 'crn': // new collection name
      return handleRenameText(ctx, state, text);

    case 'search': {
      const sl = await limiters.search(userId);
      if (!sl.allowed) { await reply(ctx, rateLimitText(sl.retryAfter)); return true; }
      const r = await showSearchResults(ctx, text, 1);
      if (r.error) await again(ctx, `⚠️ ${escapeHtml(r.error)}\n\n${SEARCH_HELP}`);
      else await clearAwait(userId);
      return true;
    }

    default:
      logger.warn('unknown await state', { kind: state.kind });
      await clearAwait(userId);
      return false;
  }
}

