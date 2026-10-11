const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { bridge } = require('../server/native');
test('Windows UI Automation：真实窗口发现、发送、中文回复、切换、草稿和身份保护', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/build-windows-native.ps1'), '-Fixture'], { stdio: 'inherit' });
  const fixture = spawn(path.resolve('native/ClawLinkFixture.exe'), [], { stdio: 'ignore' });
  const exited = new Promise(resolve => fixture.once('exit', resolve));
  t.after(async () => { if (fixture.exitCode === null) fixture.kill(); await exited; });
  let app;
  for (let i = 0; i < 20 && !app; i++) { await delay(250); app = (await bridge({ action: 'discover' })).apps.find(app => app.name === 'ClawLinkFixture'); }
  assert.ok(app, '测试窗口应被实际 UIA 发现');
  const target = { bundleId: app.bundleId, executablePath: app.path, windowTitle: 'ClawLink UIA Fixture' };
  const { nodes } = await bridge({ ...target, action: 'inspect' });
  const one = label => { const found = nodes.filter(node => node.label === label); assert.equal(found.length, 1, label); return found[0].path; };
  const binding = { ...target, markerPath: one('第一测试会话'), markerText: '第一测试会话', inputPath: one('测试消息输入框'), replyPath: one('测试回复容器'), sendPath: one('发送测试'), navigationPath: one('打开第一会话'), navigationText: '打开第一会话' };
  const checked = await bridge({ ...binding, action: 'validate', activate: true }); binding.selectors = checked.selectors;
  assert.match(checked.text, /历史回复/);
  const sent = await bridge({ ...binding, action: 'send', activate: true, text: '中文与 emoji 😀' }); assert.equal(sent.sent, true);
  await delay(150);
  assert.match((await bridge({ ...binding, action: 'capture' })).text, /测试回复：中文与 emoji 😀/);
  await assert.rejects(bridge({ ...binding, bundleId: 'win.invalid', action: 'send', text: '不能发送' }), /身份/);
  await assert.rejects(bridge({ ...binding, markerText: '不存在的会话', action: 'send', text: '不能发送' }), /标识/);
  const second = { ...binding, selectors: undefined, markerText: '第二测试会话', navigationPath: one('打开第二会话'), navigationText: '打开第二会话' };
  second.selectors = (await bridge({ ...second, action: 'validate', activate: true })).selectors;
  await assert.rejects(bridge({ ...binding, action: 'capture' }), /标识|唯一定位/);
  assert.equal((await bridge({ ...binding, action: 'send', activate: true, text: '保留草稿' })).sent, true);
  await delay(150);
  await assert.rejects(bridge({ ...binding, action: 'send', text: '不能覆盖草稿' }), /草稿/);
  const status = await bridge({ action: 'screenStatus' }); assert.equal(status.requiresPermission, false);
  // Only GitHub's disposable Windows desktop is captured, never a user's desktop.
  if (process.env.CI && status.allowed) {
    const screenshot = await bridge({ action: 'screenshot' }); assert.equal(screenshot.mimeType, 'image/jpeg');
    assert.equal(Buffer.from(screenshot.base64, 'base64').readUInt16BE(), 0xffd8);
  }
});
