import { sequentialize } from '@grammyjs/runner';
import { config, isAdmin } from '../config.js';
import { logger } from '../logger.js';
import { isMaintenance } from '../services/state.js';
import { clearAwait } from '../services/inputState.js';
import { isValidTelegramId } from '../services/tokens.js';
import { touchUser } from '../services/users.js';
import { htmlOpts, maintenanceText } from './views.js';

async function maintenanceOn() {
  try {
    return await isMaintenance();
  } catch {
    return false; // fail open: do not lock users out because Redis hiccuped
  }
}

// Button presses are flood-limited in memory (no Redis round trip per tap). Per-process is fine here:
// it only protects against a single user hammering buttons.
const taps = new Map(); // userId -> { count, resetAt }
function tapAllowed(userId) {
  const limit = config.limits.callbacksPerMinute;
  if (limit <= 0) return { allowed: true };
  const now = Date.now();
  let e = taps.get(userId);
  if (!e || now >= e.resetAt) { e = { count: 0, resetAt: now + 60_000 }; taps.set(userId, e); }
  e.count += 1;
  if (taps.size > 50_000) for (const [k, v] of taps) if (now >= v.resetAt) taps.delete(k);
  return { allowed: e.count <= limit, retryAfter: Math.max(1, Math.ceil((e.resetAt - now) / 1000)) };
}

const AUTO_ANSWER_MS = 700;

export function registerMiddleware(bot) {
  // 0. Process different users in parallel, but keep each user's own updates in order
  //    (prompt flows such as "send the new name" depend on message order).
  bot.use(sequentialize((ctx) => (ctx.from ? String(ctx.from.id) : undefined)));

  // 1. Only private chats from real users with valid numeric IDs.
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (ctx.chat?.type !== 'private' || !from || from.is_bot || !isValidTelegramId(from.id)) return;
    await next();
  });

  // 2. Profile (numeric ID is the identity), maintenance mode, callback rate limiting.
  bot.use(async (ctx, next) => {
    const userId = ctx.from.id;
    await touchUser(ctx.from).catch((err) => logger.warn('failed to update user profile', { err }));

    if (!isAdmin(userId) && (await maintenanceOn())) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: '🛠 Under maintenance', show_alert: true }).catch(() => {});
      else await ctx.reply(maintenanceText(), htmlOpts());
      return;
    }
    if (ctx.callbackQuery) {
      const rl = tapAllowed(userId);
      if (!rl.allowed) {
        await ctx.answerCallbackQuery({ text: `⏳ Slow down — try again in ${rl.retryAfter}s` }).catch(() => {});
        return;
      }
    }
    // Starting a command or uploading abandons whatever the user was typing a reply for.
    if (ctx.msg?.text?.startsWith('/') || ctx.msg?.document || ctx.msg?.photo || ctx.msg?.video || ctx.msg?.audio) {
      clearAwait(userId).catch(() => {}); // same connection => executes before any later command
    }

    if (!ctx.callbackQuery) { await next(); return; }

    // Stop the button's loading spinner quickly: if a handler has not answered within AUTO_ANSWER_MS
    // (slow database / Telegram), answer with no text. Answering twice is made harmless.
    let answered = false;
    const original = ctx.answerCallbackQuery.bind(ctx);
    ctx.answerCallbackQuery = (...args) => {
      if (answered) return Promise.resolve(true);
      answered = true;
      const call = original(...args);
      // A plain acknowledgement (no text) runs in the background while the handler keeps working;
      // alerts/toasts with text are awaited as before.
      if (!args[0]?.text) { call.catch(() => {}); return Promise.resolve(true); }
      return call;
    };
    const timer = setTimeout(() => { ctx.answerCallbackQuery().catch(() => {}); }, AUTO_ANSWER_MS);
    try {
      await next();
    } finally {
      clearTimeout(timer);
    }
  });
}
