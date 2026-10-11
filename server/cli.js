const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function findExecutable(candidates, { platform = process.platform, env = process.env } = {}) {
  const pathsApi = platform === 'win32' ? path.win32 : path;
  const directories = (env.PATH || '').split(pathsApi.delimiter);
  for (const candidate of candidates.filter(Boolean)) {
    const names = platform === 'win32' && !pathsApi.extname(candidate) ? [candidate, ...['.exe', '.com', '.cmd', '.bat'].map(ext => candidate + ext)] : [candidate];
    const paths = names.flatMap(name => pathsApi.isAbsolute(name) ? [name] : directories.map(dir => pathsApi.join(dir, name)));
    for (const file of paths) {
      try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
    }
  }
  return '';
}
function cliLaunch(command, args, platform = process.platform) {
  if (/\.[cm]?js$/i.test(command)) return { command: process.execPath, args: [command, ...args] };
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    // Resolve npm's generated Node shim without invoking cmd.exe or passing
    // user-controlled paths/arguments through shell interpolation.
    const source = fs.readFileSync(command, 'utf8');
    const match = source.match(/"%dp0%[\\/]?(node_modules[\\/][^"\r\n]+\.[cm]?js)"/i);
    if (match && !match[1].split(/[\\/]/).includes('..')) {
      const file = path.resolve(path.dirname(command), ...match[1].split(/[\\/]/));
      if (fs.existsSync(file)) return { command: process.execPath, args: [file, ...args] };
    }
    throw new Error('无法安全读取 npm 命令入口；请将 PI_CLI_PATH 设置为 PI 的 cli.js 完整路径');
  }
  return { command, args };
}
function createQueue() {
  const pending = new Map(); let closed = false;
  return {
    enqueue(key, task) {
      if (closed) return Promise.reject(new Error('连接器已停止'));
      const next = (pending.get(key) || Promise.resolve()).catch(() => {}).then(() => {
        if (closed) throw new Error('连接器已停止');
        return task();
      });
      pending.set(key, next);
      next.finally(() => { if (pending.get(key) === next) pending.delete(key); }).catch(() => {});
      return next;
    },
    close() { closed = true; }
  };
}
function createCliRunner({ spawnImpl = spawn, killDelay = 1000 } = {}) {
  const active = new Map(); let closed = false;
  function run(command, args, { input = '', cwd, env = {}, timeout = 600000, maxOutput = 8000000 } = {}) {
    if (closed) return Promise.reject(new Error('连接器已停止'));
    return new Promise((resolve, reject) => {
      let child;
      try { const launch = cliLaunch(command, args); child = spawnImpl(launch.command, launch.args, { cwd, env: { ...process.env, ...env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || '/usr/bin:/bin'}` }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }); }
      catch (error) { reject(new Error(`无法启动连接器：${error.message}`)); return; }
      let stdout = '', stderr = '', failure, forceTimer, settled = false;
      function kill(signal) {
        if (process.platform === 'win32' && child.pid) {
          // Terminate the entire tool tree; killing only the npm/Node parent
          // would leave agents and their tools running after ClawLink exits.
          const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill()); return;
        }
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { child.kill(signal); }
      }
      function abort(error) {
        if (failure || settled) return;
        failure = error; kill('SIGTERM');
        forceTimer = setTimeout(() => kill('SIGKILL'), killDelay);
      }
      function finish(error, value) {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(forceTimer); active.delete(child);
        if (error) reject(error); else resolve(value);
      }
      const timer = setTimeout(() => abort(new Error('等待回复超时；消息可能已提交，请先在目标软件检查，ClawLink 不会自动重发')), timeout);
      active.set(child, abort);
      child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', data => { stdout += data.toString(); if (Buffer.byteLength(stdout) > maxOutput) abort(new Error('连接器输出过大，已停止读取；请检查目标会话')); });
      child.stderr?.on('data', data => { stderr = (stderr + data.toString()).slice(-20000); });
      child.stdin?.on('error', error => { if (error.code !== 'EPIPE') abort(error); });
      child.on('error', error => finish(new Error(`无法启动连接器：${error.message}`)));
      child.on('close', code => finish(failure || (code !== 0 ? new Error((stderr || `连接器退出码 ${code}`).trim().slice(-1800)) : null), stdout));
      child.stdin?.end(input);
    });
  }
  return { run, close() { closed = true; for (const abort of active.values()) abort(new Error('连接器已停止；已提交的消息不会自动重发')); } };
}
module.exports = { findExecutable, cliLaunch, createQueue, createCliRunner };
