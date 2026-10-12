const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { setTimeout: delay } = require('node:timers/promises');
const { createAdapters } = require('./adapters');
const { createNative, binary: nativeBinary } = require('./native');
const { createPi } = require('./pi');
const { createPaseo } = require('./paseo');
const { acquireLock } = require('./runtime');
const { createMessaging } = require('./messaging');
const { createCommands, parse } = require('./commands');
const { permissionsFor, commandAllowed, patchPermissions } = require('./permissions');
const { version } = require('../package.json');

const rootDir = path.resolve(__dirname, '..');
// Known targets keep old configurations readable while allowing any running
// desktop app with an accessibility tree to be selected from the UI.
// Windows keeps the historical bundleId field as an opaque executable identity.
const PROVIDERS = {
  ChatGPT: 'com.openai.chat',
  Codex: 'com.openai.codex',
  Claude: 'com.anthropic.claudefordesktop',
  Paseo: 'sh.paseo.desktop'
};
const providerNames = new Map(Object.entries(PROVIDERS).map(([name, bundleId]) => [bundleId, name]));
const validBundleId = value => /^[A-Za-z0-9][A-Za-z0-9.-]{1,199}$/.test(String(value || ''));
const targetTone = bundleId => bundleId === PROVIDERS.Claude ? 'target-claude' : bundleId === PROVIDERS.Paseo ? 'target-paseo' : bundleId === PROVIDERS.Codex ? 'target-codex' : 'target-chatgpt';
const targetLogo = bundleId => bundleId === PROVIDERS.Claude ? 'A' : bundleId === PROVIDERS.Paseo ? 'P' : bundleId === PROVIDERS.Codex ? 'C' : '✦';
const makeId = prefix => `${prefix}-${crypto.randomUUID().slice(0, 12)}`;
const clean = (value, limit = 160) => String(value || '').trim().slice(0, limit);
const initialState = () => ({ version: 2, preferences: { theme: 'system', language: 'zh-CN' }, bots: [], sessions: [], routes: [], peerRoutes: {}, activity: [], stats: { day: '', messages: 0, replies: 0, durationMs: 0 } });
class HttpError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`无法读取 ${path.basename(file)}，请恢复有效数据后重启；原文件已保留`); }
}
function writeJson(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(temp, 0o600); fs.renameSync(temp, file);
}
function createApp({ dataDir = process.env.CLAWLINK_DATA_DIR || path.join(__dirname, 'data'), publicDir = process.env.CLAWLINK_PUBLIC_DIR || rootDir, adapters = createAdapters(), native = createNative(), pi = createPi(), paseo = createPaseo(), workers = true, pollDelay = 300, errorDelay = 5000 } = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); fs.chmodSync(dataDir, 0o700);
  const stateFile = path.join(dataDir, 'state.json'); const secretsFile = path.join(dataDir, 'secrets.json');
  let state = readJson(stateFile, initialState());
  let secrets = readJson(secretsFile, {});
  // Old UI prototypes did not contain real credentials or bindings. Preserve a backup.
  if (state.version !== 2) {
    writeJson(path.join(dataDir, `prototype-backup-${Date.now()}.json`), state);
    state = initialState();
  }
  for (const rule of state.routes) rule.id ||= makeId('route');
  state.preferences = { theme: ['system', 'light', 'dark'].includes(state.preferences?.theme) ? state.preferences.theme : 'system', language: state.preferences?.language === 'en' ? 'en' : 'zh-CN' };
  function authorizeWechatOwner(secret) {
    secret.allowedPeers ||= [];
    if (!secret.allowedPeers.includes(secret.ownerId)) secret.allowedPeers.push(secret.ownerId);
    secret.ownerAutoAuthorized = true;
    delete secret.pairingCode;
  }
  for (const bot of state.bots) {
    if (bot.platform !== 'wechat' || !secrets[bot.id]) continue;
    const secret = secrets[bot.id];
    // Upgrade existing logins once; a later manual revocation must survive restart.
    if (secret.token && typeof secret.ownerId === 'string' && secret.ownerId.trim() && !secret.ownerAutoAuthorized) authorizeWechatOwner(secret);
    delete secret.pairingCode;
  }
  const logins = new Map(); const polling = new Map(); const inboundQueues = new Map(); const qrFlights = new Map(); const loginFlights = new Map();
  let closed = false;
  function save() { writeJson(secretsFile, secrets); writeJson(stateFile, state); }
  function activity(text, kind = '路由', tone = 'orange') {
    state.activity.unshift({ id: makeId('event'), text, kind, tone, icon: kind === '消息' ? '◉' : kind === '连接' ? '＋' : '↗', at: new Date().toISOString() });
    state.activity = state.activity.slice(0, 200);
  }
  const commands = createCommands(state);
  const messaging = createMessaging({ state, secrets, adapters, save, activity });
  const targetAdapter = binding => binding.type === 'pi' ? pi : binding.type === 'paseo' ? paseo : native;
  const botById = id => state.bots.find(bot => bot.id === id);
  const sessionById = id => state.sessions.find(session => session.id === id) || state.sessions.find(session => session.name === id);
  function requireBot(id) { const bot = botById(id); if (!bot) throw new HttpError('机器人不存在', 404); return bot; }
  function requireSession(id) { const session = sessionById(id); if (!session) throw new HttpError('会话不存在', 404); return session; }
  function peerKey(bot, peerId) { return JSON.stringify([bot.id, peerId || '*']); }
  function resetDailyStats() {
    const day = new Date().toLocaleDateString('en-CA');
    if (state.stats.day === day) return false;
    state.stats = { day, messages: 0, replies: 0, durationMs: 0 };
    return true;
  }
  function viewState() {
    if (resetDailyStats()) save();
    return { ...state, commands: commands.list(), bots: state.bots.map(bot => ({ ...bot, permissions: permissionsFor(bot), configured: !!secrets[bot.id]?.token, pairingCode: secrets[bot.id]?.pairingCode,
      peers: secrets[bot.id]?.allowedPeers || [], route: sessionById(bot.target)?.name || '未指定' })),
      sessions: state.sessions.map(session => ({ ...session, users: state.bots.filter(bot => bot.target === session.id).length })),
      recipients: messaging.list(),
      service: { online: true, platform: process.platform, nativeBuilt: fs.existsSync(nativeBinary), polling: polling.size } };
  }
  function stopBot(botId) {
    const worker = polling.get(botId); if (worker) worker.abort(); polling.delete(botId);
  }
  function connectBot(bot) {
    stopBot(bot.id); bot.enabled = true; bot.status = 'connecting'; delete bot.error;
    if (!workers) { bot.status = 'online'; save(); return; }
    const control = new AbortController(); polling.set(bot.id, control);
    let authFailures = 0;
    (async () => {
      while (!closed && !control.signal.aborted && bot.enabled) {
        const secret = secrets[bot.id];
        if (!secret?.token) break;
        try {
          const result = await adapters.updates(bot, secret, control.signal);
          if (control.signal.aborted) break;
          authFailures = 0;
          bot.status = 'online'; bot.lastPollAt = new Date().toISOString(); delete bot.error;
          // Commit each accepted update before dispatch; never replay native sends after restart.
          for (const event of result.messages) {
            if (closed || control.signal.aborted) break;
            secret.seen ||= [];
            if (secret.seen.includes(event.id)) continue;
            secret.seen.push(event.id); secret.seen = secret.seen.slice(-500);
            save(); enqueueIncoming(bot, event);
          }
          if (bot.platform === 'telegram') secret.offset = result.cursor; else secret.cursor = result.cursor;
          save(); await delay(pollDelay, undefined, { signal: control.signal });
        } catch (error) {
          if (control.signal.aborted) break;
          const authError = [-14, 401, 403].includes(error.code);
          if (authError) authFailures += 1; else authFailures = 0;
          const expired = authError && authFailures >= 3;
          bot.status = expired ? 'expired' : authError ? 'connecting' : 'error';
          bot.error = expired ? error.message : authError ? `平台连接确认中（第 ${authFailures} 次重试）` : error.message; save();
          if (expired || error.code === 409) { bot.enabled = false; save(); break; }
          try { await delay(errorDelay, undefined, { signal: control.signal }); } catch { break; }
        }
      }
      if (polling.get(bot.id) === control) polling.delete(bot.id);
    })().catch(() => { bot.status = 'error'; bot.error = '接收循环已停止，请重新连接'; save(); });
  }
  function enqueueIncoming(bot, event) {
    const key = peerKey(bot, event.peerId);
    const previous = inboundQueues.get(key) || Promise.resolve();
    const next = previous.then(() => receive(bot, event)).catch(error => { activity(`${bot.name}：${error.message}`, '消息'); save(); });
    inboundQueues.set(key, next);
    next.finally(() => { if (inboundQueues.get(key) === next) inboundQueues.delete(key); });
  }
  async function receive(bot, event) {
    bot = botById(bot.id);
    if (!bot) return;
    const secret = secrets[bot.id];
    if (!secret || closed || !bot.enabled) return;
    const text = clean(event.text, 20000);
    const { trigger, argument: code } = parse(text);
    if (commands.match(trigger)?.id === 'pair' && bot.platform === 'telegram') {
      if (!commandAllowed(bot, 'pair')) return;
      if (event.group) return;
      if (!secret.pairingCode || code !== secret.pairingCode) return;
      secret.allowedPeers ||= [];
      if (!secret.allowedPeers.includes(event.peerId)) secret.allowedPeers.push(event.peerId);
      delete secret.pairingCode;
      messaging.syncRecipients(); messaging.rememberContext(bot, event);
      activity(`${bot.name} 已授权聊天 ${event.peerId}`, '连接', 'green'); save();
      await adapters.send(bot, secret, event, `配对成功。发送 ${commands.get('sessions').trigger} 查看会话，${commands.get('switch').trigger} 会话名 切换目标。`); return;
    }
    if (!secret.allowedPeers?.includes(event.peerId)) return;
    messaging.rememberContext(bot, event); save();
    if (!text) {
      await adapters.send(bot, secret, event, '目前支持文字消息和微信已转写的语音。请发送文字。'); return;
    }
    bot.lastMessageAt = new Date().toISOString();
    resetDailyStats();
    state.stats.messages += 1; save();
    const start = Date.now();
    let result;
    try { result = await commandForBot(bot, text, event.peerId); }
    catch (error) { result = { ok: false, reply: `处理失败：${error.message}` }; }
    // A platform reply failure must never re-run a native send.
    try {
      if (closed || !bot.enabled || secrets[bot.id] !== secret || !secret.allowedPeers?.includes(event.peerId)) return;
      if (result.image) {
        if (!commandAllowed(bot, 'screenshot')) return;
        await adapters.sendImage(bot, secret, event, result.image, { canSend: () => !closed && bot.enabled && secrets[bot.id] === secret && secret.allowedPeers?.includes(event.peerId) && commandAllowed(bot, 'screenshot') });
      } else await adapters.send(bot, secret, event, result.reply);
    }
    catch { activity(`${bot.name} ${result.image ? '截图' : '回复'}发送失败；请检查平台状态，不会自动重发`, '消息'); save(); return; }
    resetDailyStats(); state.stats.replies += 1; state.stats.durationMs += Date.now() - start;
    activity(`${bot.name} → ${result.destination || '机器人指令'}，已回复聊天 ${event.peerId}`, '消息', result.ok ? 'green' : 'orange'); save();
  }
  async function commandForBot(bot, input, peerId = '') {
    const text = clean(input, 20000);
    const { trigger: command, argument } = parse(text);
    const action = commands.match(command)?.id;
    if (action && !commandAllowed(bot, action)) return { ok: false, reply: '此账户未获准使用这条指令，请在 ClawLink 的账户权限中开启。' };
    const key = peerKey(bot, peerId);
    const defaultKey = peerKey(bot, '');
    const ownRoute = state.peerRoutes[key] || {};
    const route = { ...(state.peerRoutes[defaultKey] || {}), ...ownRoute };
    const botRules = state.routes.filter(rule => rule.bot === bot.id);
    const fallback = botRules.find(rule => rule.on && rule.command === '默认');
    const customRules = botRules.filter(rule => rule.on && rule.command !== '默认');
    // A single custom route is an unambiguous default, so ordinary messages
    // can omit its trigger. Multiple custom routes still require a switch or
    // an explicit route command to avoid silently choosing the wrong session.
    const implicitCustomTarget = !route.target && !bot.target && !fallback && customRules.length === 1 ? customRules[0].target : '';
    const firstBound = state.sessions.find(session => session.binding);
    const target = route.target || bot.target || fallback?.target || implicitCustomTarget || (!customRules.length ? firstBound?.id : '') || '';
    const choices = state.sessions.map(session => `${session.name} (${session.id})${session.binding ? '' : ' [未绑定]'}`).join('\n');
    if (['help', 'start'].includes(action)) return { ok: true, reply: commands.help(bot, id => commandAllowed(bot, id)) };
    if (action === 'pair') return { ok: false, reply: bot.platform === 'wechat' ? '微信扫码后已自动授权，无需配对。' : '请在机器人私聊中发送配对指令和配对码。' };
    if (action === 'screenshot') {
      if (!peerId) return { ok: false, reply: '请从已授权的微信或 Telegram 聊天发送截图指令。' };
      const image = await native.screenshot();
      if (!Buffer.isBuffer(image) || !image.length || image.length > 10 * 1024 * 1024) throw new Error('截图为空或超过 10 MB，未发送');
      return { ok: true, reply: '当前主屏幕截图', image };
    }
    if (action === 'sessions') return { ok: true, reply: choices || '请先在控制台添加并绑定目标会话。' };
    if (action === 'route') return { ok: true, reply: `当前目标：${sessionById(target)?.name || '未指定'}\n状态：${route.paused ? '暂停' : '启用'}${route.broadcastNext ? '；下一条广播' : ''}\n${botRules.filter(x => x.on).map(x => `${x.command} → ${x.target === 'all' ? '全部会话' : sessionById(x.target)?.name}`).join('\n')}` };
    if (action === 'switch') {
      const destination = sessionById(argument);
      if (!destination) return { ok: false, reply: `找不到会话：${argument || '未指定'}\n${choices}` };
      if (!destination.binding) return { ok: false, reply: '此会话尚未绑定目标，请先在控制台完成绑定。' };
      if (peerId) state.peerRoutes[key] = { ...route, target: destination.id, paused: false, broadcastNext: false };
      else {
        bot.target = destination.id;
        let rule = botRules.find(x => x.command === '默认');
        if (!rule) { rule = { id: makeId('route'), bot: bot.id, command: '默认', target: destination.id, on: true }; state.routes.push(rule); }
        rule.target = destination.id; rule.on = true;
        state.peerRoutes[key] = { ...route, paused: false, broadcastNext: false };
      }
      activity(`${bot.name}${peerId ? ` / ${peerId}` : ''} 切换到 ${destination.name}`); save();
      return { ok: true, reply: `已切换到「${destination.name}」。${['pi', 'paseo'].includes(destination.binding.type) ? '下一条消息会按会话 ID 发送到此目标。' : destination.binding.navigationPath ? '下一条消息会自动打开并校验目标会话。' : '请保持目标原生聊天打开；发送前会校验会话标识。'}` };
    }
    if (['pause', 'resume', 'broadcast'].includes(action)) {
      if (action === 'broadcast' && !state.sessions.some(x => x.binding)) return { ok: false, reply: '没有已绑定的会话。' };
      state.peerRoutes[key] = { ...route, ...(action === 'broadcast' ? { broadcastNext: true, paused: false } : { paused: action === 'pause' }) };
      save(); return { ok: true, reply: action === 'broadcast' ? '下一条普通消息将发送到全部已绑定会话。' : action === 'pause' ? '已暂停当前聊天的消息路由。' : '已恢复当前聊天的消息路由。' };
    }
    if (!text) return { ok: false, reply: '消息不能为空。' };
    if (route.paused) return { ok: false, reply: `当前路由已暂停，发送 ${commands.get('resume').trigger} 恢复。` };
    const matched = botRules.find(rule => rule.on && rule.command !== '默认' && rule.command === command);
    if (matched && !commandAllowed(bot, `route:${matched.id}`)) return { ok: false, reply: '此账户未获准使用这条路由指令。' };
    const broadcast = route.broadcastNext && !command.startsWith('/');
    const destinationId = broadcast ? 'all' : matched?.target || target || fallback?.target;
    if (command.startsWith('/') && !matched) return { ok: false, reply: `未知指令，发送 ${commands.get('help').trigger} 查看指令。` };
    if (!permissionsFor(bot).forwardMessages) return { ok: false, reply: '此账户已关闭向 AI 发消息，可在账户权限中开启。' };
    const message = matched ? argument : text;
    if (!message) return { ok: false, reply: '请在路由指令后输入消息内容。' };
    if (!destinationId) return { ok: false, reply: '未配置可用路由，请先在控制台绑定会话。' };
    if (broadcast) {
      const broadcastKey = Object.hasOwn(ownRoute, 'broadcastNext') ? key : defaultKey;
      state.peerRoutes[broadcastKey] = { ...(state.peerRoutes[broadcastKey] || {}), broadcastNext: false }; save();
    }
    const destinations = destinationId === 'all' ? state.sessions.filter(x => x.binding) : [requireSession(destinationId)];
    if (!destinations.length) return { ok: false, reply: '没有已绑定的会话。' };
    const replies = [];
    const forwarded = [];
    for (const session of destinations) {
      if (!permissionsFor(bot).forwardMessages || peerId && (!bot.enabled || !secrets[bot.id]?.allowedPeers?.includes(peerId))) { replies.push({ name: session.name, ok: false, text: '账户权限已变更，已停止转发。' }); break; }
      try {
        if (!session.binding) throw new Error('会话未绑定目标');
        const context = messaging.preparePrompt(session, message);
        const reply = await targetAdapter(session.binding).send(session.binding, context.message);
        forwarded.push(session.name);
        const processed = peerId && (!bot.enabled || !secrets[bot.id]?.allowedPeers?.includes(peerId) || !permissionsFor(bot).forwardMessages) ? { ok: false, text: '账户权限已变更，未执行回复中的发送指令。' } : await messaging.handleReply(session, reply, context);
        session.status = 'verified'; session.lastVerifiedAt = new Date().toISOString(); delete session.error;
        replies.push({ name: session.name, ok: processed.ok, text: processed.text });
      } catch (error) { session.status = 'error'; session.error = error.message; replies.push({ name: session.name, ok: false, text: `发送失败：${error.message}` }); }
      save();
    }
    const forwardedNotice = forwarded.length && permissionsFor(bot).forwardNotice
      ? `已转发到「${forwarded.join('」、「')}」。`
      : '';
    return {
      ok: replies.every(x => x.ok),
      destination: destinations.map(x => x.name).join('、'),
      forwardedNotice,
      reply: [
        forwardedNotice,
        replies.length === 1 ? replies[0].text : replies.map(x => `【${x.name}】\n${x.text}`).join('\n\n')
      ].filter(Boolean).join('\n\n')
    };
  }
  async function startLogin(bot) {
    if (bot.platform !== 'wechat') throw new HttpError('Telegram 请使用 BotFather Token');
    if (loginFlights.has(bot.id)) return loginFlights.get(bot.id);
    const task = (async () => {
      stopBot(bot.id); logins.delete(bot.id); bot.enabled = false; bot.status = 'pending'; delete bot.error; save();
      try {
        const tokens = state.bots.filter(x => x.platform === 'wechat').map(x => secrets[x.id]?.token).filter(Boolean);
        const data = await adapters.qrStart(tokens);
        const image = String(data.qrcode_img_content);
        const qrImage = image.startsWith('data:image/') ? image : await QRCode.toDataURL(image, { width: 320, margin: 2 });
        const login = { id: makeId('login'), qrcode: data.qrcode, base: adapters.validateBase(), startedAt: Date.now(), qrImage };
        logins.set(bot.id, login); save();
        return { loginId: login.id, qrImage, status: 'wait' };
      } catch (error) { bot.status = 'error'; bot.error = `二维码请求失败：${error.message}`; save(); throw error; }
    })();
    loginFlights.set(bot.id, task);
    try { return await task; } finally { loginFlights.delete(bot.id); }
  }
  async function pollLogin(bot, body) {
    const login = logins.get(bot.id);
    if (!login || body.loginId !== login.id) throw new HttpError('登录已失效，请重新生成二维码');
    if (Date.now() - login.startedAt > 8 * 60000) { logins.delete(bot.id); bot.status = 'expired'; save(); return { status: 'expired' }; }
    if (qrFlights.has(bot.id)) return qrFlights.get(bot.id);
    const task = (async () => {
      const data = await adapters.qrPoll(login, clean(body.verifyCode, 12));
      if (logins.get(bot.id) !== login) throw new HttpError('二维码已更新，请使用新二维码');
      if (data.status === 'scaned_but_redirect' && data.redirect_host) login.base = adapters.validateBase(`https://${data.redirect_host}`);
      if (data.status === 'confirmed') {
        if (!data.bot_token || !data.ilink_bot_id || typeof data.ilink_user_id !== 'string' || !data.ilink_user_id.trim()) throw new HttpError('微信登录确认信息不完整，无法确认扫码账号，请重新扫码');
        if (state.bots.some(x => x.id !== bot.id && x.handle === data.ilink_bot_id)) throw new HttpError('此微信已连接，请使用已有机器人');
        const base = adapters.validateBase(data.baseurl || login.base);
        secrets[bot.id] = { ...secrets[bot.id], token: data.bot_token, base, ownerId: data.ilink_user_id, cursor: '', seen: [], peerContexts: {} };
        authorizeWechatOwner(secrets[bot.id]);
        messaging.syncRecipients();
        bot.handle = data.ilink_bot_id; logins.delete(bot.id); activity(`${bot.name} 微信扫码成功`, '连接', 'green');
        save();
        let welcomeSent = false;
        let welcomeError = '';
        try {
          await adapters.sendDirect(bot, secrets[bot.id], data.ilink_user_id,
            `ClawLink 已连接此微信，扫码账号已自动授权。\n发送 ${commands.get('sessions').trigger} 查看会话，发送 ${commands.get('switch').trigger} 会话名 切换目标。\n请先发一条消息，让 ClawLink 取得此聊天的发送上下文。`);
          welcomeSent = true;
          activity(`${bot.name} 已向微信设备发送连接成功提示`, '连接', 'green');
        } catch (error) {
          welcomeError = `欢迎提示发送失败：${error.message}`;
          bot.error = welcomeError;
          activity(`${bot.name} 欢迎提示发送失败，扫码账号已授权，可直接给机器人发消息`, '连接');
        }
        connectBot(bot); if (welcomeError) bot.error = welcomeError; save();
        return { status: 'confirmed', welcomeSent, bot: viewState().bots.find(x => x.id === bot.id) };
      } else if (['expired', 'verify_code_blocked', 'binded_redirect'].includes(data.status)) {
        bot.status = 'expired'; logins.delete(bot.id); save();
      }
      return { status: data.status || 'wait', bot: viewState().bots.find(x => x.id === bot.id) };
    })();
    qrFlights.set(bot.id, task);
    try { return await task; } finally { qrFlights.delete(bot.id); }
  }
  async function bodyOf(req) {
    let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 1000000) throw new HttpError('请求过大', 413); }
    try { const body = raw ? JSON.parse(raw) : {}; if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error(); return body; }
    catch { throw new HttpError('请求体必须是 JSON 对象'); }
  }
  function json(res, code, value) { const body = JSON.stringify(value); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(body); }
  async function api(req, res, url) {
    const method = req.method; const pathname = url.pathname;
    if (pathname === '/api/ai/recipients' || pathname === '/api/ai/send') {
      const supplied = Buffer.from(req.headers.authorization || ''); const expected = Buffer.from(`Bearer ${messaging.token}`);
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw new HttpError('AI 工具凭据无效，请使用本机 ai-client.js', 401);
      if (method === 'GET' && pathname.endsWith('/recipients')) return json(res, 200, { recipients: messaging.list({ aiOnly: true }).map(({ id, name, botName, platform, ready, unavailableReason }) => ({ id, name, botName, platform, ready, unavailableReason })) });
      if (method === 'POST' && pathname.endsWith('/send')) return json(res, 200, await messaging.send(await bodyOf(req)));
      throw new HttpError('接口不存在', 404);
    }
    if (method === 'GET' && pathname === '/api/ai/config') return json(res, 200, {
      mcp: { mcpServers: { clawlink: { command: process.execPath, args: [path.join(__dirname, 'ai-client.js'), 'mcp', '--data-dir', path.resolve(dataDir)] } } },
      cli: { command: process.execPath, args: [path.join(__dirname, 'ai-client.js'), 'recipients', '--data-dir', path.resolve(dataDir)] }
    });
    if (method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, service: 'clawlink', version, platform: process.platform });
    if (method === 'GET' && pathname === '/api/state') return json(res, 200, viewState());
    if (method === 'GET' && pathname === '/api/screen/status') return json(res, 200, await native.screenStatus());
    if (method === 'GET' && pathname === '/api/commands/settings') return json(res, 200, { commands: commands.list() });
    if (method === 'GET' && pathname === '/api/native/discover') return json(res, 200, await native.discover());
    if (method === 'GET' && pathname === '/api/targets/pi') return json(res, 200, await pi.discover());
    if (method === 'GET' && pathname === '/api/targets/paseo') return json(res, 200, await paseo.discover());
    const body = ['POST', 'PATCH', 'DELETE'].includes(method) ? await bodyOf(req) : {};
    if (method === 'PATCH' && pathname === '/api/preferences') {
      if (!Object.keys(body).length || Object.keys(body).some(key => !['theme', 'language'].includes(key))) throw new HttpError('未知的偏好设置');
      if ('theme' in body && !['system', 'light', 'dark'].includes(body.theme)) throw new HttpError('主题应为 system、light 或 dark');
      if ('language' in body && !['zh-CN', 'en'].includes(body.language)) throw new HttpError('语言应为 zh-CN 或 en');
      state.preferences = { ...state.preferences, ...body }; save();
      return json(res, 200, { preferences: state.preferences });
    }
    if (method === 'PATCH' && pathname === '/api/commands/settings') { commands.update(body.commands); save(); return json(res, 200, { commands: commands.list() }); }
    if (method === 'POST' && pathname === '/api/screen/permission') return json(res, 200, await native.requestScreenPermission());
    const recipientMatch = pathname.match(/^\/api\/recipients\/([\w-]+)$/);
    if (method === 'PATCH' && recipientMatch) return json(res, 200, { recipient: messaging.patch(recipientMatch[1], body) });
    if (method === 'POST' && pathname === '/api/messages/send') return json(res, 200, await messaging.send(body, { ai: false, source: '控制台' }));
    if (method === 'POST' && pathname === '/api/native/permission') return json(res, 200, await native.requestPermission());
    if (method === 'POST' && pathname === '/api/bots') {
      if (!['wechat', 'telegram'].includes(body.platform)) throw new HttpError('平台应为 wechat 或 telegram');
      const name = clean(body.name); if (!name) throw new HttpError('请输入机器人名称');
      const target = body.target ? requireSession(body.target).id : '';
      const bot = { id: makeId(body.platform === 'wechat' ? 'wx' : 'tg'), name, platform: body.platform, handle: '', target, avatar: name[0].toUpperCase(), tone: ['orange', 'blue', 'green', 'violet'][state.bots.length % 4], status: 'pending', enabled: false };
      let validated;
      if (bot.platform === 'telegram') {
        validated = await adapters.telegramValidate(clean(body.token, 250));
        if (state.bots.some(x => x.platform === 'telegram' && x.handle === `@${validated.username}`)) throw new HttpError('此 Telegram 机器人已连接');
        bot.handle = `@${validated.username}`;
      }
      secrets[bot.id] = { allowedPeers: [], ...(validated ? { pairingCode: crypto.randomBytes(5).toString('hex'), token: clean(body.token, 250), offset: 0, seen: [] } : {}) };
      state.bots.push(bot); if (target) state.routes.push({ id: makeId('route'), bot: bot.id, command: '默认', target, on: true });
      activity(`创建机器人 ${name}`, '连接'); if (validated) connectBot(bot); save();
      return json(res, 201, { bot: viewState().bots.find(x => x.id === bot.id) });
    }
    const botMatch = pathname.match(/^\/api\/bots\/([^/]+)(?:\/(login\/start|login\/poll|start|stop|pairing|telegram))?$/);
    if (botMatch) {
      const bot = requireBot(decodeURIComponent(botMatch[1])); const action = botMatch[2];
      if (method === 'POST' && action === 'login/start') return json(res, 200, await startLogin(bot));
      if (method === 'POST' && action === 'login/poll') return json(res, 200, await pollLogin(bot, body));
      if (method === 'POST' && action === 'start') { if (!secrets[bot.id]?.token) throw new HttpError('尚未完成登录'); connectBot(bot); save(); return json(res, 200, { ok: true }); }
      if (method === 'POST' && action === 'stop') { stopBot(bot.id); bot.enabled = false; bot.status = 'stopped'; save(); return json(res, 200, { ok: true }); }
      if (method === 'POST' && action === 'pairing') {
        if (bot.platform !== 'telegram') throw new HttpError('微信扫码后自动授权本人，无需配对码');
        secrets[bot.id].pairingCode = crypto.randomBytes(5).toString('hex'); save(); return json(res, 200, { code: secrets[bot.id].pairingCode });
      }
      if (method === 'POST' && action === 'telegram') {
        if (bot.platform !== 'telegram') throw new HttpError('不是 Telegram 机器人');
        const token = clean(body.token, 250); const me = await adapters.telegramValidate(token);
        if (state.bots.some(x => x.id !== bot.id && x.handle === `@${me.username}`)) throw new HttpError('此 Telegram 机器人已连接');
        stopBot(bot.id); secrets[bot.id] = { ...secrets[bot.id], token, offset: 0, seen: [] }; bot.handle = `@${me.username}`; connectBot(bot); save(); return json(res, 200, { ok: true });
      }
      if (method === 'PATCH' && !action) {
        if (Object.hasOwn(body, 'allowedPeers') && (!Array.isArray(body.allowedPeers) || body.allowedPeers.some(x => typeof x !== 'string'))) throw new HttpError('聊天 ID 必须是字符串列表');
        if (Object.hasOwn(body, 'permissions')) patchPermissions(bot, body.permissions, [...commands.list().map(item => item.id), ...state.routes.filter(rule => rule.bot === bot.id && rule.command !== '默认').map(rule => `route:${rule.id}`)]);
        if (body.allowedPeers) { secrets[bot.id].allowedPeers = [...new Set(body.allowedPeers.map(x => clean(x)))].filter(Boolean); messaging.syncRecipients(); }
        if (body.name) bot.name = clean(body.name); save(); return json(res, 200, { ok: true });
      }
      if (method === 'DELETE' && !action) { stopBot(bot.id); bot.enabled = false; state.bots = state.bots.filter(x => x.id !== bot.id); state.routes = state.routes.filter(x => x.bot !== bot.id); Object.keys(state.peerRoutes).filter(x => JSON.parse(x)[0] === bot.id).forEach(x => delete state.peerRoutes[x]); delete secrets[bot.id]; messaging.syncRecipients(); logins.delete(bot.id); save(); return json(res, 200, { ok: true }); }
    }
    if (method === 'POST' && pathname === '/api/commands') {
      const bot = requireBot(body.botId); const peerId = clean(body.peerId);
      if (peerId && !secrets[bot.id]?.allowedPeers?.includes(peerId)) throw new HttpError('此聊天尚未授权');
      if (body.action && !['switch', 'broadcast', 'pause', 'resume'].includes(body.action)) throw new HttpError('控制台操作无效');
      const text = body.action ? `${commands.get(body.action).trigger} ${clean(body.argument)}` : body.text;
      if (commands.match(parse(text).trigger)?.id === 'screenshot') throw new HttpError('请在授权的微信或 Telegram 聊天中发送截图指令');
      return json(res, 200, await commandForBot(bot, text, peerId));
    }
    if (method === 'POST' && pathname === '/api/sessions') {
      const name = clean(body.name);
      const targetType = clean(body.targetType) || (body.provider === 'PI' ? 'pi' : body.provider === 'Paseo' && !body.bundleId ? 'paseo' : 'native');
      if (!['native', 'pi', 'paseo'].includes(targetType)) throw new HttpError('会话目标类型无效');
      const bundleId = targetType === 'native' ? clean(body.bundleId, 200) || PROVIDERS[clean(body.provider)] || '' : '';
      if (!name || targetType === 'native' && !validBundleId(bundleId)) throw new HttpError('请输入名称并选择目标应用');
      if (state.sessions.some(x => x.name === name)) throw new HttpError('会话名称已存在');
      const provider = targetType === 'pi' ? 'PI' : targetType === 'paseo' ? 'Paseo' : clean(body.provider) || providerNames.get(bundleId) || bundleId;
      const session = { id: makeId('session'), name, provider, targetType, bundleId,
        description: clean(body.description) || (targetType === 'native' ? `${process.platform === 'win32' ? 'Windows' : 'macOS'} 原生会话` : `${provider} 会话`),
        tone: targetType === 'pi' ? 'target-pi' : targetType === 'paseo' ? 'target-paseo' : targetTone(bundleId),
        logo: targetType === 'pi' || targetType === 'paseo' ? 'P' : targetLogo(bundleId), status: 'unbound' };
      state.sessions.push(session); activity(`创建会话 ${name}`); save(); return json(res, 201, { session });
    }
    if (method === 'POST' && pathname === '/api/native/inspect') {
      if (!validBundleId(body.bundleId)) throw new HttpError('应用标识无效');
      return json(res, 200, await native.inspect({ bundleId: clean(body.bundleId, 200), executablePath: String(body.executablePath || '').slice(0, 2000), windowTitle: String(body.windowTitle ?? '') }));
    }
    if (method === 'POST' && pathname === '/api/targets/bind') {
      const session = requireSession(body.sessionId);
      if (!['pi', 'paseo'].includes(session.targetType)) throw new HttpError('此会话需要绑定原生窗口');
      const adapter = session.targetType === 'pi' ? pi : paseo;
      const binding = await adapter.bind(body.binding || {}, dataDir);
      session.binding = binding; session.status = 'verified'; session.lastVerifiedAt = new Date().toISOString(); delete session.error;
      activity(`${session.name} ${session.provider} 会话绑定通过校验`, '连接', 'green'); save();
      return json(res, 200, { session });
    }
    if (method === 'POST' && pathname === '/api/native/bind') {
      const session = requireSession(body.sessionId); const source = body.binding || {};
      if (session.targetType && session.targetType !== 'native') throw new HttpError('此会话需要使用对应的 PI / Paseo 适配器');
      const expectedBundle = session.bundleId || PROVIDERS[session.provider];
      if (!validBundleId(source.bundleId) || source.bundleId !== expectedBundle) throw new HttpError('绑定应用与会话提供方不一致');
      const binding = {};
      for (const key of ['bundleId', 'windowTitle', 'markerPath', 'markerText', 'inputPath', 'replyPath', 'sendPath', 'navigationPath', 'navigationText', 'busyPath', 'busyText']) binding[key] = String(source[key] ?? '').slice(0, key.endsWith('Text') ? 8000 : 500);
      if (process.platform === 'win32') binding.executablePath = String(source.executablePath || '').slice(0, 2000);
      for (const key of ['markerPath', 'inputPath', 'replyPath']) if (!/^(root|\d+(\.\d+)*)$/.test(binding[key])) throw new HttpError(`请正确选择 ${key}`);
      for (const key of ['sendPath', 'navigationPath', 'busyPath']) if (binding[key] && !/^(root|\d+(\.\d+)*)$/.test(binding[key])) throw new HttpError(`元素路径 ${key} 无效`);
      if (!binding.markerText.trim() || /^(chatgpt|claude|openai|anthropic)$/i.test(binding.markerText.trim())) throw new HttpError('请绑定当前聊天的唯一标识，不能使用应用名称');
      if (binding.navigationPath && (binding.markerPath === binding.navigationPath || binding.markerPath.startsWith(`${binding.navigationPath}.`))) throw new HttpError('会话标识需要选取聊天正文中的标题，不能使用侧栏入口');
      if (!binding.sendPath) throw new HttpError('请选择发送按钮');
      binding.replyMode = source.replyMode === 'latest' ? 'latest' : 'append';
      binding.writeMode = source.writeMode === 'paste' ? 'paste' : 'auto';
      const checked = await native.validate(binding); binding.selectors = checked.selectors || {};
      session.bundleId = expectedBundle;
      session.binding = binding; session.status = 'verified'; session.lastVerifiedAt = new Date().toISOString(); delete session.error;
      activity(`${session.name} 原生窗口绑定通过校验`, '连接', 'green'); save(); return json(res, 200, { session });
    }
    if (method === 'POST' && ['/api/native/validate', '/api/native/send'].includes(pathname)) {
      const session = requireSession(body.sessionId); if (!session.binding) throw new HttpError('请先绑定目标会话');
      try {
        if (pathname.endsWith('/send') && !clean(body.text, 20000)) throw new HttpError('消息不能为空');
        const adapter = targetAdapter(session.binding);
        const result = pathname.endsWith('/send') ? { reply: await adapter.send(session.binding, clean(body.text, 20000)) } : await adapter.validate(session.binding);
        session.status = 'verified'; session.lastVerifiedAt = new Date().toISOString(); delete session.error; save();
        return json(res, 200, result);
      } catch (error) { session.status = 'error'; session.error = error.message; save(); throw error; }
    }
    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (method === 'PATCH' && sessionMatch) {
      const session = requireSession(sessionMatch[1]);
      if (typeof body.aiMessaging !== 'boolean') throw new HttpError('请选择是否开启回复指令发送');
      session.aiMessaging = body.aiMessaging; save(); return json(res, 200, { session });
    }
    if (method === 'DELETE' && sessionMatch) {
      const session = requireSession(sessionMatch[1]);
      if (state.routes.some(x => x.target === session.id) || Object.values(state.peerRoutes).some(x => x.target === session.id)) throw new HttpError('请先切换或移除此会话的路由规则');
      state.sessions = state.sessions.filter(x => x.id !== session.id); save(); return json(res, 200, { ok: true });
    }
    if (method === 'POST' && pathname === '/api/routes') {
      const bot = requireBot(body.bot); const target = body.target === 'all' ? 'all' : requireSession(body.target).id;
      const command = String(body.command || '').trim(); commands.validateRoute(command, bot.id);
      const meta = command === '默认' ? {} : commands.metadata({ trigger: command, description: body.description ?? '发送到指定会话', emoji: body.emoji || '' });
      const route = { id: makeId('route'), bot: bot.id, target, command, description: meta.description || '', emoji: meta.emoji || '', on: body.on !== false }; state.routes.push(route);
      if (command === '默认') bot.target = target; activity(`为 ${bot.name} 创建 ${command} 路由`); save(); return json(res, 201, { route });
    }
    const routeMatch = pathname.match(/^\/api\/routes\/([\w-]+)$/);
    if (routeMatch && ['PATCH', 'DELETE'].includes(method)) {
      const route = /^\d+$/.test(routeMatch[1]) ? state.routes[Number(routeMatch[1])] : state.routes.find(x => x.id === routeMatch[1]); if (!route) throw new HttpError('规则不存在', 404);
      if (method === 'DELETE') { state.routes.splice(state.routes.indexOf(route), 1); if (route.command === '默认') requireBot(route.bot).target = ''; }
      else {
        const command = body.command === undefined ? route.command : String(body.command).trim();
        if ((route.command === '默认') !== (command === '默认')) throw new HttpError('默认路由不使用触发指令，请另建自定义路由');
        commands.validateRoute(command, route.bot, route.id);
        const meta = command === '默认' ? {} : commands.metadata({ trigger: command, description: body.description ?? route.description ?? '发送到指定会话', emoji: body.emoji ?? route.emoji ?? '' });
        const target = body.target ? body.target === 'all' ? 'all' : requireSession(body.target).id : route.target;
        route.command = command; route.description = meta.description || ''; route.emoji = meta.emoji || '';
        if (typeof body.on === 'boolean') route.on = body.on;
        if (body.target) { route.target = target; if (route.command === '默认') requireBot(route.bot).target = route.target; }
      }
      save(); return json(res, 200, { ok: true });
    }
    throw new HttpError('接口不存在', 404);
  }
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host)) throw new HttpError('仅允许本机访问', 403);
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new HttpError('拒绝跨站请求', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError('拒绝跨站请求', 403);
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname.startsWith('/api/')) {
        if (['POST', 'PATCH', 'DELETE'].includes(req.method) && !req.headers['content-type']?.startsWith('application/json')) throw new HttpError('请使用 application/json', 415);
        return await api(req, res, url);
      }
      // Explicit public assets only: never serve data, credentials, dependencies or source.
      const files = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/i18n.js': 'i18n.js', '/locales/en.js': 'locales/en.js', '/styles.css': 'styles.css' };
      if (publicDir !== rootDir && /^\/assets\/[\w.-]+\.(js|css|woff2|svg|png)$/.test(url.pathname)) files[url.pathname] = url.pathname.slice(1);
      if (req.method !== 'GET' || !files[url.pathname]) throw new HttpError('文件不存在', 404);
      const file = files[url.pathname]; const ext = path.extname(file);
      const fullPath = path.join(publicDir, file); if (!fs.existsSync(fullPath)) throw new HttpError('文件不存在', 404);
      res.writeHead(200, { 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' }[ext], 'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'" });
      fs.createReadStream(fullPath).on('error', () => res.destroy()).pipe(res);
    } catch (error) { if (!res.headersSent) json(res, error.status || 400, { error: error.message || '请求失败' }); else res.end(); }
  });
  const aiEndpointFile = path.join(dataDir, 'ai-endpoint.json');
  server.on('listening', () => writeJson(aiEndpointFile, { url: `http://127.0.0.1:${server.address().port}`, token: messaging.token }));
  // Online means a poll actually succeeded, never just that a credential exists.
  for (const bot of state.bots) {
    if (secrets[bot.id]?.token && bot.enabled) connectBot(bot);
    else bot.status = secrets[bot.id]?.token ? 'stopped' : 'pending';
  }
  save();
  return { server, viewState, commandForBot, receive, async close() { closed = true; messaging.close(); for (const id of polling.keys()) stopBot(id); native.close?.(); pi.close?.(); paseo.close?.(); save(); if (server.listening) await new Promise(resolve => server.close(resolve)); if (fs.existsSync(aiEndpointFile)) fs.unlinkSync(aiEndpointFile); } };
}
if (require.main === module) {
  const dataDir = process.env.CLAWLINK_DATA_DIR || path.join(__dirname, 'data');
  let releaseLock;
  try { releaseLock = acquireLock(dataDir); } catch (error) { console.error(error.message); process.exit(1); }
  process.on('exit', releaseLock);
  const app = createApp();
  const port = Number(process.env.PORT || 4173);
  let shuttingDown = false;
  function stop() { if (shuttingDown) return; shuttingDown = true; app.close().then(() => process.exit(0)); }
  const parentPid = Number(process.env.CLAWLINK_PARENT_PID);
  if (Number.isInteger(parentPid) && parentPid > 0) {
    // An app force-quit must not leave hidden bot receivers behind.
    const watch = setInterval(() => { try { process.kill(parentPid, 0); } catch (error) { if (error.code === 'ESRCH') stop(); } }, 2000);
    watch.unref();
  }
  app.server.once('error', error => { console.error(`无法启动本地服务：${error.code || error.message}`); app.close().finally(() => process.exit(1)); });
  app.server.listen(port, '127.0.0.1', () => console.log(`ClawLink: http://localhost:${app.server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  // Desktop launchers use a private IPC channel for graceful Windows shutdown.
  if (process.send) { process.on('message', message => { if (message?.action === 'stop') stop(); }); process.on('disconnect', stop); }
}
module.exports = { createApp };
