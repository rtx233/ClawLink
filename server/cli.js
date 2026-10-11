const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function findExecutable(candidates) {
  const directories = (process.env.PATH || '').split(path.delimiter);
  for (const candidate of candidates.filter(Boolean)) {
    const paths = path.isAbsolute(candidate) ? [candidate] : directories.map(dir => path.join(dir, candidate));
    for (const file of paths) {
      try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
    }
  }
  return '';
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
      try { child = spawnImpl(command, args, { cwd, env: { ...process.env, ...env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || '/usr/bin:/bin'}` }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }); }
      catch (error) { reject(new Error(`无法启动连接器：${error.message}`)); return; }
      let stdout = '', stderr = '', failure, forceTimer, settled = false;
      function kill(signal) {
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
module.exports = { findExecutable, createQueue, createCliRunner };
