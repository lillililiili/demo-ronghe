/* =============================================================================
 * 访问矩阵：navModel 里全部路由 × {admin1, reviewer1}（决策 15-10）。
 *
 * 这一层**只钉"页面进不进得去"**，不做业务流程：
 *   · 该进的进得去，而且真渲染出了内容（只断言"没有拒绝页"，白屏也会绿）；
 *   · 该拦的拦得住，而且提示里写的是**用户看得懂的页名**（决策 15-8/12-14）；
 *   · 全程没有控制台错误与未捕获异常；
 *   · 1280/1366/1440 三档视口下不出现横向滚动。
 *
 * 期望值来自服务端 /auth/me 的 menu_keys，不在用例里再抄一份角色矩阵——
 * 要验的就是"前端的判断与后端的授权是否一致"。
 * ========================================================================== */
import { expect, test } from '@playwright/test';

import {
  BIGSCREEN_KEY, ROUTE_KEYS, deniedTitle, expectReachable, landingKey, pageTitle, permissionKey
} from './support/matrix.js';
import { ACCOUNTS, apiLogin, collectPageSignals, seedSession, unexpectedFailures } from './support/session.js';

const VIEWPORT_WIDTHS = [1280, 1366, 1440];

/** 布局改完要等两帧才稳；固定 sleep 会在慢机器上变成偶发红。 */
async function settle(page) {
  await page.evaluate(() => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function assertNoHorizontalOverflow(page) {
  for (const width of VIEWPORT_WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await settle(page);
    const measured = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth
    }));
    expect(measured.scrollWidth, `${width}px 视口下页面横向溢出 ${measured.scrollWidth - measured.innerWidth}px`)
      .toBeLessThanOrEqual(measured.innerWidth);
  }
}

/** 登录 + 注入会话；账号还不存在时返回 null，由调用方转成**带理由的显式 skip**。 */
/** 应用自身的错误一条都不许有；失败响应按 session.js 的显式清单逐条对账。 */
function assertNoUnexpectedNoise(signals, account, what) {
  expect(signals.appErrors, `${what}产生了应用级错误：\n${signals.appErrors.join('\n')}`).toEqual([]);
  const unexpected = unexpectedFailures(signals.failedResponses, account);
  expect(unexpected,
    `${what}发出了 ${account} 不该发出的请求（清单外的失败响应）：\n${unexpected.join('\n')}\n`
    + '若确属该角色的正常越权拒绝，请在 e2e/support/session.js 的 EXPECTED_FAILED_RESPONSES 里逐条登记并写明理由。')
    .toEqual([]);
}

async function signIn(context, request, account) {
  const session = await apiLogin(request, account);
  if (session) await seedSession(context, session.sessionId);
  return session;
}

