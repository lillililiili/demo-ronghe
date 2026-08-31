/* 已转换为真 Vue 组件的页面注册表。
   转换节奏：每转一页，在这里登记；未登记的 key 一律走 LegacyHost。
   验收标准：转换页与 legacy 版并排 DOM 指纹一致（元素数 + 全文哈希）后才准登记。
   ⚠ monitor 不转：其 devAlarms 在模块加载期消耗共享 LCG（M.util.ri），时间戳
   与排序由加载位置决定，SFC 重算必然数值漂移 —— 转换收益抵不过 1:1 破坏，
   长期方案是数据层把 devAlarms 挪进 mock.js 后再转。 */
import { defineAsyncComponent } from 'vue';
import StatsPage from './StatsPage.vue';
import UsersPage from './UsersPage.vue';
import ArchivePage from './ArchivePage.vue';
import EvidencePage from './EvidencePage.vue';
import AlarmsPage from './AlarmsPage.vue';
import CommissionPage from './CommissionPage.vue';
import DevicesPage from './DevicesPage.vue';
import FlightsPage from './FlightsPage.vue';
import SituationPage from './SituationPage.vue';
import PunishPage from './PunishPage.vue';
import LegalityPage from './LegalityPage.vue';

export const VUE_PAGES = {
  stats: StatsPage,
  users: UsersPage,
  archive: ArchivePage,
  evidence: EvidencePage,
  alarms: AlarmsPage,
  commission: CommissionPage,
  devices: DevicesPage,
  /* flights/risk/airspace 三个路由 key 共用一个组件：
     组件内 syncTabByRoute 按当前 hash 预置页签（#/risk → 全部风险事件），
     复刻 legacy 别名代理（PAGES.risk/airspace → flights）语义。 */
  flights: FlightsPage,
  risk: FlightsPage,
  airspace: FlightsPage,
  situation: SituationPage,
  punish: PunishPage,
  legality: LegalityPage
};

/* dev-only：Naive UI 主题校准对照台（P0 验收用）。异步组件，不进生产构建。 */
if (import.meta.env.DEV) {
  VUE_PAGES['__ui-lab'] = defineAsyncComponent(() => import('../ui/UiLab.vue'));
}
