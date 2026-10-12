const { test, expect } = require('@playwright/test');

async function expectReadableText(page) {
  const contrasts = await page.evaluate(() => {
    const luminance = color => {
      const rgb = color.match(/[\d.]+/g).slice(0, 3).map(value => Number(value) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    return ['#view-overview h1', '#metricBots', '#view-overview .section-heading h2'].map(selector => {
      const element = document.querySelector(selector); let background = element;
      while (getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)' && background.parentElement) background = background.parentElement;
      const a = luminance(getComputedStyle(element).color), b = luminance(getComputedStyle(background).backgroundColor);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    });
  });
  for (const contrast of contrasts) expect(contrast).toBeGreaterThanOrEqual(4.5);
}

test('明暗主题、系统变化、刷新恢复和移动端设置', async ({ page }) => {
  await page.request.patch('/api/preferences', { data: { theme: 'system' } });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/'); await expect(page.locator('#serviceStatus')).toContainText('本地服务');
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expectReadableText(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('#view-overview h1')).toHaveCSS('color', 'rgb(229, 237, 245)');
  await expectReadableText(page);
  await page.click('[data-action="settings"]');
  await expect(page.locator('#themeSelect')).toHaveValue('system');
  await page.selectOption('#themeSelect', 'light');
  await expect(page.locator('#themeSelect')).toBeEnabled();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'light' }); await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.selectOption('#themeSelect', 'dark'); await expect(page.locator('#themeSelect')).toBeEnabled();
  // Remove the browser cache: the server must still restore the preference.
  await page.evaluate(() => localStorage.clear()); await page.reload();
  await expect(page.locator('#serviceStatus')).toContainText('本地服务');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('#view-overview h1')).toHaveCSS('color', 'rgb(229, 237, 245)');
  await expectReadableText(page);
  await page.emulateMedia({ colorScheme: 'light' }); await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '/tmp/clawlink-theme-dark.png', fullPage: true });
  await page.click('[data-action="settings"]'); await expect(page.locator('#themeSelect')).toHaveValue('dark');
  await page.screenshot({ path: '/tmp/clawlink-theme-settings.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#themeSelect')).toBeVisible();
  await page.selectOption('#themeSelect', 'system'); await expect(page.locator('#themeSelect')).toBeEnabled();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' }); await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: '/tmp/clawlink-theme-mobile.png', fullPage: true });
  await page.selectOption('#themeSelect', 'light'); await expect(page.locator('#themeSelect')).toBeEnabled();
});

test('权限查询失败仍可设置主题；保存失败还原主题并显示错误', async ({ page }) => {
  await page.request.patch('/api/preferences', { data: { theme: 'light' } });
  await page.route('**/api/native/discover', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '连接器不可用' }) }));
  await page.goto('/'); await expect(page.locator('#serviceStatus')).toContainText('本地服务');
  await page.click('[data-action="settings"]');
  await page.selectOption('#themeSelect', 'dark'); await expect(page.locator('#themeSelect')).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.route('**/api/preferences', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '无法保存本地偏好' }) }));
  await page.selectOption('#themeSelect', 'light');
  await expect(page.locator('#modalError')).toHaveText('无法保存本地偏好');
  await expect(page.locator('#themeSelect')).toHaveValue('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.unroute('**/api/preferences');
  await page.selectOption('#themeSelect', 'system'); await expect(page.locator('#themeSelect')).toBeEnabled();
});
