import { expect, test } from '@playwright/test';
import { apiLogin, seedSession } from './support/session.js';

test('天气模拟预报停留至到期时重新读取并显示过期', async ({ context, page, request }) => {
  const session = await apiLogin(request, 'admin1');
  expect(session, '需要本地开发管理员').not.toBeNull();
  const plans = await request.get('/api/v1/flight-plans', { headers: { Authorization: `Bearer ${session.sessionId}` } });
  const envelope = await plans.json();
  const planId = envelope.data.items[0]?.plan_id;
  expect(planId, '需要已有可访问计划，不创建业务数据').toBeTruthy();
  await seedSession(context, session.sessionId);
  const start = Date.now();
  await page.clock.install({ time: start });
  let expired = false;
  await page.route(`**/api/v1/flight-plans/${planId}/weather-forecast`, route => route.fulfill({ json: {
    ok: true, data: { plan_id: planId, status: expired ? 'STALE' : 'READY', forecast: {
      area_name: '接口测试区域', provider_name: '天气模拟服务', source_mode: 'mock', published_at: start,
      periods: [{ from: start, to: start + 5000, summary: '晴', temperature_c: 24 }]
    } }
  } }));
  await page.goto(`/#/flights?plan=${encodeURIComponent(planId)}`);
  await page.getByRole('tab', { name: '天气预报', exact: true }).click();
  await expect(page.locator('.plan-weather')).toContainText('模拟数据');
  expired = true;
  await page.clock.runFor(6000);
  await expect(page.locator('.plan-weather')).toContainText('天气预报已过期');
});
