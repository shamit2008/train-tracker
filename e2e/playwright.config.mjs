/* Browser smoke tests: does the site still work, on a desktop window and a phone screen.
   Locally they use the Chrome already installed; CI installs Playwright's Chromium. */
import { defineConfig, devices } from '@playwright/test';

const chrome = process.env.CI ? {} : { channel: 'chrome' };
export default defineConfig({
  testDir: './tests',
  timeout: 45000,
  expect: { timeout: 10000 },
  fullyParallel: false,   // one shared server and database
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure' },
  webServer: { command: 'node server.mjs', url: 'http://localhost:4173', reuseExistingServer: !process.env.CI },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...chrome, viewport: { width: 1280, height: 800 } } },
    { name: 'phone', use: { ...devices['Pixel 7'], ...chrome } },
  ],
});
