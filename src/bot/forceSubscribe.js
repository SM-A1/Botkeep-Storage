import { InlineKeyboard } from 'grammy';
import { config, isAdmin } from '../config.js';
import { logger } from '../logger.js';
import * as fs from '../services/forceSubscribe.js';
import { clearAwait, getAwait, setAwait } from '../services/inputState.js';
import { limiters } from '../services/rateLimit.js';
import { escapeHtml } from '../utils/format.js';
import { formatDayTime } from '../utils/time.js';
import { editOrReply } from './common.js';
import { htmlOpts } from './views.js';
import { guard } from './admin.js';

const ID = '([A-HJKMNP-Z2-9]{8})';
const STEPS = ['name', 'ref', 'btn', 'url', 'desc'];
const FIELD_OF = { n: 'name', r: 'ref', b: 'btn', u: 'url', d: 'desc' };
const CODE_OF = Object.fromEntries(Object.entries(FIELD_OF).map(([k, v]) => [v, k]));
const FIELD_LABEL = { name: 'Name', ref: 'Channel username / ID', btn: 'Join button text', url: 'Join URL', desc: 'Description' };
const PAGE_SIZE = 5;
const esc = escapeHtml;

/** Edit the tapped message for button presses, send a new message after a typed answer. */
const show = (ctx, text, kb) => (ctx.callbackQuery ? editOrReply(ctx, text, kb) : ctx.reply(text, htmlOpts({ reply_markup: kb })));

// =====================================================================================================
//  Admin: screens
// =====================================================================================================

function statusOf(ch) {
  if (!ch.enabled) return '⏸ Disabled';
  if (ch.lastError) return `⚠️ Needs attention (${esc(fs.labelForError(ch.lastError))})`;
  return '✅ Active';
}

async function homeScreen(notice = '') {
  const all = await fs.listChannels();
  const active = all.filter((c) => c.enabled).length;
  const attention = all.filter((c) => c.enabled && c.lastError).length;
  const lines = [
    '📢 <b>Force Subscribe Manager</b>', '',
    `Channels: <b>${all.length}</b> · mandatory (active): <b>${active}</b> · disabled: ${all.length - active}${attention ? ` · ⚠️ ${attention} need attention` : ''}`,
    'Users must join <b>every active channel</b> before they can use the bot. Admins are never blocked.',
  ];
  if (notice) lines.unshift(notice, '');
  const kb = new InlineKeyboard()
    .text('➕ Add New Channel', 'adm:fs:add').text('📋 Manage Channels', 'adm:fs:list:1').row()
    .text('✏️ Edit Channel', 'adm:fs:pick:e').text('🗑️ Remove Channel', 'adm:fs:pick:d').row()
    .text('🔄 Refresh Channel List', 'adm:fs:refresh').row()
    .text('🔙 Back to Admin Panel', 'adm:home');
  return { text: lines.join('\n'), reply_markup: kb };
}

async function listScreen(page, notice = '') {
  const all = await fs.listChannels();
  const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, page), totalPages);
  const slice = all.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  const lines = ['📋 <b>Manage Channels</b>', `${all.length} configured`, ''];
  if (notice) lines.unshift(notice, '');
  if (slice.length === 0) lines.push('No channels yet. Tap “Add New Channel”.');
  const kb = new InlineKeyboard();
  slice.forEach((c, i) => {
    const n = (p - 1) * PAGE_SIZE + i + 1;
    lines.push(`<b>${n}. ${esc(c.name)}</b> — ${statusOf(c)}`, `   <code>${esc(c.ref)}</code>`);
    kb.text(`👁 ${n}`, `adm:fs:v:${c.id}`).text(`✏️ ${n}`, `adm:fs:e:${c.id}`).text(`🔛 ${n}`, `adm:fs:t:${c.id}`).text(`🗑 ${n}`, `adm:fs:d:${c.id}`).row();
  });
  if (totalPages > 1) kb.text('⬅️', p > 1 ? `adm:fs:list:${p - 1}` : 'noop').text(`${p}/${totalPages}`, 'noop').text('➡️', p < totalPages ? `adm:fs:list:${p + 1}` : 'noop').row();
  kb.text('➕ Add', 'adm:fs:add').text('🔄 Refresh', 'adm:fs:refresh').row().text('⬅️ Back', 'adm:fs').text('🔙 Admin Panel', 'adm:home');
  if (slice.length) lines.push('', '<i>👁 details · ✏️ edit · 🔛 enable/disable · 🗑 delete</i>');
  return { text: lines.join('\n'), reply_markup: kb };
}

