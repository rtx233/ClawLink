const { test, expect } = require('@playwright/test');
const { TOKEN } = require('../helpers');

test('真实前后端操作：原生绑定、微信扫码、Telegram Token、UI 切换', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#serviceStatus')).toContainText('本地服务');
  await expect(page.locator('#metricBots')).toHaveText('0');
  await expect(page.locator('#metricMessages')).toHaveText('0');
  await page.click('[data-view="sessions"]'); await page.click('#newSessionBtn');
  await page.fill('#sessionName', '前端研究室'); await page.click('#saveSession');
  await page.click('#inspectWindow');
  await page.selectOption('#markerPath', '0'); await page.selectOption('#inputPath', '1');
  await page.selectOption('#replyPath', '2'); await page.selectOption('#sendPath', '3');
  await expect(page.locator('#markerPreview')).toHaveValue('unique-marker');
  await page.click('#saveBinding'); await expect(page.locator('#modalBackdrop')).not.toHaveClass(/open/);
  await expect(page.locator('#sessionGrid')).toContainText('已校验');
  await page.click('#addBotTop'); await page.fill('#botName', '测试微信'); await page.click('#createBot');
  await expect(page.locator('.qr-image')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(page.locator('#qrStatus')).toContainText('扫码成功');
  await page.click('#modalClose'); await page.click('#addBotTop');
  await page.selectOption('#botPlatform', 'telegram');
  await expect(page.locator('#botToken')).toBeVisible(); await expect(page.locator('#createBot')).toHaveText('验证并连接');
  await page.fill('#botName', '测试 TG'); await page.fill('#botToken', TOKEN); await page.click('#createBot');
  await expect(page.locator('.pairing-box code')).toContainText('/pair');
  await expect(page.locator('.qr-image')).toHaveCount(0); await page.click('#modalClose');
  await page.click('[data-view="sessions"]'); await page.click('[data-session-switch]');
  await expect(page.locator('#switchBot')).toHaveCount(1); await page.selectOption('#switchBot', { label: '测试 TG' });
  await page.click('#performSwitch'); await expect(page.locator('#modalBackdrop')).not.toHaveClass(/open/);
  await page.click('[data-view="overview"]'); await expect(page.locator('#routeTableBody')).toContainText('前端研究室');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#addBotTop')).toBeVisible();
  await page.screenshot({ path: '/tmp/clawlink-mobile.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: '/tmp/clawlink-ui.png', fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('网络失败保持错误信息和真实状态，名称转义，键盘关闭对话框', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#serviceStatus')).toContainText('本地服务');
  await page.click('#addBotTop'); await page.selectOption('#botPlatform', 'telegram');
  await page.fill('#botName', '无效 Token'); await page.fill('#botToken', 'invalid'); await page.click('#createBot');
  await expect(page.locator('#modalError')).toContainText('有效');
  await expect(page.locator('#modalBackdrop')).toHaveClass(/open/); await page.keyboard.press('Escape');
  await expect(page.locator('#modalBackdrop')).not.toHaveClass(/open/);
  await page.click('[data-view="sessions"]'); await page.click('#newSessionBtn');
  await page.fill('#sessionName', '<img src=x onerror=alert(1)>'); await page.click('#saveSession');
  await expect(page.locator('#modalTitle')).toHaveText('绑定 <img src=x onerror=alert(1)>');
  await page.keyboard.press('Escape'); await expect(page.locator('#sessionGrid h3').last()).toHaveText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#sessionGrid img')).toHaveCount(0);
  await page.route('**/api/native/discover', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '连接器不可用' }) }));
  await page.locator('[data-bind-session]').last().click();
  await expect(page.locator('#modalError')).toHaveText('连接器不可用');
  await page.keyboard.press('Escape');
  await page.route('**/api/bots/*/login/start', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '微信暂时不可用' }) }));
  await page.click('#addBotTop'); await page.fill('#botName', '扫码错误'); await page.click('#createBot');
  await expect(page.locator('#qrStatus')).toHaveText('请求失败');
  await expect(page.locator('#modalError')).toHaveText('微信暂时不可用');
  await page.keyboard.press('Escape');
  await page.route('**/api/state', route => route.abort());
  await expect(page.locator('#serviceStatus')).toHaveText('服务未连接', { timeout: 6000 });
});

