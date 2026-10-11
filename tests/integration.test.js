const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { fixture, TOKEN, until } = require('./helpers');
const { createApp } = require('../server');

test('真实协议扫码、验证码、凭据隔离及私有数据权限', async t => {
  const f = await fixture(); t.after(() => f.close());
  const created = await f.request('/api/bots', { platform: 'wechat', name: '工作微信' });
  assert.equal(created.status, 201); const bot = created.data.bot;
  assert.equal(bot.pairingCode, undefined);
  const qr = await f.request(`/api/bots/${bot.id}/login/start`, {});
  assert.match(qr.data.qrImage, /^data:image\/png;base64,/);
  const qrRequest = f.calls.find(x => x.path.endsWith('get_bot_qrcode'));
  assert.deepEqual(qrRequest.body.local_token_list, []); assert.equal(qrRequest.query.bot_type, '3');
  assert.equal(qrRequest.headers['ilink-app-id'], 'bot');
  f.setQrStatus('need_verifycode');
  assert.equal((await f.request(`/api/bots/${bot.id}/login/poll`, { loginId: qr.data.loginId })).data.status, 'need_verifycode');
  f.setQrStatus('confirmed');
  const result = await f.request(`/api/bots/${bot.id}/login/poll`, { loginId: qr.data.loginId, verifyCode: '123456' });
  assert.equal(result.data.status, 'confirmed');
  assert.equal(result.data.welcomeSent, true);
  const qrPoll = f.calls.filter(x => x.path.endsWith('get_qrcode_status')).at(-1);
  assert.equal(qrPoll.query.verify_code, '123456');
  assert.ok(f.sent.some(x => x.platform === 'wechat' && x.peer === 'wx-owner' && x.text.includes('自动授权') && !x.text.includes('/pair')));
  const state = await f.request('/api/state');
  assert.equal(state.data.bots[0].configured, true);
  assert.deepEqual(state.data.bots[0].peers, ['wx-owner']);
  assert.equal(state.data.bots[0].pairingCode, undefined);
  const recipient = state.data.recipients.find(item => item.botId === bot.id);
  assert.equal(recipient.peerId, 'wx-owner');
  assert.equal(recipient.aiEnabled, false);
  assert.equal(recipient.ready, false);
  assert.equal((await f.request(`/api/bots/${bot.id}/pairing`, {})).status, 400);
  assert.ok(!JSON.stringify(state.data).includes('wx-private-test-token'));
  if (process.platform !== 'win32') assert.equal((fs.statSync(path.join(f.dataDir, 'secrets.json')).mode & 0o777), 0o600);
  assert.equal((await f.request('/server/data/secrets.json')).status, 404);
  assert.equal((await f.request('/native/ClawLinkBridge.swift')).status, 404);
  assert.equal((await f.request('/api/commands', { botId: bot.id, text: '/route' }, 'POST', { Origin: 'https://evil.test' })).status, 403);
  for (const host of ['evil.test', '[evil.test]:4173', 'localhost@evil.test', '127.0.0.1.evil.test']) {
    const hostStatus = await new Promise(resolve => {
      http.get(`${f.origin}/api/state`, { headers: { Host: host } }, response => { response.resume(); resolve(response.statusCode); });
    });
    assert.equal(hostStatus, 403);
  }
  await f.request('/api/bots', { platform: 'telegram', name: 'TG', token: TOKEN });
  const second = (await f.request('/api/bots', { platform: 'wechat', name: '第二微信' })).data.bot;
  await f.request(`/api/bots/${second.id}/login/start`, {});
  const nextQr = f.calls.filter(x => x.path.endsWith('get_bot_qrcode')).at(-1);
  assert.deepEqual(nextQr.body.local_token_list, ['wx-private-test-token']);
  assert.ok(!JSON.stringify(nextQr.body).includes(TOKEN), 'Telegram Token 不得传给微信服务');
});