async function pickScreen(mode) {
  const all = await fs.listChannels();
  const kb = new InlineKeyboard();
  all.forEach((c, i) => kb.text(`${i + 1}. ${c.name}`.slice(0, 60), `adm:fs:${mode}:${c.id}`).row());
  kb.text('⬅️ Back', 'adm:fs');
  const what = mode === 'e' ? '✏️ <b>Edit Channel</b>\n\nChoose the channel to edit.' : '🗑️ <b>Remove Channel</b>\n\nChoose the channel to delete.';
  return { text: all.length ? what : `${what.split('\n')[0]}\n\nNo channels configured yet.`, reply_markup: kb };
}

async function detailScreen(ch, { probe = true, notice = '' } = {}) {
  let access = '—';
  if (probe) {
    const info = await fs.probeChannel(ch);
    access = info.ok ? '✅ the bot can verify members' : `❌ ${esc(info.message)}`;
    ch = (await fs.getChannel(ch.id)) ?? ch;
  }
  const lines = [
    `📢 <b>${esc(ch.name)}</b>`, '',
    `Status: ${statusOf(ch)}`,
    `Bot access: ${access}`,
    `Username/ID: <code>${esc(ch.ref)}</code>`,
    `Chat ID: <code>${esc(ch.chatId)}</code> · ${esc(ch.type)}`,
    `Join button: ${esc(ch.btn)}`,
    `Join URL: ${esc(ch.url)}`,
    `Description: ${ch.desc ? esc(ch.desc) : '—'}`,
    `Added: ${formatDayTime(ch.createdAt)} · updated ${formatDayTime(ch.updatedAt)}`,
  ];
  if (notice) lines.unshift(notice, '');
  const kb = new InlineKeyboard()
    .text(ch.enabled ? '⏸ Disable' : '🔛 Enable', `adm:fs:tv:${ch.id}`).text('✏️ Edit', `adm:fs:e:${ch.id}`).row()
    .text('🗑 Delete', `adm:fs:d:${ch.id}`).row()
    .text('⬅️ Channels', 'adm:fs:list:1').text('🔙 Admin Panel', 'adm:home');
  return { text: lines.join('\n'), reply_markup: kb };
}

function editScreen(ch, notice = '') {
  const lines = [
    `✏️ <b>Edit · ${esc(ch.name)}</b>`, '',
    `Name: ${esc(ch.name)}`, `Username/ID: <code>${esc(ch.ref)}</code>`, `Join button: ${esc(ch.btn)}`, `Join URL: ${esc(ch.url)}`, `Description: ${ch.desc ? esc(ch.desc) : '—'}`,
    '', '<i>Changes apply immediately — no redeploy needed.</i>',
  ];
  if (notice) lines.unshift(notice, '');
  const kb = new InlineKeyboard()
    .text('✏️ Name', `adm:fs:ef:${ch.id}:n`).text('🆔 Channel ID', `adm:fs:ef:${ch.id}:r`).row()
    .text('🔘 Button text', `adm:fs:ef:${ch.id}:b`).text('🔗 Join URL', `adm:fs:ef:${ch.id}:u`).row()
    .text('📝 Description', `adm:fs:ef:${ch.id}:d`).row()
    .text('⬅️ Back', `adm:fs:v:${ch.id}`);
  return { text: lines.join('\n'), reply_markup: kb };
}

// =====================================================================================================
//  Admin: add / edit conversation
// =====================================================================================================