test('原生客户端未登录时显示登录引导；授权后可以重新检查', async ({ page }) => {
  await page.goto('/'); await page.click('[data-view="sessions"]'); await page.click('#newSessionBtn');
  await page.fill('#sessionName', '登录引导测试'); await page.selectOption('#sessionProvider', 'Claude');
  await page.route('**/api/native/inspect', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ nodes: [{ path: '0', role: 'AXStaticText', label: 'Sign in', text: 'Sign in', editable: false }] }) }));
  await page.click('#saveSession'); await page.click('#inspectWindow');
  await expect(page.locator('#bindingForm')).toContainText('完成登录');
  await expect(page.locator('#saveBinding')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.route('**/api/native/discover', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trusted: false, apps: [] }) }));
  await page.locator('[data-bind-session]').last().click();
  await expect(page.locator('#nativePermission')).toHaveText('请求系统授权');
  await expect(page.getByRole('button', { name: '授权后重新检查' })).toBeVisible();
});

test('PI 已有文件 / 新会话与 Paseo 已有 ID 均可绑定并读取模拟回复', async ({ page }) => {
  await page.goto('/'); await page.click('[data-view="sessions"]');
  for (const [provider, name] of [['PI', 'PI 文件路由'], ['Paseo', 'Paseo 已有路由']]) {
    await page.click('#newSessionBtn'); await page.fill('#sessionName', name); await page.selectOption('#sessionProvider', provider); await page.click('#saveSession');
    await expect(page.locator('#nativePermission')).toHaveCount(0);
    if (provider === 'PI') { await page.selectOption('#piExistingSession', '/tmp/pi-existing.jsonl'); await expect(page.locator('#piSessionFile')).toHaveValue('/tmp/pi-existing.jsonl'); }
    else { await page.fill('#paseoSearch', '现有'); await page.selectOption('#paseoAgent', '11111111-2222-4333-8444-555555555555'); }
    await page.click('#saveTargetBinding'); await expect(page.locator('#modalBackdrop')).not.toHaveClass(/open/);
    const card = page.locator('.session-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(card).toContainText('已校验'); await card.locator('[data-validate-session]').click(); await expect(page.locator('#toastMessage')).toHaveText('目标会话校验通过');
    await card.locator('[data-session-menu]').click(); await page.fill('#nativeTestText', '只回传本次文本'); await page.locator('[data-test-session]').click();
    await expect(page.locator('#nativeTestReply')).toHaveText(`${provider} 回复：只回传本次文本`); await page.keyboard.press('Escape');
  }
  await page.click('#newSessionBtn'); await page.fill('#sessionName', 'PI 新会话路由'); await page.selectOption('#sessionProvider', 'PI'); await page.click('#saveSession');
  await page.selectOption('#piMode', 'new'); await expect(page.locator('#piSessionFile')).not.toBeVisible(); await page.fill('#piWorkdir', '/tmp');
  await page.click('#saveTargetBinding'); await expect(page.locator('#modalBackdrop')).not.toHaveClass(/open/);
});

test('会话发现结果返回较晚时，不覆盖用户之后打开的弹窗', async ({ page }) => {
  let finish;
  await page.route('**/api/native/discover', async route => { await new Promise(resolve => { finish = resolve; }); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trusted: true, apps: [{ bundleId: 'com.example.late', name: 'late', windows: ['late'] }] }) }); });
  await page.goto('/'); await page.click('[data-view="sessions"]'); await page.click('#newSessionBtn');
  await expect.poll(() => !!finish).toBe(true); await page.keyboard.press('Escape'); await page.click('#addBotTop'); finish();
  await expect(page.locator('#modalTitle')).toHaveText('添加机器人'); await expect(page.locator('#sessionProvider')).toHaveCount(0);
});
