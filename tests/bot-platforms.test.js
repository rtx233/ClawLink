const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture, FEISHU, DISCORD_TOKEN, until } = require('./helpers');
const { createApp } = require('../server');
const { createClient } = require('../server/ai-client');
const { createBotPlatforms, feishuEvent, discordEvent } = require('../server/bot-platforms');

const secondFeishu = { appId: 'cli_abcdef1234567890', appSecret: 'second-private-app-secret' };
const secondDiscord = 'discord-private-test-token-second-account';
const fsMessage = (text, id = randomUUID(), group = false) => ({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } }, message: { message_id: id, chat_id: 'same-peer', chat_type: group ? 'group' : 'p2p', message_type: 'text', content: JSON.stringify({ text }), create_time: String(Date.now()), mentions: [] } });
const dcMessage = (text, id = randomUUID(), group = false) => ({ id, channelId: 'same-peer', author: { id: '987654321', bot: false }, content: text, guildId: group ? 'guild-id' : null, createdTimestamp: Date.now() });
const ready = stream => stream.platform === 'feishu' ? stream.options.onReady() : stream.emit('clientReady');
async function emit(stream, message) {
  if (stream.platform === 'feishu') await stream.dispatcher.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: randomUUID() }, event: message }, { needCheck: false });
  else stream.emit('messageCreate', message);
}
async function add(f, platform, credentials = platform === 'feishu' ? FEISHU : { token: DISCORD_TOKEN }, target = '') {
  const result = await f.request('/api/bots', { platform, name: platform, target, ...credentials });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.bot;
}
function secrets(f) { return JSON.parse(fs.readFileSync(path.join(f.dataDir, 'secrets.json'))); }

test('飞书 / Discord 验证凭据、拒绝重复身份，API 不返回 Token 或 App Secret', async t => {
  const f = await fixture(); t.after(() => f.close());
  for (const body of [{ platform: 'feishu', appId: 'bad', appSecret: FEISHU.appSecret }, { platform: 'discord', token: 'bad' }, { platform: '__proto__' }]) assert.equal((await f.request('/api/bots', { name: 'bad', ...body })).status, 400);
  f.setPlatformFailure(401);
  const invalid = await f.request('/api/bots', { name: 'bad', platform: 'feishu', ...FEISHU });
  assert.equal(invalid.status, 400); assert.ok(!JSON.stringify(invalid.data).includes(FEISHU.appSecret));
  assert.equal(f.app.viewState().bots.length, 0);
  f.setPlatformFailure(0);
  for (const platform of ['feishu', 'discord']) {
    const bot = await add(f, platform); assert.equal(bot.configured, true); assert.equal(bot.status, 'online');
    const duplicate = await f.request('/api/bots', { name: 'duplicate', platform, ...(platform === 'feishu' ? FEISHU : { token: DISCORD_TOKEN }) });
    assert.equal(duplicate.status, 400); assert.match(duplicate.data.error, /已连接/);
    const invalidChange = await f.request(`/api/bots/${bot.id}/credentials`, { token: 'bad', appId: 'bad' });
    assert.equal(invalidChange.status, 400); assert.equal(f.app.viewState().bots.find(x => x.id === bot.id).configured, true);
  }
  const state = JSON.stringify((await f.request('/api/state')).data);
  for (const value of [FEISHU.appSecret, FEISHU.appId, DISCORD_TOKEN, 'fs-access-']) assert.ok(!state.includes(value));
  assert.equal(secrets(f)[f.app.viewState().bots[0].id].appSecret, FEISHU.appSecret);
});

