const crypto = require('node:crypto');

const WECHAT_BASE = 'https://ilinkai.weixin.qq.com';
// Protocol metadata from @tencent-weixin/openclaw-weixin 2.4.10.
const VERSION = '2.4.10';
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 10;
class UpstreamError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
function trustedWechatBase(value) {
  const url = new URL(value || WECHAT_BASE);
  if (url.protocol !== 'https:' || !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com')) || url.username || url.password || url.port) {
    throw new Error('微信返回了不受信任的服务地址');
  }
  return url.origin;
}
function wechatHeaders(token) {
  return {
    'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(crypto.randomBytes(4).readUInt32BE())).toString('base64'),
    'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(CLIENT_VERSION),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}
function chunks(text, limit) {
  const chars = Array.from(text); const result = [];
  for (let i = 0; i < chars.length; i += limit) result.push(chars.slice(i, i + limit).join(''));
  return result;
}
function createAdapters({ fetchImpl = fetch, wechatBase = WECHAT_BASE, telegramBase = 'https://api.telegram.org', allowTestHosts = false } = {}) {
  const validateBase = value => allowTestHosts ? new URL(value || wechatBase).origin : trustedWechatBase(value || wechatBase);
  async function request(url, options = {}, timeout = 18000, signal) {
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
      if (!response.ok) throw new UpstreamError(`平台请求失败（HTTP ${response.status}）`, response.status);
      const data = await response.json();
      const code = data.errcode || data.ret;
      if (code) throw new UpstreamError(`微信接口错误（${code}）`, code);
      if (data.ok === false) throw new UpstreamError(`Telegram 接口错误（${data.error_code || '未知'}）：${String(data.description || '').replace(/\d{5,}:[\w-]+/g, '[已隐藏]')}`, data.error_code);
      return data;
    } catch (error) {
      if (error instanceof UpstreamError || error.name === 'TimeoutError' || signal?.aborted) throw error;
      throw new UpstreamError('无法连接平台，请检查网络连接');
    }
  }
  const wxPost = (base, endpoint, token, body, timeout, signal) => request(`${validateBase(base)}/ilink/bot/${endpoint}`, {
    method: 'POST', headers: wechatHeaders(token), body: JSON.stringify({ ...body, base_info: { channel_version: VERSION, bot_agent: 'ClawLink' } })
  }, timeout, signal);
  const tg = (token, method, body = {}, timeout, signal) => request(`${telegramBase}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeout, signal);
  return {
    validateBase,
    async qrStart(tokens = []) {
      const data = await wxPost(wechatBase, 'get_bot_qrcode?bot_type=3', '', { local_token_list: tokens.slice(-10) });
      if (!data.qrcode || !data.qrcode_img_content) throw new Error('微信未返回可用的二维码');
      return data;
    },
    async qrPoll(login, verifyCode) {
      const query = new URLSearchParams({ qrcode: login.qrcode });
      if (verifyCode) query.set('verify_code', verifyCode);
      try { return await request(`${validateBase(login.base)}/ilink/bot/get_qrcode_status?${query}`, { headers: wechatHeaders() }, 38000); }
      catch (error) { if (error.name === 'TimeoutError') return { status: 'wait' }; throw error; }
    },
    async telegramValidate(token) {
      if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('请输入有效的 BotFather Token');
      const [me, webhook] = await Promise.all([tg(token, 'getMe'), tg(token, 'getWebhookInfo')]);
      if (!me.result?.is_bot) throw new Error('该 Token 不属于 Telegram 机器人');
      if (webhook.result?.url) throw new Error('此机器人已配置 webhook，请先在原有服务中取消 webhook，再接入 ClawLink');
      return me.result;
    },
    async updates(bot, secret, signal) {
      if (bot.platform === 'telegram') {
        const data = await tg(secret.token, 'getUpdates', { offset: secret.offset || 0, timeout: 30, allowed_updates: ['message'] }, 38000, signal);
        return { cursor: data.result?.length ? Math.max(...data.result.map(x => x.update_id)) + 1 : secret.offset || 0,
          messages: (data.result || []).filter(x => x.message && !x.message.from?.is_bot).map(x => ({
            id: String(x.update_id), peerId: String(x.message.chat.id), senderId: String(x.message.from?.id || ''),
            group: x.message.chat.type !== 'private', text: x.message.text || '', unsupported: !x.message.text,
            createdAt: x.message.date * 1000
          })) };
      }
      let data;
      try { data = await wxPost(secret.base, 'getupdates', secret.token, { get_updates_buf: secret.cursor || '' }, 38000, signal); }
      catch (error) { if (error.name === 'TimeoutError') return { cursor: secret.cursor || '', messages: [] }; throw error; }
      return { cursor: data.get_updates_buf ?? secret.cursor ?? '', messages: (data.msgs || []).filter(x => x.message_type === 1 && x.from_user_id && (x.message_state == null || x.message_state === 2)).map(x => ({
        id: String(x.message_id ?? crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex')),
        peerId: x.from_user_id, senderId: x.from_user_id, group: false,
        text: (x.item_list || []).map(item => item.text_item?.text || item.voice_item?.text || '').filter(Boolean).join('\n'),
        contextToken: x.context_token || '', createdAt: x.create_time_ms
      })) };
    },
    async send(bot, secret, event, text) {
      if (bot.platform === 'telegram') {
        for (const piece of chunks(text, 3500)) await tg(secret.token, 'sendMessage', { chat_id: event.peerId, text: piece });
      } else {
        if (!event.contextToken) throw new Error('缺少微信消息上下文，无法回复；请重新给机器人发送消息');
        for (const piece of chunks(text, 1800)) await wxPost(secret.base, 'sendmessage', secret.token, { msg: {
          from_user_id: '', to_user_id: event.peerId, client_id: `clawlink-${crypto.randomUUID()}`,
          message_type: 2, message_state: 2, context_token: event.contextToken,
          item_list: [{ type: 1, text_item: { text: piece } }]
        } });
      }
    },
    async sendDirect(bot, secret, peerId, text) {
      if (!peerId) throw new Error('平台未返回可用的设备会话');
      if (bot.platform === 'telegram') {
        for (const piece of chunks(text, 3500)) await tg(secret.token, 'sendMessage', { chat_id: peerId, text: piece });
        return;
      }
      for (const piece of chunks(text, 1800)) await wxPost(secret.base, 'sendmessage', secret.token, { msg: {
        from_user_id: '', to_user_id: peerId, client_id: `clawlink-${crypto.randomUUID()}`,
        message_type: 2, message_state: 2,
        item_list: [{ type: 1, text_item: { text: piece } }]
      } });
    }
  };
}
module.exports = { createAdapters, chunks, trustedWechatBase };
