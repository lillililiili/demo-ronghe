/* 已转换为真 Vue 组件的页面注册表。
   转换节奏：每转一页，在这里登记；未登记的 key 一律走 LegacyHost。
   验收标准：转换页与 legacy 版并排 DOM 指纹一致（元素数 + 全文哈希）后才准登记。
   monitor 已迁移为后端状态驱动页面，不再读取或消耗 legacy 随机序列。 */
import { defineAsyncComponent } from 'vue';
import StatsPage from './StatsPage.vue';
import EvidencePage from './EvidencePage.vue';
import AlarmsPage from './AlarmsPage.vue';
import SituationPage from './SituationPage.vue';
import PunishPage from './PunishPage.vue';
import LegalityPage from './LegalityPage.vue';

/* FlightsPage 依赖尚未入库的 positionMap.js；同步 import 会让登录与其它页一起挂。
   异步加载后，缺文件只影响飞行/空域/风险页。 */
const FlightsPage = defineAsyncComponent(() => import('./FlightsPage.vue'));
const AirspacePage = defineAsyncComponent(() => import('./airspace/AirspacePage.vue'));

export const VUE_PAGES = {
  stats: StatsPage,
  evidence: EvidencePage,
  alarms: AlarmsPage,
  flights: FlightsPage,
  /* #/risk 由 router 重定向到 #/flights?tab=events，不再作为独立「空间安全风险」页渲染。
     airspace 自 2026-09-13 起是独立页（设计稿 v2），访问权限仍由飞行计划菜单承载（accessControl 的别名）。 */
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
