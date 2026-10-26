import { defineAsyncComponent } from 'vue';
import PageLoadState from '@/components/PageLoadState.vue';

// 外壳只加载公共代码；业务页第一次进入时加载，之后复用模块缓存。
// 切页后旧组件加载完成不会挂载已经离开的页面。
const page = loader => defineAsyncComponent({
  loader, delay: 150, loadingComponent: PageLoadState, errorComponent: PageLoadState
});
const StatsPage = page(() => import('./StatsPage.vue'));
const EvidencePage = page(() => import('./EvidencePage.vue'));
const AlarmsPage = page(() => import('./AlarmsPage.vue'));
const SituationPage = page(() => import('./SituationPage.vue'));
const PunishPage = page(() => import('./PunishPage.vue'));
const LegalityPage = page(() => import('./LegalityPage.vue'));
const FlightsPage = page(() => import('./FlightsPage.vue'));
const AirspacePage = page(() => import('./airspace/AirspacePage.vue'));

export const VUE_PAGES = {
  stats: StatsPage,
  evidence: EvidencePage,
  alarms: AlarmsPage,
  flights: FlightsPage,
  /* #/risk 由 router 重定向到 #/flights?tab=events，不再作为独立「空间安全风险」页渲染。
     airspace 自 2026-09-13 起是独立页（设计稿 v2），访问权限仍由飞行任务菜单承载（accessControl 的别名）。 */
  risk: FlightsPage,
  airspace: AirspacePage,
  situation: SituationPage,
  punish: PunishPage,
  legality: LegalityPage
};

/* dev-only：Naive UI 主题校准对照台（P0 验收用）。异步组件，不进生产构建。 */
if (import.meta.env.DEV) {
  VUE_PAGES['__ui-lab'] = defineAsyncComponent(() => import('@/components/UiLab.vue'));
}
