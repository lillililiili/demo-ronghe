import { expect, test } from '@playwright/test';
import { apiLogin, seedSession } from './support/session.js';

test('统计保留真实零值、不可用原因与模拟来源，缺失值不补零', async ({ context, page, request }) => {
  const session = await apiLogin(request, 'admin1');
  test.skip(session === null, '本地验收账号不存在');
  await seedSession(context, session.sessionId);
  await page.route('**/api/v1/stats/operations', route => route.fulfill({ json: {
    ok: true, data: {
      from: '2026-09-01', to: '2026-09-22', generated_at: 1790046000000,
      source_mode: 'replay', simulated: true, summary: { total: 0, illegal: null, punish: 0, high_risk: null },
      devices: { total: 0, online: 0, online_rate: null }, days: [], regions: [],
      by_type: [], by_risk: [], by_duration: [], by_track: [], alt_bands: [], alt_total: 0, by_penalty: [], partners: [],
      availability: {
        total: { status: 'AVAILABLE', reason: '按首次发现时间去重' },
        punish: { status: 'AVAILABLE', reason: '按立案时间统计案件' },
        illegal: { status: 'UNAVAILABLE', reason: '当前账号无合法性读取权限' },
        high_risk: { status: 'UNAVAILABLE', reason: '当前账号无风险读取权限' },
        by_risk: { status: 'UNAVAILABLE', reason: '当前账号无风险读取权限' },
        by_type: { status: 'AVAILABLE', reason: '当前目标类型' },
        alt_bands: { status: 'AVAILABLE', reason: '海拔缺失不以离地高度替代', missing_count: 0 },
        by_duration: { status: 'UNAVAILABLE', reason: '尚无可靠的飞行时长汇总' },
        by_track: { status: 'UNAVAILABLE', reason: '尚无可靠的里程汇总' },
        by_penalty: { status: 'AVAILABLE', reason: '仅统计有效处罚决定', missing_count: 0 }
      }
    }
  } }));
  await page.goto('/#/stats');
  await expect(page.getByText('新增目标数', { exact: true })).toBeVisible();
  await expect(page.getByText('当前账号无合法性读取权限', { exact: true })).toBeVisible();
  await expect(page.getByText('飞行时长统计', { exact: true })).toHaveCount(0);
  await expect(page.getByText('轨迹长度统计', { exact: true })).toHaveCount(0);
  await expect(page.getByText('每日立案数量', { exact: true })).toBeVisible();
  await expect(page.getByText('处罚结果形成情况', { exact: true })).toBeVisible();
  await expect(page.locator('.stats-penalty')).toContainText('统计区间内无立案案件');
  await expect(page.locator('.stats-penalty .penalty-bars')).toHaveCount(0);
  await expect(page.locator('.stats-basis')).toContainText('回放记录');
  await expect(page.locator('.stats-basis')).toContainText('北京时间');
  await expect(page.getByText('飞行/目标总次数', { exact: true })).toHaveCount(0);
});
