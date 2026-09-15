import { expect, test } from '@playwright/test';
import { apiLogin, seedSession } from './support/session.js';

// 本页同时加载本地 PMTiles、WebGL 与持续 Canvas 动画；串行运行可避免多个
// Chromium 上下文争抢 GPU，导致底图 ready 与页面卸载断言出现非业务性超时。
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const VIEWED_KEY = 'situation.mock.viewed.v1';
const STARTED_KEY = 'situation.mock.started-at.v1';

async function openFreshSituation(context, page, request, { ageMs = 0 } = {}) {
  const session = await apiLogin(request, 'admin1');
  test.skip(session === null, '本地开发管理员不存在，无法验证融合感知页。');
  await seedSession(context, session.sessionId);
  await page.goto('/#/situation');
  await page.evaluate(([viewed, started, age]) => {
    sessionStorage.removeItem(viewed);
    if (age > 0) sessionStorage.setItem(started, String(Date.now() - age));
    else sessionStorage.removeItem(started);
  }, [VIEWED_KEY, STARTED_KEY, ageMs]);
  await page.reload();
  await expect(page.locator('.situation-page')).toBeVisible();
}

test('四源模拟态、设备气泡和查看状态保持正确语义', async ({ context, page, request }) => {
  await page.setViewportSize({ width: 1920, height: 800 });
  const writes = [];
  page.on('request', req => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
  });
  await openFreshSituation(context, page, request);

  await expect(page.getByText('模拟数据', { exact: true })).toBeVisible();
  await expect(page.getByText('非生产实时数据', { exact: true })).toBeVisible();
  await expect(page.getByText('监测目标 24 · 无人机 18 · 异物 6', { exact: true })).toBeVisible();
  await expect(page.locator('.sit-device-summary')).toContainText('38在线 2异常 2离线');
  await expect(page.locator('.sit-device-row')).toHaveCount(4);
  await expect(page.locator('.sit-device-row').nth(0)).toContainText('雷达6 台');
  await expect(page.locator('.sit-device-row').nth(1)).toContainText('光电6 台');
  await expect(page.locator('.sit-device-row').nth(2)).toContainText('5G-A12 台');
  await expect(page.locator('.sit-device-row').nth(3)).toContainText('TDOA18 台');
  await expect(page.locator('.sit-device-row').nth(0)).toContainText('单站 5 km');
  await expect(page.locator('#stMap')).toHaveAttribute('data-map-state', 'ready', { timeout: 30_000 });
  const mapInventory = await page.evaluate(() => {
    const map = document.querySelector('#stMap').__map;
    const [west, south, east, north] = map._viewBounds();
    const topLeft = map.map.project([west, north]);
    const bottomRight = map.map.project([east, south]);
    return {
      deviceCount: map.data.devices.length,
      targetCount: map.data.targets.length,
      planCount: map.data.flightPlans.length,
      riskCount: map.data.risks.length,
      airspaceKinds: map.data.airspaces.map(item => item.kindCode),
      iconKinds: [...new Set(map.data.targets.map(target => target.iconKind))].sort(),
      coverageFillsViewport: topLeft.x <= 0 && topLeft.y <= 0
        && bottomRight.x >= map.w && bottomRight.y >= map.h
    };
  });
  expect(mapInventory).toMatchObject({
    deviceCount: 42,
    targetCount: 24,
    planCount: 6,
    airspaceKinds: ['PROHIBITED', 'TEMPORARY_CONTROL', 'ALTITUDE_LIMIT', 'RESTRICTED', 'PERMITTED'],
    iconKinds: ['balloon', 'bird', 'kite', 'lantern', 'uav', 'unknown'],
    coverageFillsViewport: true
  });
  // 新风险在场景启动 18 秒后加入；慢速 CI 若在此之前仍在加载底图，允许快照已进入下一阶段。
  expect([2, 3]).toContain(mapInventory.riskCount);
  await expect(page.getByRole('button', { name: '防控空域，共5个区域' })).toHaveText('防控空域 5');

  await page.getByRole('button', { name: /展开TDOA设备，共18台/ }).click();
  await page.getByRole('button', { name: /查看TDOA设备 河口城区TDOA站3/ }).focus();
  await page.keyboard.press('Enter');
  const tip = page.locator('.maptip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('离线');
  await expect(tip).toContainText('当前不可用');
  await expect(tip).toContainText('前端演示配置');
  await expect(tip).toContainText('心跳中断');
  const box = await tip.boundingBox();
  const viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  await tip.getByRole('button', { name: '关闭设备详情' }).click();
  await expect(tip).toBeHidden();

  await page.getByRole('button', { name: /展开5G-A设备，共12台/ }).click();
  const abnormal5gDevice = page.getByRole('button', { name: /查看5G-A设备 广饶城区5G-A通感站1，异常/ });
  await expect(abnormal5gDevice).not.toContainText('告警');
  await abnormal5gDevice.click();
  await expect(tip).toContainText('异常');
  await expect(tip).toContainText('设备异常，覆盖能力不可用');
  await expect(tip).toContainText('通感时钟偏差超阈');
  await tip.getByRole('button', { name: '关闭设备详情' }).click();

  const firstAlarm = page.locator('.sit-alert-row').filter({ hasText: 'SIM-UAV-001' });
  await expect(firstAlarm).toHaveClass(/is-new/);
  await expect(firstAlarm).toContainText('新异常');
  await firstAlarm.click();
  await expect(firstAlarm).not.toHaveClass(/is-new/);
  await expect(firstAlarm).toContainText('已查看，风险持续');
  await expect(page.locator('.sit-map-pop-target .sit-map-pop-note')).toHaveCount(0);
  await expect(page.getByText('已处理', { exact: false })).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.sit-alert-row').filter({ hasText: 'SIM-UAV-001' })).toContainText('已查看，风险持续');
  await expect(page.locator('.sit-alert-row').filter({ hasText: 'SIM-UAV-001' })).not.toHaveClass(/is-new/);
  expect(writes).toEqual([]);
});