test('长连接仅在 ready 后在线；私聊配对、指令切换、普通转发、去重及机器人身份隔离', async t => {
  const f = await fixture({ workers: true }); t.after(() => f.close());
  const a = await f.session('研究'); const b = await f.session('编程', 'Claude');
  const feishu = await add(f, 'feishu', FEISHU, a.id); const discord = await add(f, 'discord', { token: DISCORD_TOKEN }, a.id);
  const [fsStream, dcStream] = f.streams;
  assert.equal(feishu.status, 'connecting'); assert.equal(discord.status, 'connecting');
  assert.equal(f.app.viewState().service.polling, 2); ready(fsStream); ready(dcStream);
  assert.equal(f.app.viewState().bots[0].status, 'online');
  for (const [bot, stream, factory] of [[feishu, fsStream, fsMessage], [discord, dcStream, dcMessage]]) {
    await emit(stream, factory('未经授权'));
    const groupPair = factory(`/pair ${bot.pairingCode}`, undefined, true);
    if (bot.platform === 'feishu') { groupPair.message.content = JSON.stringify({ text: `@_bot /pair ${bot.pairingCode}` }); groupPair.message.mentions = [{ key: '@_bot', id: { open_id: 'ou_first_bot' } }]; }
    else groupPair.content = `<@123456789012345678> /pair ${bot.pairingCode}`;
    await emit(stream, groupPair);
    assert.deepEqual(f.app.viewState().bots.find(x => x.id === bot.id).peers, []);
    await emit(stream, factory(`/pair ${bot.pairingCode}`));
    await until(() => f.sent.some(x => x.platform === bot.platform && x.text?.includes('配对成功')));
    const paired = f.app.viewState().bots.find(x => x.id === bot.id); assert.deepEqual(paired.peers, ['same-peer']); assert.equal(paired.pairingCode, undefined);
  }
  const recipients = f.app.viewState().recipients; assert.equal(recipients.length, 2); assert.notEqual(recipients[0].id, recipients[1].id);
  await emit(fsStream, fsMessage('/switch 编程'));
  await until(() => f.sent.some(x => x.platform === 'feishu' && x.text?.includes('已切换')));
  const message = fsMessage('独立路由'); await emit(fsStream, message); await emit(fsStream, message);
  await emit(dcStream, dcMessage('默认路由'));
  await until(() => f.nativeCalls.length === 2 && f.sent.filter(x => x.text?.includes('已转发')).length === 2);
  assert.deepEqual(f.nativeCalls.map(x => [x.text, x.binding.bundleId]).sort(), [['独立路由', 'com.anthropic.claudefordesktop'], ['默认路由', 'com.openai.chat']].sort());
  await emit(fsStream, fsMessage('/broadcast')); await until(() => f.sent.some(x => x.text?.includes('下一条普通消息')));
  await emit(fsStream, fsMessage('广播')); await until(() => f.nativeCalls.length === 4);
  await until(() => f.sent.some(x => x.platform === 'feishu' && x.text?.includes('【研究】')));
  const seen = secrets(f)[feishu.id].seen; assert.equal(seen.filter(id => id === message.message.message_id).length, 1);
  assert.equal(f.app.viewState().sessions.find(x => x.id === b.id).status, 'verified');
});

test('事件过滤：群仅响应 @本人，忽略机器人、webhook 和无效载荷，保留其他人的提及', () => {
  const fs = fsMessage('@_bot /sessions @_other', 'id', true);
  fs.message.mentions = [{ key: '@_bot', id: { open_id: 'ou_first_bot' } }, { key: '@_other', id: { open_id: 'ou_other' } }];
  assert.equal(feishuEvent(fs, 'ou_first_bot').text, '/sessions @_other');
  assert.equal(feishuEvent(fs, 'ou_second_bot'), undefined);
  assert.equal(feishuEvent({ ...fs, sender: { sender_type: 'app', sender_id: { open_id: 'ou_app' } } }, 'ou_first_bot'), undefined);
  assert.equal(feishuEvent({ ...fs, message: { ...fs.message, content: 'invalid' } }, 'ou_first_bot'), undefined);
  assert.equal(discordEvent(dcMessage('ordinary', 'id', true), '123456789012345678'), undefined);
  assert.equal(discordEvent(dcMessage('<@!123456789012345678> /switch 研究 <@987654321>', 'id', true), '123456789012345678').text, '/switch 研究 <@987654321>');
  assert.equal(discordEvent({ ...dcMessage('loop'), author: { bot: true } }, '123456789012345678'), undefined);
  assert.equal(discordEvent({ ...dcMessage('loop'), webhookId: 'webhook' }, '123456789012345678'), undefined);
});

test('SDK 启动失败和错误详情不会泄露凭据；接口返回非机器人身份时拒绝连接', async t => {
  const f = await fixture({ workers: true, adapterOptions: { discordClient: () => {
    const { EventEmitter } = require('node:events'); const client = new EventEmitter();
    client.login = async token => { const error = new Error(`private body ${token}`); error.code = 'TokenInvalid'; throw error; };
    client.destroy = async () => {}; return client;
  } } }); t.after(() => f.close());
  const bot = await add(f, 'discord'); await until(() => !f.app.viewState().bots[0].enabled);
  const state = f.app.viewState(); assert.equal(state.bots[0].status, 'expired'); assert.equal(state.service.polling, 0); assert.ok(!JSON.stringify(state).includes(DISCORD_TOKEN));
  assert.equal(state.bots[0].id, bot.id);
  const api = createBotPlatforms({ fetchImpl: async () => ({ ok: true, json: async () => ({ code: 0, tenant_access_token: 'token', expire: 7200, bot: false, id: '123456789', username: 'personal' }) }) });
  await assert.rejects(api.validate('discord', { token: DISCORD_TOKEN }), /不属于/);
  await assert.rejects(api.validate('feishu', FEISHU), /机器人能力/);
});

