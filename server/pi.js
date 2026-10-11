const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { findExecutable, createQueue, createCliRunner } = require('./cli');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function findCommand() {
  return findExecutable([process.env.PI_CLI_PATH, path.join(os.homedir(), '.local/bin/pi'), '/opt/homebrew/bin/pi', '/usr/local/bin/pi', 'pi']);
}
function headerOf(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(16384); const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const header = JSON.parse(buffer.toString('utf8', 0, length).split('\n')[0]);
    if (header.type !== 'session' || !UUID.test(header.id) || !path.isAbsolute(header.cwd || '')) throw new Error();
    return header;
  } catch { throw new Error('不是有效的 PI 会话文件（缺少 session ID 或工作目录）'); }
  finally { fs.closeSync(fd); }
}
function absolute(value) {
  const text = String(value || '').trim();
  const expanded = text.startsWith('~/') ? path.join(os.homedir(), text.slice(2)) : text;
  if (!path.isAbsolute(expanded)) throw new Error('请输入绝对路径');
  return expanded;
}
function workdirOf(value) {
  const dir = fs.realpathSync(absolute(value));
  if (!fs.statSync(dir).isDirectory()) throw new Error('工作目录不存在');
  return dir;
}
function extractReply(output) {
  const assistants = [];
  for (const line of output.split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'message_end' && event.message?.role === 'assistant') assistants.push(event.message);
  }
  const last = assistants.at(-1);
  if (!last) throw new Error('PI 未返回可识别的助手回复；请检查 PI 登录、模型和扩展');
  if (['error', 'aborted'].includes(last.stopReason)) throw new Error(last.errorMessage || 'PI 生成失败或被中断');
  const text = (last.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
  if (!text) throw new Error('PI 未返回文本回复');
  return text;
}
function createPi({ command = findCommand(), runner = createCliRunner(), sessionRoot = path.join(os.homedir(), '.pi/agent/sessions'), timeout = 600000 } = {}) {
  const queue = createQueue();
  function discover() {
    const available = !!findExecutable([command]); const sessions = [];
    function scan(dir, depth = 0) {
      if (depth > 2) return;
      let files; try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of files) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) scan(file, depth + 1);
        else if (entry.isFile() && file.endsWith('.jsonl')) {
          try { const h = headerOf(file); sessions.push({ file, id: h.id, cwd: h.cwd, updatedAt: fs.statSync(file).mtimeMs }); } catch {}
        }
      }
    }
    scan(sessionRoot);
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return { available, command, sessions: sessions.slice(0, 200), defaultWorkdir: os.homedir() };
  }
  async function bind(source, dataDir) {
    if (!findExecutable([command])) throw new Error('未找到 PI CLI，请先安装并登录 PI');
    let file, header;
    if (source.mode === 'new') {
      const cwd = workdirOf(source.workdir); const id = crypto.randomUUID();
      const dir = path.join(dataDir, 'pi-sessions'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      file = path.join(dir, `${id}.jsonl`);
      header = { type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd };
      fs.writeFileSync(file, `${JSON.stringify(header)}\n`, { flag: 'wx', mode: 0o600 });
    } else {
      file = fs.realpathSync(absolute(source.sessionFile));
      if (!file.endsWith('.jsonl') || !fs.statSync(file).isFile()) throw new Error('请选择 PI 的 .jsonl 会话文件');
      header = headerOf(file); workdirOf(header.cwd);
    }
    return { type: 'pi', sessionFile: file, sessionId: header.id, workdir: header.cwd,
      provider: String(source.provider || '').trim().slice(0, 160), model: String(source.model || '').trim().slice(0, 160) };
  }
  async function validate(binding) {
    if (!findExecutable([command])) throw new Error('未找到 PI CLI，请先安装并登录 PI');
    const header = headerOf(binding.sessionFile);
    if (header.id !== binding.sessionId || header.cwd !== binding.workdir) throw new Error('PI 会话标识或工作目录已变化，请重新绑定');
    workdirOf(binding.workdir);
    return { text: `PI 会话 ${header.id}`, sessionFile: binding.sessionFile };
  }
  async function send(binding, message) {
    return queue.enqueue(fs.realpathSync(binding.sessionFile), async () => {
      await validate(binding);
      const args = ['-p', '--mode', 'json', '--session', binding.sessionFile];
      if (binding.provider) args.push('--provider', binding.provider);
      if (binding.model) args.push('--model', binding.model);
      const output = await runner.run(command, args, { input: message, cwd: binding.workdir, timeout });
      return extractReply(output);
    });
  }
  return { discover, bind, validate, send, close() { queue.close(); runner.close(); } };
}
module.exports = { createPi, findCommand, headerOf, extractReply };
