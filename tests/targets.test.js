const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture, TOKEN } = require('./helpers');
const { createPi, headerOf, extractReply } = require('../server/pi');
const { createPaseo } = require('../server/paseo');
const { perform, replyFromTimeline } = require('../server/paseo-core.cjs');
const { createCliRunner, createQueue } = require('../server/cli');
const { setTimeout: delay } = require('node:timers/promises');
const id = '11111111-2222-4333-8444-555555555555';
const assistant = text => JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text }], stopReason: 'stop' } });

test('微信 / Telegram 共用 PI、Paseo 和原生目标，跨类型切换并只回传对应回复', async t => {
  const f = await fixture(); t.after(() => f.close());
  const native = await f.session('原生研究');
  const pi = (await f.request('/api/sessions', { name: 'PI 研究', provider: 'PI', targetType: 'pi' })).data.session;
  assert.equal((await f.request('/api/targets/bind', { sessionId: pi.id, binding: { mode: 'existing', sessionFile: '/tmp/pi-existing.jsonl' } })).status, 200);
  const paseo = (await f.request('/api/sessions', { name: 'Paseo 研究', provider: 'Paseo', targetType: 'paseo' })).data.session;
  assert.equal((await f.request('/api/targets/bind', { sessionId: paseo.id, binding: { agentId: f.paseoId } })).status, 200);
  assert.equal((await f.request('/api/native/bind', { sessionId: pi.id, binding: {} })).status, 400);
  assert.equal((await f.request('/api/native/send', { sessionId: pi.id, text: '' })).status, 400);
  assert.equal((await f.request('/api/native/validate', { sessionId: paseo.id })).status, 200);
  for (const platform of ['wechat', 'telegram']) {
    const bot = (await f.request('/api/bots', { name: platform, platform, token: TOKEN, target: native.id })).data.bot;
    if (platform === 'wechat') { const qr = (await f.request(`/api/bots/${bot.id}/login/start`, {})).data; await f.request(`/api/bots/${bot.id}/login/poll`, { loginId: qr.loginId }); }
    const live = f.app.viewState().bots.find(b => b.id === bot.id);
    const event = text => ({ text, peerId: platform === 'wechat' ? 'wx-owner' : 'telegram-owner', contextToken: 'ctx' });
    if (platform === 'telegram') await f.app.receive(live, event(`/pair ${bot.pairingCode}`));
    for (const [destination, prefix] of [[pi, 'PI'], [paseo, 'Paseo'], [native, 'AI']]) {
      await f.app.receive(live, event(`/switch ${destination.name}`));
      await f.app.receive(live, event(`测试 ${platform}`));
      assert.equal(f.sent.at(-1).text, `${prefix} 回复：测试 ${platform}`);
    }
    const broadcast = await f.request('/api/commands', { botId: bot.id, text: '/broadcast' }); assert.equal(broadcast.data.ok, true);
    const result = await f.request('/api/commands', { botId: bot.id, text: '广播' });
    assert.match(result.data.reply, /PI 回复：广播/); assert.match(result.data.reply, /Paseo 回复：广播/); assert.match(result.data.reply, /AI 回复：广播/);
  }
  assert.equal((await f.request('/api/targets/pi')).data.available, true);
  assert.equal((await f.request('/api/targets/paseo')).data.agents[0].id, f.paseoId);
  const persisted = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'state.json')));
  assert.equal(persisted.sessions.find(s => s.id === pi.id).binding.type, 'pi');
  assert.equal(persisted.sessions.find(s => s.id === paseo.id).binding.agentId, f.paseoId);
});

test('PI 精确续聊现有文件，新建路径稳定，提示文字走 stdin，丢失或被替换时拒绝', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawlink-pi-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'existing.jsonl'); const header = { type: 'session', version: 3, id, cwd: dir };
  fs.writeFileSync(file, JSON.stringify(header) + '\n');
  const calls = []; let running = 0, peak = 0;
  const pi = createPi({ command: process.execPath, sessionRoot: dir, runner: { async run(command, args, options) { peak = Math.max(peak, ++running); calls.push({ command, args, options }); await delay(15); running--; return assistant(options.input); }, close() {} } });
  t.after(() => pi.close());
  assert.equal(pi.discover().sessions[0].file, file);
  const binding = await pi.bind({ sessionFile: file, mode: 'existing' }, dir);
  const prompt = '@sensitive.txt\n中文 $HOME `literal`';
  const results = await Promise.all([pi.send(binding, prompt), pi.send({ ...binding }, 'second')]);
  assert.equal(results[0], prompt); assert.equal(peak, 1);
  assert.deepEqual(calls[0].args, ['-p', '--mode', 'json', '--session', fs.realpathSync(file)]);
  assert.equal(calls[0].options.input, prompt); assert.equal(calls[0].options.cwd, dir);
  const fresh = await pi.bind({ mode: 'new', workdir: dir }, dir);
  assert.notEqual(fresh.sessionFile, file); assert.equal(headerOf(fresh.sessionFile).id, fresh.sessionId);
  await pi.send(fresh, 'new'); await pi.send(fresh, 'continue'); assert.equal(calls.at(-1).args.at(-1), fresh.sessionFile);
  assert.equal(fs.statSync(fresh.sessionFile).mode & 0o777, 0o600);
  fs.writeFileSync(file, JSON.stringify({ ...header, id: '99999999-2222-4333-8444-555555555555' }) + '\n');
  await assert.rejects(pi.send(binding, 'no'), /标识/);
  fs.unlinkSync(file); await assert.rejects(pi.validate(binding), /ENOENT/);
  assert.equal(calls.length, 4);
});

