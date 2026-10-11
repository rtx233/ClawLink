const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, TOKEN } = require('./helpers');
const { createApp } = require('../server');
const { createAdapters } = require('../server/adapters');

async function accounts(f) {
  const session = await f.session();
  const tg = (await f.request('/api/bots', { platform: 'telegram', name: '通知 TG', token: TOKEN, target: session.id })).data.bot;
  await f.request(`/api/bots/${tg.id}`, { allowedPeers: ['tg-owner'] }, 'PATCH');
  const wx = (await f.request('/api/bots', { platform: 'wechat', name: '通知微信', target: session.id })).data.bot;
  const qr = (await f.request(`/api/bots/${wx.id}/login/start`, {})).data;
  await f.request(`/api/bots/${wx.id}/login/poll`, { loginId: qr.loginId });
  return { session, tg: f.app.viewState().bots.find(b => b.id === tg.id), wx: f.app.viewState().bots.find(b => b.id === wx.id) };
}
const patch = (f, bot, permissions) => f.request(`/api/bots/${bot.id}`, { permissions }, 'PATCH');
const command = (f, bot, text, peerId = '') => f.request('/api/commands', { botId: bot.id, text, peerId });

test('全部内置指令可改名；help、配对和前端切换使用最新名字；冲突不会部分保存', async t => {
  const f = await fixture(); t.after(() => f.close()); const { tg, wx, session } = await accounts(f);
  const originals = f.app.viewState().commands;
  const edits = originals.map(item => ({ ...item, trigger: item.id === 'help' ? '[微笑]' : `/新_${item.id}`, description: `修改的 ${item.id} 说明`, emoji: '[强]' }));
  assert.equal((await f.request('/api/commands/settings', { commands: edits }, 'PATCH')).status, 200);
  const help = (await command(f, wx, '[微笑]')).data.reply;
  assert.match(help, /\[强\] \/新_switch 会话名 修改的 switch 说明/); assert.ok(!help.includes('/新_pair')); assert.ok(!help.includes('/新_screenshot'));
  assert.match((await command(f, tg, '[微笑]')).data.reply, /\/新_pair/);
  assert.match((await command(f, tg, '/help')).data.reply, /未知指令/);
  assert.equal((await command(f, tg, '/新_sessions@test_router_bot')).data.ok, true);
  assert.equal((await f.request('/api/commands', { botId: tg.id, action: 'switch', argument: session.id })).data.ok, true);
  await f.request(`/api/bots/${tg.id}/pairing`, {});
  const bot = f.app.viewState().bots.find(b => b.id === tg.id);
  await f.app.receive(bot, { peerId: 'new-peer', text: `/新_pair ${bot.pairingCode}` });
  assert.ok(f.app.viewState().bots.find(b => b.id === tg.id).peers.includes('new-peer'));
  assert.match(f.sent.at(-1).text, /\/新_sessions/);
  const collision = await f.request('/api/commands/settings', { commands: [{ ...edits[0], trigger: edits[1].trigger }] }, 'PATCH');
  assert.equal(collision.status, 400); assert.equal(f.app.viewState().commands[0].trigger, '[微笑]');
  const invalid = await f.request('/api/commands/settings', { commands: [{ ...edits[0], trigger: '/hello world' }] }, 'PATCH');
  assert.equal(invalid.status, 400);
});