test('航线风险与异物、计划同步标记，查看不改变业务状态', async ({ context, page, request }) => {
  const writes = [];
  page.on('request', req => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
  });
  await openFreshSituation(context, page, request, { ageMs: 19_000 });
  await page.getByRole('tab', { name: /航线风险/ }).click();
  await expect(page.locator('.sit-route-risk-row')).toHaveCount(3);
  const newRisk = page.locator('.sit-route-risk-row').filter({ hasText: 'SIM-FP-20260914-003' });
  await expect(newRisk).toHaveClass(/is-new/);
  await expect(newRisk).toContainText('气球');
  await expect(newRisk).toContainText('邻近航线 · 236 m');
  const before = await page.evaluate(() => {
    const plan = document.querySelector('#stMap').__map.data.flightPlans.find(item => item.id === 'SIM-PLAN-003');
    const target = document.querySelector('#stMap').__map.data.targets.find(item => item.id === 'SIM-OBJ-002');
    return { activeRiskCount: plan.activeRiskCount, newRisk: plan.newRisk, targetNew: target.newAlert };
  });
  expect(before).toEqual({ activeRiskCount: 1, newRisk: true, targetNew: true });
  await newRisk.focus();
  await page.keyboard.press('Enter');
  await expect(newRisk).not.toHaveClass(/is-new/);
  await expect(newRisk).toContainText('待通知');
  await expect(page.locator('.sit-map-pop-plan')).toContainText('1 条当前风险');
  const after = await page.evaluate(() => {
    const plan = document.querySelector('#stMap').__map.data.flightPlans.find(item => item.id === 'SIM-PLAN-003');
    return { activeRiskCount: plan.activeRiskCount, newRisk: plan.newRisk };
  });
  expect(after).toEqual({ activeRiskCount: 1, newRisk: false });

  const planTip = page.locator('.sit-map-pop-plan');
  await expect(planTip.getByRole('button', { name: '排除风险' })).toBeVisible();
  await expect(planTip.getByRole('button', { name: '通知上级' })).toBeVisible();
  await planTip.getByRole('button', { name: '通知上级' }).click();
  const modal = page.locator('.n-modal');
  await expect(modal).toContainText('提交后通知渠道投递');
  await expect(modal).toContainText('本期仅记录前端模拟结果，不调用真实接口');
  await modal.getByRole('button', { name: '取消' }).click();
  await expect(modal).toBeHidden();
  await expect(newRisk).toHaveCount(1);

  await planTip.getByRole('button', { name: '通知上级' }).click();
  await modal.getByRole('button', { name: '提交通知' }).click();
  await expect(page.getByText('已提交（前端模拟）：已通知上级', { exact: true })).toBeVisible();
  await expect(newRisk).toHaveCount(0);
  await expect(planTip.getByRole('button', { name: '通知上级' })).toHaveCount(0);
  const notifiedPlan = await page.evaluate(() => {
    const plan = document.querySelector('#stMap').__map.data.flightPlans.find(item => item.id === 'SIM-PLAN-003');
    return { activeRiskCount: plan.activeRiskCount, newRisk: plan.newRisk };
  });
  expect(notifiedPlan).toEqual({ activeRiskCount: 0, newRisk: false });

  const birdRisk = page.locator('.sit-route-risk-row').filter({ hasText: 'SIM-FP-20260914-001' });
  await birdRisk.click();
  await page.locator('.sit-map-pop-plan').getByRole('button', { name: '排除风险' }).click();
  await expect(modal).toContainText('取消红色高亮，并从右上航线风险列表移除');
  await modal.getByRole('button', { name: '确认排除' }).click();
  await expect(page.getByText('已提交（前端模拟）：风险已排除', { exact: true })).toBeVisible();
  await expect(birdRisk).toHaveCount(0);
  await expect(page.locator('.sit-route-risk-row')).toHaveCount(1);

  const history = page.locator('.sit-route-risk-row').filter({ hasText: 'SIM-FP-20260914-005' });
  await expect(history).toHaveClass(/is-history/);
  await expect(history).toContainText('已通知');
  await page.reload();
  await page.getByRole('tab', { name: /航线风险/ }).click();
  await expect(page.locator('.sit-route-risk-row')).toHaveCount(1);
  await expect(page.getByText('已处理', { exact: false })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('第二条异常按时出现且减少动态效果时保持静态醒目', async ({ context, page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openFreshSituation(context, page, request);
  await expect(page.locator('.sit-alert-row')).toHaveCount(1);
  await expect(page.locator('.sit-alert-row')).toHaveCount(2, { timeout: 16_000 });
  const second = page.locator('.sit-alert-row').filter({ hasText: 'SIM-UAV-002' });
  await expect(second).toContainText('新异常');
  const durationSeconds = await second.evaluate(element => {
    const value = getComputedStyle(element).animationDuration;
    return value.endsWith('ms') ? Number.parseFloat(value) / 1000 : Number.parseFloat(value);
  });
  expect(durationSeconds).toBeLessThanOrEqual(0.00001);
  await expect(page.getByText('已处理', { exact: false })).toHaveCount(0);
});

test('图层按钮提供 Canvas 的键盘等价入口', async ({ context, page, request }) => {
  await openFreshSituation(context, page, request);
  const coverage = page.getByRole('button', { name: '覆盖范围' });
  await expect(coverage).toHaveAttribute('aria-pressed', 'true');
  await coverage.focus();
  await page.keyboard.press('Enter');
  await expect(coverage).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Enter');
  await expect(coverage).toHaveAttribute('aria-pressed', 'true');
  const plans = page.getByRole('button', { name: '计划航线' });
  await plans.focus();
  await page.keyboard.press('Enter');
  await expect(plans).toHaveAttribute('aria-pressed', 'false');
});

test('离开页面后销毁 Canvas 动画与监听载体', async ({ context, page, request }) => {
  await openFreshSituation(context, page, request);
  await page.evaluate(() => { window.__situationMapUnderTest = document.querySelector('#stMap').__map; });
  await page.goto('/#/flights');
  await expect(page.locator('.situation-page')).toHaveCount(0);
  const teardown = await page.evaluate(() => ({
    dead: window.__situationMapUnderTest?._dead,
    raf: window.__situationMapUnderTest?._raf,
    canvasChildren: window.__situationMapUnderTest?.box?.childElementCount
  }));
  expect(teardown).toEqual({ dead: true, raf: null, canvasChildren: 0 });
});

test('主流大屏尺寸下浮层不碰撞且页面无横向溢出', async ({ context, page, request }) => {
  await openFreshSituation(context, page, request);
  const sizes = [
    { width: 1280, height: 720 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1440, height: 1024 }
  ];

  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.waitForTimeout(250);
    const layout = await page.evaluate(() => {
      const device = document.querySelector('.sit-device-dock').getBoundingClientRect();
      const alert = document.querySelector('.sit-alert-dock').getBoundingClientRect();
      const layerbar = document.querySelector('.sit-layerbar').getBoundingClientRect();
      return {
        noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        dockGap: alert.left - device.right,
        layerbarInside: layerbar.left >= 0 && layerbar.right <= innerWidth && layerbar.bottom <= innerHeight,
        docksInside: device.left >= 0 && alert.right <= innerWidth
      };
    });
    expect(layout.noHorizontalOverflow).toBe(true);
    expect(layout.dockGap).toBeGreaterThan(12);
    expect(layout.layerbarInside).toBe(true);
    expect(layout.docksInside).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`situation-${size.width}x${size.height}.png`),
      animations: 'disabled'
    });
  }
});
