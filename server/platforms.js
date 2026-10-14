const platforms = {
  wechat: { label: '微信', prefix: 'wx' },
  telegram: { label: 'Telegram', prefix: 'tg' },
  feishu: { label: '飞书', prefix: 'fs' },
  discord: { label: 'Discord', prefix: 'dc' }
};
const configured = (bot, secret) => bot.platform === 'feishu' ? !!(secret?.appId && secret?.appSecret) : !!secret?.token;
const streaming = bot => ['feishu', 'discord'].includes(bot.platform);
module.exports = { platforms, configured, streaming };