function promptText(step, draft, { mode, current = '', error = '' }) {
  const idx = STEPS.indexOf(step) + 1;
  const head = mode === 'edit' ? `✏️ <b>Edit · ${FIELD_LABEL[step]}</b>` : `➕ <b>Add channel</b> · step ${idx}/5`;
  const name = draft?.name || 'Your Channel';
  const body = {
    name: ['Send the <b>channel name</b>.', 'Example: <code>The Royal Zone</code>'],
    ref: [
      'Send the channel <b>@username</b> or <b>chat ID</b>.',
      'Examples:\n<code>@TheRoyalZone</code>\n<code>-1001234567890</code>',
      '<i>The bot must be an administrator of the channel so it can check who joined.</i>',
    ],
    btn: ['Send the <b>join button text</b>.', `Example: <code>${esc(`📢 Join ${name}`)}</code>`],
    url: [
      'Send the <b>invite link</b>.',
      `Public: <code>${esc(draft?.ref?.startsWith('@') ? `https://t.me/${draft.ref.slice(1)}` : 'https://t.me/TheRoyalZone')}</code>\nPrivate: <code>https://t.me/+AbCdEf123</code>`,
    ],
    desc: ['Optional: send a short <b>description</b> for users, or tap Skip.', 'Example: <code>Join our official channel to unlock all bot features.</code>'],
  }[step];
  const lines = [head, '', ...body];
  if (current) lines.push('', `Current: <code>${esc(current)}</code>`);
  if (error) lines.unshift(`❌ ${esc(error)}`, '');
  return lines.join('\n');
}

const stepKeyboard = (step, { backTo = 'adm:fs:back', cancelTo = 'adm:fs:cancel' } = {}) => {
  const kb = new InlineKeyboard().text('⬅️ Back', backTo).text('✖️ Cancel', cancelTo);
  if (step === 'desc') kb.row().text('⏭ Skip', 'adm:fs:skip');
  return kb;
};

async function askStep(ctx, step, draft, { ret = '', error = '' } = {}) {
  await setAwait(ctx.from.id, { kind: 'fs', mode: 'add', step, ret });
  await show(ctx, promptText(step, draft, { mode: 'add', error, current: ret ? draft[step] ?? '' : '' }), stepKeyboard(step));
}

function previewScreen(draft, notice = '') {
  const lines = [
    '📢 <b>NEW FORCE SUBSCRIBE CHANNEL</b>', '',
    `Channel: ${esc(draft.name)}`,
    `Username/ID: <code>${esc(draft.ref)}</code>`,
    `Join Button: ${esc(draft.btn)}`,
    `Join URL: ${esc(draft.url)}`,
    `Description: ${draft.desc ? esc(draft.desc) : '—'}`,
    'Status: Pending Verification',
    '', '<i>On “Confirm &amp; Save” the bot checks the chat with Telegram and that it can verify members.</i>',
  ];
  if (notice) lines.unshift(notice, '');
  const kb = new InlineKeyboard().text('✅ Confirm & Save', 'adm:fs:ok').row().text('✏️ Edit Details', 'adm:fs:ed').text('❌ Cancel', 'adm:fs:cancel');
  return { text: lines.join('\n'), reply_markup: kb };
}

const complete = (d) => d && STEPS.filter((s) => s !== 'desc').every((s) => typeof d[s] === 'string' && d[s]);

