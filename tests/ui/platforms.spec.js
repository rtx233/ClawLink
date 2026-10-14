const { test, expect } = require('@playwright/test');
const { FEISHU, DISCORD_TOKEN } = require('../helpers');

test('飞书 / Discord 表单、凭据修改、账户权限、平台筛选、中英翻译与窄屏', async ({ page }) => {
  const created = []; const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.request.patch('/api/preferences', { data: { language: 'zh-CN' } });
  try {
    await page.goto('/'); await expect(page.locator('#serviceStatus')).toContainText('本地服务');
    for (const platform of ['feishu', 'discord']) {
      await page.click('#addBotTop'); await page.selectOption('#botPlatform', platform);
      await expect(page.locator('#createBot')).toHaveText('验证并连接');
      await page.fill('#botName', platform === 'feishu' ? '新增飞书' : '新增 Discord');
      if (platform === 'feishu') {
        await expect(page.locator('#botToken')).toBeHidden(); await expect(page.locator('#botPlatformHint')).toContainText('im.message.receive_v1');
        await page.fill('#botAppId', FEISHU.appId); await page.fill('#botAppSecret', FEISHU.appSecret);
      } else {
        await expect(page.locator('#botAppId')).toBeHidden(); await expect(page.locator('#botTokenLabel')).toHaveText('Discord Bot Token');
        await expect(page.locator('#botPlatformHint')).toContainText('Message Content Intent'); await page.fill('#botToken', DISCORD_TOKEN);
      }
      await page.click('#createBot'); await expect(page.locator('.pairing-box')).toContainText('私聊窗口');
      const state = await (await page.request.get('/api/state')).json(); const bot = state.bots.find(x => x.platform === platform); created.push(bot.id);
      await expect(page.locator('#newPairing')).toBeVisible(); await expect(page.locator('#allowedPeers')).toBeVisible();
      await page.fill('#allowedPeers', platform === 'feishu' ? 'oc_group' : '123456789012345678'); await page.click('#savePeers');
      await expect(page.locator('#toastMessage')).toHaveText('授权聊天已保存'); await page.keyboard.press('Escape');
      await page.click('[data-view="bots"]'); await page.locator(`[data-connect-bot="${bot.id}"]`).click();
      await expect(page.locator('#modalContent')).toContainText('需重新授权');
      if (platform === 'feishu') { await expect(page.locator('#replacementAppSecret')).toHaveValue(''); await page.fill('#replacementAppId', FEISHU.appId); await page.fill('#replacementAppSecret', FEISHU.appSecret); }
      else { await expect(page.locator('#replacementToken')).toHaveValue(''); await page.fill('#replacementToken', DISCORD_TOKEN); }
      await page.click('#savePlatformCredentials'); await expect(page.locator('#allowedPeers')).not.toHaveValue('');
      await page.click(`[data-bot-permissions="${bot.id}"]`); await expect(page.locator('[data-command-permission="pair"]')).toBeVisible();
      await page.uncheck('#permission-forwardNotice'); await page.click('#savePermissions');
      await expect(page.locator('#modalBackdrop')).not.toHaveClass(/open/);
      await page.click('[data-view="overview"]'); await page.click(`[data-filter="${platform}"]`);
      await expect(page.locator('#routeTableBody tr')).toHaveCount(1); await expect(page.locator(`[data-filter="${platform}"] span`)).toHaveText('1');
      await expect(page.locator('#routeTableBody')).toContainText(bot.name);
    }
    await page.click('[data-action="settings"]'); await page.selectOption('#languageSelect', 'en'); await expect(page.locator('#languageSelect')).toBeEnabled(); await page.keyboard.press('Escape');
    await page.click('#addBotTop'); await page.selectOption('#botPlatform', 'feishu'); await expect(page.locator('#botPlatformHint')).toContainText('enterprise custom app');
    const formText = await page.locator('#modalContent').evaluate(element => {
      const copy = element.cloneNode(true); copy.querySelector('#botTarget').replaceChildren(); return copy.textContent;
    });
    expect(formText).not.toMatch(/[\u3400-\u9fff]/);
    await page.selectOption('#botPlatform', 'discord'); await expect(page.locator('#botPlatformHint')).toContainText('Developer Portal');
    await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('#botToken')).toBeVisible();
    await page.screenshot({ path: '/tmp/clawlink-new-bots-mobile.png', fullPage: true });
    await page.keyboard.press('Escape'); await page.click('[data-view="overview"]');
    await expect(page.locator('[data-filter="feishu"]')).toContainText('Feishu'); await expect(page.locator('[data-filter="discord"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    for (const id of created) await page.request.delete(`/api/bots/${id}`);
    await page.request.patch('/api/preferences', { data: { language: 'zh-CN' } });
  }
});
