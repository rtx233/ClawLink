// Executes the compiled bridge against a real Cocoa window, without personal accounts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createNative } = require('../server/native');

test('真实 macOS AX：双会话切换、发送读取、身份重定位、草稿拒绝、粘贴及剪贴板恢复', { skip: process.platform !== 'darwin', timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawlink-ax-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = path.join(dir, 'ClawLinkFixture.app');
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.clawlink.fixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>ClawLinkFixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  const fixture = path.join(app, 'Contents/MacOS/Fixture');
  execFileSync('swiftc', ['tests/native/Fixture.swift', '-o', fixture, '-framework', 'Cocoa']);
  const binary = path.join(dir, 'ClawLinkBridge');
  execFileSync('swiftc', ['-D', 'CLAWLINK_TESTING', 'native/ClawLinkBridge.swift', '-o', binary, '-framework', 'Cocoa', '-framework', 'ApplicationServices']);
  const processFixture = spawn(fixture, [], { stdio: 'ignore' });
  t.after(() => processFixture.kill());
  const call = request => new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.on('error', reject);
    child.on('close', () => { try { const response = JSON.parse(output); if (!response.ok) throw new Error(response.error); resolve(response.result); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify(request));
  });
  let discovered;
  for (let i = 0; i < 40; i += 1) { discovered = await call({ action: 'discover' }); if (discovered.apps.some(x => x.bundleId === 'dev.clawlink.fixture' && x.windows.length)) break; await delay(150); }
  assert.equal(discovered.trusted, true, '需要辅助功能权限以运行真实 AX 测试');
  const base = { bundleId: 'dev.clawlink.fixture', windowTitle: 'ClawLink Native Fixture' };
  const { nodes } = await call({ ...base, action: 'inspect' });
  const node = identifier => { const found = nodes.filter(x => x.selector.identifier === identifier); assert.equal(found.length, 1, identifier); return found[0]; };
  const binding = { ...base, markerPath: node('conversation-marker').path, markerText: 'fixture-one', inputPath: node('conversation-input').path,
    replyPath: node('conversation-reply').path, sendPath: node('send-message').path, navigationPath: node('navigation-0').path, navigationText: '会话一', replyMode: 'append' };
  const validated = await call({ ...binding, action: 'validate', activate: true });
  binding.selectors = validated.selectors;
  const native = createNative({ call, interval: 100, minWait: 100, stableWait: 200, timeout: 5000 });
  assert.equal(await native.send(binding, '真实发送一'), '回复[one]：真实发送一');
  // The original path now points at a different button: identity must recover the correct one.
  const relocated = { ...binding, sendPath: node('navigation-1').path };
  assert.equal(await native.send(relocated, '身份重定位'), '回复[one]：身份重定位');
  const second = { ...binding, markerText: 'fixture-two', navigationPath: node('navigation-1').path, navigationText: '会话二', selectors: { ...binding.selectors, marker: { ...binding.selectors.marker, name: 'fixture-two' }, navigation: node('navigation-1').selector } };
  assert.equal(await native.send(second, '真实发送二'), '回复[two]：真实发送二');
  const originalClipboard = execFileSync('/usr/bin/pbpaste');
  assert.equal(await native.send({ ...second, writeMode: 'paste' }, '粘贴兼容验证'), '回复[two]：粘贴兼容验证');
  assert.deepEqual(execFileSync('/usr/bin/pbpaste'), originalClipboard);
  await assert.rejects(call({ ...second, markerText: 'wrong-marker', action: 'send', text: '不能提交' }), /会话.*不符/);
  await assert.rejects(call({ ...second, selectors: { ...second.selectors, send: { role: 'AXButton', identifier: 'deleted-button', name: '不存在' } }, action: 'send', text: '草稿保留' }), /无法唯一定位/);
  await assert.rejects(call({ ...second, action: 'send', text: '不能覆盖草稿' }), /未发送草稿/);
});