test('PI 过滤思考与工具事件，只返回最终助手文本并传播失败', () => {
  const output = ['extension log', assistant('intermediate'), JSON.stringify({ type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'tool secret' }] } }), assistant('最终答案')].join('\n');
  assert.equal(extractReply(output), '最终答案');
  assert.throws(() => extractReply(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'auth failed' } })), /auth failed/);
  assert.throws(() => extractReply('not json'), /未返回/);
});

const entry = (seq, type, text, turnId = 'ours', extra = {}) => ({ seqStart: seq, seqEnd: seq, turnId, item: { type, text, ...extra } });
function timelineFixture() {
  return {
    before: { epoch: 'e1', entries: [entry(2, 'assistant_message', 'old', 'old')] },
    after: { epoch: 'e1', entries: [entry(2, 'assistant_message', 'old', 'old'), entry(3, 'user_message', 'prompt', 'ours', { clientMessageId: id }), entry(4, 'reasoning', 'private'), entry(5, 'tool_call', 'private'), entry(6, 'assistant_message', '本次回复'), entry(7, 'user_message', 'other prompt', 'theirs'), entry(8, 'assistant_message', 'other reply', 'theirs')] }
  };
}
test('Paseo 使用客户端消息 ID / turn ID 回传本轮，拒绝时间线变化和缺失标识', () => {
  const { before, after } = timelineFixture();
  assert.equal(replyFromTimeline(before, after, id), '本次回复');
  assert.throws(() => replyFromTimeline(before, { ...after, epoch: 'e2' }, id), /时间线/);
  assert.throws(() => replyFromTimeline(before, after, 'missing'), /标识/);
  assert.throws(() => replyFromTimeline(before, { ...after, entries: after.entries.filter(e => e.seqEnd !== 6) }, id), /没有可回传/);
});

test('Paseo SDK 先检查会话，发一次，处理等待授权 / 失败 / 超时，不返回旧回复', async () => {
  const { before, after } = timelineFixture(); let status = 'idle', sends = 0, running = false, timelineCount = 0;
  const client = { fetchAgent: async () => ({ agent: { id, title: 'existing', status: running ? 'running' : 'idle' } }), fetchAgentTimeline: async () => timelineCount++ % 2 === 0 ? before : after,
    sendAgentMessage: async (agentId, message, options) => { assert.equal(agentId, id); assert.equal(options.messageId, id); sends++; }, waitForFinish: async () => ({ status, error: 'provider error' }) };
  const input = { action: 'send', agentId: id, message: 'prompt', messageId: id, timeout: 100 };
  assert.equal((await perform(client, input)).reply, '本次回复'); assert.equal(sends, 1);
  running = true; await assert.rejects(perform(client, input), /正在运行/); assert.equal(sends, 1); running = false;
  for (const value of ['permission', 'error', 'timeout']) { status = value; timelineCount = 0; await assert.rejects(perform(client, input), /不会自动重发/); }
  assert.equal(sends, 4);
});

test('Paseo 同目标排队、stdin 传输、SDK 不兼容和关闭队列显式报错', async t => {
  const calls = []; let active = 0, peak = 0;
  const runner = { async run(command, args, options) { peak = Math.max(peak, ++active); const input = JSON.parse(options.input); calls.push(input); await delay(15); active--; return JSON.stringify({ ok: true, result: { reply: input.message } }); }, close() {} };
  const p = createPaseo({ runner, runtime: { available: true, command: 'helper', runner: 'entrypoint', clientModule: 'client' } }); t.after(() => p.close());
  assert.deepEqual(await Promise.all([p.send({ agentId: id }, '中文'), p.send({ agentId: id }, 'two')]), ['中文', 'two']);
  assert.equal(peak, 1); assert.notEqual(calls[0].messageId, calls[1].messageId);
  await assert.rejects(p.validate({ agentId: 'short' }), /完整/);
  p.close(); await assert.rejects(p.send({ agentId: id }, 'late'), /停止/);
  const incompatible = createPaseo({ runner: { run: async () => 'completed', close() {} }, runtime: { available: true } });
  t.after(() => incompatible.close()); await assert.rejects(incompatible.send({ agentId: id }, 'x'), /无法识别/);
});

test('CLI Unicode / stdin / PATH 与生命周期，超时强制停止，关闭取消待发送队列', async t => {
  const runner = createCliRunner({ killDelay: 80 }); t.after(() => runner.close());
  const text = '中文\n`literal` $HOME @file';
  const result = await runner.run(process.execPath, ['-e', "process.stdin.on('data',d=>process.stdout.write(d));"], { input: text, timeout: 5000 });
  assert.equal(result, text);
  await assert.rejects(runner.run(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"], { timeout: 150 }), /超时/);
  const active = runner.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 5000 });
  runner.close(); await assert.rejects(active, /停止/);
  await assert.rejects(runner.run(process.execPath, []), /停止/);
  const queue = createQueue(); let release; const gate = new Promise(resolve => { release = resolve; }); let called = 0;
  const a = queue.enqueue('same', () => { called++; return gate; }); await delay(1);
  const b = queue.enqueue('same', () => { called++; }); const rejection = assert.rejects(b, /停止/);
  queue.close(); release(); await a; await rejection; assert.equal(called, 1);
});
