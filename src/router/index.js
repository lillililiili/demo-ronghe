import { createRouter, createWebHashHistory } from 'vue-router';
import { REDIRECT, PAGE_THEME, pageTitle, routeKey } from '../shell/navModel.js';
import PageHost from '../shell/PageHost.vue';

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

/* body[data-page]/[data-theme] 与标题统一在 afterEach 写（首个路由也会触发）。 */
router.afterEach(to => {
  const k = routeKey(to);
  document.body.dataset.page = k;
  document.body.dataset.theme = PAGE_THEME[k] || 'sensing';
  document.title = pageTitle(k) + ' · 无人机融合感知平台';
});
