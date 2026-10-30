import { GrammyError } from 'grammy';
import { isAdmin } from '../config.js';
import { getFileRecord } from '../services/files.js';
import { clearAwait, setAwait } from '../services/inputState.js';
import { EXPIRY_PRESETS } from '../utils/time.js';
import { htmlOpts } from './views.js';
import { cancelKeyboard } from './keyboards.js';

export const isNotModified = (err) => err instanceof GrammyError && /message is not modified/i.test(err.description);

/** Edit the callback's message in place; falls back to a fresh message if editing is impossible. */
export async function editOrReply(ctx, text, reply_markup) {
  try {
    await ctx.editMessageText(text, htmlOpts({ reply_markup }));
  } catch (err) {
    if (isNotModified(err)) return;
    await ctx.reply(text, htmlOpts({ reply_markup }));
  }
}

export const canAccess = (meta, userId) => meta.uploaderId === userId || isAdmin(userId);

/** Loads a file the caller may manage, or answers the callback with a generic alert and returns null. */
export async function loadOwnedFile(ctx, id) {
  const record = await getFileRecord(id);
  if ((record.status !== 'ok' && record.status !== 'expired') || !canAccess(record.meta, ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: 'File not found or no longer available.', show_alert: true }).catch(() => {});
    return null;
  }
  return record.meta;
}

/** Ask the user to type something: stores what we are waiting for and shows a prompt with Cancel. */
export async function promptText(ctx, state, text, cancelTarget = null) {
  await setAwait(ctx.from.id, state);
  await editOrReply(ctx, text, cancelKeyboard(cancelTarget));
}

export { clearAwait };

/** "1d" | "7d" | "m90" -> seconds, or null. */
export function expiryFromCode(code) {
  if (EXPIRY_PRESETS[code]) return EXPIRY_PRESETS[code].seconds;
  const m = /^m(\d{1,6})$/.exec(code);
  return m ? Number(m[1]) * 60 : null;
}

export function codeForSeconds(seconds) {
  const preset = Object.entries(EXPIRY_PRESETS).find(([, p]) => p.seconds === seconds);
  return preset ? preset[0] : `m${Math.round(seconds / 60)}`;
}

/** Best-effort removal of a message that contains a password. */
export const deleteQuietly = (ctx, messageId) => ctx.api.deleteMessage(ctx.chat.id, messageId).catch(() => {});