test('微信缺少扫码本人身份时拒绝登录；欢迎消息失败不影响自动授权', async t => {
  const f = await fixture(); t.after(() => f.close());
  const bot = (await f.request('/api/bots', { platform: 'wechat', name: '微信' })).data.bot;
  const qr = (await f.request(`/api/bots/${bot.id}/login/start`, {})).data;
  f.setQrOwner('');
  const invalid = await f.request(`/api/bots/${bot.id}/login/poll`, { loginId: qr.loginId });
  assert.equal(invalid.status, 400); assert.match(invalid.data.error, /无法确认扫码账号/);
  assert.equal(f.app.viewState().bots[0].configured, false);
  assert.deepEqual(f.app.viewState().bots[0].peers, []); assert.equal(f.sent.length, 0);
  f.setQrOwner('wx-owner'); f.setSendFailure(true);
  const confirmed = await f.request(`/api/bots/${bot.id}/login/poll`, { loginId: qr.loginId });
  assert.equal(confirmed.data.status, 'confirmed'); assert.equal(confirmed.data.welcomeSent, false);
  assert.deepEqual(confirmed.data.bot.peers, ['wx-owner']);
  assert.equal(confirmed.data.bot.status, 'online');
  assert.equal(f.app.viewState().recipients[0].peerId, 'wx-owner');
});

test('旧微信登录自动迁移本人，保留设置；手动撤销后重启不会恢复授权', async t => {
  const f = await fixture(); t.after(() => f.close()); const session = await f.session();
  const wx = (await f.request('/api/bots', { platform: 'wechat', name: '微信', target: session.id })).data.bot;
  const qr = (await f.request(`/api/bots/${wx.id}/login/start`, {})).data;
  await f.request(`/api/bots/${wx.id}/login/poll`, { loginId: qr.loginId });
  const tg = (await f.request('/api/bots', { platform: 'telegram', name: 'TG', token: TOKEN })).data.bot;
  await f.request(`/api/bots/${wx.id}`, { allowedPeers: ['wx-extra'] }, 'PATCH');
  const extra = f.app.viewState().recipients[0];
  await f.request(`/api/recipients/${extra.id}`, { name: '保留的微信', aiEnabled: true }, 'PATCH');
  const state = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'state.json')));
  const secrets = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'secrets.json')));
  delete secrets[wx.id].ownerAutoAuthorized;
  secrets[wx.id].pairingCode = 'legacy-code';
  secrets[wx.id].peerContexts['wx-extra'] = { contextToken: 'extra-context' };
  const legacyDir = path.join(f.dataDir, 'legacy'); fs.mkdirSync(legacyDir);
  const secretFile = path.join(legacyDir, 'secrets.json');
  fs.writeFileSync(path.join(legacyDir, 'state.json'), JSON.stringify(state));
  fs.writeFileSync(secretFile, JSON.stringify(secrets));
  // No poll or welcome message is sent by the migration.
  const sent = []; const adapters = { send: async (...args) => { sent.push(args); } };
  const migrated = createApp({ dataDir: legacyDir, workers: false, native: f.native, adapters });
  try {
    const view = migrated.viewState();
    assert.deepEqual(view.bots.find(bot => bot.id === wx.id).peers, ['wx-extra', 'wx-owner']);
    assert.equal(view.bots.find(bot => bot.id === wx.id).pairingCode, undefined);
    assert.equal(view.bots.find(bot => bot.id === tg.id).pairingCode, tg.pairingCode);
    assert.deepEqual(view.sessions.map(({ users, ...session }) => session), state.sessions);
    assert.deepEqual(view.routes, state.routes);
    assert.equal(view.recipients.find(item => item.id === extra.id).name, '保留的微信');
    assert.equal(view.recipients.find(item => item.id === extra.id).aiEnabled, true);
    assert.equal(view.recipients.find(item => item.peerId === 'wx-owner').aiEnabled, false);
    const saved = JSON.parse(fs.readFileSync(secretFile));
    assert.equal(saved[wx.id].token, secrets[wx.id].token);
    assert.equal(saved[wx.id].peerContexts['wx-extra'].contextToken, 'extra-context');
    assert.equal(saved[wx.id].pairingCode, undefined);
    await migrated.receive(view.bots.find(bot => bot.id === wx.id), { peerId: 'wx-stranger', text: '/pair legacy-code' });
    assert.equal(sent.length, 0);
  } finally { await migrated.close(); }
  const revoked = JSON.parse(fs.readFileSync(secretFile));
  revoked[wx.id].allowedPeers = ['wx-extra']; fs.writeFileSync(secretFile, JSON.stringify(revoked));
  const restarted = createApp({ dataDir: legacyDir, workers: false, native: f.native, adapters });
  try {
    assert.deepEqual(restarted.viewState().bots.find(bot => bot.id === wx.id).peers, ['wx-extra']);
    assert.ok(!restarted.viewState().recipients.some(item => item.peerId === 'wx-owner'));
    await restarted.receive(restarted.viewState().bots.find(bot => bot.id === wx.id), { peerId: 'wx-owner', text: '已撤销' });
    assert.equal(sent.length, 0);
  } finally { await restarted.close(); }
});

