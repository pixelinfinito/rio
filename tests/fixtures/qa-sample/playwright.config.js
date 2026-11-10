import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests', fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173' },
  projects: [
    { name: 'mobile-light', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium', colorScheme: 'light' } },
    { name: 'mobile-dark', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium', colorScheme: 'dark' } },
    { name: 'desktop-light', use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light' } },
    { name: 'desktop-dark', use: { viewport: { width: 1440, height: 900 }, colorScheme: 'dark' } }
  ],
  webServer: { command: 'npm run build && node scripts/test-server.mjs', url: 'http://127.0.0.1:4173/api/health', reuseExistingServer: false }
});
