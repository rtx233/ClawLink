const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./helpers');
const { createApp } = require('../server');

test('旧配置补充主题偏好，非法更新不改配置，重启换端口恢复主题和会话', async t => {
  const f = await fixture(); let active;
  t.after(async () => { if (active) await active.close(); await f.close(); });
  const session = await f.session('偏好升级测试');
  await f.app.close();
  const file = path.join(f.dataDir, 'state.json');
  const legacy = JSON.parse(fs.readFileSync(file)); delete legacy.preferences;
  fs.writeFileSync(file, JSON.stringify(legacy));
  const app = createApp({ dataDir: f.dataDir, native: f.native, workers: false });
  active = app;
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const state = await (await fetch(`${origin}/api/state`)).json();
  assert.deepEqual(state.preferences, { theme: 'system', language: 'zh-CN' });
  assert.equal(state.sessions[0].id, session.id);
  for (const body of [{ theme: 'dark', token: 'invalid-test-field' }, { theme: 'unknown' }, { theme: null }, { language: null }, { language: 'fr' }, { theme: 'light', language: 'invalid' }, {}]) {
    const response = await fetch(`${origin}/api/preferences`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    assert.deepEqual(app.viewState().preferences, { theme: 'system', language: 'zh-CN' });
  }
  const response = await fetch(`${origin}/api/preferences`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: 'dark' }) });
  assert.equal(response.status, 200);
  const languageResponse = await fetch(`${origin}/api/preferences`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: 'en' }) });
  assert.equal(languageResponse.status, 200);
  assert.deepEqual((await languageResponse.json()).preferences, { theme: 'dark', language: 'en' });
  await app.close(); active = null;
  const reopened = createApp({ dataDir: f.dataDir, native: f.native, workers: false });
  active = reopened;
  try {
    await new Promise(resolve => reopened.server.listen(0, '127.0.0.1', resolve));
    const restored = await (await fetch(`http://127.0.0.1:${reopened.server.address().port}/api/state`)).json();
    assert.deepEqual(restored.preferences, { theme: 'dark', language: 'en' });
    assert.equal(restored.sessions[0].id, session.id);
    assert.equal(fs.readdirSync(f.dataDir).some(name => name.startsWith('prototype-backup')), false);
  } finally { await reopened.close(); active = null; }
});

test('已有主题配置补充中文语言；更新主题不覆盖语言', async t => {
  const f = await fixture(); let active;
  t.after(async () => { if (active) await active.close(); await f.close(); });
  await f.app.close();
  const file = path.join(f.dataDir, 'state.json');
  const legacy = JSON.parse(fs.readFileSync(file)); legacy.preferences = { theme: 'dark' };
  fs.writeFileSync(file, JSON.stringify(legacy));
  active = createApp({ dataDir: f.dataDir, native: f.native, workers: false });
  await new Promise(resolve => active.server.listen(0, '127.0.0.1', resolve));
  assert.deepEqual(active.viewState().preferences, { theme: 'dark', language: 'zh-CN' });
  const origin = `http://127.0.0.1:${active.server.address().port}`;
  for (const body of [{ language: 'en' }, { theme: 'light' }]) {
    assert.equal((await fetch(`${origin}/api/preferences`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 200);
  }
  assert.deepEqual(active.viewState().preferences, { theme: 'light', language: 'en' });
});
