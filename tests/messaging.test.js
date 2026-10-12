const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { fixture, TOKEN } = require('./helpers');
const { createApp } = require('../server');
const { createClient } = require('../server/ai-client');
const { createMessaging } = require('../server/messaging');

async function telegram(f, name = '我的 TG', peerIds = ['101', '202'], token = TOKEN) {
  const created = await f.request('/api/bots', { platform: 'telegram', name, token });
  assert.equal(created.status, 201);
  const bot = created.data.bot;
  await f.request(`/api/bots/${bot.id}`, { allowedPeers: peerIds }, 'PATCH');
  return bot;
}
async function wechat(f) {
  const bot = (await f.request('/api/bots', { platform: 'wechat', name: '我的微信' })).data.bot;
  const qr = (await f.request(`/api/bots/${bot.id}/login/start`, {})).data;
  assert.equal((await f.request(`/api/bots/${bot.id}/login/poll`, { loginId: qr.loginId })).status, 200);
  return bot;
}
async function enable(f, botId, peerId, name) {
  const item = (await f.request('/api/state')).data.recipients.find(recipient => recipient.botId === botId && recipient.peerId === peerId);
  assert.ok(item);
  const result = await f.request(`/api/recipients/${item.id}`, { name, aiEnabled: true }, 'PATCH');
  assert.equal(result.status, 200);
  return result.data.recipient;
}
function sendRequest(recipientId, text = '任务已完成') { return { recipientId, text, requestId: randomUUID() }; }
async function cli(f, args, input = '') {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../server/ai-client.js'), ...args, '--data-dir', f.dataDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr })); });
  child.stdin.end(input);
  return done;
}

test('AI 选择不同 TG 机器人 / 微信收件人，凭据和上下文不暴露', async t => {
  const f = await fixture(); t.after(() => f.close());
  const a = await telegram(f); const b = await telegram(f, '第二 TG', ['101'], TOKEN.replace('123456:', '654321:'));
  const wx = await wechat(f);
  const client = createClient(f.dataDir);
  assert.equal((await f.request('/api/ai/recipients')).status, 401);
  assert.deepEqual((await client('/api/ai/recipients')).recipients, []);
  const first = await enable(f, a.id, '101', '工作 TG');
  const second = await enable(f, b.id, '101', '私人 TG');
  assert.notEqual(first.id, second.id);
  const internal = f.app.viewState().bots.find(bot => bot.id === wx.id);
  await f.app.receive(internal, { id: 'owner-hello', peerId: 'wx-owner', text: '/help', contextToken: 'wx-context-one' });
  await f.request(`/api/bots/${wx.id}`, { allowedPeers: ['wx-owner', 'wx-two'] }, 'PATCH');
  await f.app.receive(internal, { id: 'hello', peerId: 'wx-two', text: '/help', contextToken: 'wx-context-two' });
  const wxOne = await enable(f, wx.id, 'wx-owner', '工作微信'); const wxTwo = await enable(f, wx.id, 'wx-two', '私人微信');
  const selected = (await client('/api/ai/recipients')).recipients;
  assert.equal(selected.length, 4);
  assert.ok(selected.every(item => item.ready));
  for (const item of [first, second, wxOne, wxTwo]) assert.equal((await client('/api/ai/send', sendRequest(item.id, `发给 ${item.name}`))).status, 'submitted');
  const tgSends = f.calls.filter(call => call.path.endsWith('/sendMessage'));
  assert.match(tgSends[0].path, /^\/bot123456:/); assert.match(tgSends[1].path, /^\/bot654321:/);
  assert.equal(f.sent.at(-2).peer, 'wx-owner'); assert.equal(f.sent.at(-2).contextToken, 'wx-context-one');
  assert.equal(f.sent.at(-1).peer, 'wx-two'); assert.equal(f.sent.at(-1).contextToken, 'wx-context-two');
  const exposed = JSON.stringify([(await f.request('/api/state')).data, selected, (await f.request('/api/ai/config')).data]);
  for (const privateValue of [TOKEN, 'wx-context-one', 'wx-context-two', 'wx-private-test-token', JSON.parse(fs.readFileSync(path.join(f.dataDir, 'ai-endpoint.json'))).token]) assert.ok(!exposed.includes(privateValue));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.dataDir, 'ai-endpoint.json')).mode & 0o777, 0o600);
  assert.equal((await f.request('/server/data/ai-endpoint.json')).status, 404);
  assert.equal((await f.request('/api/ai/send', sendRequest(first.id), 'POST', { Authorization: 'Bearer wrong' })).status, 401);
  assert.ok(!JSON.stringify((await f.request('/api/state')).data.activity).includes('发给 '));
});