test('重新扫码失败后停止旧接收，保留凭据并允许恢复', async t => {
  const f = await fixture(); t.after(() => f.close());
  const bot = (await f.request('/api/bots', { platform: 'wechat', name: '微信' })).data.bot;
  const qr = (await f.request(`/api/bots/${bot.id}/login/start`, {})).data;
  await f.request(`/api/bots/${bot.id}/login/poll`, { loginId: qr.loginId });
  f.setQrFailure(true);
  assert.equal((await f.request(`/api/bots/${bot.id}/login/start`, {})).status, 400);
  const state = (await f.request('/api/state')).data.bots[0];
  assert.equal(state.status, 'error'); assert.equal(state.enabled, false); assert.equal(state.configured, true);
  assert.match(state.error, /二维码请求失败/);
  assert.equal((await f.request(`/api/bots/${bot.id}/login/poll`, { loginId: qr.loginId })).status, 400);
  assert.equal((await f.request(`/api/bots/${bot.id}/start`, {})).status, 200);
});

test('扫码过期不会把机器人标记为在线；拒绝过期登录 ID', async t => {
  const f = await fixture(); t.after(() => f.close());
  const bot = (await f.request('/api/bots', { platform: 'wechat', name: '微信' })).data.bot;
  const qr = (await f.request(`/api/bots/${bot.id}/login/start`, {})).data;
  assert.equal((await f.request(`/api/bots/${bot.id}/login/poll`, { loginId: 'wrong' })).status, 400);
  f.setQrStatus('expired');
  assert.equal((await f.request(`/api/bots/${bot.id}/login/poll`, { loginId: qr.loginId })).data.status, 'expired');
  assert.equal((await f.request('/api/state')).data.bots[0].status, 'expired');
  assert.equal((await f.request(`/api/bots/${bot.id}/start`, {})).status, 400);
});

test('Telegram Token 验证失败或已使用 webhook 时不创建机器人', async t => {
  const f = await fixture(); t.after(() => f.close());
  assert.equal((await f.request('/api/bots', { platform: 'telegram', name: 'TG', token: 'bad' })).status, 400);
  f.setWebhook('https://existing.test/hook');
  assert.equal((await f.request('/api/bots', { platform: 'telegram', name: 'TG', token: TOKEN })).status, 400);
  assert.equal((await f.request('/api/state')).data.bots.length, 0);
});

test('多机器人共享会话、聊天独立切换、精准指令及单次广播', async t => {
  const f = await fixture(); t.after(() => f.close());
  const a = await f.session('研究'); const b = await f.session('编程', 'Claude');
  const bot = (await f.request('/api/bots', { platform: 'telegram', name: 'TG', token: TOKEN, target: a.id })).data.bot;
  await f.request(`/api/bots/${bot.id}`, { allowedPeers: ['100', '200'] }, 'PATCH');
  const command = (text, peerId = '100') => f.request('/api/commands', { botId: bot.id, peerId, text });
  assert.equal((await command('/switch 编程')).data.ok, true);
  assert.equal((await command('你好')).data.reply, 'AI 回复：你好');
  assert.equal(f.nativeCalls.at(-1).binding.bundleId, 'com.anthropic.claudefordesktop');
  await command('其他人', '200'); assert.equal(f.nativeCalls.at(-1).binding.bundleId, 'com.openai.chat');
  assert.equal((await command('/switch 未知')).data.ok, false);
  const wx = (await f.request('/api/bots', { platform: 'wechat', name: '另一微信', target: a.id })).data.bot;
  await f.request('/api/commands', { botId: wx.id, text: '同一会话' }); assert.equal(f.nativeCalls.at(-1).binding.bundleId, 'com.openai.chat');
  await f.request('/api/routes', { bot: bot.id, command: '/research', target: a.id });
  const count = f.nativeCalls.length;
  assert.equal((await command('/researcher 没有匹配')).data.ok, false); assert.equal(f.nativeCalls.length, count);
  await command('/research 只发送内容'); assert.equal(f.nativeCalls.at(-1).text, '只发送内容');
  await command('/pause'); assert.equal((await command('暂停消息')).data.ok, false);
  await command('/resume'); await command('/broadcast'); const before = f.nativeCalls.length;
  await command('/research 保持广播待命'); assert.equal(f.nativeCalls.length, before + 1);
  await command('广播'); assert.equal(f.nativeCalls.length, before + 3);
  await command('单条'); assert.equal(f.nativeCalls.length, before + 4);
  assert.equal((await command('未授权', '999')).status, 400);
  // A default broadcast applies to the next chat without an individual override.
  await f.request(`/api/bots/${bot.id}`, { allowedPeers: ['100', '200', '300'] }, 'PATCH');
  await command('/broadcast', ''); const global = f.nativeCalls.length;
  await command('默认广播', '300'); await command('默认单条', '300'); assert.equal(f.nativeCalls.length, global + 3);
});

