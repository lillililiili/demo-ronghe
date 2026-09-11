/* =============================================================================
 * 处置授权行的动作按钮 == 服务端在那一行给的 allowed_actions（决策 15-35）。
 *
 * 为什么这条放在 E2E 这一层：它验的是**权限到界面的对应关系**，和路由可达性同一类接缝，
 * 不是业务流程。E2 这次发现的"申请之后的审批/执行/停止在全仓没有任何页面入口"，
 * 恰恰是访问矩阵天然看不见的一种漏洞——页面进得去、内容也渲染了，只是那颗按钮从来不存在。
 * 这类问题不放在这一层，就没有别的层会看它。
 *
 * <p>**夹具自给**（2026-09-09）：干净库里阶段 13 的三条种子授权分别是 REJECTED/COMPLETED/EXPIRED
 * （批准过的那条 30 分钟有效期早就过了），`allowed_actions` 全是空的——"该画的画了"这一半
 * 在干净库上**结构性地跑不到**。CI 第三跑就红在这里，而本机之前是绿的，因为库里有别人手工造的行。
 * 所以这条用例现在**自己发起一条处置申请**（REQUESTED，`allowed_actions=[APPROVE,REJECT,CANCEL]`），
 * 比对完再 cancel 收回，不依赖库里恰好存在可动作的行。
 *
 * 判据取**两个方向都要对**：
 *   · 画出来的每一颗按钮，服务端都得允许——否则就是"点了才吃 403"的越权入口；
 *   · 服务端允许、且本页有入口的动作，都得画出来——否则就是这次要修的那种漏做。
 * 只查一个方向都会留下一整类看不见的问题。
 * ========================================================================== */
import { expect, test } from '@playwright/test';

import { apiLogin, collectPageSignals, seedSession, unexpectedFailures } from './support/session.js';

/**
 * 页面承诺提供入口的动作（`PunishPage.vue` 的 `DISPOSAL_ROW_ACTIONS`）。
 *
 * 这份表在测试里**另写一份**而不是 import 产品代码：它是**策略主张**（"这几个动作本页给入口"），
 * 不是事实。照抄的话，谁把某个动作的入口去掉，测试跟着一起去掉、照样全绿——
 * 而那正是需要有人确认一次的改动。同样的理由见 e2e/support/matrix.js 里的别名表。
 */
const BUTTON_FOR_ACTION = {
  APPROVE: '审批',        // 批准与驳回是同一个弹窗的两个结论，只画一颗
  REJECT: '审批',
  EXECUTE: '执行',
  MANUAL_RESULT: '登记执行结果',
  STOP: '停止'
};

/** 服务端会给、但本页**有意不画**的动作：还没有对应的弹窗，画一颗点不动的按钮不如不画。 */
const DELIBERATELY_NOT_RENDERED = ['CANCEL'];

