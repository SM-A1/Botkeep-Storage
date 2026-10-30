import { registerCommands } from './commands.js';
import { registerHandlers, registerMiddleware } from './handlers.js';
import { forceSubscribeGate } from './forceSubscribe.js';

/** Order matters: middleware -> force-subscribe gate -> commands -> callbacks/uploads -> fallback. */
export function registerBot(bot) {
  registerMiddleware(bot);
  bot.use(forceSubscribeGate()); // after maintenance/rate limits, before ANY command, button, upload or text handler
  registerCommands(bot);
  registerHandlers(bot);
}