/** Handles a typed answer while an admin is in the add/edit flow. Returns true when it consumed the message. */
export async function handleFsubText(ctx, state) {
  const uid = ctx.from.id;
  if (!isAdmin(uid)) { // never trust stored state: a non-admin can never change channel settings
    await clearAwait(uid); await fs.clearDraft(uid);
    return false;
  }
  const text = ctx.msg.text ?? '';
  const step = state.step;
  if (!STEPS.includes(step)) { await clearAwait(uid); return false; }
  const parse = { name: fs.parseName, ref: fs.parseChannelRef, btn: fs.parseButtonLabel, url: fs.validateJoinUrl, desc: fs.parseDescription }[step];
  const parsed = parse(text);

  if (state.mode === 'edit') {
    const ch = await fs.getChannel(state.id ?? '');
    if (!ch) { await clearAwait(uid); await ctx.reply('❌ That channel no longer exists.', htmlOpts()); return true; }
    const back = `adm:fs:e:${ch.id}`;
    const retry = async (error) => {
      await setAwait(uid, state);
      await ctx.reply(promptText(step, null, { mode: 'edit', current: ch[step], error }), htmlOpts({ reply_markup: stepKeyboard(step, { backTo: back, cancelTo: back }) }));
      return true;
    };
    if (!parsed.ok) return retry(parsed.error);
    if (step === 'ref') await ctx.reply('🔎 Checking with Telegram…', htmlOpts());
    const res = await fs.updateChannel(ch.id, { [step]: text }, { actorId: uid });
    if (!res.ok) return retry(res.message);
    await clearAwait(uid);
    const view = editScreen(res.channel, '✅ <b>Saved</b> — active immediately.');
    await ctx.reply(view.text, htmlOpts({ reply_markup: view.reply_markup }));
    return true;
  }

  // ---- add wizard
  const draft = await fs.getDraft(uid);
  if (!draft) {
    await clearAwait(uid);
    await ctx.reply('⌛ This setup expired. Open Admin → Force Subscribe → Add New Channel to start again.', htmlOpts({ reply_markup: new InlineKeyboard().text('📢 Force Subscribe', 'adm:fs') }));
    return true;
  }
  if (!parsed.ok) { await askStep(ctx, step, draft, { ret: state.ret, error: parsed.error }); return true; }
  draft[step] = parsed.value;
  await fs.saveDraft(uid, draft);
  const next = state.ret === 'preview' ? null : STEPS[STEPS.indexOf(step) + 1];
  if (!next) {
    await clearAwait(uid);
    const view = previewScreen(draft);
    await ctx.reply(view.text, htmlOpts({ reply_markup: view.reply_markup }));
    return true;
  }
  await askStep(ctx, next, draft);
  return true;
}

// =====================================================================================================
//  Admin: callback handlers (every one re-validates the numeric admin ID)
// =====================================================================================================

