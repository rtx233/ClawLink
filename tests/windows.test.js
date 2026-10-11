const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliLaunch, createCliRunner } = require('../server/cli');
const { desktopRuntime } = require('../server/paseo');
test('Windows npm shim 用 Node 入口运行，含空格/中文/特殊字符参数不经过 shell', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawlink shim & 中文-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = path.join(dir, 'node_modules/pi/dist/cli.js'); fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "process.stdin.on('data',d=>process.stdout.write(d));");
  const shim = path.join(dir, 'pi.cmd'); fs.writeFileSync(shim, '@"%dp0%\\node_modules\\pi\\dist\\cli.js" %*');
  const args = ['--session', path.join(dir, 'quoted & session.jsonl')];
  const launch = cliLaunch(shim, args, 'win32'); assert.equal(launch.command, process.execPath); assert.deepEqual(launch.args, [cli, ...args]);
  const runner = createCliRunner(); t.after(() => runner.close());
  assert.equal(await runner.run(launch.command, launch.args, { input: '中文 $HOME `text` &' }), '中文 $HOME `text` &');
  fs.writeFileSync(shim, 'echo unsupported'); assert.throws(() => cliLaunch(shim, [], 'win32'), /PI_CLI_PATH/);
});
test('Windows Paseo 从安装目录和自定义 exe 路径定位自身 SDK', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawlink-paseo-win-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = path.join(dir, 'Programs/Paseo'); fs.mkdirSync(path.join(app, 'resources/app.asar.unpacked/dist/daemon'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Paseo.exe'), ''); fs.writeFileSync(path.join(app, 'resources/app.asar'), ''); fs.writeFileSync(path.join(app, 'resources/app.asar.unpacked/dist/daemon/node-entrypoint-runner.js'), '');
  const runtime = desktopRuntime({ platform: 'win32', env: { LOCALAPPDATA: dir } });
  assert.equal(runtime.available, true); assert.equal(runtime.command, path.join(app, 'Paseo.exe'));
  assert.equal(desktopRuntime({ platform: 'win32', env: { PASEO_APP_PATH: runtime.command } }).available, true);
  assert.equal(desktopRuntime({ platform: 'win32', env: {} }).available, false);
});