test('自定义路由可改名、说明和微信表情；精确匹配；权限随稳定 ID 保留', async t => {
  const f = await fixture(); t.after(() => f.close()); const { tg, wx, session } = await accounts(f);
  const rule = (await f.request('/api/routes', { bot: tg.id, target: session.id, command: '/research' })).data.route;
  await patch(f, tg, { commands: { [`route:${rule.id}`]: false } });
  assert.equal((await f.request(`/api/routes/${rule.id}`, { command: '[愉快]', description: '研究问题', emoji: '💬' }, 'PATCH')).status, 200);
  assert.equal((await command(f, tg, '[愉快] 新消息')).data.ok, false); assert.equal(f.nativeCalls.length, 0);
  assert.ok(!(await command(f, tg, '/help')).data.reply.includes('[愉快]'));
  await patch(f, tg, { commands: { [`route:${rule.id}`]: true } });
  assert.match((await command(f, tg, '/help')).data.reply, /💬 \[愉快\] 消息内容 研究问题/);
  assert.equal((await command(f, tg, '[愉快] 实际问题')).data.reply, 'AI 回复：实际问题');
  assert.equal((await command(f, tg, '/research 旧指令')).data.ok, false);
  assert.equal((await command(f, wx, '[愉快] 普通文本')).data.reply, 'AI 回复：[愉快] 普通文本');
  assert.equal((await f.request(`/api/routes/${rule.id}`, { command: '/help' }, 'PATCH')).status, 400);
  assert.equal((await f.request('/api/commands/settings', { commands: [{ ...f.app.viewState().commands[0], trigger: '[愉快]' }] }, 'PATCH')).status, 400);
});

test('账户权限分别控制入站、主动发送和每条指令；跨账户隔离；重启保留', async t => {
  const f = await fixture(); t.after(() => f.close()); const { tg, wx } = await accounts(f);
  await f.app.receive(wx, { peerId: 'wx-owner', text: '/help', contextToken: 'private-context' });
  const recipient = f.app.viewState().recipients.find(r => r.botId === tg.id);
  await f.request(`/api/recipients/${recipient.id}`, { aiEnabled: true }, 'PATCH');
  await patch(f, tg, { forwardMessages: false, sendMessages: false, commands: { switch: false, pause: false } });
  assert.equal((await command(f, tg, '问题')).data.ok, false); assert.equal(f.nativeCalls.length, 0);
  assert.equal((await command(f, wx, '问题')).data.reply, 'AI 回复：问题');
  assert.equal((await f.request('/api/commands', { botId: tg.id, action: 'switch', argument: f.app.viewState().sessions[0].id })).data.ok, false);
  const help = (await command(f, tg, '/help')).data.reply; assert.ok(!help.includes('/switch')); assert.ok(!help.includes('/pause'));
  const send = await f.request('/api/messages/send', { recipientId: recipient.id, text: '不能发送', requestId: crypto.randomUUID() });
  assert.equal(send.status, 409); assert.match(send.data.error, /关闭接收/);
  const privateKey = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'ai-endpoint.json'))).token;
  assert.equal((await f.request('/api/ai/send', { recipientId: recipient.id, text: '不能发送', requestId: crypto.randomUUID() }, 'POST', { Authorization: `Bearer ${privateKey}` })).status, 409);
  await patch(f, tg, { sendMessages: true });
  assert.equal((await f.request('/api/messages/send', { recipientId: recipient.id, text: '允许主动发', requestId: crypto.randomUUID() })).status, 200);
  assert.equal((await command(f, tg, '入站仍关闭')).data.ok, false);
  const helpCommand = f.app.viewState().commands.find(item => item.id === 'help');
  await f.request('/api/commands/settings', { commands: [{ ...helpCommand, trigger: '/帮助', description: '显示账户指令', emoji: '[微笑]' }] }, 'PATCH');
  const malformed = await f.request(`/api/bots/${tg.id}`, { permissions: { forwardMessages: true }, allowedPeers: [123] }, 'PATCH');
  assert.equal(malformed.status, 400); assert.equal(f.app.viewState().bots.find(b => b.id === tg.id).permissions.forwardMessages, false);
  const copy = path.join(f.dataDir, 'restart'); fs.mkdirSync(copy);
  for (const file of ['state.json', 'secrets.json']) fs.copyFileSync(path.join(f.dataDir, file), path.join(copy, file));
  const restored = createApp({ dataDir: copy, workers: false, native: f.native });
  const saved = restored.viewState().bots.find(b => b.id === tg.id);
  assert.equal(saved.permissions.forwardMessages, false); assert.equal(saved.permissions.sendMessages, true); assert.equal(saved.permissions.commands.switch, false);
  assert.match((await restored.commandForBot(saved, '/帮助')).reply, /\[微笑\] \/帮助 显示账户指令/);
  await restored.close();
});

