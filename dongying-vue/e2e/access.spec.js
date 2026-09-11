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
import { ACCOUNTS, DISABLED_ACCOUNT, apiLogin, collectPageSignals, PASSWORD, seedSession, unexpectedFailures } from './support/session.js';

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

/**
 * 角色覆盖自检：**每一个有人使用的角色，矩阵里都要有一个账号代表它**。
 *
 * 没有这一条，演示种子哪天没跑成功、或某个角色改了名，`ACCOUNTS` 里的账号登不上会被逐条 skip，
 * 矩阵悄悄缩回只剩超管——**少测了四五个角色，报表上和"全测过了"长得一模一样**。
 * 这正是本项目反复踩的那个形状：没跑到的检查，看起来和跑过且通过的检查完全相同。
 *
 * 判据取"有人使用的角色"而不是"全部角色"：没有任何用户的角色本来也没法登录去验，
 * 把它算进来只会让这条自检变成一条永远红的噪声。
 */
test('矩阵自检：每个有人使用的角色都有账号代表', async ({ request }) => {
  const admin = await apiLogin(request, 'admin1');
  test.skip(admin === null, 'admin1 不可登录，无从取得角色清单。这不是通过，是没跑。');

  const listed = await request.get('/api/v1/roles', { headers: { Authorization: `Bearer ${admin.sessionId}` } });
  expect(listed.ok(), '取不到角色清单，这条自检没有比对对象').toBeTruthy();
  const rolesWithUsers = ((await listed.json())?.data || [])
    .filter(role => (role.user_count ?? 0) > 0)
    .map(role => role.role_code)
    .sort();

  const covered = [];
  const missing = [];
  for (const { account } of ACCOUNTS) {
    const session = await apiLogin(request, account);
    if (session === null) missing.push(account);
    else covered.push(session.roleCode);
  }
  expect(missing, `这些账号登不上，矩阵实际没有覆盖它们所代表的角色：${missing.join('、')}。`
    + '多半是演示种子没落地——此时其余用例会逐条 skip 而不是红，很容易被当成全绿').toEqual([]);

  expect([...new Set(covered)].sort(),
    '有人使用的角色必须都在矩阵里有代表；对不上说明种子加了新角色而覆盖清单没跟上')
    .toEqual(rolesWithUsers);
});

/**
 * 已停用的账号**必须登不上**。
 *
 * 这条验的是认证不是访问矩阵，所以不进上面的循环。它的价值在于：停用是一个**动作**，
 * 而"停用之后还能登"在页面上看不出来——只有拿这个账号真去登一次才知道。
 */
test(`已停用的账号 ${DISABLED_ACCOUNT.account} 必须登不上`, async ({ request }) => {
  const response = await request.post('/api/v1/auth/login', {
    data: { account: DISABLED_ACCOUNT.account, password: PASSWORD }
  });
  const envelope = await response.json();

  // 先自证这个账号确实存在：不存在的账号也登不上，那样这条用例什么也没证明。
  const admin = await apiLogin(request, 'admin1');
  test.skip(admin === null, 'admin1 不可登录，无法确认停用账号是否存在。这不是通过，是没跑。');
  const users = await request.get(`/api/v1/users?keyword=${DISABLED_ACCOUNT.account}&page=1&size=5`,
    { headers: { Authorization: `Bearer ${admin.sessionId}` } });
  const found = ((await users.json())?.data?.items || [])
    .some(user => user.account === DISABLED_ACCOUNT.account);
  expect(found, `演示库里没有 ${DISABLED_ACCOUNT.account} 这个账号——`
    + '不存在的账号当然登不上，这条用例就成了空转').toBeTruthy();

  expect(envelope.ok, `已停用的账号仍然登录成功了——停用没有真正生效`).toBeFalsy();
});
