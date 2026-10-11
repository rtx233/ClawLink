const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createQueue, createCliRunner } = require('./cli');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function desktopRuntime({ platform = process.platform, env = process.env } = {}) {
  const candidates = [env.PASEO_APP_PATH, ...(platform === 'win32' ? [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs/Paseo'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Paseo'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Paseo')
  ] : ['/Applications/Paseo.app'])].filter(Boolean);
  function locate(app) {
  if (platform === 'win32' && /\.exe$/i.test(app)) app = path.dirname(app);
  const resources = path.join(app, platform === 'win32' ? 'resources' : 'Contents/Resources');
  const command = path.join(app, platform === 'win32' ? 'Paseo.exe' : 'Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper');
  const runner = path.join(resources, 'app.asar.unpacked/dist/daemon/node-entrypoint-runner.js');
  // Paseo owns its SDK and transport configuration. Load its installed CLI
  // connection utility with its own Electron runtime (which understands asar).
  return { command, runner, clientModule: path.join(resources, 'app.asar/node_modules/@getpaseo/cli/dist/utils/client.js'), available: fs.existsSync(command) && fs.existsSync(runner) && fs.existsSync(path.join(resources, 'app.asar')) };
  }
  const found = candidates.map(locate);
  return found.find(runtime => runtime.available) || found[0] || { available: false };
}
function createPaseo({ runner = createCliRunner(), runtime = desktopRuntime(), timeout = 600000 } = {}) {
  const queue = createQueue();
  async function call(input) {
    if (!runtime.available) throw new Error('未找到 Paseo 桌面客户端；请安装并启动 Paseo，或设置 PASEO_APP_PATH');
    const output = await runner.run(runtime.command, [runtime.runner, 'node-script', path.join(__dirname, 'paseo-worker.mjs'), runtime.clientModule], {
      input: JSON.stringify({ ...input, timeout }), timeout: input.action === 'send' ? timeout + 30000 : 30000,
      env: { ELECTRON_RUN_AS_NODE: '1', PASEO_NODE_ENV: 'production', PASEO_DESKTOP_MANAGED: '1' }
    });
    let data;
    for (const line of output.trim().split('\n').reverse()) { try { const value = JSON.parse(line); if (typeof value.ok === 'boolean') { data = value; break; } } catch {} }
    if (!data) throw new Error('无法识别 Paseo SDK 返回数据，可能需要升级 ClawLink 适配器');
    if (!data.ok) throw new Error(data.error || 'Paseo 连接失败');
    return data.result;
  }
  async function discover() {
    if (!runtime.available) return { available: false, agents: [], error: '未安装 Paseo 桌面客户端' };
    try { return await call({ action: 'discover' }); }
    catch (error) { return { available: false, agents: [], error: error.message }; }
  }
  async function validate(binding) {
    if (!UUID.test(binding.agentId || '')) throw new Error('请输入完整的 Paseo 会话 ID');
    return call({ action: 'validate', agentId: binding.agentId });
  }
  async function bind(source) {
    const result = await validate(source);
    return { type: 'paseo', agentId: result.agentId, name: result.name };
  }
  function send(binding, message) {
    return queue.enqueue(binding.agentId, async () => {
      if (!UUID.test(binding.agentId || '')) throw new Error('Paseo 会话 ID 无效');
      const result = await call({ action: 'send', agentId: binding.agentId, message, messageId: crypto.randomUUID() });
      if (!result.reply?.trim()) throw new Error('Paseo 未返回文本回复');
      return result.reply;
    });
  }
  return { discover, bind, validate, send, close() { queue.close(); runner.close(); } };
}
module.exports = { createPaseo, desktopRuntime };
