const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const binary = path.resolve(__dirname, `../native/ClawLinkBridge${process.platform === 'win32' ? '.exe' : ''}`);
const children = new Set();
process.once('exit', () => { for (const child of children) child.kill(); });
function bridge(request) {
  return new Promise((resolve, reject) => {
    if (!['darwin', 'win32'].includes(process.platform)) return reject(new Error('原生会话连接支持 macOS 和 Windows'));
    if (!fs.existsSync(binary)) return reject(new Error('请先运行 npm run native:build 编译原生连接器'));
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    children.add(child);
    let output = ''; let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('原生连接器超时')); }, 20000);
    child.stdout.on('data', data => { size += data.length; if (size > (request.action === 'screenshot' ? 16_000_000 : 4_000_000)) child.kill(); else output += data; });
    child.on('error', () => { clearTimeout(timer); reject(new Error('无法启动原生连接器')); });
    child.on('close', () => {
      children.delete(child);
      clearTimeout(timer);
      try { const data = JSON.parse(output); if (!data.ok) throw new Error(data.error); resolve(data.result); }
      catch (error) { reject(new Error(error.message.startsWith('Unexpected') ? '原生连接器返回了无效结果' : error.message)); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}
function extractReply(before, after, prompt, mode) {
  if (!after || before === after) return '';
  if (mode === 'latest') return after.trim() === prompt.trim() ? '' : after.trim();
  // Append mode must preserve the old conversation. Refuse to echo its history.
  if (before && !after.startsWith(before)) return '';
  let delta = after.slice(before.length).trim();
  if (delta.startsWith(prompt.trim())) delta = delta.slice(prompt.trim().length).trim();
  return delta;
}
function createNative({ call = bridge, interval = 1200, minWait = 10000, stableWait = 6500, timeout = 180000 } = {}) {
  let tail = Promise.resolve();
  let closed = false;
  function ensureOpen() { if (closed) throw new Error('本地连接器已停止，未继续发送或读取'); }
  function exclusive(fn) { const next = tail.then(fn); tail = next.catch(() => {}); return next; }
  return {
    discover: () => call({ action: 'discover' }),
    requestPermission: () => call({ action: 'permission' }),
    screenStatus: () => call({ action: 'screenStatus' }),
    requestScreenPermission: () => call({ action: 'screenPermission' }),
    screenshot: async () => { ensureOpen(); const result = await call({ action: 'screenshot' }); ensureOpen(); return Buffer.from(result.base64, 'base64'); },
    inspect: binding => exclusive(() => { ensureOpen(); return call({ ...binding, action: 'inspect' }); }),
    validate: binding => exclusive(() => { ensureOpen(); return call({ ...binding, action: 'validate', activate: true }); }),
    send: (binding, text) => exclusive(async () => {
      ensureOpen();
      const start = Date.now();
      const sent = await call({ ...binding, action: 'send', text, activate: true });
      if (!sent.sent) throw new Error('原生应用未确认发送');
      let last = ''; let changedAt = Date.now();
      while (Date.now() - start < timeout) {
        await delay(interval);
        ensureOpen();
        // capture rechecks the conversation marker on every poll.
        const result = await call({ ...binding, action: 'capture' });
        const reply = extractReply(sent.before || '', result.text || '', text, binding.replyMode);
        if (reply !== last || result.busy) { last = reply; changedAt = Date.now(); }
        if (last && !result.busy && Date.now() - start >= minWait && Date.now() - changedAt >= stableWait) return last;
      }
      throw new Error('消息已提交，但未在等待时间内读取到完整回复。请检查原生会话，勿自动重发');
    }),
    close: () => { closed = true; if (call === bridge) for (const child of children) child.kill(); }
  };
}
module.exports = { createNative, extractReply, bridge, binary };
