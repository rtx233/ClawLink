const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: 'reduce' }); });
test.afterEach(async ({ request }) => { await request.patch('/api/preferences', { data: { language: 'zh-CN', theme: 'system' } }); });

test('中英切换、导航与弹窗翻译、原始数据保留、刷新恢复和窄屏', async ({ page }) => {
  await page.request.patch('/api/preferences', { data: { language: 'zh-CN', theme: 'dark' } });
  const sessionResult = await page.request.post('/api/sessions', { data: { name: '总览', provider: 'PI', targetType: 'pi' } });
  const { session } = await sessionResult.json();
  const failures = []; page.on('pageerror', error => failures.push(error.message));
  try {
    await page.goto('/'); await expect(page.locator('#serviceStatus')).toContainText('本地服务');
    await expect(page.locator('#view-overview h1')).toHaveCSS('color', 'rgb(229, 237, 245)');
    await page.click('[data-view="sessions"]');
    await page.click('[data-action="settings"]');
    await page.selectOption('#languageSelect', 'en');
    await expect(page.locator('#languageSelect')).toBeEnabled();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#modalTitle')).toHaveText('App settings');
    await expect(page.locator('#pageTitle')).toHaveText('Chat spaces');
    await expect(page.locator('#themeSelect option[value="system"]')).toHaveText('System');
    await expect(page.getByLabel('Interface language')).toHaveValue('en');
    await page.keyboard.press('Escape');
    await expect(page.locator('#sessionGrid').getByRole('heading', { name: '总览', exact: true })).toBeVisible();
    await expect(page.locator('[data-view="bots"]')).toHaveAccessibleName('Bots');
    await expect(page.locator('#globalSearch')).toHaveAttribute('placeholder', 'Search bots or chats');
    await page.click('#addBotTop');
    await expect(page.locator('#modalTitle')).toHaveText('Add bot');
    await expect(page.locator('#botName')).toHaveAttribute('placeholder', 'e.g. Work WeChat');
    await page.selectOption('#botPlatform', 'telegram');
    await expect(page.locator('#createBot')).toHaveText('Verify and connect');
    await page.keyboard.press('Escape');
    for (const view of ['overview', 'bots', 'routing', 'messaging', 'activity']) {
      await page.click(`[data-view="${view}"]`);
      // These pages contain no Chinese user data in this fixture's visible area.
      if (view !== 'overview' && view !== 'activity') {
        const intro = await page.locator(`#view-${view} .page-intro`).innerText();
        expect(intro).not.toMatch(/[\u3400-\u9fff]/);
      }
    }
    await page.evaluate(() => localStorage.clear()); await page.reload();
    await expect(page.locator('#serviceStatus')).toContainText('Local service');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page).toHaveTitle('ClawLink · Chat routing center');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(17, 25, 35)');
    for (const selector of ['#view-overview h1', '#metricBots', '#view-overview .section-heading h2', '.session-copy strong']) {
      await expect(page.locator(selector).first()).toHaveCSS('color', 'rgb(229, 237, 245)');
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.locator('.view.active')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: '/tmp/clawlink-english.png', fullPage: true });
    await page.click('[data-action="settings"]');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#languageSelect')).toBeVisible();
    await expect(page.locator('.modal')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: '/tmp/clawlink-english-settings-mobile.png', fullPage: true });
    await page.selectOption('#languageSelect', 'zh-CN');
    await expect(page.locator('#languageSelect')).toBeEnabled();
    await expect(page.locator('#modalTitle')).toHaveText('App 设置');
    await expect(page.locator('#themeSelect')).toHaveValue('dark');
    expect(failures).toEqual([]);
  } finally { await page.request.delete(`/api/sessions/${session.id}`); }
});

test('语言保存失败保留原语言；离线缓存和不可用存储仍能加载', async ({ page }) => {
  await page.request.patch('/api/preferences', { data: { language: 'en' } });
  await page.goto('/'); await expect(page.locator('#serviceStatus')).toContainText('Local service');
  await page.click('[data-action="settings"]');
  await page.route('**/api/preferences', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '无法保存本地偏好' }) }));
  await page.selectOption('#languageSelect', 'zh-CN');
  await expect(page.locator('#modalError')).toHaveText('Could not save local preferences');
  await expect(page.locator('#languageSelect')).toHaveValue('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.unroute('**/api/preferences');
  await page.route('**/api/state', route => route.abort()); await page.reload();
  await expect(page.locator('#pageTitle')).toHaveText('Overview');
  await page.unroute('**/api/state');
  await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage unavailable'); } }); });
  await page.reload(); await expect(page.locator('#serviceStatus')).toContainText('Local service');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
