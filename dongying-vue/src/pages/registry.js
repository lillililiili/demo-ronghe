/* 已转换为真 Vue 组件的页面注册表。
   转换节奏：每转一页，在这里登记；未登记的 key 一律走 LegacyHost。
   验收标准：转换页与 legacy 版并排 DOM 指纹一致（元素数 + 全文哈希）后才准登记。
   monitor 已迁移为后端状态驱动页面，不再读取或消耗 legacy 随机序列。 */
import { defineAsyncComponent } from 'vue';
import StatsPage from './StatsPage.vue';
import UsersPage from './UsersPage.vue';
import RolesPage from './RolesPage.vue';
import ArchivePage from './ArchivePage.vue';
import EvidencePage from './EvidencePage.vue';
import AlarmsPage from './AlarmsPage.vue';
import CommissionPage from './CommissionPage.vue';
import DevicesPage from './DevicesPage.vue';
import MonitorPage from './MonitorPage.vue';
import FlightsPage from './FlightsPage.vue';
import SituationPage from './SituationPage.vue';
import PunishPage from './PunishPage.vue';
import LegalityPage from './LegalityPage.vue';
import WorkbenchPage from './WorkbenchPage.vue';

export const VUE_PAGES = {
  workbench: WorkbenchPage,
  stats: StatsPage,
  users: UsersPage,
  roles: RolesPage,
  archive: ArchivePage,
  evidence: EvidencePage,
  alarms: AlarmsPage,
  commission: CommissionPage,
  devices: DevicesPage,
  monitor: MonitorPage,
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
  VUE_PAGES['__ui-lab'] = defineAsyncComponent(() => import('@/components/UiLab.vue'));
}
