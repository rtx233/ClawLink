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
  await expect(page.locator('.wechat-authorization')).toContainText('自动授权本人');
  await expect(page.locator('.wechat-authorization')).toContainText('1 个已授权聊天');
  await expect(page.locator('.pairing-command')).toHaveCount(0);
  await page.click('#modalClose');
  const wx = (await (await page.request.get('/api/state')).json()).bots.find(bot => bot.platform === 'wechat');
  await page.locator(`#botGrid [data-bot-menu="${wx.id}"]`).click();
  await expect(page.locator('#newPairing')).toHaveCount(0);
  await expect(page.locator('#allowedPeers')).toHaveValue('wx-owner');
  await page.click('#modalClose');
  await page.click('[data-view="messaging"]');
  await expect(page.locator('#recipientGrid')).toContainText('wx-owner');
  await page.click('#addBotTop');
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

test('AI 收件人命名、权限开关、手工发送与 MCP 配置', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#serviceStatus')).toContainText('本地服务');
  const state = await (await page.request.get('/api/state')).json();
  const bot = state.bots.find(item => item.platform === 'telegram');
  expect(bot).toBeTruthy();
  await page.request.patch(`/api/bots/${bot.id}`, { data: { allowedPeers: ['ui-notify-101', 'ui-notify-202'] } });
  await page.reload(); await page.click('[data-view="messaging"]');
  const first = page.locator('.recipient-card').filter({ hasText: 'ui-notify-101' });
  await expect(first).toContainText('可以发送');
  await first.locator('[data-edit-recipient]').click();
  await page.fill('#recipientName', '<工作 TG>'); await page.check('#recipientAiEnabled'); await page.click('#saveRecipient');
  await expect(page.locator('#modalBackdrop')).not.toHaveClass(/open/);
  await expect(first.locator('h3')).toHaveText('<工作 TG>');
  await expect(first.locator('[data-recipient-toggle]')).toHaveAttribute('aria-pressed', 'true');
  await first.locator('[data-compose-recipient]').click();
  await expect(page.locator('#messageRecipient')).toHaveValue((await (await page.request.get('/api/state')).json()).recipients.find(item => item.peerId === 'ui-notify-101').id);
  await page.fill('#messageText', '前端发给指定 TG 的通知'); await page.click('#sendMessage');
  await expect(page.locator('#messageSendResult')).toHaveText('已向「<工作 TG>」提交消息。');
  await expect(page.locator('#sendMessage')).toBeDisabled(); await page.keyboard.press('Escape');
  await page.click('#aiSetupBtn'); await expect(page.locator('#mcpConfig')).toContainText('ai-client.js');
  const config = JSON.parse(await page.locator('#mcpConfig').textContent());
  expect(config.mcpServers.clawlink.args).toContain('mcp');
  await expect(page.locator('#aiCliInstructions')).toContainText('requestId');
  await page.keyboard.press('Escape');
  await first.locator('[data-recipient-toggle]').click();
  await expect(first.locator('[data-recipient-toggle]')).toHaveAttribute('aria-pressed', 'false');
  const sessionToggle = page.locator('[data-session-messaging]').first();
  await sessionToggle.click(); await expect(sessionToggle).toHaveAttribute('aria-pressed', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(first).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/clawlink-ai-messaging-mobile.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '/tmp/clawlink-ai-messaging.png', fullPage: true, animations: 'disabled' });
});

