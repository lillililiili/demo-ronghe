import { expect, test } from '@playwright/test';

// 真实 Vue 组件的浏览器回归：固定计划 props，仅拦截天气读取，不创建业务计划或登录会话。
const plan = { id: 'weather-component-regression', start: Date.UTC(2026, 8, 23, 2), end: Date.UTC(2026, 8, 23, 3) };

function forecastFor(plan, periods) {
  return {
    area_name: '接口测试区域', provider_name: '天气模拟服务', source_mode: 'mock',
    published_at: plan.start - 120_000,
    periods: periods || [
      { from: plan.start - 60_000, to: plan.end + 60_000, summary: '晴', temperature_c: 24 },
      { from: plan.start - 120_000, to: plan.start, summary: '计划前时段' }
    ]
  };
}

function beijingTime(value) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

async function openForecast(page, request, data) {
  const componentPath = '/src/pages/flights/components/PlanWeatherForecast.vue';
  const component = await request.get(componentPath);
  expect(component.ok(), '需要现有 Vite 服务编译真实天气组件').toBe(true);
  // 与 Vite 编译组件使用相同的 Vue 模块 URL，避免测试挂载第二份运行时。
  const vueModule = (await component.text()).match(/from\s+["']([^"']*\/vue\.js(?:\?[^"']*)?)["']/)?.[1];
  expect(vueModule, '需要可读取的 Vite Vue 模块入口').toBeTruthy();
  let reads = 0;
  await page.route('**/api/v1/**', route => route.abort('blockedbyclient'));
  await page.route(`**/api/v1/flight-plans/${plan.id}/weather-forecast`, route => {
    reads++;
    return route.fulfill({ json: { ok: true, data: { plan_id: plan.id, ...data } } });
  });
  await page.route('**/__weather-forecast-test__', route => route.fulfill({ contentType: 'text/html', body: `
    <!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"></head><body><div id="app"></div>
    <script type="module">
      import { createApp } from ${JSON.stringify(vueModule)};
      import PlanWeatherForecast from ${JSON.stringify(componentPath)};
      createApp(PlanWeatherForecast, ${JSON.stringify({ planId: plan.id, startAt: plan.start, endAt: plan.end })}).mount('#app');
    </script></body></html>` }));
  await page.goto('/__weather-forecast-test__');
  await expect(page.locator('.plan-weather .weather-summary')).toBeVisible();
  return () => reads;
}

async function expectCoveredForecast(page, plan, forecast) {
  const weather = page.locator('.plan-weather');
  await expect(weather.locator('.forecast-period')).toHaveCount(1);
  await expect(weather.locator('.forecast-period header strong')).toHaveText(
    `${beijingTime(plan.start)} 至 ${beijingTime(plan.end)}`);
  await expect(weather.locator('.forecast-period')).toContainText('24°C');
  await expect(weather).not.toContainText('计划前时段');
  await expect(weather.locator('.weather-summary')).toContainText('天气模拟服务');
  await expect(weather.locator('.weather-summary')).toContainText('模拟数据');
  await expect(weather.locator('.weather-summary')).toContainText(beijingTime(forecast.published_at));
  await expect(weather).not.toContainText('过期');
}

test('READY 预报裁剪到计划时段，跨过结束时间及恢复可见后不按到期重读', async ({ page, request }) => {
  const forecast = forecastFor(plan);
  const forecastEnd = forecast.periods[0].to;
  await page.clock.install({ time: forecastEnd - 60_000 });
  const reads = await openForecast(page, request, { status: 'READY', forecast });
  await expectCoveredForecast(page, plan, forecast);
  expect(reads()).toBe(1);

  await page.clock.pauseAt(forecastEnd - 5000);
  await page.clock.runFor(6000);
  await expectCoveredForecast(page, plan, forecast);
  expect(reads(), '跨过预报结束时间不触发到期读取').toBe(1);

  // 显式模拟页面从隐藏恢复可见，避免无头浏览器的前台标签行为差异。
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
  });
  await page.clock.runFor(1000);
  await expectCoveredForecast(page, plan, forecast);
  expect(reads(), '恢复可见不触发到期读取').toBe(1);
});

test('兼容旧 STALE 响应：有覆盖的预报正常展示并忽略过期提示', async ({ page, request }) => {
  const forecast = forecastFor(plan);
  await openForecast(page, request, { status: 'STALE', message: '天气预报已过期，请重新读取', forecast });
  await expectCoveredForecast(page, plan, forecast);
  await expect(page.locator('.plan-weather')).not.toContainText('请重新读取');
});

test('兼容旧 STALE 响应：无计划时段覆盖时只提示暂无预报', async ({ page, request }) => {
  const forecast = forecastFor(plan, [
    { from: plan.start - 60_000, to: plan.start, summary: '计划前时段' },
    { from: plan.end, to: plan.end + 60_000, summary: '计划后时段' }
  ]);
  await openForecast(page, request, { status: 'STALE', message: '天气预报已过期，请重新读取', forecast });
  const weather = page.locator('.plan-weather');
  await expect(weather.locator('.forecast-period')).toHaveCount(0);
  await expect(weather.locator('.weather-state strong')).toHaveText('计划飞行时段暂无天气预报');
  await expect(weather).toContainText('当前预报未覆盖计划飞行时段。');
  await expect(weather).not.toContainText('过期');
  await expect(weather).not.toContainText('请重新读取');
  await expect(weather).not.toContainText('计划前时段');
  await expect(weather).not.toContainText('计划后时段');
});
