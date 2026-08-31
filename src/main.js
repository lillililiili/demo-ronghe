/* main.js —— Vue 外壳入口。legacy 层（mock/ui/charts/…/pages/search）已由
   index.html 的经典 script 标签按原顺序加载完毕（经典脚本先于 module 执行），
   这里只负责：① 建 APP/ROUTES 全局 shim（legacy 页面与 search.js 消费）
   ② 挂 Vue 应用。 */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './shell/App.vue';
import { router } from './router/index.js';
import { ROUTES, pageTitle } from './shell/navModel.js';
import { useAppStore } from './stores/app.js';

const pinia = createPinia();
const store = useAppStore(pinia);

/* 全局 shim，语义同旧 app.js 的 g.APP / g.ROUTES：
   rerender = 整页重挂（PageHost 监听 remountKey）；setCrumb = 面包屑业务上下文。
   必须在 app.mount 之前就绪 —— search.js 的 DOMContentLoaded 回调会引用它。 */
window.ROUTES = ROUTES;
window.APP = {
  rerender() { store.remountKey++; },
  setCrumb(txt) { store.crumbCtx = txt; },
  pageTitle,
  routes: ROUTES
};

createApp(App).use(pinia).use(router).mount('#app');
