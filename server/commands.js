const DEFAULTS = [
  ['help', '/help', '查看可用指令'], ['start', '/start', '开始使用并查看帮助'],
  ['pair', '/pair', '授权机器人私聊', '配对码'], ['sessions', '/sessions', '列出会话'],
  ['route', '/route', '查看当前路由'], ['switch', '/switch', '切换目标会话', '会话名'],
  ['broadcast', '/broadcast', '下一条消息发送到全部已绑定会话'],
  ['pause', '/pause', '暂停消息路由'], ['resume', '/resume', '恢复消息路由'],
  ['screenshot', '/screenshot', '截取电脑当前主屏幕并发回图片']
].map(([id, trigger, description, argument = '']) => ({ id, trigger, description, argument, emoji: '' }));
class CommandError extends Error { constructor(message) { super(message); this.status = 400; } }
function validTrigger(value) {
  return typeof value === 'string' && value.length <= 64 && value !== '默认' && /^\/?[\p{L}\p{N}\p{M}\p{So}\p{Sk}\p{Cf}_\-\[\]！!]+$/u.test(value) && value !== '/';
}
function parse(text) {
  const [first = '', ...parts] = String(text || '').trim().split(/\s+/);
  return { trigger: first.replace(/@[A-Za-z0-9_]+$/, ''), argument: parts.join(' ') };
}
function createCommands(state) {
  state.commands ||= {};
  function list() { return DEFAULTS.map(item => ({ ...item, ...state.commands[item.id], id: item.id, argument: item.argument })); }
  const get = id => list().find(item => item.id === id);
  const match = trigger => list().find(item => item.trigger === trigger);
  function metadata(source) {
    if (!validTrigger(source.trigger)) throw new CommandError('指令须为不超过 64 字的单个词，可使用 /、中文、emoji 或 [微笑] 等微信表情');
    if (typeof source.description !== 'string' || !source.description.trim() || source.description.length > 160 || /[\r\n]/.test(source.description)) throw new CommandError('请输入不超过 160 字的单行说明');
    if (typeof (source.emoji || '') !== 'string' || (source.emoji || '').length > 32 || /[\r\n]/.test(source.emoji || '')) throw new CommandError('表情须为不超过 32 字的单行文字');
    return { trigger: source.trigger, description: source.description.trim(), emoji: source.emoji || '' };
  }
  function update(items) {
    if (!Array.isArray(items) || !items.length) throw new CommandError('请提供要修改的指令');
    const candidate = Object.fromEntries(list().map(item => [item.id, item])); const ids = new Set();
    for (const item of items) {
      if (!item || !candidate[item.id] || ids.has(item.id)) throw new CommandError('指令 ID 无效或重复');
      ids.add(item.id); candidate[item.id] = { ...candidate[item.id], ...metadata(item) };
    }
    const triggers = Object.values(candidate).map(item => item.trigger);
    if (new Set(triggers).size !== triggers.length || state.routes.some(rule => triggers.includes(rule.command))) throw new CommandError('指令名称重复，或与自定义路由指令冲突');
    for (const id of ids) state.commands[id] = metadata(candidate[id]);
  }
  function validateRoute(command, botId, ignoreId) {
    if (command !== '默认' && (!validTrigger(command) || match(command))) throw new CommandError('自定义指令格式无效，或与内置指令冲突');
    if (state.routes.some(rule => rule.id !== ignoreId && rule.bot === botId && rule.command === command)) throw new CommandError('此机器人已有同名规则');
  }
  function help(bot, allowed) {
    const rows = list().filter(item => (item.id !== 'pair' || bot.platform !== 'wechat') && allowed(item.id));
    return [...rows.map(item => `${item.emoji ? `${item.emoji} ` : ''}${item.trigger}${item.argument ? ` ${item.argument}` : ''} ${item.description}`),
      ...state.routes.filter(rule => rule.bot === bot.id && rule.on && rule.command !== '默认' && allowed(`route:${rule.id}`)).map(rule => `${rule.emoji ? `${rule.emoji} ` : ''}${rule.command} 消息内容 ${rule.description || '发送到指定会话'}`)].join('\n') || '此账户暂无可用指令。';
  }
  return { list, get, match, update, validateRoute, help, metadata };
}
module.exports = { createCommands, parse, validTrigger };