test('处罚页的处置授权行：按钮集合与服务端 allowed_actions 一致', async ({ context, page, request }) => {
  const reviewer = await apiLogin(request, 'reviewer1');
  test.skip(reviewer === null, 'reviewer1 尚不存在（决策 15-3）。这条不是通过，是没跑。');
  const admin = await apiLogin(request, 'admin1');
  test.skip(admin === null, 'admin1 不可登录，无法自给夹具。这条不是通过，是没跑。');

  const subject = await pickHandoffSubject(request, reviewer.sessionId);
  test.skip(subject === null, '交接列表里没有任何带主体的交接，这条用例没有可验的对象——这不是通过，是没跑。');

  // 自己造一条待审批的授权：干净库里没有任何可动作的行，"该画的画了"那一半否则永远跑不到。
  const created = await requestAuthorization(request, admin.sessionId, subject);
  test.skip(created === null, '无法发起处置申请（接口或权限不可用），没有可动作的行可比——这不是通过，是没跑。');

  try {
    await seedSession(context, reviewer.sessionId);
    const signals = collectPageSignals(page);
    /** 服务端逐行给的 allowed_actions，按授权号索引。 */
    const allowedById = new Map();
    page.on('response', async response => {
      if (!new URL(response.url()).pathname.endsWith('/disposal-authorizations')) return;
      try {
        const body = await response.json();
        for (const item of body?.data?.items || []) {
          allowedById.set(item.authorization_id, item.allowed_actions || []);
        }
      } catch { /* 非 JSON 或已被消费：下面的空集合断言会兜住 */ }
    });

    await page.goto('/#/punish');
    await page.waitForSelector(`tr[data-row="${subject.handoffId}"]`);
    await page.click(`tr[data-row="${subject.handoffId}"]`);
    await page.waitForSelector('.pn-disposal-row');

    const rows = await page.locator('.pn-disposal-row').evaluateAll(nodes => nodes.map(node => ({
      id: node.querySelector('b.mono')?.getAttribute('title') || '',
      buttons: Array.from(node.querySelectorAll('.pn-disposal-acts button')).map(b => b.textContent.trim())
    })));

    expect(rows.length, '页面上一条处置授权都没有，这条用例什么也没验').toBeGreaterThan(0);
    expect(allowedById.size, '没有抓到 /disposal-authorizations 的响应，无从比对').toBeGreaterThan(0);
    expect(rows.map(row => row.id), '刚发起的那条授权必须出现在页面上，否则比对的不是它')
        .toContain(created.authorizationId);

    let rowsWithActions = 0;
    let rowsWithoutActions = 0;
    for (const row of rows) {
      const allowed = allowedById.get(row.id);
      expect(allowed, `页面上的授权 ${row.id} 在服务端响应里找不到`).toBeDefined();

      const expectedButtons = [...new Set(allowed
        .filter(action => !DELIBERATELY_NOT_RENDERED.includes(action))
        .map(action => BUTTON_FOR_ACTION[action])
        .filter(Boolean))];

      expect([...new Set(row.buttons)].sort(),
        `授权 ${row.id}：服务端允许 [${allowed.join(', ')}]，页面画了 [${row.buttons.join(', ')}]。`
        + '多一颗是"点了才吃 403"的越权入口，少一颗是这条动作在全仓没有入口。')
        .toEqual(expectedButtons.sort());

      for (const action of allowed.filter(a => DELIBERATELY_NOT_RENDERED.includes(a))) {
        expect(row.buttons, `授权 ${row.id}：${action} 目前没有对应的弹窗，不该画出按钮；`
          + '若已经补上弹窗，请把它从 DELIBERATELY_NOT_RENDERED 里挪进 BUTTON_FOR_ACTION').not.toContain(action);
      }

      if (allowed.length) rowsWithActions++; else rowsWithoutActions++;
    }

    // 两边都要有样本，否则这条用例是空转的。可动作的那一行现在由夹具保证，
    // 终态那几行由阶段 13 的种子保证（REJECTED/COMPLETED/EXPIRED）。
    expect(rowsWithActions, '没有任何一行是可动作的——"该画的画了"这一半没有被执行；'
      + '夹具刚发起的那条授权应当就是它').toBeGreaterThan(0);
    expect(rowsWithoutActions, '没有任何一行是终态的——"不该画的没画"这一半没有被执行；'
      + '把按钮写死成永远渲染也会通过').toBeGreaterThan(0);

    expect(signals.appErrors, `处罚页产生了应用级错误：\n${signals.appErrors.join('\n')}`).toEqual([]);
    const unexpected = unexpectedFailures(signals.failedResponses, 'reviewer1');
    expect(unexpected, `处罚页发出了 reviewer1 不该发出的请求：\n${unexpected.join('\n')}`).toEqual([]);
  } finally {
    // 收尾放 finally：用例红了也要把这条申请撤回，否则下一轮库里会攒出一堆待审批的演示申请。
    await cancelAuthorization(request, admin.sessionId, created);
  }
});

/**
 * 取一条带主体的交接（处罚页的授权面板按交接的 source_kind/source_id 列授权）。
 *
 * **从列表末尾往前找，而不是取第一条**：处罚页默认选中的是**第一条**交接，
 * 访问矩阵那些用例打开 `#/punish` 看到的就是它。这条用例会在选中的主体上建一条授权再撤回，
 * 如果用的也是第一条，两边就会在并发（3 个 worker）下互相干扰——
 * 实测表现为 `reviewer1 #/punish` 时红时绿，两遍数字对不上。
 * 用末尾那条，等于给这条用例一个别人不会浏览的主体，干扰就没有了。
 */
async function pickHandoffSubject(request, sessionId) {
  const listed = await request.get('/api/v1/handoffs?page=1&size=50',
    { headers: { Authorization: `Bearer ${sessionId}` } });
  const handoffs = (await listed.json())?.data?.items || [];
  for (let i = handoffs.length - 1; i >= 0; i--) {
    const handoff = handoffs[i];
    if (handoff.source_kind && handoff.source_id) {
      return { handoffId: handoff.handoff_id, subjectKind: handoff.source_kind, subjectId: handoff.source_id };
    }
  }
  return null;
}

/**
 * 自己发起一条处置申请。`channel: MANUAL` 是有意的——经设备执行的处置必须指定设备，
 * 而本用例不关心设备，挑人工渠道就不必在测试里硬编码某台种子设备。
 */
async function requestAuthorization(request, sessionId, subject) {
  const response = await request.post('/api/v1/disposal-authorizations', {
    headers: { Authorization: `Bearer ${sessionId}`, 'Idempotency-Key': `e2e-disposal-${Date.now()}-${Math.random()}` },
    data: {
      action_type: 'DISPERSAL', subject_kind: subject.subjectKind, subject_id: subject.subjectId,
      channel: 'MANUAL', reason: 'E2E 夹具：自给一条待审批的处置申请，跑完撤回'
    }
  });
  if (!response.ok()) return null;
  const data = (await response.json())?.data;
  return data?.authorization_id ? { authorizationId: data.authorization_id, version: data.version ?? 0 } : null;
}

async function cancelAuthorization(request, sessionId, created) {
  if (!created) return;
  await request.post(`/api/v1/disposal-authorizations/${created.authorizationId}/cancel`, {
    headers: { Authorization: `Bearer ${sessionId}`, 'Idempotency-Key': `e2e-cancel-${Date.now()}-${Math.random()}` },
    data: { expected_version: created.version }
  });
}