export function registerForceSubscribeAdmin(bot) {
  const on = (pattern, kind, fn) => bot.callbackQuery(pattern, async (ctx) => {
    if (!(await guard(ctx, kind))) return;
    await clearAwait(ctx.from.id); // navigating always abandons a pending "type your answer" prompt
    await fn(ctx);
  });
  const render = async (ctx, view) => { await ctx.answerCallbackQuery(); await editOrReply(ctx, view.text, view.reply_markup); };
  const alert = (ctx, text) => ctx.answerCallbackQuery({ text: String(text).slice(0, 190), show_alert: true });

  on('adm:fs', 'fs:home', async (ctx) => render(ctx, await homeScreen()));

  on(/^adm:fs:list:(\d{1,3})$/, 'fs:list', async (ctx) => render(ctx, await listScreen(Number(ctx.match[1]))));

  on('adm:fs:refresh', 'fs:refresh', async (ctx) => {
    await ctx.answerCallbackQuery({ text: '🔄 Checking channels…' });
    const all = await fs.listChannels();
    await Promise.all(all.map((c) => fs.probeChannel(c)));
    const view = await listScreen(1, '🔄 <b>Channel list refreshed</b>');
    await editOrReply(ctx, view.text, view.reply_markup);
  });

  on(/^adm:fs:pick:(e|d)$/, 'fs:pick', async (ctx) => render(ctx, await pickScreen(ctx.match[1])));

  on(new RegExp(`^adm:fs:v:${ID}$`), 'fs:view', async (ctx) => {
    const ch = await fs.getChannel(ctx.match[1]);
    if (!ch) return alert(ctx, 'That channel no longer exists.');
    await ctx.answerCallbackQuery();
    const view = await detailScreen(ch);
    await editOrReply(ctx, view.text, view.reply_markup);
  });

  on(new RegExp(`^adm:fs:e:${ID}$`), 'fs:edit', async (ctx) => {
    const ch = await fs.getChannel(ctx.match[1]);
    if (!ch) return alert(ctx, 'That channel no longer exists.');
    await render(ctx, editScreen(ch));
  });

  on(new RegExp(`^adm:fs:ef:${ID}:([nrbud])$`), 'fs:edit-field', async (ctx) => {
    const ch = await fs.getChannel(ctx.match[1]);
    if (!ch) return alert(ctx, 'That channel no longer exists.');
    const step = FIELD_OF[ctx.match[2]];
    await setAwait(ctx.from.id, { kind: 'fs', mode: 'edit', id: ch.id, step });
    await ctx.answerCallbackQuery();
    const back = `adm:fs:e:${ch.id}`;
    await editOrReply(ctx, promptText(step, null, { mode: 'edit', current: ch[step] }), stepKeyboard(step, { backTo: back, cancelTo: back }));
  });

  // Enable / disable (t = from the list, tv = from the detail screen)
  on(new RegExp(`^adm:fs:(t|tv):${ID}$`), 'fs:toggle', async (ctx) => {
    const [, from, id] = ctx.match;
    const ch = await fs.getChannel(id);
    if (!ch) return alert(ctx, 'That channel no longer exists.');
    await ctx.answerCallbackQuery({ text: ch.enabled ? '⏸ Disabling…' : '🔎 Checking with Telegram…' });
    const res = await fs.setChannelEnabled(id, !ch.enabled, { actorId: ctx.from.id });
    const notice = res.ok ? (res.channel.enabled ? '✅ <b>Enabled</b> — now mandatory for every user.' : '⏸ <b>Disabled</b> — no longer required, effective immediately.') : `❌ <b>Not changed</b>: ${esc(res.message)}`;
    const view = from === 'tv' && (await fs.getChannel(id)) ? await detailScreen(await fs.getChannel(id), { probe: false, notice }) : await listScreen(1, notice);
    await editOrReply(ctx, view.text, view.reply_markup);
  });

  // Delete with confirmation
  on(new RegExp(`^adm:fs:d:${ID}$`), 'fs:delete', async (ctx) => {
    const ch = await fs.getChannel(ctx.match[1]);
    if (!ch) return alert(ctx, 'That channel no longer exists.');
    await render(ctx, {
      text: `🗑 <b>Delete “${esc(ch.name)}”?</b>\n\nUsers will no longer need to join it. Other channels and all bot data stay untouched.\n<i>This cannot be undone.</i>`,
      reply_markup: new InlineKeyboard().text('🗑 Yes, delete', `adm:fs:dd:${ch.id}`).text('✖️ Cancel', `adm:fs:v:${ch.id}`),
    });
  });
  on(new RegExp(`^adm:fs:dd:${ID}$`), 'fs:delete-confirm', async (ctx) => {
    const res = await fs.deleteChannel(ctx.match[1], { actorId: ctx.from.id });
    await ctx.answerCallbackQuery({ text: res.ok ? '🗑 Deleted' : res.message });
    const view = await listScreen(1, res.ok ? `🗑 <b>${esc(res.channel.name)}</b> deleted.` : `❌ ${esc(res.message)}`);
    await editOrReply(ctx, view.text, view.reply_markup);
  });

  // ---- add wizard
  on('adm:fs:add', 'fs:add', async (ctx) => {
    if ((await fs.countChannels()) >= fs.MAX_CHANNELS) return alert(ctx, `You can configure at most ${fs.MAX_CHANNELS} channels.`);
    const draft = {};
    await fs.saveDraft(ctx.from.id, draft);
    await ctx.answerCallbackQuery();
    await askStep(ctx, 'name', draft);
  });

  on('adm:fs:cancel', 'fs:cancel', async (ctx) => {
    await fs.clearDraft(ctx.from.id);
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    const view = await homeScreen('❌ Setup cancelled — nothing was saved.');
    await editOrReply(ctx, view.text, view.reply_markup);
  });

  bot.callbackQuery('adm:fs:back', async (ctx) => {
    if (!(await guard(ctx, 'fs:back'))) return;
    const state = await getAwait(ctx.from.id);
    const draft = (await fs.getDraft(ctx.from.id)) ?? {};
    await ctx.answerCallbackQuery();
    if (state?.kind === 'fs' && state.mode === 'add') {
      if (state.ret === 'preview') { await clearAwait(ctx.from.id); const v = previewScreen(draft); return editOrReply(ctx, v.text, v.reply_markup); }
      const idx = STEPS.indexOf(state.step);
      if (idx > 0) return askStep(ctx, STEPS[idx - 1], draft);
    }
    await clearAwait(ctx.from.id); await fs.clearDraft(ctx.from.id);
    const view = await homeScreen();
    await editOrReply(ctx, view.text, view.reply_markup);
  });

  bot.callbackQuery('adm:fs:skip', async (ctx) => {
    if (!(await guard(ctx, 'fs:skip'))) return;
    const draft = await fs.getDraft(ctx.from.id);
    if (!draft) return alert(ctx, 'This setup expired. Start again.');
    draft.desc = '';
    await fs.saveDraft(ctx.from.id, draft);
    await clearAwait(ctx.from.id);
    await ctx.answerCallbackQuery();
    const v = previewScreen(draft);
    await editOrReply(ctx, v.text, v.reply_markup);
  });

  on('adm:fs:ed', 'fs:edit-details', async (ctx) => {
    const draft = await fs.getDraft(ctx.from.id);
    if (!draft) return alert(ctx, 'This setup expired. Start again.');
    const kb = new InlineKeyboard();
    for (const f of STEPS) kb.text(`✏️ ${FIELD_LABEL[f]}`, `adm:fs:edf:${CODE_OF[f]}`).row();
    kb.text('⬅️ Back to preview', 'adm:fs:pv');
    await render(ctx, { text: '✏️ <b>Edit details</b>\n\nWhich detail do you want to change?', reply_markup: kb });
  });

  on('adm:fs:pv', 'fs:preview', async (ctx) => {
    const draft = await fs.getDraft(ctx.from.id);
    if (!draft) return alert(ctx, 'This setup expired. Start again.');
    await render(ctx, previewScreen(draft));
  });

  on(/^adm:fs:edf:([nrbud])$/, 'fs:edit-draft-field', async (ctx) => {
    const draft = await fs.getDraft(ctx.from.id);
    if (!draft) return alert(ctx, 'This setup expired. Start again.');
    await ctx.answerCallbackQuery();
    await askStep(ctx, FIELD_OF[ctx.match[1]], draft, { ret: 'preview' });
  });

  bot.callbackQuery('adm:fs:ok', async (ctx) => {
    if (!(await guard(ctx, 'fs:save'))) return;
    const draft = await fs.getDraft(ctx.from.id);
    if (!complete(draft)) return alert(ctx, 'This setup expired or is incomplete. Start again.');
    await ctx.answerCallbackQuery({ text: '🔎 Verifying with Telegram…' });
    const res = await fs.createChannel(draft, { actorId: ctx.from.id });
    if (!res.ok) {
      const v = previewScreen(draft, `❌ <b>Not saved</b>\n${esc(res.message)}`);
      v.reply_markup = new InlineKeyboard().text('🔁 Try again', 'adm:fs:ok').row().text('✏️ Edit Details', 'adm:fs:ed').text('❌ Cancel', 'adm:fs:cancel');
      return editOrReply(ctx, v.text, v.reply_markup);
    }
    await fs.clearDraft(ctx.from.id); await clearAwait(ctx.from.id);
    const ch = res.channel;
    await editOrReply(ctx, `✅ <b>Channel saved</b>\n\n<b>${esc(ch.name)}</b> (<code>${esc(ch.ref)}</code>) is now a mandatory channel. Users must join it before using the bot.`,
      new InlineKeyboard().text('📋 Manage Channels', 'adm:fs:list:1').text('➕ Add another', 'adm:fs:add').row().text('🔙 Back to Force Subscribe', 'adm:fs'));
  });
}

