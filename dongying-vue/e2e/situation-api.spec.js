import { expect, test } from '@playwright/test';
import { apiLogin, collectPageSignals, seedSession, unexpectedFailures } from './support/session.js';

const batch = process.env.MQTT_ACCEPTANCE_BATCH;

function escaped(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('融合感知页展示真实后端 MQTT 批次及四源融合链路', async ({ context, page, request }) => {
  test.skip(!batch, '未提供 MQTT_ACCEPTANCE_BATCH，跳过真实 MQTT 批次验收。');
  const session = await apiLogin(request, 'admin1');
  test.skip(session === null, '本地开发管理员不存在，无法验证融合感知页。');
  await seedSession(context, session.sessionId);
  const headers = { Authorization: `Bearer ${session.sessionId}` };

  const deviceResponse = await request.get(`/api/v1/devices?page=1&size=100&keyword=${encodeURIComponent(batch)}`, { headers });
  const deviceEnvelope = await deviceResponse.json();
  expect(deviceEnvelope.ok).toBeTruthy();
  expect(deviceEnvelope.data.items).toHaveLength(42);
  expect(deviceEnvelope.data.items.every(device => device.coverage?.status === 'AVAILABLE')).toBeTruthy();

  const observedFrom = Date.now() - 5 * 60_000;
  const targetResponse = await request.get(`/api/v1/targets?page=1&size=100&seen_from=${observedFrom}&seen_to=${Date.now()}`, { headers });
  const targetEnvelope = await targetResponse.json();
  expect(targetEnvelope.ok).toBeTruthy();
  let fourSourceTarget = null;
  for (const target of targetEnvelope.data.items) {
    const detailResponse = await request.get(`/api/v1/targets/${target.target_id}`, { headers });
    const detailEnvelope = await detailResponse.json();
    if (!detailEnvelope.ok) continue;
    const links = detailEnvelope.data.source_links || [];
    if (!links.some(link => String(link.source_name || '').includes(batch))) continue;
    const types = new Set(links.map(link => link.source_type));
    if (['RADAR', 'TDOA', 'FIVE_G_A', 'EO'].every(type => types.has(type))) {
      fourSourceTarget = detailEnvelope.data;
      break;
    }
  }
  expect(fourSourceTarget, '应找到同批次的雷达/TDOA/5G-A/光电四源目标').not.toBeNull();

  const signals = collectPageSignals(page);
  await page.goto('/#/situation');
  await expect(page.locator('.situation-page')).toBeVisible();
  await expect(page.locator('.sit-live-pill')).not.toContainText('来源待确认');
  await expect(page.locator('.sit-live-pill')).toContainText(/回放/);
  await page.getByRole('button', { name: /展开雷达设备/ }).click();
  await expect(page.getByRole('button', { name: new RegExp(escaped(batch)) }).first()).toBeVisible();

  const alarm = page.getByRole('button', {
    name: new RegExp(`查看${escaped(fourSourceTarget.target_no)}的`)
  }).first();
  await expect(alarm).toBeVisible();
  await alarm.click();
  await expect(page.locator('.sit-fuse-dock')).toBeVisible();
  for (const type of ['雷达', 'TDOA', '5G-A', '光电']) {
    await expect(page.locator('.sit-fuse-links')).toContainText(type);
  }

  expect(signals.appErrors).toEqual([]);
  const failures = signals.failedResponses.filter(item =>
    !(item.status === 404 && item.path === '/map-data/control/map-config.json'));
  expect(unexpectedFailures(failures, 'admin1')).toEqual([]);
});
