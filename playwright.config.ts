import { defineConfig, devices } from '@playwright/test';
import fs from 'fs';

const testWebUrl =
  process.env.TEST_WEB_URL ||
  process.env.PLAYWRIGHT_BASE_URL ||
  'http://localhost:8080';
const customChromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const chromiumLaunchOptions =
  customChromiumPath && fs.existsSync(customChromiumPath)
    ? { executablePath: customChromiumPath }
    : undefined;

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
  ],
  timeout: 60_000,
  use: {
    baseURL: testWebUrl,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 15000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: chromiumLaunchOptions },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:8080',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
