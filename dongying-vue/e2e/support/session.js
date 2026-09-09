/* =============================================================================
 * session.js —— 登录经 API 注入，不点登录表单（决策 15-10）。
 *
 * 这一层要验的是**页面进不进得去**，不是登录页好不好用。把表单也塞进来，
 * 登录页一改整张矩阵全红，真正的回归会被淹掉。
 *
 * 口令来自环境变量 E2E_PASSWORD，缺省 changeme —— **只适用于开了 dev-seed 的
 * 本地/CI 环境**。别拿这套去连任何真实环境。
 * ========================================================================== */

/** 与 src/services/apiClient.js:3 同一个键；路由守卫 restoreSession() 读它。 */
export const SESSION_KEY = 'dongying.api.session.v1';

export const PASSWORD = process.env.E2E_PASSWORD || 'changeme';

/** 演示账号。reviewer1 由 LocalStage15DemoReviewerSeeder 造（决策 15-3）。 */
export const ACCOUNTS = [
  { account: 'admin1', why: '内置超级管理员，全部菜单可达' },
  { account: 'reviewer1', why: '第二人角色 ROLE-DEMO-REVIEWER（决策 15-3），用来验"被拒"的那一半' }
];

/**
 * 登录并读回 /auth/me。
 * 账号不存在时返回 null 而不是抛——调用方要把它变成**带理由的显式 skip**，
 * 报告里照实写 skip 数；静默当作通过是这套测试最容易骗自己的地方。
 */
export async function apiLogin(request, account) {
  const response = await request.post('/api/v1/auth/login', {
    data: { account, password: PASSWORD }
  });
  const envelope = await response.json();
  if (!envelope.ok) {
    if (envelope.error?.code === 'INVALID_CREDENTIALS') return null;
    throw new Error(`登录 ${account} 失败：${envelope.error?.code} ${envelope.error?.message}`);
  }
  const sessionId = envelope.data.session_id;
  const meResponse = await request.get('/api/v1/auth/me', {
    headers: { Authorization: `Bearer ${sessionId}` }
  });
  const me = await meResponse.json();
  if (!me.ok) throw new Error(`读取 ${account} 的 /auth/me 失败：${me.error?.code}`);
  return { sessionId, menuKeys: me.data.menu_keys || [], roleCode: me.data.role_code };
}

/** 把会话写进 sessionStorage：addInitScript 在每次导航的页面脚本之前跑。 */
export async function seedSession(context, sessionId) {
  await context.addInitScript(([key, token]) => {
    try { window.sessionStorage.setItem(key, token); } catch { /* 无痕/禁存储时用例自然会红在登录页 */ }
  }, [SESSION_KEY, sessionId]);
}

/* =============================================================================
 * 失败响应的**显式清单**。
 *
 * 浏览器对每个 4xx/5xx 都会自动打一条 "Failed to load resource"，那是网络层的
 * 事实，不是应用打的日志——所以它不进 appErrors，而是单独归到 failedResponses，
 * 在这里按 **账号 × 端点** 逐条对账。
 *
 * 为什么不干脆整类放行：一旦放行，以后任何一个"页面发了它这个角色发不出的请求"
 * 都再也看不见了，而那正是本阶段（把动作权限接进角色矩阵）最会出问题的地方。
 * 逐条列出的代价是每加一个已知项要写一次理由，收益是**新冒出来的越权请求会立刻红**。
 * ========================================================================== */
export const EXPECTED_FAILED_RESPONSES = {
  admin1: [],
  reviewer1: [
    {
      status: 403,
      match: /^\/api\/v1\/workbench\/items$/,
      why: '外壳在每个路由上都拉工作台事项（4 次），而该角色没有 dashboard.read。'
         + '页面自身处理得体（显示"当前账号没有工作台读取权限"），所以不算页面坏了；'
         + '但"每加载一页必然四次越权请求"已报领导。'
    },
    {
      status: 403,
      match: /^\/api\/v1\/evidence-chains\//,
      why: '告警页选中告警后取证据链，而该角色只有 alarms.read、没有 evidence.read。'
         + '同上：已报领导，等动作权限接线后应由页面按权限决定发不发这个请求。'
    }
  ]
};

/**
 * 收三路信号，分开记：
 *   · appErrors —— 应用自己打的 console.error 与**未捕获异常**（pageerror 不走
 *     console 通道，只听 console 会漏掉真正让页面挂掉的那一类）；
 *   · failedResponses —— 4xx/5xx 响应，带方法与路径（"Failed to load resource"
 *     这句话不带 URL，光有它没法判断是不是缺陷）。
 */
export function collectPageSignals(page) {
  const appErrors = [];
  const failedResponses = [];
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    /* 浏览器为失败请求自动打的那句，归到 failedResponses 去逐条对账。 */
    if (text.startsWith('Failed to load resource')) return;
    appErrors.push(`console.error: ${text}`);
  });
  page.on('pageerror', error => appErrors.push(`pageerror: ${String(error?.message || error)}`));
  page.on('response', response => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    failedResponses.push({
      status: response.status(),
      method: response.request().method(),
      path: url.pathname,
      label: `${response.status()} ${response.request().method()} ${url.pathname}${url.search}`
    });
  });
  return { appErrors, failedResponses };
}

/** 清单外的失败响应（去重后）——每一条都是"这个角色不该发出的请求"的候选。 */
export function unexpectedFailures(failedResponses, account) {
  const expected = EXPECTED_FAILED_RESPONSES[account] || [];
  const unexpected = failedResponses.filter(item =>
    !expected.some(rule => rule.status === item.status && rule.match.test(item.path)));
  return [...new Set(unexpected.map(item => item.label))];
}
