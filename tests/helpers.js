const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { createAdapters } = require('../server/adapters');
const { setTimeout: delay } = require('node:timers/promises');
const { EventEmitter } = require('node:events');
const TOKEN = '123456:abcdefghijklmnopqrstuvwxyz0123456789';
const FEISHU = { appId: 'cli_1234567890abcdef', appSecret: 'feishu-private-test-secret' };
const DISCORD_TOKEN = 'discord-private-test-token-first-account';
async function fixture({ workers = false, port = 0, publicDir, adapterOptions = {} } = {}) {
  const calls = [], sent = [], screenshotCalls = [], tgUpdates = [], wxUpdates = [], nativeCalls = [], piCalls = [], paseoCalls = [];
  let qrStatus = 'confirmed', qrOwner = 'wx-owner', qrFailure = false, webhook = '', nativeFailure = '', updateFailure = 0, sendFailure = false, platformFailure = 0;
  const streams = [];
  const feishuSocket = options => {
    const stream = { platform: 'feishu', options, closed: false, start({ eventDispatcher }) { this.dispatcher = eventDispatcher; return Promise.resolve(); }, close() { this.closed = true; } };
    streams.push(stream); return stream;
  };
  const discordClient = options => {
    const stream = new EventEmitter(); Object.assign(stream, { platform: 'discord', options, closed: false, ready: false, isReady() { return this.ready; }, login(token) { this.token = token; return Promise.resolve(); }, destroy() { this.closed = true; return Promise.resolve(); } });
    streams.push(stream); return stream;
  };
  const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const buffers = []; for await (const chunk of req) buffers.push(chunk);
    const bytes = Buffer.concat(buffers); const raw = bytes.toString();
    const body = raw && req.headers['content-type']?.includes('application/json') ? JSON.parse(raw) : {};
    if (url.pathname.startsWith('/open-apis/') || url.pathname.startsWith('/discord/')) {
      calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers, multipart: raw });
      if (platformFailure || sendFailure && req.method === 'POST' && !url.pathname.includes('/auth/')) { res.writeHead(platformFailure || 403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'upstream-private-detail' })); return; }
      let data;
      if (url.pathname.endsWith('/tenant_access_token/internal')) data = { code: 0, tenant_access_token: `fs-access-${body.app_id}`, expire: 7200 };
      else if (url.pathname.endsWith('/bot/v3/info')) data = { code: 0, bot: { open_id: req.headers.authorization.endsWith(FEISHU.appId) ? 'ou_first_bot' : 'ou_second_bot', app_name: 'Test Feishu Bot' } };
      else if (url.pathname.endsWith('/users/@me')) data = { bot: true, id: req.headers.authorization.endsWith(DISCORD_TOKEN) ? '123456789012345678' : '223456789012345678', username: 'TestDiscordBot' };
      else if (url.pathname.endsWith('/images')) data = { code: 0, data: { image_key: 'test-image-key' } };
      else if (url.pathname === '/open-apis/im/v1/messages') { sent.push({ platform: 'feishu', peer: body.receive_id, text: body.msg_type === 'text' ? JSON.parse(body.content).text : '', image: body.msg_type === 'image' }); data = { code: 0, data: { message_id: 'fs-sent' } }; }
      else if (/\/channels\/[^/]+\/messages$/.test(url.pathname)) { sent.push({ platform: 'discord', peer: url.pathname.split('/')[3], text: body.content, image: !!raw.includes('files[0]') }); data = { id: 'discord-sent' }; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data || {})); return;
    }
    if (url.pathname === '/c2c/upload') { calls.push({ path: url.pathname, bytes, headers: req.headers }); res.writeHead(200, { 'x-encrypted-param': 'test-download-param' }); res.end(); return; }
    if (url.pathname.endsWith('sendPhoto')) { calls.push({ path: url.pathname, bytes, headers: req.headers }); sent.push({ platform: 'telegram', image: true, multipart: raw }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: {} })); return; }
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers });
    let data = {};
    if (url.pathname.endsWith('get_bot_qrcode')) data = qrFailure ? { ret: 500 } : { qrcode: 'real-upstream-qr-id', qrcode_img_content: 'https://example.test/wechat/login?id=1' };
    else if (url.pathname.endsWith('get_qrcode_status')) data = { status: qrStatus, ...(qrStatus === 'confirmed' ? { bot_token: 'wx-private-test-token', ilink_bot_id: 'wx-account-1', ilink_user_id: qrOwner, baseurl: `http://127.0.0.1:${upstream.address().port}` } : {}), ...(qrStatus === 'scaned_but_redirect' ? { redirect_host: 'ilinkai.weixin.qq.com' } : {}) };
    else if (url.pathname.endsWith('getMe')) data = { ok: true, result: { id: 123456, is_bot: true, username: url.pathname.startsWith('/bot654321:') ? 'second_router_bot' : 'test_router_bot' } };
    else if (url.pathname.endsWith('getWebhookInfo')) data = { ok: true, result: { url: webhook } };
    else if (url.pathname.endsWith('getUpdates')) data = updateFailure ? { ok: false, error_code: updateFailure, description: 'Test poll failure' } : { ok: true, result: tgUpdates.splice(0) };
    else if (url.pathname.endsWith('getupdates')) data = { ret: 0, msgs: wxUpdates.splice(0), get_updates_buf: 'next-cursor' };
    else if (url.pathname.endsWith('sendMessage')) { if (!sendFailure) sent.push({ platform: 'telegram', peer: body.chat_id, text: body.text }); data = sendFailure ? { ok: false, error_code: 403, description: 'Test send failure' } : { ok: true, result: {} }; }
    else if (url.pathname.endsWith('getuploadurl')) data = { ret: 0, upload_param: 'test-upload-param' };
    else if (url.pathname.endsWith('sendmessage')) { if (!sendFailure) sent.push({ platform: 'wechat', peer: body.msg.to_user_id, text: body.msg.item_list[0].text_item?.text, image: body.msg.item_list[0].image_item, contextToken: body.msg.context_token }); data = sendFailure ? { ret: -14 } : { ret: 0 }; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawlink-test-'));
  const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1eIAAAAASUVORK5CYII=', 'base64');
  const native = {
    screenStatus: async () => ({ allowed: true }), requestScreenPermission: async () => ({ allowed: true }),
    screenshot: async () => { screenshotCalls.push(Date.now()); return screenshot; },
    discover: async () => ({ trusted: true, apps: [{ bundleId: 'com.openai.chat', name: 'ChatGPT', windows: ['ChatGPT'] }, { bundleId: 'com.anthropic.claudefordesktop', name: 'Claude', windows: ['Claude'] }] }),
    inspect: async () => ({ nodes: [
      { path: '0', role: 'AXStaticText', label: '唯一会话标题', text: 'unique-marker', actions: [] },
      { path: '1', role: 'AXTextArea', label: '输入消息', text: '', editable: true, actions: [] },
      { path: '2', role: 'AXGroup', label: '回复容器', text: 'previous', actions: [] },
      { path: '3', role: 'AXButton', label: '发送', text: '发送', actions: ['AXPress'] }
    ] }),
    validate: async binding => { if (binding.markerText !== 'unique-marker') throw new Error('当前会话与绑定标识不符'); return { text: 'previous' }; },
    send: async (binding, text) => { if (nativeFailure || binding.markerText !== 'unique-marker') throw new Error(nativeFailure || '当前会话与绑定标识不符'); nativeCalls.push({ binding, text }); return `AI 回复：${text}`; }
  };
  const paseoId = '11111111-2222-4333-8444-555555555555';
  const pi = {
    discover: async () => ({ available: true, sessions: [{ file: '/tmp/pi-existing.jsonl', id: paseoId, cwd: '/tmp', updatedAt: Date.now() }], defaultWorkdir: '/tmp' }),
    bind: async source => { if (source.mode !== 'new' && !source.sessionFile) throw new Error('请选择 PI 会话文件'); return { type: 'pi', sessionFile: source.sessionFile || '/tmp/pi-new.jsonl', sessionId: paseoId, workdir: '/tmp', provider: source.provider || '', model: source.model || '' }; },
    validate: async () => ({ text: 'PI existing session' }),
    send: async (binding, text) => { piCalls.push({ binding, text }); return `PI 回复：${text}`; }
  };
  const paseo = {
    discover: async () => ({ available: true, agents: [{ id: paseoId, name: 'Paseo 现有对话', provider: 'pi', status: 'idle', cwd: '/tmp' }] }),
    bind: async source => { if (source.agentId !== paseoId) throw new Error('Paseo 会话不存在'); return { type: 'paseo', agentId: paseoId, name: 'Paseo 现有对话' }; },
    validate: async () => ({ text: 'Paseo existing session' }),
    send: async (binding, text) => { paseoCalls.push({ binding, text }); return `Paseo 回复：${text}`; }
  };
  const adapters = createAdapters({ wechatBase: base, telegramBase: base, wechatCdn: `${base}/c2c`, feishuBase: base, discordBase: `${base}/discord`, feishuSocket, discordClient, allowTestHosts: true, ...adapterOptions });
  const app = createApp({ dataDir, publicDir, adapters, native, pi, paseo, workers, pollDelay: 15, errorDelay: 15 });
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  async function request(endpoint, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
    const response = await fetch(`${origin}${endpoint}`, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); return { status: response.status, data };
  }
  async function session(name = '研究室', provider = 'ChatGPT') {
    const { data } = await request('/api/sessions', { name, provider });
    const binding = { bundleId: provider === 'ChatGPT' ? 'com.openai.chat' : 'com.anthropic.claudefordesktop', windowTitle: provider, markerPath: '0', markerText: 'unique-marker', inputPath: '1', replyPath: '2', sendPath: '3' };
    const result = await request('/api/native/bind', { sessionId: data.session.id, binding });
    if (result.status !== 200) throw new Error(JSON.stringify(result));
    return result.data.session;
  }
  return { app, adapters, streams, request, session, origin, dataDir, calls, sent, screenshot, screenshotCalls, nativeCalls, piCalls, paseoCalls, paseoId, tgUpdates, wxUpdates, native,
    setQrStatus: value => { qrStatus = value; }, setQrOwner: value => { qrOwner = value; }, setQrFailure: value => { qrFailure = value; }, setWebhook: value => { webhook = value; }, setNativeFailure: value => { nativeFailure = value; }, setUpdateFailure: value => { updateFailure = value; },
    setSendFailure: value => { sendFailure = value; },
    setPlatformFailure: value => { platformFailure = value; },
    async close() { await app.close(); await new Promise(resolve => upstream.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); }
  };
}
async function until(check, timeout = 3000) { const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) throw new Error('Condition timeout'); await delay(20); } }
module.exports = { fixture, TOKEN, FEISHU, DISCORD_TOKEN, until };