test('Codex、Paseo 和自定义 Bundle ID 可以作为原生路由目标', async t => {
  const f = await fixture(); t.after(() => f.close());
  for (const [name, provider, bundleId] of [['Codex 对话', 'Codex', 'com.openai.codex'], ['Paseo 对话', 'Paseo', 'sh.paseo.desktop'], ['其它应用', '自定义客户端', 'com.example.client']]) {
    const created = await f.request('/api/sessions', { name, provider, bundleId });
    assert.equal(created.status, 201);
    assert.equal(created.data.session.bundleId, bundleId);
    const binding = { bundleId, windowTitle: name, markerPath: '0', markerText: 'unique-marker', inputPath: '1', replyPath: '2', sendPath: '3' };
    const bound = await f.request('/api/native/bind', { sessionId: created.data.session.id, binding });
    assert.equal(bound.status, 200);
    assert.equal(bound.data.session.binding.bundleId, bundleId);
  }
  assert.equal((await f.request('/api/sessions', { name: '无效', targetType: 'native', provider: 'PI', bundleId: 'not a bundle id' })).status, 400);
});

test('入站微信完整链路：扫码授权本人、忽略陌生人、/switch、上下文回复', async t => {
  const f = await fixture(); t.after(() => f.close()); const s = await f.session();
  const bot = (await f.request('/api/bots', { platform: 'wechat', name: '微信', target: s.id })).data.bot;
  const qr = (await f.request(`/api/bots/${bot.id}/login/start`, {})).data;
  await f.request(`/api/bots/${bot.id}/login/poll`, { loginId: qr.loginId });
  const internal = f.app.viewState().bots[0];
  const event = (text, peerId = 'wx-owner') => ({ peerId, text, contextToken: 'context-1', id: text });
  const before = f.sent.length;
  await f.app.receive(internal, event('未授权消息', 'wx-stranger'));
  await f.app.receive(internal, event('/pair old-code', 'wx-stranger'));
  assert.equal(f.nativeCalls.length, 0); assert.equal(f.sent.length, before);
  assert.deepEqual(f.app.viewState().bots[0].peers, ['wx-owner']);
  await f.app.receive(internal, event(`/switch ${s.name}`));
  await f.app.receive(internal, event('你好微信'));
  assert.equal(f.nativeCalls.at(-1).text, '你好微信');
  assert.equal(f.sent.at(-1).text, 'AI 回复：你好微信');
  assert.equal(f.sent.at(-1).contextToken, 'context-1');
  assert.equal(f.app.viewState().recipients.find(item => item.botId === bot.id).ready, true);
  const wxSend = f.calls.find(x => x.path.endsWith('sendmessage'));
  assert.equal(wxSend.headers.authorization, 'Bearer wx-private-test-token');
  assert.equal(wxSend.body.msg.message_type, 2); assert.equal(wxSend.body.msg.message_state, 2);
  const exposed = JSON.stringify((await f.request('/api/state')).data);
  assert.ok(!exposed.includes('context-1')); assert.ok(!exposed.includes('wx-private-test-token'));
});

