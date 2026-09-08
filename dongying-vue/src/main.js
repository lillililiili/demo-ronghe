/* main.js —— Vue 外壳入口。index.html 只保留绘图用的经典脚本
   （echarts/ui/charts/geo/map/video，经典脚本先于 module 执行），
   这里只负责挂 Vue 应用。
   阶段 12：legacy 页面与 search.js 已删除，随之去掉为它们建的 APP/ROUTES 全局 shim，
   以及零消费者的 UI.confirmAction / UI.openRiskVerification 挂载——弹窗一律由页面直接 ESM 导入。
   CSS 必须先于 theme.js 求值，保证 getComputedStyle 能读到 token。 */
import '@/assets/css/index.css';
import '@/services/offlineMap.js';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from '@/layout/App.vue';
import { router } from '@/router/index.js';

const pinia = createPinia();

createApp(App).use(pinia).use(router).mount('#app');
