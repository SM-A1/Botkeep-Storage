import { Readable } from 'node:stream';
import { Bot, GrammyError } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { config } from '../config.js';
import { logger } from '../logger.js';

// IMPORTANT: the client-wide timeout must be LONGER than the long-polling `timeout` (30 s, set by the runner).
// With both at 30 s every idle getUpdates call was aborted client-side just before Telegram answered; the runner
// treated each one as an error and backed off exponentially (0.1 s, 0.2 s, 0.4 s ...), so after a quiet period the
// bot became deaf for seconds-to-minutes and answered late. Updates are only delivered promptly while polls keep
// succeeding (i.e. while somebody is actively messaging the bot).
const API_CALL_TIMEOUT_MS = 30_000; // every normal API call (sendMessage, copyMessage, ...) keeps its 30 s limit
export const bot = new Bot(config.botToken, { client: { timeoutSeconds: 120 } }); // 120 s: hang guard for getUpdates only

// Installed BEFORE autoRetry so the 30 s limit applies to each attempt (as before), not to all retries together.
bot.api.config.use((prev, method, payload, signal) => {
  if (method === 'getUpdates') return prev(method, payload, signal); // long poll: governed by the 120 s guard above
  const limit = AbortSignal.timeout(API_CALL_TIMEOUT_MS);
  return prev(method, payload, signal ? AbortSignal.any([signal, limit]) : limit);
});
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 15 }));

/** Copy a user's message into the private storage channel. Returns the channel message ID. */
export async function copyToStorage(fromChatId, messageId) {
  const copied = await bot.api.copyMessage(config.storageChannelId, fromChatId, messageId);
  return copied.message_id;
}

/** Deliver a stored file to a user by copying it out of the storage channel (works for any size). */
export function copyFromStorage(toChatId, storageMessageId, extra = {}) {
  return bot.api.copyMessage(toChatId, config.storageChannelId, storageMessageId, extra);
}

/** Copy several stored files out of the channel in one call (ids must be ascending, at most 100). */
export function copyManyFromStorage(toChatId, storageMessageIds, extra = {}) {
  return bot.api.copyMessages(toChatId, config.storageChannelId, storageMessageIds, extra);
}

/** Best-effort delete. Returns true when the message is gone (or was already gone). */
export async function deleteStorageMessage(messageId) {
  try {
    await bot.api.deleteMessage(config.storageChannelId, messageId);
    return true;
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 400 && /not found/i.test(err.description)) return true;
    logger.warn('could not delete storage channel message', { err });
    return false;
  }
}

/**
 * Open a download stream for a Telegram file_id via the Bot API (<= 20 MB).
 * The bot token stays on the server; the browser only sees our own URL.
 */
export async function openFileStream(fileId, { range = '' } = {}) {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram returned no file_path');

  const controller = new AbortController();
  const headerTimer = setTimeout(() => controller.abort(), 20_000);
  let response;
  try {
    response = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`, {
      signal: controller.signal,
      headers: range ? { Range: range } : undefined,
    });
  } finally {
    clearTimeout(headerTimer);
  }
  if (!response.ok || !response.body) {
    throw new Error(`Telegram file download failed with HTTP ${response.status}`);
  }
  return {
    body: Readable.fromWeb(response.body),
    status: response.status, // 206 when Telegram honoured the Range header
    length: Number(response.headers.get('content-length')) || null,
    contentRange: response.headers.get('content-range') || '',
    cancel: () => controller.abort(),
  };
}

export async function checkStorageChannel() {
  try {
    const chat = await bot.api.getChat(config.storageChannelId);
    const me = await bot.api.getMe();
    const member = await bot.api.getChatMember(config.storageChannelId, me.id);
    const isCreator = member.status === 'creator';
    const isAdminMember = member.status === 'administrator';
    return {
      ok: (isCreator || isAdminMember) && chat.type === 'channel',
      isChannel: chat.type === 'channel',
      isPublic: Boolean(chat.username),
      canPost: isCreator || Boolean(member.can_post_messages),
      canDelete: isCreator || Boolean(member.can_delete_messages),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export const isBlockedError = (err) => err instanceof GrammyError && err.error_code === 403;