test('收件人开关、重名、授权撤销、微信缺少上下文及停止连接均拒绝误发', async t => {
  const f = await fixture(); t.after(() => f.close()); const tg = await telegram(f);
  const client = createClient(f.dataDir);
  const all = (await f.request('/api/state')).data.recipients;
  await assert.rejects(client('/api/ai/send', sendRequest(all[0].id)), /未开启/);
  const recipient = await enable(f, tg.id, '101', '唯一名称');
  assert.equal((await f.request(`/api/recipients/${all[1].id}`, { name: '唯一名称' }, 'PATCH')).status, 400);
  await assert.rejects(client('/api/ai/send', sendRequest('recipient-wrong')), /不存在/);
  const wx = await wechat(f);
  await f.request(`/api/bots/${wx.id}`, { allowedPeers: ['wx-only'] }, 'PATCH');
  const wxPeer = await enable(f, wx.id, 'wx-only', '待联系微信');
  assert.equal(wxPeer.ready, false);
  await assert.rejects(client('/api/ai/send', sendRequest(wxPeer.id)), /先从此微信/);
  await f.request(`/api/bots/${tg.id}/stop`, {});
  await assert.rejects(client('/api/ai/send', sendRequest(recipient.id)), /尚未在线/);
  await f.request(`/api/bots/${tg.id}/start`, {});
  await f.request(`/api/bots/${tg.id}`, { allowedPeers: ['202'] }, 'PATCH');
  await assert.rejects(client('/api/ai/send', sendRequest(recipient.id)), /不存在|撤销/);
  assert.ok(!(await client('/api/ai/recipients')).recipients.some(item => item.id === recipient.id));
});

test('并发同 ID 只发一次，内容冲突拒绝；失败重试和重启均不重复发送', async t => {
  const f = await fixture(); t.after(() => f.close()); const tg = await telegram(f);
  const recipient = await enable(f, tg.id, '101', '通知'); const client = createClient(f.dataDir);
  const payload = sendRequest(recipient.id, '绝不能重复');
  const results = await Promise.all(Array.from({ length: 8 }, () => client('/api/ai/send', payload)));
  assert.ok(results.every(result => result.status === 'submitted'));
  assert.equal(f.sent.filter(item => item.text === payload.text).length, 1);
  await assert.rejects(client('/api/ai/send', { ...payload, text: '内容变了' }), /不能用于不同消息/);
  f.setSendFailure(true);
  const failed = sendRequest(recipient.id, '平台失败');
  await assert.rejects(client('/api/ai/send', failed), /发送未确认/);
  const attempts = f.calls.filter(item => item.path.endsWith('/sendMessage')).length;
  f.setSendFailure(false);
  await assert.rejects(client('/api/ai/send', failed), /不会自动重发/);
  assert.equal(f.calls.filter(item => item.path.endsWith('/sendMessage')).length, attempts);
  await f.app.close();
  const restored = createApp({ dataDir: f.dataDir, workers: false });
  await new Promise(resolve => restored.server.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal((await client('/api/ai/send', payload)).duplicate, true);
    await assert.rejects(client('/api/ai/send', failed), /不会自动重发/);
    assert.equal(restored.viewState().recipients.find(item => item.id === recipient.id).name, '通知');
  } finally { await restored.close(); }
});

test('CLI 从 stdin 发送；MCP 握手、工具发现、发送错误和指定收件人发送', async t => {
  const f = await fixture(); t.after(() => f.close()); const tg = await telegram(f);
  const recipient = await enable(f, tg.id, '202', '目标 TG');
  const listing = await cli(f, ['recipients']); assert.equal(listing.code, 0); assert.equal(JSON.parse(listing.stdout).recipients[0].name, '目标 TG');
  const sending = await cli(f, ['send'], JSON.stringify(sendRequest(recipient.id, 'Unicode 中文\n"引号" $()')));
  assert.equal(sending.code, 0); assert.equal(f.sent.at(-1).peer, '202'); assert.equal(f.sent.at(-1).text, 'Unicode 中文\n"引号" $()');
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'clawlink_list_recipients', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'clawlink_send_message', arguments: sendRequest(recipient.id, 'MCP 精确选择') } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'clawlink_send_message', arguments: sendRequest('unknown') } },
    { jsonrpc: '2.0', id: 6, method: 'unknown' }
  ];
  const result = await cli(f, ['mcp'], messages.map(message => JSON.stringify(message)).join('\n')+'\n');
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
  const responses = Object.fromEntries(result.stdout.trim().split('\n').map(line => { const value = JSON.parse(line); return [value.id, value]; }));
  assert.equal(Object.keys(responses).length, 6);
  assert.equal(responses[1].result.protocolVersion, '2025-06-18');
  assert.deepEqual(responses[2].result.tools.map(tool => tool.name), ['clawlink_list_recipients', 'clawlink_send_message']);
  assert.equal(JSON.parse(responses[3].result.content[0].text).recipients[0].id, recipient.id);
  assert.equal(JSON.parse(responses[4].result.content[0].text).status, 'submitted');
  assert.equal(responses[5].result.isError, true); assert.equal(responses[6].error.code, -32601);
  assert.ok(f.sent.some(item => item.peer === '202' && item.text === 'MCP 精确选择'));
});