test('Telegram 长轮询接收、去重、回复及停止恢复', async t => {
  const f = await fixture({ workers: true }); t.after(() => f.close()); const s = await f.session();
  const bot = (await f.request('/api/bots', { platform: 'telegram', name: 'TG', token: TOKEN, target: s.id })).data.bot;
  await f.app.receive(bot, { peerId: '42', text: '配对前不转发', id: 'before-pair' });
  assert.equal(f.nativeCalls.length, 0); assert.equal(f.sent.length, 0);
  const update = (id, text) => ({ update_id: id, message: { chat: { id: 42, type: 'private' }, from: { id: 42 }, date: Math.floor(Date.now() / 1000), text } });
  f.tgUpdates.push(update(1, `/pair ${bot.pairingCode}`), update(2, '真实入站'));
  await until(() => f.sent.some(x => x.text === 'AI 回复：真实入站'));
  assert.equal(f.nativeCalls.length, 1);
  f.tgUpdates.push(update(2, '真实入站')); await until(() => f.tgUpdates.length === 0);
  assert.equal(f.nativeCalls.length, 1);
  assert.ok(f.calls.some(x => x.path.endsWith('getUpdates') && x.body.offset === 3));
  await f.request(`/api/bots/${bot.id}/stop`, {});
  assert.equal((await f.request('/api/state')).data.bots[0].status, 'stopped');
  await f.request(`/api/bots/${bot.id}/start`, {}); await until(() => f.app.viewState().bots[0].status === 'online');
  f.setUpdateFailure(401); await until(() => f.app.viewState().bots[0].status === 'expired');
  assert.equal(f.app.viewState().bots[0].enabled, false);
});

test('错误会话或失效绑定拒绝发送，并将失败返回机器人', async t => {
  const f = await fixture(); t.after(() => f.close()); const s = await f.session();
  const wrong = await f.request('/api/native/bind', { sessionId: s.id, binding: { ...s.binding, markerText: 'wrong' } }); assert.equal(wrong.status, 400);
  const missingButton = await f.request('/api/native/bind', { sessionId: s.id, binding: { ...s.binding, sendPath: '' } }); assert.equal(missingButton.status, 400);
  const genericMarker = await f.request('/api/native/bind', { sessionId: s.id, binding: { ...s.binding, markerText: 'ChatGPT' } }); assert.equal(genericMarker.status, 400);
  const sidebarMarker = await f.request('/api/native/bind', { sessionId: s.id, binding: { ...s.binding, navigationPath: '0' } }); assert.equal(sidebarMarker.status, 400);
  const bot = (await f.request('/api/bots', { platform: 'telegram', name: 'TG', token: TOKEN, target: s.id })).data.bot;
  await f.request(`/api/bots/${bot.id}`, { allowedPeers: ['42'] }, 'PATCH');
  f.setNativeFailure('当前会话与绑定标识不符');
  await f.app.receive(f.app.viewState().bots[0], { peerId: '42', text: '不能发错', id: '3' });
  assert.equal(f.nativeCalls.length, 0); assert.match(f.sent.at(-1).text, /当前会话与绑定标识不符/);
  assert.equal((await f.request('/api/state')).data.sessions[0].status, 'error');
});

test('状态重启后保留；损坏状态不会被静默覆盖', async t => {
  const f = await fixture(); t.after(() => f.close()); const session = await f.session();
  const restarted = createApp({ dataDir: f.dataDir, workers: false, native: f.native });
  assert.equal(restarted.viewState().sessions[0].id, session.id); await restarted.close();
  const corruptDir = path.join(f.dataDir, 'corrupt'); fs.mkdirSync(corruptDir); fs.writeFileSync(path.join(corruptDir, 'state.json'), '{bad');
  assert.throws(() => createApp({ dataDir: corruptDir }), /无法读取/);
  assert.equal(fs.readFileSync(path.join(corruptDir, 'state.json'), 'utf8'), '{bad');
});

test('删除规则后稳定 ID 仍修改原规则；过期 ID 不会影响相邻规则', async t => {
  const f = await fixture(); t.after(() => f.close()); const a = await f.session('会话甲'); const b = await f.session('会话乙');
  const bot = (await f.request('/api/bots', { platform: 'wechat', name: '微信' })).data.bot;
  const first = (await f.request('/api/routes', { bot: bot.id, command: '/first', target: a.id })).data.route;
  const second = (await f.request('/api/routes', { bot: bot.id, command: '/second', target: a.id })).data.route;
  assert.ok(first.id); assert.notEqual(first.id, second.id);
  assert.equal((await f.request(`/api/routes/${first.id}`, {}, 'DELETE')).status, 200);
  assert.equal((await f.request(`/api/routes/${second.id}`, { target: b.id }, 'PATCH')).status, 200);
  assert.equal((await f.request(`/api/routes/${first.id}`, { on: false }, 'PATCH')).status, 404);
  const route = (await f.request('/api/state')).data.routes.find(x => x.id === second.id);
  assert.equal(route.command, '/second'); assert.equal(route.target, b.id); assert.equal(route.on, true);
});
