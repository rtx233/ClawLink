const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium, expect } = require('@playwright/test');
const { version } = require('../package.json');

test('独立安装包：内置 Node、生产页面、数据隔离、重启恢复偏好、退出停止服务', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const bundle = path.resolve(`release/ClawLink-${version}-arm64.app`);
  assert.ok(fs.existsSync(bundle), '先执行 npm run release');
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle]);
  for (const file of ['LICENSE', 'NOTICE']) assert.ok(fs.existsSync(path.join(bundle, 'Contents/Resources', file)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawlink-package-'));
  let diagnostic = '';
  let launcher, exited;
  function launch() {
    launcher = spawn(path.join(bundle, 'Contents/MacOS/ClawLink'), [], { env: { ...process.env, CLAWLINK_DATA_DIR: dir, CLAWLINK_NO_OPEN: '1', PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'pipe'] });
    launcher.stderr.on('data', bytes => { diagnostic += bytes; });
    exited = new Promise(resolve => launcher.once('exit', resolve));
  }
  launch();
  t.after(async () => {
    if (launcher.exitCode === null) {
      launcher.kill(); const timer = setTimeout(() => launcher.kill('SIGKILL'), 3500);
      await exited; clearTimeout(timer);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const endpointFile = path.join(dir, 'endpoint.json');
  for (let i = 0; i < 70 && !fs.existsSync(endpointFile); i += 1) { if (launcher.exitCode !== null) throw new Error(`安装包启动失败：${diagnostic}`); await delay(100); }
  assert.ok(fs.existsSync(endpointFile), fs.existsSync(path.join(dir, 'service.log')) ? fs.readFileSync(path.join(dir, 'service.log'), 'utf8') : '未生成服务地址');
  const { url, pid } = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
  const health = await (await fetch(`${url}/api/health`)).json(); assert.equal(health.version, version); assert.equal(health.ok, true);
  const state = await (await fetch(`${url}/api/state`)).json(); assert.equal(state.bots.length, 0); assert.equal(state.sessions.length, 0); assert.equal(state.service.nativeBuilt, true);
  assert.equal((await fetch(`${url}/server/data/secrets.json`)).status, 404);
  assert.equal((fs.statSync(path.join(dir, 'secrets.json')).mode & 0o777), 0o600);
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const failures = []; page.on('pageerror', error => failures.push(error.message));
  const response = await page.goto(url); assert.equal(response.status(), 200);
  await page.locator('#serviceStatus').filter({ hasText: '本地服务' }).waitFor();
  assert.equal(await page.locator('#metricBots').textContent(), '0');
  await page.click('[data-action="settings"]');
  await page.selectOption('#themeSelect', 'dark'); await expect(page.locator('#themeSelect')).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.selectOption('#languageSelect', 'en'); await expect(page.locator('#languageSelect')).toBeEnabled();
  await expect(page.locator('#modalTitle')).toHaveText('App settings');
  await page.keyboard.press('Escape');
  await page.evaluate(() => localStorage.clear()); await page.reload();
  await expect(page.locator('#serviceStatus')).toContainText('Local service');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.view.active')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: '/tmp/clawlink-release-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: '/tmp/clawlink-release-mobile.png', fullPage: true });
  assert.deepEqual(failures, []);
  launcher.kill('SIGTERM'); await exited;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(fs.existsSync(path.join(dir, 'service.lock')), false);
  assert.ok(fs.existsSync(path.join(dir, 'state.json')), '退出保留配置');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'))).preferences, { theme: 'dark', language: 'en' });
  fs.rmSync(endpointFile, { force: true }); launch();
  for (let i = 0; i < 70 && !fs.existsSync(endpointFile); i += 1) { if (launcher.exitCode !== null) throw new Error(`重启失败：${diagnostic}`); await delay(100); }
  const { url: restoredUrl } = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
  await page.evaluate(() => localStorage.clear()); await page.goto(restoredUrl);
  await expect(page.locator('#serviceStatus')).toContainText('Local service');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('真实 App 窗口：WKWebView 加载生产 UI 和原生设置桥接', { skip: process.platform !== 'darwin', timeout: 25000 }, async t => {
  const bundle = path.resolve(`release/ClawLink-${version}-arm64.app`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawlink-window-'));
  let diagnostic = '';
  const launcher = spawn(path.join(bundle, 'Contents/MacOS/ClawLink'), [], { env: { ...process.env, CLAWLINK_DATA_DIR: dir, CLAWLINK_NO_OPEN: '0', PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'pipe'] });
  launcher.stderr.on('data', bytes => { diagnostic += bytes; });
  const exited = new Promise(resolve => launcher.once('exit', resolve));
  t.after(async () => { if (launcher.exitCode === null) { launcher.kill(); const timer = setTimeout(() => launcher.kill('SIGKILL'), 3500); await exited; clearTimeout(timer); } fs.rmSync(dir, { recursive: true, force: true }); });
  const statusFile = path.join(dir, 'window-status.json');
  for (let i = 0; i < 150 && !fs.existsSync(statusFile); i++) { if (launcher.exitCode !== null) throw new Error(diagnostic || 'App 提前退出'); await delay(100); }
  assert.ok(fs.existsSync(statusFile), `真实 WKWebView 未加载 UI 或桥接未通过：${diagnostic}`);
  const status = JSON.parse(fs.readFileSync(statusFile));
  assert.equal(status.embedded, true); assert.equal(status.bridge, true); assert.match(status.title, /ClawLink/);
  const { url } = JSON.parse(fs.readFileSync(path.join(dir, 'endpoint.json')));
  const screen = await (await fetch(`${url}/api/screen/status`)).json();
  assert.equal(typeof screen.allowed, 'boolean');
  // This read-only test does not register a login item or request system screen access.
});
