const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { acquireLock } = require('../server/runtime');

test('运行锁阻止重复接收，恢复已退出进程，保留损坏锁', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawlink-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const unlock = acquireLock(dir); assert.throws(() => acquireLock(dir), /已在运行/); unlock();
  const finished = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'service.lock'), JSON.stringify({ pid: Number(finished.stdout) }));
  const recovered = acquireLock(dir); recovered(); assert.equal(fs.existsSync(path.join(dir, 'service.lock')), false);
  fs.writeFileSync(path.join(dir, 'service.lock'), '{bad'); assert.throws(() => acquireLock(dir), /无法读取/);
  assert.equal(fs.readFileSync(path.join(dir, 'service.lock'), 'utf8'), '{bad');
});
