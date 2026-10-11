const defaults = () => ({ forwardMessages: true, sendMessages: true, screenshot: false, commands: {} });
function permissionsFor(bot) { return { ...defaults(), ...bot.permissions, commands: { ...bot.permissions?.commands } }; }
function commandAllowed(bot, id) {
  const permissions = permissionsFor(bot);
  return permissions.commands[id] !== false && (id !== 'screenshot' || permissions.screenshot);
}
function patchPermissions(bot, input, validIds) {
  const fail = message => { const error = new Error(message); error.status = 400; throw error; };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('权限必须是对象');
  const next = permissionsFor(bot);
  for (const [key, value] of Object.entries(input)) {
    if (['forwardMessages', 'sendMessages', 'screenshot'].includes(key)) {
      if (typeof value !== 'boolean') fail('权限开关必须是布尔值'); next[key] = value;
    } else if (key === 'commands') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('指令权限必须是对象');
      for (const [id, enabled] of Object.entries(value)) {
        if (!validIds.includes(id) || typeof enabled !== 'boolean') fail('指令权限 ID 无效或开关不是布尔值');
        next.commands[id] = enabled;
      }
    } else fail('未知权限设置');
  }
  bot.permissions = next;
  return next;
}
module.exports = { permissionsFor, commandAllowed, patchPermissions };
