const crypto = require('node:crypto');
const Lark = require('@larksuiteoapi/node-sdk');
const Discord = require('discord.js');
const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };

class PlatformError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
// Discord counts UTF-16 units; Feishu limits the UTF-8 size of message content.
// Neither splitter breaks a Unicode code point.
function splitText(text, limit, measure = value => value.length) {
  const pieces = []; let piece = '', size = 0;
  for (const char of String(text)) {
    const cost = measure(char);
    if (size + cost > limit && piece) { pieces.push(piece); piece = ''; size = 0; }
    piece += char; size += cost;
  }
  if (piece) pieces.push(piece);
  return pieces;
}
function feishuEvent(data, botId) {
  const { sender, message } = data || {};
  if (!message?.message_id || !message.chat_id || sender?.sender_type !== 'user' || !sender.sender_id?.open_id || sender.sender_id.open_id === botId) return;
  const group = message.chat_type !== 'p2p';
  const mentions = (message.mentions || []).filter(item => item.id?.open_id === botId);
  if (group && !mentions.length) return;
  let text = '';
  if (message.message_type === 'text') {
    try { text = JSON.parse(message.content).text || ''; } catch { return; }
    if (typeof text !== 'string') return;
    for (const mention of mentions) if (mention.key) text = text.split(mention.key).join('');
  }
  return { id: message.message_id, peerId: message.chat_id, senderId: sender.sender_id.open_id, group, text: text.trim(), unsupported: message.message_type !== 'text', createdAt: Number(message.create_time) };
}
function discordEvent(message, botId) {
  if (!message?.id || !message.channelId || !message.author || message.author.bot || message.webhookId || message.author.id === botId) return;
  const group = !!message.guildId;
  const mention = new RegExp(`<@!?${botId}>`, 'g');
  const text = String(message.content || '');
  if (group && !mention.test(text)) return;
  return { id: message.id, peerId: message.channelId, senderId: message.author.id, group, text: text.replace(mention, '').trim(), unsupported: !text, createdAt: message.createdTimestamp };
}
function createBotPlatforms({ fetchImpl = fetch, feishuBase = 'https://open.feishu.cn', discordBase = 'https://discord.com/api/v10', allowTestHosts = false,
  feishuSocket = options => new Lark.WSClient(options), discordClient = options => new Discord.Client(options) } = {}) {
  if (!allowTestHosts && (feishuBase !== 'https://open.feishu.cn' || discordBase !== 'https://discord.com/api/v10')) throw new Error('机器人服务地址不可更改');
  const tokens = new Map();
  async function request(platform, endpoint, options = {}) {
    try {
      const response = await fetchImpl(`${platform === 'feishu' ? feishuBase : discordBase}${endpoint}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new PlatformError(`${platform === 'feishu' ? '飞书' : 'Discord'} 请求失败（HTTP ${response.status}）`, response.status);
      const data = await response.json();
      if (platform === 'feishu' && data.code) throw new PlatformError(`飞书接口错误（${data.code}），请检查应用凭据和权限`, data.code);
      return data;
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      // SDK/network errors can contain a credential-bearing request URL/body.
      throw new PlatformError(`${platform === 'feishu' ? '飞书' : 'Discord'} 请求未确认，请检查网络及平台配置`);
    }
  }
  const jsonPost = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const tokenKey = secret => crypto.createHash('sha256').update(`${secret.appId}\n${secret.appSecret}`).digest('hex');
  async function feishuToken(secret) {
    const key = tokenKey(secret); const prior = tokens.get(key);
    if (prior?.expiresAt > Date.now()) return prior.token;
    const data = await request('feishu', '/open-apis/auth/v3/tenant_access_token/internal', jsonPost({ app_id: secret.appId, app_secret: secret.appSecret }));
    if (!data.tenant_access_token) throw new PlatformError('飞书未返回可用的访问凭据');
    tokens.set(key, { token: data.tenant_access_token, expiresAt: Date.now() + Math.max(0, (Number(data.expire) || 0) - 60) * 1000 });
    // Bound memory usage when many credential replacements are made.
    if (tokens.size > 100) tokens.delete(tokens.keys().next().value);
    return data.tenant_access_token;
  }
  async function feishuRequest(secret, endpoint, options = {}) {
    const token = await feishuToken(secret);
    try { return await request('feishu', endpoint, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } }); }
    catch (error) { if ([401, 403, 99991663, 99991664, 99991668].includes(error.code)) tokens.delete(tokenKey(secret)); throw error; }
  }
  const discordRequest = (secret, endpoint, options = {}) => request('discord', endpoint, { ...options, headers: { ...options.headers, Authorization: `Bot ${secret.token}` } });
  return {
    async validate(platform, fields) {
      if (platform === 'feishu') {
        const appId = String(fields.appId || '').trim(); const appSecret = String(fields.appSecret || '').trim();
        if (!/^cli_[0-9a-fA-F]{16}$/.test(appId) || appSecret.length < 10 || appSecret.length > 250 || /\s/.test(appSecret)) throw new PlatformError('请输入有效的飞书 App ID 和 App Secret');
        const secret = { appId, appSecret };
        const data = await feishuRequest(secret, '/open-apis/bot/v3/info');
        if (!data.bot?.open_id) throw new PlatformError('请先在飞书应用中开启机器人能力');
        return { credentials: { ...secret, botId: data.bot.open_id }, identity: data.bot.open_id, handle: data.bot.app_name || appId };
      }
      if (platform === 'discord') {
        const token = String(fields.token || '').trim().replace(/^Bot\s+/i, '');
        if (!/^[A-Za-z0-9._-]{30,250}$/.test(token)) throw new PlatformError('请输入有效的 Discord Bot Token');
        const data = await discordRequest({ token }, '/users/@me');
        if (!data.bot || !/^\d{5,25}$/.test(data.id)) throw new PlatformError('该 Token 不属于 Discord 机器人');
        return { credentials: { token, botId: data.id }, identity: data.id, handle: `@${data.username || data.id}` };
      }
      throw new PlatformError('不支持此机器人平台');
    },
    subscribe(bot, secret, { signal, onMessage, onStatus }) {
      if (signal.aborted) return;
      let client, timeout, stopped = false;
      const status = (value, error, fatal = false) => { if (!stopped && !signal.aborted) onStatus({ status: value, error, fatal }); };
      const online = () => { clearTimeout(timeout); status('online'); };
      const deliver = event => { if (!stopped && !signal.aborted && event) onMessage(event); };
      const cleanup = () => {
        if (stopped) return; stopped = true; clearTimeout(timeout); signal.removeEventListener('abort', cleanup);
        if (bot.platform === 'feishu') client?.close({ force: true });
        else if (client) Promise.resolve(client.destroy()).catch(() => {});
      };
      signal.addEventListener('abort', cleanup, { once: true });
      // A resolved SDK start/login alone never marks a bot online.
      timeout = setTimeout(() => status('error', '机器人连接超时，请检查网络、凭据和事件配置'), 45000); timeout.unref?.();
      try {
        if (bot.platform === 'feishu') {
          client = feishuSocket({ appId: secret.appId, appSecret: secret.appSecret, autoReconnect: true, handshakeTimeoutMs: 30000,
            logger: quietLogger, loggerLevel: Lark.LoggerLevel.error,
            onReady: online, onReconnected: online, onReconnecting: () => status('connecting'),
            onError: () => status('error', '飞书连接失败，请检查长连接事件配置、应用凭据及发布状态') });
          const eventDispatcher = new Lark.EventDispatcher({ logger: quietLogger, loggerLevel: Lark.LoggerLevel.error }).register({ 'im.message.receive_v1': data => { deliver(feishuEvent(data, secret.botId)); } });
          Promise.resolve(client.start({ eventDispatcher })).catch(() => status('error', '飞书连接失败，请检查长连接事件配置、应用凭据及发布状态'));
        } else if (bot.platform === 'discord') {
          client = discordClient({ intents: [Discord.GatewayIntentBits.Guilds, Discord.GatewayIntentBits.GuildMessages, Discord.GatewayIntentBits.DirectMessages, Discord.GatewayIntentBits.MessageContent], partials: [Discord.Partials.Channel] });
          const failure = error => {
            const code = Number(error?.code);
            const fatal = [4004, 4013, 4014].includes(code) || error?.code === 'TokenInvalid' || error?.code === 'DisallowedIntents';
            status(fatal ? 'expired' : 'error', code === 4014 || error?.code === 'DisallowedIntents' ? '请在 Discord Developer Portal 开启 Message Content Intent 后重新连接' : 'Discord 连接失败，请检查 Bot Token、Intent 和网络', fatal);
          };
          client.on(Discord.Events.ClientReady, online).on(Discord.Events.MessageCreate, message => deliver(discordEvent(message, secret.botId)))
            .on(Discord.Events.ShardReconnecting, () => status('connecting')).on(Discord.Events.ShardResume, online)
            .on(Discord.Events.ShardDisconnect, event => [4004, 4013, 4014].includes(event?.code) ? failure(event) : status('connecting'))
            .on(Discord.Events.ShardError, failure).on(Discord.Events.Error, failure)
            .on(Discord.Events.Invalidated, () => status('error', 'Discord 会话失效，请重新连接', true));
          Promise.resolve(client.login(secret.token)).catch(failure);
        } else throw new PlatformError('不支持此机器人平台');
      } catch { status('error', '无法启动机器人连接，请检查平台配置', true); cleanup(); }
    },
    async send(bot, secret, event, text) {
      if (bot.platform === 'feishu') {
        for (const piece of splitText(text, 12000, value => Buffer.byteLength(value))) await feishuRequest(secret, '/open-apis/im/v1/messages?receive_id_type=chat_id', jsonPost({ receive_id: event.peerId, msg_type: 'text', content: JSON.stringify({ text: piece }), uuid: crypto.randomUUID() }));
      } else if (bot.platform === 'discord') {
        for (const piece of splitText(text, 2000)) await discordRequest(secret, `/channels/${encodeURIComponent(event.peerId)}/messages`, jsonPost({ content: piece, allowed_mentions: { parse: [] } }));
      } else throw new PlatformError('不支持此机器人平台');
    },
    async sendImage(bot, secret, event, bytes, { canSend = () => true } = {}) {
      const ensureAllowed = () => { if (!canSend()) throw new PlatformError('截图权限已变更，未继续发送'); };
      ensureAllowed();
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const file = new Blob([bytes], { type: png ? 'image/png' : 'image/jpeg' });
      if (bot.platform === 'feishu') {
        const form = new FormData(); form.append('image_type', 'message'); form.append('image', file, `screenshot.${png ? 'png' : 'jpg'}`);
        const data = await feishuRequest(secret, '/open-apis/im/v1/images', { method: 'POST', body: form });
        if (!data.data?.image_key) throw new PlatformError('飞书未返回图片标识，请检查图片上传权限');
        ensureAllowed();
        await feishuRequest(secret, '/open-apis/im/v1/messages?receive_id_type=chat_id', jsonPost({ receive_id: event.peerId, msg_type: 'image', content: JSON.stringify({ image_key: data.data.image_key }), uuid: crypto.randomUUID() }));
      } else if (bot.platform === 'discord') {
        const form = new FormData(); form.append('payload_json', JSON.stringify({ allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: `screenshot.${png ? 'png' : 'jpg'}` }] }));
        form.append('files[0]', file, `screenshot.${png ? 'png' : 'jpg'}`); ensureAllowed();
        await discordRequest(secret, `/channels/${encodeURIComponent(event.peerId)}/messages`, { method: 'POST', body: form });
      } else throw new PlatformError('不支持此机器人平台');
    },
    close() { tokens.clear(); }
  };
}
module.exports = { createBotPlatforms, feishuEvent, discordEvent, splitText };
