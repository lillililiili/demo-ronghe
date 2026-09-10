/**
 * 跑用例之前先确认后端真的在。
 *
 * 起因是一次实跑：后端在半途重启，118 条里几十条一起红，报的是"发出了不该发出的请求"——
 * 而真正的原因是**后端不在了**。那种报错读起来像一堆权限缺陷，得挨个点开才发现是连接被拒。
 * 与其让人从几十条红里反推，不如在第一条用例之前就说清楚。
 */
export default async function globalSetup(config) {
  const baseURL = config.projects[0]?.use?.baseURL || 'http://localhost:5174';
  const target = process.env.APP_API_PROXY_TARGET || '（playwright.config.js 里的缺省值）';
  let status;
  try {
    // 未登录时后端应答 401——**401 就是"活着"**，只有连不上才算不在。
    status = (await fetch(`${baseURL}/api/v1/auth/me`)).status;
  } catch (error) {
    throw new Error(`后端不可达：经 ${baseURL} 代理到 ${target} 连不上（${error.message}）。\n`
      + '先确认后端已启动、且 APP_API_PROXY_TARGET 指向的是它；否则整套用例会红成一片"越权请求"，'
      + '而真正的原因只是连接被拒。');
  }
  if (status >= 500) {
    // Vite 代理把上游"连接被拒"也包装成 500，所以这一条同时覆盖两种情况：
    // 后端没起，或者起了但自身 5xx。两者都不是权限问题，别去查角色。
    throw new Error(`经 ${baseURL} 代理到 ${target} 拿到 ${status}。\n`
      + '两种可能：后端根本没起（Vite 会把连接被拒包装成 500），或者后端起了但自身 5xx。\n'
      + '都不是权限问题——先确认那个端口上真的有后端在，再看它的日志。');
  }
}
