import { expect, test } from '@playwright/test';
import { apiLogin, seedSession } from './support/session.js';

const VIEWED_KEY = 'situation.mock.viewed.v1';
const STARTED_KEY = 'situation.mock.started-at.v1';

async function openFreshSituation(context, page, request) {
  const session = await apiLogin(request, 'admin1');
  test.skip(session === null, '本地开发管理员不存在，无法验证融合感知页。');
  await seedSession(context, session.sessionId);
  await page.goto('/#/situation');
  await page.evaluate(([viewed, started]) => {
    sessionStorage.removeItem(viewed);
    sessionStorage.removeItem(started);
  }, [VIEWED_KEY, STARTED_KEY]);
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
  await expect(page.getByText('18 架监测目标', { exact: true })).toBeVisible();
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
      coverageFillsViewport: topLeft.x <= 0 && topLeft.y <= 0
        && bottomRight.x >= map.w && bottomRight.y >= map.h
    };
  });
  expect(mapInventory).toEqual({ deviceCount: 42, targetCount: 18, coverageFillsViewport: true });

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

  const firstAlarm = page.locator('.sit-alert-row').filter({ hasText: 'SIM-UAV-001' });
  await expect(firstAlarm).toHaveClass(/is-new/);
  await expect(firstAlarm).toContainText('新异常');
  await firstAlarm.click();
  await expect(firstAlarm).not.toHaveClass(/is-new/);
  await expect(firstAlarm).toContainText('已查看，风险持续');
  await expect(page.locator('.sit-map-pop-target')).toContainText('风险状态仍保留');
  await expect(page.getByText('已处理', { exact: false })).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.sit-alert-row').filter({ hasText: 'SIM-UAV-001' })).toContainText('已查看，风险持续');
  await expect(page.locator('.sit-alert-row').filter({ hasText: 'SIM-UAV-001' })).not.toHaveClass(/is-new/);
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
