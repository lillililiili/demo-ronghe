/* =============================================================================
 * 处置授权行的动作按钮 == 服务端在那一行给的 allowed_actions（决策 15-35）。
 *
 * 为什么这条放在 E2E 这一层：它验的是**权限到界面的对应关系**，和路由可达性同一类接缝，
 * 不是业务流程。E2 这次发现的"申请之后的审批/执行/停止在全仓没有任何页面入口"，
 * 恰恰是访问矩阵天然看不见的一种漏洞——页面进得去、内容也渲染了，只是那颗按钮从来不存在。
 * 这类问题不放在这一层，就没有别的层会看它。
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
  const session = await apiLogin(request, 'reviewer1');
  test.skip(session === null, 'reviewer1 尚不存在（决策 15-3）。这条不是通过，是没跑。');
  await seedSession(context, session.sessionId);

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
    } catch { /* 非 JSON 或已被消费：这一条就不参与比对，下面的空集合断言会兜住 */ }
  });

  // 不能依赖"默认选中的那条交接刚好有处置授权"：演示数据一加新交接，默认选中的就换人了
  // （2026-09-09 实测：新增的 seed-vol-pcase-* 交接排到了前面，默认那条主体下没有授权，
  //  用例于是等不到 .pn-disposal-row 而超时——那是夹具假设的问题，不是产品的问题）。
  // 改为先问服务端哪条交接的主体下确实有授权，再按 data-row 点那一条。
  const target = await findHandoffWithAuthorizations(request, session.sessionId);
  test.skip(target === null, '演示数据里没有任何一条交接的主体下有处置授权，这条用例没有可验的对象——'
      + '这不是通过，是没跑');

  await page.goto('/#/punish');
  await page.waitForSelector(`tr[data-row="${target}"]`);
  await page.click(`tr[data-row="${target}"]`);
  await page.waitForSelector('.pn-disposal-row');

  const rows = await page.locator('.pn-disposal-row').evaluateAll(nodes => nodes.map(node => ({
    id: node.querySelector('b.mono')?.getAttribute('title') || '',
    buttons: Array.from(node.querySelectorAll('.pn-disposal-acts button')).map(b => b.textContent.trim())
  })));

  expect(rows.length, '页面上一条处置授权都没有，这条用例什么也没验').toBeGreaterThan(0);
  expect(allowedById.size, '没有抓到 /disposal-authorizations 的响应，无从比对').toBeGreaterThan(0);

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

    // 有意不画的那些，必须**真的**没画——否则"有意"会在某次改动里悄悄变成"顺手加上了"。
    for (const action of allowed.filter(a => DELIBERATELY_NOT_RENDERED.includes(a))) {
      expect(row.buttons, `授权 ${row.id}：${action} 目前没有对应的弹窗，不该画出按钮；`
        + '若已经补上弹窗，请把它从 DELIBERATELY_NOT_RENDERED 里挪进 BUTTON_FOR_ACTION').not.toContain(action);
    }

    if (allowed.length) rowsWithActions++; else rowsWithoutActions++;
  }

  // 两边都要有样本，否则这条用例是空转的：
  // 只有可动作的行时，"不该画的没画"没跑；只有终态行时，"该画的画了"没跑。
  expect(rowsWithActions, '没有任何一行是可动作的——"该画的画了"这一半没有被执行').toBeGreaterThan(0);
  expect(rowsWithoutActions, '没有任何一行是终态的——"不该画的没画"这一半没有被执行；'
    + '把按钮写死成永远渲染也会通过').toBeGreaterThan(0);

  expect(signals.appErrors, `处罚页产生了应用级错误：\n${signals.appErrors.join('\n')}`).toEqual([]);
  const unexpected = unexpectedFailures(signals.failedResponses, 'reviewer1');
  expect(unexpected, `处罚页发出了 reviewer1 不该发出的请求：\n${unexpected.join('\n')}`).toEqual([]);
});

/**
 * 找一条"主体下有处置授权"的交接。顺着交接列表问服务端，拿到第一条有授权的就停。
 *
 * 放在测试侧而不是写死某个种子 id：种子 id 会随演示数据调整而变，写死等于把用例挂在
 * 别人的夹具编号上；而"哪条交接有授权"本来就是服务端能直接回答的问题。
 */
async function findHandoffWithAuthorizations(request, sessionId) {
  const headers = { Authorization: `Bearer ${sessionId}` };
  const listed = await request.get('/api/v1/handoffs?page=1&size=50', { headers });
  const handoffs = (await listed.json())?.data?.items || [];
  for (const handoff of handoffs) {
    if (!handoff.source_kind || !handoff.source_id) continue;
    const response = await request.get(
      `/api/v1/disposal-authorizations?subject_kind=${handoff.source_kind}&subject_id=${handoff.source_id}&page=1&size=1`,
      { headers });
    if (!response.ok()) continue;
    if (((await response.json())?.data?.items || []).length > 0) return handoff.handoff_id;
  }
  return null;
}