// =====================================================================================================
//  Users: the gate (runs on every message and button press) + "Verify All Memberships"
// =====================================================================================================

function joinScreen(results, { intro = '' } = {}) {
  const lines = [
    '🔒 <b>Join required</b>', '',
    intro || 'To use this bot you need to join the channel(s) below. After joining, tap <b>✅ Verify All Memberships</b>.', '',
  ];
  const kb = new InlineKeyboard();
  for (const r of results) {
    const c = r.channel;
    if (r.state === 'member') { lines.push(`✅ <b>${esc(c.name)}</b> — joined`); continue; }
    lines.push(`${r.state === 'error' ? '⚠️' : '❌'} <b>${esc(c.name)}</b> — ${r.state === 'error' ? 'could not be verified right now, try again in a moment' : 'not joined yet'}`);
    if (c.desc) lines.push(`   <i>${esc(c.desc)}</i>`);
    const url = fs.validateJoinUrl(c.url);
    if (url.ok) kb.url(c.btn, url.value).row();
  }
  kb.text('✅ Verify All Memberships', 'fs:verify');
  return { text: lines.join('\n'), reply_markup: kb };
}

const START_PAYLOAD_RE = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{1,64})$/;
const PRIVACY_RE = /^\/privacy(?:@\w+)?\s*$/i;