test('重启后的长连接继续去重，群聊仅在授权且 @机器人时转发', async t => {
  const f = await fixture({ workers: true }); t.after(() => f.close()); const session = await f.session();
  const bot = await add(f, 'feishu', FEISHU, session.id); const first = f.streams[0]; ready(first);
  await f.request(`/api/bots/${bot.id}`, { allowedPeers: ['same-peer'] }, 'PATCH');
  const history = fsMessage('仅一次'); await emit(first, history); await until(() => f.sent.some(x => x.text?.includes('仅一次'))); await f.app.close();
  const restored = createApp({ dataDir: f.dataDir, adapters: f.adapters, native: f.native });
  try {
    const next = f.streams.at(-1); ready(next); await emit(next, history); assert.equal(f.nativeCalls.length, 1);
    await emit(next, fsMessage('群内普通消息', undefined, true));
    const group = fsMessage('@_bot 群内提问', undefined, true); group.message.mentions = [{ key: '@_bot', id: { open_id: 'ou_first_bot' } }];
    await emit(next, group); await until(() => f.nativeCalls.length === 2); assert.equal(f.nativeCalls[1].text, '群内提问');
    await until(() => f.sent.some(x => x.text?.includes('群内提问')));
    assert.equal(f.nativeCalls.length, 2);
  } finally { await restored.close(); }
});

test('新增平台 AI 发送、长文字 Unicode 限制、禁止 Discord 提及、双向权限和截图', async t => {
  const f = await fixture(); t.after(() => f.close()); const target = await f.session(); const client = createClient(f.dataDir);
  for (const platform of ['feishu', 'discord']) {
    const bot = await add(f, platform, undefined, target.id);
    await f.request(`/api/bots/${bot.id}`, { allowedPeers: ['peer'] }, 'PATCH');
    const recipient = f.app.viewState().recipients.find(x => x.botId === bot.id);
    await assert.rejects(client('/api/ai/send', { recipientId: recipient.id, text: '未开启', requestId: randomUUID() }), /未开启/);
    await f.request(`/api/recipients/${recipient.id}`, { aiEnabled: true }, 'PATCH');
    const text = '😀'.repeat(2500) + '@everyone <@12345> 中文';
    const payload = { recipientId: recipient.id, text, requestId: randomUUID() };
    assert.equal((await client('/api/ai/send', payload)).status, 'submitted');
    assert.equal((await client('/api/ai/send', payload)).duplicate, true);
    const sent = f.sent.filter(x => x.platform === platform && x.peer === 'peer'); assert.equal(sent.map(x => x.text).join(''), text);
    if (platform === 'discord') { assert.ok(sent.every(x => x.text.length <= 2000)); assert.ok(f.calls.filter(x => x.path.includes('/channels/') && x.body.content).every(x => x.body.allowed_mentions.parse.length === 0)); }
    else assert.ok(sent.every(x => Buffer.byteLength(x.text) <= 12000));
    const event = { peerId: 'peer', text: '/screenshot' };
    await f.app.receive(bot, event); assert.equal(f.screenshotCalls.length, platform === 'feishu' ? 0 : 1);
    await f.request(`/api/bots/${bot.id}`, { permissions: { screenshot: true } }, 'PATCH');
    await f.app.receive(bot, event); assert.ok(f.sent.some(x => x.platform === platform && x.image));
    await f.request(`/api/bots/${bot.id}`, { permissions: { forwardMessages: false, sendMessages: false } }, 'PATCH');
    await f.app.receive(bot, { peerId: 'peer', text: '不能转发' }); assert.equal(f.nativeCalls.length, 0);
    await assert.rejects(client('/api/ai/send', { ...payload, requestId: randomUUID() }), /关闭接收/);
  }
  assert.equal(f.screenshotCalls.length, 2);
  const imageCalls = f.calls.filter(x => x.path.endsWith('/images')); assert.equal(imageCalls.length, 1); assert.match(imageCalls[0].multipart, /image_type/);
  let allowed = true;
  const adapters = createBotPlatforms({ fetchImpl: async () => { allowed = false; return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'token', expire: 7200, data: { image_key: 'image' } }) }; } });
  await assert.rejects(adapters.sendImage({ platform: 'feishu' }, FEISHU, { peerId: 'peer' }, f.screenshot, { canSend: () => allowed }), /权限已变更/);
});