test('截图默认拒绝、未授权聊天忽略；开启后 TG sendPhoto 和微信加密 CDN 回传到原聊天', async t => {
  const f = await fixture(); t.after(() => f.close()); const { tg, wx } = await accounts(f);
  await f.app.receive(wx, { peerId: 'stranger', text: '/screenshot', contextToken: 'evil' });
  await f.app.receive(wx, { peerId: 'wx-owner', text: '/screenshot', contextToken: 'private-context' });
  assert.equal(f.screenshotCalls.length, 0); assert.match(f.sent.at(-1).text, /未获准/);
  for (const bot of [tg, wx]) {
    await patch(f, bot, { screenshot: true });
    await f.app.receive(f.app.viewState().bots.find(b => b.id === bot.id), { peerId: bot.platform === 'wechat' ? 'wx-owner' : 'tg-owner', text: '/screenshot', contextToken: 'private-context' });
  }
  assert.equal(f.screenshotCalls.length, 2);
  const photo = f.calls.find(c => c.path.endsWith('sendPhoto'));
  assert.match(photo.headers['content-type'], /multipart\/form-data/); assert.match(photo.bytes.toString(), /tg-owner/); assert.ok(photo.bytes.includes(f.screenshot));
  const upload = f.calls.find(c => c.path.endsWith('getuploadurl'));
  const cdn = f.calls.find(c => c.path === '/c2c/upload'); assert.equal(cdn.headers.authorization, undefined);
  assert.equal(upload.body.to_user_id, 'wx-owner'); assert.equal(upload.body.rawsize, f.screenshot.length);
  const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from(upload.body.aeskey, 'hex'), null);
  assert.deepEqual(Buffer.concat([decipher.update(cdn.bytes), decipher.final()]), f.screenshot);
  const image = f.sent.find(c => c.image && c.platform === 'wechat');
  assert.equal(image.peer, 'wx-owner'); assert.equal(image.contextToken, 'private-context');
  assert.equal(Buffer.from(image.image.media.aes_key, 'base64').toString(), upload.body.aeskey);
  assert.equal(image.image.media.encrypt_query_param, 'test-download-param');
  assert.ok(!JSON.stringify(f.app.viewState()).includes(f.screenshot.toString('base64')));
});

test('截图过程中撤销权限不会发出；系统权限错误回传文字；微信上传地址拒绝外部域名', async t => {
  const f = await fixture(); t.after(() => f.close()); const { wx } = await accounts(f);
  await patch(f, wx, { screenshot: true });
  const live = f.app.viewState().bots.find(b => b.id === wx.id);
  let finish; f.native.screenshot = () => new Promise(resolve => { finish = resolve; });
  const pending = f.app.receive(live, { peerId: 'wx-owner', text: '/screenshot', contextToken: 'ctx' });
  await new Promise(resolve => setImmediate(resolve)); assert.ok(finish);
  await patch(f, wx, { screenshot: false }); finish(f.screenshot); await pending;
  assert.equal(f.sent.filter(x => x.image).length, 0); assert.equal(f.calls.filter(x => x.path.endsWith('getuploadurl')).length, 0);
  await patch(f, wx, { screenshot: true });
  f.native.screenshot = async () => { throw new Error('请允许屏幕录制'); };
  await f.app.receive(f.app.viewState().bots.find(b => b.id === wx.id), { peerId: 'wx-owner', text: '/screenshot', contextToken: 'ctx' });
  assert.match(f.sent.at(-1).text, /请允许屏幕录制/);
  let count = 0;
  const adapters = createAdapters({ fetchImpl: async () => { count++; return Response.json({ upload_full_url: 'https://evil.example/upload' }); } });
  await assert.rejects(adapters.sendImage({ platform: 'wechat' }, { token: 'secret' }, { peerId: 'wx-owner', contextToken: 'ctx' }, f.screenshot), /不受信任/);
  assert.equal(count, 1);
});