async function verify(ctx, channels) {
  const uid = ctx.from.id;
  const rl = await limiters.fsubVerify(uid);
  if (!rl.allowed) { await ctx.answerCallbackQuery({ text: `⏳ Try again in ${rl.retryAfter}s` }).catch(() => {}); return; }
  const res = await fs.checkAll(uid, channels, { fresh: true });
  if (res.allowed) {
    const pending = await fs.takePending(uid);
    const kb = new InlineKeyboard();
    if (pending) kb.url('▶️ Continue', `https://t.me/${config.botUsername}?start=${pending}`).row();
    kb.text('🏠 Open menu', 'menu:home');
    await ctx.answerCallbackQuery({ text: '✅ Verified' }).catch(() => {});
    await editOrReply(ctx, '✅ <b>Verified</b>\n\nThanks for joining! You now have full access.', kb);
    return;
  }
  const missing = res.results.filter((r) => r.state !== 'member').map((r) => r.channel.name);
  await ctx.answerCallbackQuery({ text: `❌ Still missing: ${missing.join(', ')}`.slice(0, 190), show_alert: false }).catch(() => {});
  const view = joinScreen(res.results);
  await editOrReply(ctx, view.text, view.reply_markup);
}

/** Middleware: blocks every non-admin until ALL active mandatory channels confirm membership. Fails closed. */
export function forceSubscribeGate() {
  return async (ctx, next) => {
    const uid = ctx.from?.id;
    if (!uid || isAdmin(uid)) return next(); // bot owner / admins are never blocked

    let channels;
    try {
      channels = await fs.listChannels({ onlyActive: true });
    } catch (err) {
      logger.error('force subscribe: could not load channel configuration; denying access', { err });
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: '⚠️ Temporarily unavailable. Try again.', show_alert: true }).catch(() => {});
      else await ctx.reply('⚠️ <b>Temporarily unavailable</b>\n\nPlease try again in a moment.', htmlOpts());
      return undefined;
    }
    if (channels.length === 0) return next(); // nothing is mandatory

    if (ctx.callbackQuery?.data === 'fs:verify') return verify(ctx, channels);

    const text = ctx.msg?.text ?? '';
    if (PRIVACY_RE.test(text)) return next();

    const res = await fs.checkAll(uid, channels); // real getChatMember on every protected interaction
    if (res.allowed) return next();

    const payload = START_PAYLOAD_RE.exec(text)?.[1];
    if (payload) await fs.savePending(uid, payload).catch(() => {});

    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: '🔒 Join the required channels first' }).catch(() => {});
    } else if (ctx.msg && !ctx.msg.text) {
      const rl = await limiters.fsubNotice(uid); // a burst of uploads (e.g. 20 files): one notice, not twenty. Text/commands always get an answer.
      if (!rl.allowed) return undefined;
    }
    const view = joinScreen(res.results);
    await show(ctx, view.text, view.reply_markup);
    return undefined;
  };
}
