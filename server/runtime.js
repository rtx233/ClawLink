const fs = require('node:fs');
const path = require('node:path');

function acquireLock(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'service.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); fs.closeSync(fd);
      return () => {
        try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file); } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid;
      try { pid = JSON.parse(fs.readFileSync(file, 'utf8')).pid; } catch { throw new Error('服务锁无法读取，请检查 service.lock；未修改已有数据'); }
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('服务锁无效，请检查 service.lock；未修改已有数据');
      try { process.kill(pid, 0); throw new Error('同一工作区的 ClawLink 服务已在运行，请使用已有控制台'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      fs.unlinkSync(file);
    }
  }
  throw new Error('无法获取工作区服务锁');
}
module.exports = { acquireLock };