test('重连 / 停止 / 删除关闭 SDK，过期回调和旧队列不能恢复连接或转发', async t => {
  const f = await fixture({ workers: true }); t.after(() => f.close()); const session = await f.session();
  const bot = await add(f, 'discord', { token: DISCORD_TOKEN }, session.id); const first = f.streams[0]; ready(first);
  await f.request(`/api/bots/${bot.id}`, { allowedPeers: ['same-peer'] }, 'PATCH');
  first.emit('shardDisconnect', { code: 1006 }); assert.equal(f.app.viewState().bots[0].status, 'connecting');
  first.emit('shardResume'); assert.equal(f.app.viewState().bots[0].status, 'online');
  const send = f.native.send; let finish;
  f.native.send = (...args) => new Promise(resolve => { finish = async () => resolve(await send(...args)); });
  await emit(first, dcMessage('正在执行')); await until(() => !!finish); await emit(first, dcMessage('队列旧消息'));
  await f.request(`/api/bots/${bot.id}/stop`, {}); assert.equal(first.closed, true);
  await f.request(`/api/bots/${bot.id}/start`, {}); const second = f.streams[1];
  ready(first); first.emit('error', { code: 4014 }); assert.equal(f.app.viewState().bots[0].status, 'connecting');
  await finish(); await until(() => f.nativeCalls.length === 1); f.native.send = send;
  ready(second); await emit(second, dcMessage('新的连接')); await until(() => f.nativeCalls.length === 2);
  assert.ok(!f.nativeCalls.some(x => x.text === '队列旧消息'));
  assert.ok(!f.sent.some(x => x.text?.includes('正在执行')));
  second.emit('shardDisconnect', { code: 4014 });
  assert.equal(second.closed, true); assert.equal(f.app.viewState().bots[0].enabled, false); assert.match(f.app.viewState().bots[0].error, /Message Content Intent/);
  await f.request(`/api/bots/${bot.id}/start`, {}); const third = f.streams[2];
  await f.request(`/api/bots/${bot.id}`, {}, 'DELETE'); ready(third); assert.equal(third.closed, true); assert.equal(f.app.viewState().bots.length, 0); assert.equal(f.app.viewState().service.polling, 0);
  const fsBot = await add(f, 'feishu'); const fsStream = f.streams[3]; ready(fsStream); fsStream.options.onReconnecting(); assert.equal(f.app.viewState().bots[0].status, 'connecting'); fsStream.options.onReconnected(); assert.equal(f.app.viewState().bots[0].status, 'online');
  await f.app.close(); assert.equal(fsStream.closed, true); ready(fsStream); assert.equal(f.app.viewState().bots[0].id, fsBot.id);
});

test('同身份更换凭据保留授权和去重；换机器人撤销聊天与路由；重启不重复发历史消息', async t => {
  const f = await fixture({ workers: true }); t.after(() => f.close()); const session = await f.session();
  for (const [platform, fields, other] of [['feishu', FEISHU, secondFeishu], ['discord', { token: DISCORD_TOKEN }, { token: secondDiscord }]]) {
    const bot = await add(f, platform, fields, session.id); const first = f.streams.at(-1); ready(first);
    await f.request(`/api/bots/${bot.id}`, { allowedPeers: ['same-peer'] }, 'PATCH');
    const message = platform === 'feishu' ? fsMessage('一次') : dcMessage('一次');
    await emit(first, message); await until(() => f.sent.some(x => x.platform === platform && x.text?.includes('AI 回复')));
    await f.request('/api/commands', { botId: bot.id, peerId: 'same-peer', text: `/switch ${session.name}` });
    const before = f.nativeCalls.length; const seen = secrets(f)[bot.id].seen;
    assert.equal((await f.request(`/api/bots/${bot.id}/credentials`, fields)).data.authorizationReset, false); assert.equal(first.closed, true);
    const next = f.streams.at(-1); ready(next); await emit(next, message);
    assert.deepEqual(secrets(f)[bot.id].seen, seen); assert.equal(f.nativeCalls.length, before);
    assert.deepEqual(f.app.viewState().bots.find(x => x.id === bot.id).peers, ['same-peer']);
    assert.equal((await f.request(`/api/bots/${bot.id}/credentials`, other)).data.authorizationReset, true);
    assert.deepEqual(f.app.viewState().bots.find(x => x.id === bot.id).peers, []);
    assert.ok(!f.app.viewState().recipients.some(x => x.botId === bot.id));
    assert.ok(!Object.keys(f.app.viewState().peerRoutes).some(key => JSON.parse(key)[0] === bot.id));
    assert.ok(f.app.viewState().bots.find(x => x.id === bot.id).pairingCode);
  }
  await f.app.close();
  const restored = createApp({ dataDir: f.dataDir, workers: true, adapters: f.adapters, native: f.native });
  try {
    assert.equal(restored.viewState().bots.length, 2); assert.equal(restored.viewState().service.polling, 2);
    assert.ok(restored.viewState().bots.every(x => x.configured && x.status === 'connecting'));
    for (const stream of f.streams.slice(-2)) ready(stream);
    assert.ok(restored.viewState().bots.every(x => x.status === 'online'));
  } finally { await restored.close(); }
});
