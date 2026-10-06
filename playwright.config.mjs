import { defineConfig } from '@playwright/test';
import { loadTestEnv } from './scripts/test-env.mjs';
loadTestEnv();

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 10000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: 'output/playwright',
  globalTeardown: './scripts/performance-teardown.mjs',
  use: {
    baseURL: 'http://127.0.0.1:8878',
    viewport: { width: 1280, height: 720 },
    launchOptions: { args: ['--enable-precise-memory-info'] },
    // Provider URLs contain credentials. Never record network traces, screenshots or video.
    trace: 'off', screenshot: 'off', video: 'off',
  },
  webServer: {
    command: 'node scripts/performance-server.mjs',
    url: 'http://127.0.0.1:8878/api/health',
    timeout: 30000,
    reuseExistingServer: false,
  },
});
