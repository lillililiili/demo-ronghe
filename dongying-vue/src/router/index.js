/*
 * @Author: 黄建凯 1922184621@qq.com
 * @Date: 2026-09-03 15:44:13
 * @LastEditors: 黄建凯 1922184621@qq.com
 * @LastEditTime: 2026-09-04 11:48:20
 * @FilePath: \demo-ronghe\dongying-vue\src\router\index.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { createRouter, createWebHashHistory } from 'vue-router';
import { REDIRECT, ROUTES, PAGE_THEME, pageTitle, routeKey } from '@/config/navModel.js';
import PageHost from '@/layout/PageHost.vue';
import { authRestoreError, authSession, isAuthenticated, needsPasswordChange, restoreSession } from '@/services/auth.js';

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
router.beforeEach(async to => {
  await restoreSession();
  const key = routeKey(to);
  // 后端暂时不可达时保留 Bearer 会话，由外壳展示隔离的重试页；只有明确 401 才清会话。
  if (authSession.value && authRestoreError.value) return true;
  if (key === 'login') return isAuthenticated()
    ? (needsPasswordChange() ? '/change-password' : loginDestination(to.query.redirect))
    : true;
  if (!isAuthenticated()) return { path: '/login', query: { redirect: loginDestination(to.fullPath) }, replace: true };
  if (needsPasswordChange() && key !== 'change-password') return { path: '/change-password', replace: true };
  if (!needsPasswordChange() && key === 'change-password') return { path: '/workbench', replace: true };
  return true;
});

/* body[data-page]/[data-theme] 与标题统一在 afterEach 写（首个路由也会触发）。 */
router.afterEach(to => {
  const k = routeKey(to);
  document.body.classList.toggle('bs-body', k === 'bigscreen');
  document.body.dataset.page = k;
  document.body.dataset.theme = PAGE_THEME[k] || 'sensing';
  document.title = '无人机融合感知平台';
});