test('内置指令和路由可编辑，帮助预览跟随修改，改名后 UI 仍可切换', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#serviceStatus')).toContainText('本地服务');
  await page.click('[data-action="commands"]');
  await page.fill('[aria-label="help 指令名称"]', '/帮助');
  await page.fill('[aria-label="switch 指令名称"]', '[愉快]');
  await page.fill('[aria-label="switch 帮助说明"]', '选择新的 AI 会话');
  await page.fill('[aria-label="switch 表情"]', '[强]');
  await expect(page.locator('#helpPreview')).toContainText('[强] [愉快] 会话名 选择新的 AI 会话');
  await expect(page.locator('#helpPreview')).toContainText('/pair 配对码');
  await page.click('#saveCommands'); await expect(page.locator('#modalBackdrop')).not.toHaveClass(/open/);
  await page.click('[data-view="overview"]'); await expect(page.locator('.command-list')).toContainText('[愉快]');
  const state = await (await page.request.get('/api/state')).json();
  const tg = state.bots.find(bot => bot.platform === 'telegram');
  const session = state.sessions.find(session => session.binding);
  await page.locator(`#routeTableBody [data-bot-menu="${tg.id}"]`).click(); await page.locator(`#modalContent [data-switch-bot="${tg.id}"]`).click();
  await page.selectOption('#switchTarget', session.id); await page.click('#performSwitch');
  await expect(page.locator('#modalBackdrop')).not.toHaveClass(/open/);
  await page.click('[data-view="routing"]'); await page.click('#newRouteBtn');
  await page.selectOption('#ruleBot', tg.id); await page.fill('#ruleCommand', '/ui_research'); await page.fill('#ruleDescription', '发送研究问题'); await page.fill('#ruleEmoji', '💬'); await page.click('#saveRule');
  const routes = (await (await page.request.get('/api/state')).json()).routes;
  const rule = routes.find(rule => rule.command === '/ui_research');
  await page.click(`[data-rule-menu="${rule.id}"]`); await expect(page.locator('#ruleCommand')).toBeEnabled();
  await page.fill('#ruleCommand', '/查询'); await page.fill('#ruleDescription', '查询路由'); await page.click('#saveRule');
  await page.click('[data-action="commands"]'); await page.selectOption('#helpPreviewBot', tg.id);
  await expect(page.locator('#helpPreview')).toContainText('💬 /查询 消息内容 查询路由');
  await page.fill('[aria-label="help 指令名称"]', '[愉快]'); await page.click('#saveCommands');
  await expect(page.locator('#modalError')).toContainText('重复');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/clawlink-command-settings.png', fullPage: true, animations: 'disabled' });
});

test('账户权限分别保存，帮助隐藏禁用指令，系统截图权限有清楚入口', async ({ page }) => {
  await page.goto('/'); await page.click('[data-view="bots"]');
  const state = await (await page.request.get('/api/state')).json(); const tg = state.bots.find(bot => bot.platform === 'telegram');
  await page.locator(`#botGrid [data-bot-menu="${tg.id}"]`).click(); await page.click(`[data-bot-permissions="${tg.id}"]`);
  await expect(page.locator('#permission-screenshot')).not.toBeChecked();
  await page.uncheck('#permission-forwardMessages'); await page.uncheck('#permission-sendMessages');
  await page.check('#permission-screenshot'); await page.uncheck('[data-command-permission="switch"]');
  await page.click('#savePermissions'); await expect(page.locator('#modalBackdrop')).not.toHaveClass(/open/);
  const saved = (await (await page.request.get('/api/state')).json()).bots.find(bot => bot.id === tg.id);
  expect(saved.permissions).toMatchObject({ screenshot: true, forwardMessages: false, sendMessages: false, commands: { switch: false } });
  await page.click('[data-action="commands"]'); await page.selectOption('#helpPreviewBot', tg.id);
  await expect(page.locator('#helpPreview')).not.toContainText('[愉快]'); await expect(page.locator('#helpPreview')).toContainText('/screenshot');
  await page.keyboard.press('Escape'); await page.click('[data-action="settings"]');
  await expect(page.locator('#screenStatus')).toContainText('已允许');
  await expect(page.locator('#launchAtLogin')).toHaveCount(0);
  await expect(page.locator('#modalContent')).toContainText('ClawLink.app');
  await page.click('#screenPermission'); await expect(page.locator('#screenStatus')).toHaveText('屏幕录制权限已允许');
});

test('App 内开机自启开关通过原生桥接保存，失败时恢复原状态', async ({ page }) => {
  await page.addInitScript(() => {
    window.testLoginCalls = [];
    window.webkit = { messageHandlers: { clawlink: { postMessage: request => { window.testLoginCalls.push(request.action); setTimeout(() => window.clawlinkNativeReply({ id: request.id, result: request.action === 'setLaunchAtLogin' && window.testFailLogin ? { error: '系统拒绝注册' } : { launchAtLogin: request.action === 'setLaunchAtLogin' ? request.enabled : false, loginStatus: request.enabled ? 'enabled' : 'notRegistered' } }), 0); } } } };
  });
  await page.goto('/'); await page.click('[data-action="settings"]');
  await expect(page.locator('#launchAtLogin')).toBeEnabled(); await page.check('#launchAtLogin');
  await expect(page.locator('#loginStatus')).toHaveText('开机自启已启用');
  await page.evaluate(() => { window.testFailLogin = true; }); await page.uncheck('#launchAtLogin');
  await expect(page.locator('#modalError')).toHaveText('系统拒绝注册'); await expect(page.locator('#launchAtLogin')).toBeChecked();
  expect(await page.evaluate(() => window.testLoginCalls.filter(action => action === 'setLaunchAtLogin').length)).toBe(2);
});
