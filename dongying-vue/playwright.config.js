/* =============================================================================
 * Playwright 配置（阶段 15.3，决策 15-9 / 15-10）。
 *
 * 前端用 localhost 而不是 127.0.0.1：Vite 只监听 IPv6（[::1]:5174）。
 * webServer 的 reuseExistingServer 在本地为真——**本机已经跑着的 5174 会被直接复用，
 * 不会被这套用例杀掉或重启**：同一台机器上可能有别的会话正在用它。
 * ========================================================================== */
import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.E2E_PORT || '5174';
const BASE_URL = process.env.E2E_BASE_URL || `http://localhost:${PORT}`;
const API_TARGET = process.env.APP_API_PROXY_TARGET || 'http://127.0.0.1:8081';

export default defineConfig({
  testDir: './e2e',
  /* 用例之间不共享状态（每条自己登录 + 自己的 context），可以并行；
     但并行度压在个位数：后端与 dev server 是本机共享的，不该被这套用例压垮。 */
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  timeout: 40_000,
  expect: { timeout: 10_000 },
  /* 本地不重试：重试会把"偶发红"变成"看起来绿"，而偶发红本身就是要报的东西。 */
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    /* 默认视口取矩阵里最窄的一档；横向溢出用例会依次切到 1366/1440。 */
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command: `npx vite --port ${PORT}`,
    url: BASE_URL,
    env: { APP_API_PROXY_TARGET: API_TARGET },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
