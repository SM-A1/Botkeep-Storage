// Membership cache behaviour (FORCE_SUB_CACHE_SECONDS > 0). Separate file because config is read once at import.
//   VAULT_TEST_REDIS_URL=redis://127.0.0.1:6379/15 node --test tests/forceSubscribeCache.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

const TEST_URL = process.env.VAULT_TEST_REDIS_URL;
if (!TEST_URL) { console.error('Set VAULT_TEST_REDIS_URL to a throw-away Redis database (it will be flushed).'); process.exit(1); }
Object.assign(process.env, {
  BOT_TOKEN: '123456:TESTTOKENTESTTOKENTESTTOKENTESTTOKEN1', REDIS_URL: TEST_URL, STORAGE_CHANNEL_ID: '-1001234567890',
  ADMIN_IDS: '1001', BOT_USERNAME: 'Test_Vault_Bot', LOG_LEVEL: 'error', FORCE_SUB_CACHE_SECONDS: '2', FORCE_SUB_SEED: '',
});
const { redis, connectRedis } = await import('../src/services/redis.js');
await connectRedis();
await redis.flushdb();
const { bot } = await import('../src/services/telegram.js');
const fsub = await import('../src/services/forceSubscribe.js');

let status = 'member'; let memberCalls = 0;
bot.botInfo = { id: 123456, is_bot: true, first_name: 'Vault', username: 'Test_Vault_Bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
bot.api.config.use(async (_p, method, payload) => {
  if (method === 'getChat') return { ok: true, result: { id: -1001000000001, type: 'channel', title: 'Chan', username: 'TheRoyalZone' } };
  if (method === 'getChatMember') {
    if (Number(payload.user_id) === 123456) return { ok: true, result: { status: 'administrator', user: { id: 123456, is_bot: true, first_name: 'b' } } };
    memberCalls += 1;
    return { ok: true, result: { status, user: { id: payload.user_id, is_bot: false, first_name: 'U' } } };
  }
  return { ok: true, result: true };
});

test('positive results are cached briefly; a leave is noticed after the TTL; failures and "Verify" are never served from cache', async () => {
  const created = await fsub.createChannel({ name: 'Chan', ref: '@TheRoyalZone', btn: 'Join', url: 'https://t.me/TheRoyalZone', desc: '' });
  assert.equal(created.ok, true);
  const ch = created.channel;
  assert.equal((await fsub.checkMembership(42, ch)).state, 'member');
  assert.equal(memberCalls, 1);
  status = 'left'; // user leaves
  assert.equal((await fsub.checkMembership(42, ch)).state, 'member', 'still inside the cache window');
  assert.equal(memberCalls, 1);
  assert.equal((await fsub.checkMembership(42, ch, { fresh: true })).state, 'not_member', 'Verify button bypasses the cache');
  assert.equal(memberCalls, 2);
  status = 'member';
  assert.equal((await fsub.checkMembership(42, ch, { fresh: true })).state, 'member');
  status = 'left';
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal((await fsub.checkMembership(42, ch)).state, 'not_member', 'blocked again once the cache expired');
  // a negative result is never cached
  status = 'member';
  assert.equal((await fsub.checkMembership(42, ch)).state, 'member');
  // editing the chat id invalidates cached entries (cache value is bound to the chat id)
  const other = { ...ch, chatId: '-1001999999999' };
  status = 'left';
  assert.equal((await fsub.checkMembership(42, other)).state, 'not_member');
});

test.after(async () => { await redis.quit().catch(() => {}); });