for (const { account, why } of ACCOUNTS) {
  test.describe(`${account}（${why}）`, () => {

    /* 反空转自检（本账号一侧）：这个账号至少要有一个可达页，
       否则整段 describe 里"进得去"那一半根本没跑，却全绿。 */
    test('矩阵自检：本账号至少有一个可达页', async ({ context, request }) => {
      const session = await signIn(context, request, account);
      test.skip(session === null, `账号 ${account} 尚不存在（决策 15-3）。`);
      const reachable = ROUTE_KEYS.filter(key => expectReachable(key, session.menuKeys));
      expect(reachable.length,
        `${account}（${session.roleCode}）一个可达页都没有，"进得去"这一半是空转`).toBeGreaterThan(0);
    });

    for (const key of ROUTE_KEYS) {
      test(`#/${key} —— ${pageTitle(key)}`, async ({ context, page, request }) => {
        const session = await signIn(context, request, account);
        test.skip(session === null,
          `账号 ${account} 尚不存在：LocalStage15DemoReviewerSeeder 未落地（决策 15-3）。`
          + '这条不是通过，是没跑——报告里按 skip 计数。');

        const signals = collectPageSignals(page);
        await page.goto(`/#/${key}`);
        await page.waitForSelector('.view', { state: 'attached' });

        /* 落地路由：#/overview → #/situation，#/risk → #/flights?tab=events（router/index.js）。
           断言的是**落地后**的地址，不是"停在原地"。 */
        const landed = landingKey(key);
        await expect.poll(() => new URL(page.url()).hash,
          { message: `#/${key} 应落到 #/${landed}` }).toContain(`#/${landed}`);
        if (key === 'risk') {
          expect(new URL(page.url()).hash, '#/risk 要带上「全部风险事件」页签').toContain('tab=events');
        }

        const denied = page.locator('.access-denied');
        if (expectReachable(key, session.menuKeys)) {
          await expect(denied, `${account} 的 menu_keys 里有这一页的权限，却被前端拦下了`).toHaveCount(0);
          /* 不只是"没有拒绝页"：真有内容渲染出来才算进得去。 */
          await expect(page.locator('.view:not(.access-denied-view)').first(),
            '页面没有渲染出任何内容（可能是路由键没登记到 pages/registry.js）').toBeVisible();
        } else {
          await expect(denied, `${account} 没有这一页的权限，却没有被拦下`).toBeVisible();
          await expect(denied.locator('h2'),
            '拒绝页要说用户看得懂的页名，不是英文路由键（决策 12-14）').toContainText(deniedTitle(key));
          /* 别名页（如 #/airspace 由飞行计划的权限承载）还要说**该去要哪一页的权限**（决策 15-8）：
             只说"需要空域与航线规则的查看权限"，看的人会去找一个权限矩阵里根本不存在的项。 */
          if (permissionKey(key) !== landed) {
            await expect(denied.locator('p'),
              `#/${key} 的权限挂在“${pageTitle(permissionKey(key))}”下，提示里必须出现它（决策 15-8）`)
              .toContainText(pageTitle(permissionKey(key)));
          }
        }

        await assertNoHorizontalOverflow(page);
        assertNoUnexpectedNoise(signals, account, `#/${key}`);
      });
    }

    /* 大屏不走 PageHost：App.vue 直接挂 BigScreenApp（另一套外壳），所以单列。
       无权限时会落回 PageHost 分支 → 拒绝页，两边仍然对称。 */
    test(`#/${BIGSCREEN_KEY} —— ${pageTitle(BIGSCREEN_KEY)}（独立外壳）`, async ({ context, page, request }) => {
      const session = await signIn(context, request, account);
      test.skip(session === null,
        `账号 ${account} 尚不存在：LocalStage15DemoReviewerSeeder 未落地（决策 15-3）。`);

      const signals = collectPageSignals(page);
      await page.goto(`/#/${BIGSCREEN_KEY}`);

      if (session.menuKeys.includes(BIGSCREEN_KEY)) {
        await expect(page.locator('.bs-root'), '有大屏菜单权限却没渲染出大屏').toBeVisible();
        await expect(page.locator('.access-denied')).toHaveCount(0);
      } else {
        await expect(page.locator('.access-denied')).toBeVisible();
        await expect(page.locator('.access-denied h2')).toContainText(pageTitle(BIGSCREEN_KEY));
      }
      assertNoUnexpectedNoise(signals, account, '大屏');
    });
  });
}

/* 反空转自检（整张矩阵）：**必须至少有一个账号在某一页上会被拦下**。
   admin1 是超管，天然全可达；如果 reviewer1 哪天被授成了全菜单（演示种子改错一次就够），
   36 条用例会全绿，而"拦得住"那一半一次都没跑——没有这条谁也不会发现。
   所以这一条不放在 per-account 的 describe 里，它问的是整张矩阵有没有意义。 */
test('矩阵自检：整张矩阵里必须存在"应被拦下"的组合', async ({ context, request }) => {
  const blocked = [];
  const missing = [];
  for (const { account } of ACCOUNTS) {
    const session = await apiLogin(request, account);
    if (session === null) { missing.push(account); continue; }
    ROUTE_KEYS.filter(key => !expectReachable(key, session.menuKeys))
      .forEach(key => blocked.push(`${account} #/${key}`));
  }
  expect(missing,
    `这些演示账号还不存在，被拦的那一半没有账号来跑：${missing.join('、')}`
    + '（LocalStage15DemoReviewerSeeder，决策 15-3）').toEqual([]);
  expect(blocked.length,
    '整张矩阵里没有任何"应被拦下"的组合——拒绝路径一次都没被执行，全绿不代表拦得住')
    .toBeGreaterThan(0);
});