test('崩溃时尚未确认的发送保留去重记录，恢复后不会再次调用平台', async () => {
  const state = { bots: [{ id: 'tg', name: 'TG', platform: 'telegram', enabled: true, status: 'online' }] };
  const secrets = { tg: { token: TOKEN, allowedPeers: ['101'] } };
  let snapshot, finish, calls = 0;
  const adapters = { send: () => { calls += 1; return new Promise(resolve => { finish = resolve; }); } };
  const service = createMessaging({ state, secrets, adapters, save: () => { snapshot = structuredClone({ state, secrets }); }, activity: () => {} });
  const recipient = service.list()[0]; service.patch(recipient.id, { aiEnabled: true });
  const payload = sendRequest(recipient.id, '等待平台确认');
  const flight = service.send(payload);
  assert.equal(snapshot.secrets._ai.deliveries[0].status, 'pending');
  service.close();
  const restored = createMessaging({ ...snapshot, adapters, save: () => {}, activity: () => {} });
  try {
    await assert.rejects(restored.send(payload), /不会自动重发/);
    assert.equal(calls, 1);
  } finally { restored.close(); finish(); await flight; }
});

test('开启原生回复指令后带入本轮目标，严格执行最终指令且不回显内部代码', async t => {
  const f = await fixture(); t.after(() => f.close()); const session = await f.session('任务会话');
  const tg = await telegram(f); const recipient = await enable(f, tg.id, '202', '发结果的 TG');
  await f.request('/api/routes', { bot: tg.id, command: '默认', target: session.id });
  await f.request(`/api/sessions/${session.id}`, { aiMessaging: true }, 'PATCH');
  let latestTurn;
  f.native.send = async (binding, message) => {
    assert.ok(message.includes('发结果的 TG'));
    latestTurn = JSON.parse(message.match(/\{"turnId":"[^\n]+/)[0]);
    return `任务完成。\n\n\`\`\`clawlink-send\n${JSON.stringify({ turnId: latestTurn.turnId, messages: [{ recipientId: recipient.id, text: '已完成指定任务' }] })}\n\`\`\``;
  };
  const result = await f.request('/api/commands', { botId: tg.id, peerId: '101', text: '把结果发给发结果的 TG' });
  assert.equal(result.data.ok, true); assert.match(result.data.reply, /已向「发结果的 TG」提交/); assert.ok(!result.data.reply.includes('clawlink-send'));
  assert.equal(f.sent.at(-1).peer, '202'); assert.equal(f.sent.at(-1).text, '已完成指定任务');
  const before = f.sent.length;
  f.native.send = async () => `\`\`\`clawlink-send\n${JSON.stringify({ turnId: latestTurn.turnId, messages: [{ recipientId: recipient.id, text: '旧轮次重放' }] })}\n\`\`\``;
  const replay = await f.request('/api/commands', { botId: tg.id, peerId: '101', text: '下一轮' });
  assert.equal(replay.data.ok, false); assert.match(replay.data.reply, /未发送任何/); assert.equal(f.sent.length, before);
  f.native.send = async (binding, message) => {
    const turn = JSON.parse(message.match(/\{"turnId":"[^\n]+/)[0]);
    return `\`\`\`clawlink-send\n${JSON.stringify({ turnId: turn.turnId, messages: [{ recipientId: recipient.id, text: '正确' }, { recipientId: 'unknown', text: '错误' }] })}\n\`\`\``;
  };
  const invalid = await f.request('/api/commands', { botId: tg.id, peerId: '101', text: '混合目标' });
  assert.equal(invalid.data.ok, false); assert.equal(f.sent.length, before, '先校验全部目标再发送');
  f.native.send = async (binding, message) => {
    const turn = JSON.parse(message.match(/\{"turnId":"[^\n]+/)[0]);
    await f.request(`/api/recipients/${recipient.id}`, { aiEnabled: false }, 'PATCH');
    return `\`\`\`clawlink-send\n${JSON.stringify({ turnId: turn.turnId, messages: [{ recipientId: recipient.id, text: '生成期间已关闭权限' }] })}\n\`\`\``;
  };
  const revoked = await f.request('/api/commands', { botId: tg.id, peerId: '101', text: '生成时撤销权限' });
  assert.equal(revoked.data.ok, false); assert.equal(f.sent.length, before);
  await f.request(`/api/sessions/${session.id}`, { aiMessaging: false }, 'PATCH');
  f.native.send = async (binding, message) => { assert.equal(message, '普通问题'); return '普通回复'; };
  assert.equal((await f.request('/api/commands', { botId: tg.id, peerId: '101', text: '普通问题' })).data.reply, '已转发到「任务会话」。\n\n普通回复');
});
