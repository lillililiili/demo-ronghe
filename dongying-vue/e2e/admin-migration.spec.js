import { expect, test } from '@playwright/test';
import { apiLogin, seedSession } from './support/session.js';

const MIGRATED = ['devices', 'monitor', 'commission', 'users', 'roles', 'archive'];

test('六个旧管理地址显示迁移提示且不自动跨系统跳转', async ({ context, page, request }) => {
  const session = await apiLogin(request, 'admin1');
  test.skip(session === null, '本地开发管理员不存在，无法验证登录后的迁移提示。');
  await seedSession(context, session.sessionId);

  for (const key of MIGRATED) {
    await page.goto(`/#/${key}`);
    await expect(page.locator('.migrated-admin-page')).toBeVisible();
    await expect(page.locator('.migrated-admin-page h1')).toContainText('已迁移至后台管理系统');
    expect(new URL(page.url()).hash).toBe(`#/${key}`);
  }

  await page.getByRole('button', { name: '返回融合感知首页' }).click();
  await expect.poll(() => new URL(page.url()).hash).toContain('#/situation');
});
