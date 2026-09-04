import { createRouter, createWebHashHistory } from 'vue-router';
import { REDIRECT, ROUTES, PAGE_THEME, pageTitle, routeKey } from '@/config/navModel.js';
import PageHost from '@/layout/PageHost.vue';
import { isAuthenticated, restoreSession } from '@/services/auth.js';

/* hash 模式与旧版地址完全兼容：#/situation、#/legality、旧书签、UI.goto 写
   location.hash 都直接命中。REDIRECT 表用 router redirect 实现（等价旧版
   location.replace，不污染历史）。 */
const routes = Object.keys(REDIRECT).map(k => ({
  path: '/' + k, redirect: '/' + REDIRECT[k]
}));
routes.push({ path: '/:page*', component: PageHost });
/* dev-only 的 #/__ui-lab 对照台不在这里挂路由 —— 本应用没有 <router-view>
   出口（PageHost 由 App.vue 直接渲染），页面注册一律走 pages/registry.js。 */

export const router = createRouter({
  history: createWebHashHistory(),
  routes
});

export { routeKey };

/* 只接受系统内已知单段页面，不接受外站、嵌套路径和登录自循环。 */
export function loginDestination(value) {
  if (typeof value !== 'string' || !/^\/[a-z][a-z0-9-]*(?:\?[^#]*)?$/.test(value)) return '/workbench';
  const key = value.slice(1).split('?')[0];
  return key !== 'login' && ROUTES[key] ? value : '/workbench';
}
let sessionRestored = false;
router.beforeEach(async to => {
  // 首次导航只恢复一次后端会话，后续跳转直接使用已同步的响应式认证状态。
  if (!sessionRestored) {
    try {
      await restoreSession();
    } catch {
      /* 会话已清理，继续按未登录路由处理 */
    }
    sessionRestored = true;
  }
  const key = routeKey(to);
  if (key === 'login') return isAuthenticated() ? loginDestination(to.query.redirect) : true;
  // redirect 先经 loginDestination 收敛，避免登录后跳往外站或未知路由。
  if (!isAuthenticated()) return { path: '/login', query: { redirect: loginDestination(to.fullPath) }, replace: true };
  return true;
});

/* body[data-page]/[data-theme] 与标题统一在 afterEach 写（首个路由也会触发）。 */
router.afterEach(to => {
  const k = routeKey(to);
  document.body.classList.toggle('bs-body', k === 'bigscreen');
  document.body.dataset.page = k;
  document.body.dataset.theme = PAGE_THEME[k] || 'sensing';
  document.title = pageTitle(k) + ' · 无人机融合感知平台';
});
