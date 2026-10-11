const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/ui', timeout: 20000, fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:4181', headless: true, screenshot: 'only-on-failure', ...(process.env.CLAWLINK_TEST_CHROME === '1' ? { channel: 'chrome' } : {}) },
  webServer: { command: 'node tests/ui-server.js', url: 'http://127.0.0.1:4181/api/health', reuseExistingServer: false }
});
