# 协作者 B 只读：MOCK 盘点与登录审查

> 对话 3。只读审查，不改业务代码。  
> 盘点日期：2026-09-03。  
> 仓库：`/Users/frank/Desktop/dongyiwurenji`  
> 当前检出：`feature/stage1-security-baseline` @ `884a7e8`（本对话未切分支、未提交）。  
> 本地 `main`：`fbce28c`（`chore: ignore local worktrees`，尚未推 origin；其父提交 `d0a0b4e` 已含 A 的安全基线 PR #2）。

**共同禁区（已遵守）**

- 未改 `server/src/main/java`、`db/migration`、`MockAdapter`、`AuthService`
- 未在 `feature/stage1-security-baseline` 上提交
- 未新增 npm 生产依赖
- 本文件只新增文档

---

## 0. 给调度（对话 0）的结论

1. **`feature/b-auth-client` 已建分支和 worktree，但还是空的。** 指向 `fbce28c`，与本地 `main` 零 diff；worktree `/Users/frank/.codex/worktrees/41a9/dongyiwurenji` 工作区干净。`apiClient.js` 未创建，Vite **没有** `/api` 代理，`auth.js` 仍是 Mock。`feature/b-page-chrome` 同样空（`.worktrees/feature-b-page-chrome`）。origin 尚无这两条分支。
2. **登录仍会 Mock 成功。** 不是「接口失败后回退 Mock」，而是 **根本不打后端**。`admin` / `Demo@2026` 在后端关机时也能进工作台。`duty1` / `changeme` **不能**走 Vue 登录（Mock 用户表里没有 `duty1`）。
3. 八个 B 名下页面（工作台 / 态势 / 飞行计划 / 合法性 / 告警 / 处罚 / 统计 / 大屏）**全部以 `window.MOCK` 为数据真源**。尚无 `PageLoading` / `PageEmpty` / `PageError` / `PagePager`。
4. 列表空态大多是页内 `.empty`（「请选择 / 当前筛选无数据」），**没有接口错态**。若干按钮 **toast 成功但无 MOCK 写入、无网络**。
5. 对话 2 铺壳：优先 **统计页**（只读 + 假导出）。不要动 `auth.js` / `LoginPage` / `router`。告警/工作台/合法性/处罚的动作走共享 `EVT` / `RISK_IMPL`，壳可以挂，**不要改状态机**。
6. 用户/角色页也读 `MOCK.users`，今晚只允许「管理接口未就绪」，不准假 CRUD。

**今晚验收第 1–4 条（真实登录贯通）目前全部未满足。** 对话 1 必须先做完 `2026-09-03-stage-b1-auth-client.md`。

---

## 1. 登录是否仍会 Mock 成功

**结论：会。后端挂了、401、从未启动，都不影响 `admin` / `Demo@2026` 登录成功。**

`feature/b-auth-client` 已存在，但 `git diff main...feature/b-auth-client` 为空，worktree 无未提交改动。因此 **没有可审的登录 diff**；下列路径与本地 `main` 前端一致。

### 1.1 现行流程（零 HTTP）

| 步骤 | 行为 | 位置 |
| --- | --- | --- |
| 启动 | 同步 `restoreSession()` | `src/router/index.js:29` |
| 恢复会话 | 读 `sessionStorage['dongying.demo.session.v1']`，用 Mock 用户 id（如 `U001`）在 `M.users` 里找 `status === '正常'`，命中则 `M.switchUser` | `src/services/auth.js:31-39` |
| 守卫 | 非 `/login` 要求 `isAuthenticated()`（`sessionId` 与 `M.currentUser.id` 一致且账号正常），否则去登录页 | `src/router/index.js:30-34` |
| 提交 | 450ms 后同步调用 `login()`，**无 `fetch`** | `src/pages/login/LoginPage.vue:54-57` |
| 校验 | `M.users` 按账号查找；密码必须等于硬编码 `DEMO_PASSWORD = 'Demo@2026'` | `src/services/auth.js:5,41-46` |
| 成功 | `M.switchUser`、写 sessionStorage、可选记住账号（不记密码） | `src/services/auth.js:51-58` |
| 退出 | 本地清会话 + `M.clearCurrentUser()`，**不调** `POST /api/v1/auth/logout` | `src/services/auth.js:60-68`，`HeaderBar.vue:82-90` |
| 401 | Vue 侧 **没有** Bearer、没有 401 清 token | 无 `apiClient.js`；`vite.config.js` 无 `/api` proxy |

`App.vue:23-27` 的登录壳同样只看 Mock 的 `authSession` / `isAuthenticated()`。

### 1.2 演示账号 vs 后端 Seeder

Mock 用户（`public/assets/js/mock.js:3018-3031`）：

`admin` `zhangjg` `liguoq` `wangzh` `zhangwei` `liqiang` `wanglei` `zhaopeng` `suntao` `zhoumin`（停用）`wugang` `zhengkai`

登录页帮助仍写：`admin` / `Demo@2026`，以及 `zhangwei` / `zhaopeng` / `wugang`（`LoginPage.vue:37-38`）。

后端 local seeder 是 `duty1` / `changeme`（另有 admin1、judge1…）。**两套账号未对齐。** 用 `duty1` 走当前 Vue 登录会失败（Mock 表没有该账号）；用 `admin`/`Demo@2026` 则永远不经过后端。

### 1.3 审查项（对话 1 合入前必须挡住）

| 风险 | 现状 |
| --- | --- |
| 接口失败假装登录成功 | **现行实现比回退更糟：从未请求接口** |
| 越权 | 登录成功后权限矩阵仍是 `M.can` / `M.canMenu`（Mock 角色）。接入 API 后 `isAuthenticated` 必须以后端会话为准，菜单可暂读 MOCK |
| 静默 Mock | `auth.js` 文件头写明「不发送网络请求」。`login()` 没有 try/catch 回退，因为没有网络 |
| 会话伪造 | sessionStorage 存的是 Mock 用户 id，不是后端 `session_id` |

对话 1 应交的文件（本对话未改）：`apiClient.js`（新建）、`auth.js`、`LoginPage.vue`、`router/index.js`、`vite.config.js`、`scripts/bootstrap-dev.ps1`、`dongying-vue/docs/api-contract-current.md`。`HeaderBar.vue` 的 `logout()` 也必须改成先打后端再清本地。

---

## 2. 八页对 `window.MOCK` 的读写

约定：页面均 `const M = window.MOCK`。Vue 均已登记（大屏不在 `registry.js`，由 `App.vue` 异步挂载）。

| 页面 | 路由 key | SFC | 读 | 写 / 变异 | 空/错/加载 |
| --- | --- | --- | --- | --- | --- |
| 工作台 | `workbench` | `WorkbenchPage.vue` | 经 `workbenchEvents.js` 读设备/风险/告警上下文；页内 `M.currentUser` `M.can` `M.riskNext` `M.airspaces` | 经 `EVT` / `RISK_IMPL` / `DEVICE_ACTIONS` 推进状态；设备事件 Map 为模块内存 | 有筛选空态、未选中空态；无接口错态 |
| 态势 | `situation` | `SituationPage.vue` | `liveTargets` `todayAlarms` `alarms` `airspaces` `devices` `todayTargets` `allTargets` `DISTRICTS` `T_TYPES` `fusionWeights` `AIRSPACE_TYPES` `CONF` `riskAdvice` `riskLevelOf` | 本页不直接改 MOCK 数组；鸟情/驱离按钮假 toast | 筛选无告警 `.empty`；无接口错态 |
| 飞行计划 | `flights` / `risk` / `airspace` | `FlightsPage.vue` | `flightPlans` `riskEvents` `airspaces` `todayTargets` `allTargets` `routes` `routesOf` `PARTNERS` `DISTRICTS` `airspaceType` `riskNext` | `window.RISK_IMPL.act` 推进 `M.riskEvents` 状态（与工作台共用） | 「请选择计划」空态；导出 toast 无文件 |
| 合法性 | `legality` | `LegalityPage.vue` | `allTargets` `todayTargets` `airspaces` `devices` `alarms` `cases` `flightPlans` `VIOLATIONS` `LEGAL_STATUS` `AIRSPACE_TYPES` `can` `routeById` | **写**：`auditLogs.push`、`reviewRequests.push`、`alarms.unshift` / `todayAlarms.unshift`、改 `t.legal` / `t.reviewLog` | 「没有研判目标 / 请选择目标」；无接口错态 |
| 告警 | `alarms` | `AlarmsPage.vue` | `alarms` `todayAlarms` `allTargets` `liveTargets` `airspaces` `DISTRICTS` `notifyChannels` | 本页不直接改数组；经 `window.EVT.verify` / `startLinkedCounter` / `confirmPunish` 改共享事件（告警状态、案件、审计） | 「请选择告警」；无接口错态 |
| 处罚 | `punish` | `PunishPage.vue` | `cases` `reviewRequests` `users` `devices` `airspaces` `stats` `pendingSubjects` `allTargets` `can` | **写**：启动时按 sessionStorage 改 `c.stage` / `reviewRequests.status`；`auditLogs.unshift`；`authLogs.unshift`；复核办结；`EVT.confirmPunish` | 「请选择案件 / 暂无需复核」；导出 toast 无文件 |
| 统计 | `stats` | `StatsPage.vue` | `M.stats`（及 `days/byRisk/byType/regions/...`）`deviceStats` `cases` `CONF` `util` | **不写 MOCK** | 无空态组件（数据常驻 Mock）；导出/月报 **假成功 toast** |
| 大屏 | `bigscreen` | `bigscreen/BigScreenApp.vue` | `liveTargets` `todayTargets` `todayAlarms` `cases` `devices` `deviceStats` `flightPlans` `airspaces` `stats.days` `evidenceFiles` `caseNoticeStatus` `systemNowStr` | **不写 MOCK**（只读查询壳 + 地图 `setData`） | 无统一空/错组件 |

### 2.1 工作台 `WorkbenchPage.vue`

- 入口：`src/services/workbenchEvents.js`（`const M = window.MOCK`，`EVT = window.EVT`）。
- **读**
  - `M.devices`：设备异常队列、详情、重启/恢复（`workbenchEvents.js:37,153,189,220,237`）
  - `M.riskEvents` / `M.routeById` / `M.plansOf` / `M.noticesOf` / `M.auditLogs`（详情与时间线）
  - `EVT.of`：无人机告警五环节
  - 页内：`M.currentUser`、`M.can('处置处罚管理'|'反制/干扰授权')`、`M.riskNext`、`M.airspaces`（`WorkbenchPage.vue:43-46,141,146`）
- **写**
  - `advanceUav` / `verifyUav` → `EVT.advance` / `EVT.verify` / `EVT.startLinkedCounter` / `EVT.confirmPunish`
  - `actRisk` → `window.RISK_IMPL.act`（改 `M.riskEvents`）
  - `openDeviceReboot`：`DEVICE_ACTIONS` **会改** 同一个 `M.devices[]` 对象（`lastReboot`、`controlLogs`、稍后 `status/alarm/hb`）并 `M.recalcDeviceStats()`；工作台自己的 `deviceIncidents` Map **不在 MOCK 里**
  - `verifyDeviceRecovery`：只改 incident Map + `M.pushAudit`（`workbenchEvents.js:235-251`），事件阶段不落 MOCK
- **空态**：`WorkbenchPage.vue:326,434,439,443-445,454,459`（筛选无事件 / 无证据 / 无通报 / 无控制记录 / 无审计 / 未选中）。
- **无** PageError；UAV/风险成功 toast 一般伴随 MOCK 写入。设备重启 toast 声称 `POST /api/v1/device/control`，实际是 `monitor.js` 里约 2.6s 定时器。

### 2.2 态势 `SituationPage.vue`

- **读**：`M.liveTargets` `M.todayAlarms` `M.alarms` `M.airspaces` `M.devices` `M.todayTargets` `M.allTargets` `M.DISTRICTS` `M.T_TYPES` `M.fusionWeights` `M.AIRSPACE_TYPES` `M.CONF.demoTime` `M.util` `M.riskAdvice` `M.riskLevelOf`（约 `SituationPage.vue:41-320`）。
- **写**：不改 MOCK 集合。地图 `setData` 只消费只读切片。
- **假成功（无 MOCK 写入、无网络）**
  - `SituationPage.vue:239` 「已通知东营胜利机场塔台与属地派出所（回执 2/2）」
  - `SituationPage.vue:240` 「已派发驱离作业任务至属地保障单位」
- 筛选无告警：`SituationPage.vue:176` `.empty`。

### 2.3 飞行计划 `FlightsPage.vue`

- **读**：`M.flightPlans` `M.riskEvents` `M.airspaces` `M.todayTargets` `M.allTargets` `M.routes` / `M.routesOf` `M.PARTNERS` `M.DISTRICTS` `M.airspaceType` `M.riskNext` `M.CONF` `M.util`（约 `66-375`）。
- **写**：`FlightsPage.vue:373-378` 点击「通知上级」→ `window.RISK_IMPL.act(ev, to, rerender)`，与工作台同一套风险状态机，会改 `M.riskEvents` 并生成通报。
- **假成功**：`FlightsPage.vue:481` 「已导出「飞行计划.xlsx」…」——无下载、无接口。
- 空态：`180` 请选择计划；`206` 计划尚未开始。

### 2.4 合法性 `LegalityPage.vue`

最重的 MOCK 写入页之一。

- **读**：`M.allTargets` `M.todayTargets` `M.airspaces` `M.devices` `M.alarms` `M.cases` `M.flightPlans` `M.reviewRequests` `M.VIOLATIONS` `M.LEGAL_STATUS` `M.AIRSPACE_TYPES` `M.C01_DIMS` `M.TRACK_MODEL` `M.ALARM_TYPE` `M.stats.byPenalty` `M.can` `M.routeById` `M.pushAudit`（拒绝路径）。
- **写**
  - `M.auditLogs.push`（`390-397`）
  - 改目标对象字段：`t.legal` / `t.legalOriginal` / `t.reviewLog`（`400+` `applyReview`）
  - `M.reviewRequests = ...; M.reviewRequests.push`（`442-451`）
  - `M.alarms.unshift` + `M.todayAlarms.unshift`（`571-572`，转告警）
  - `EVT.ensureCaseRecord`（`609`）可能派生案件
- 空态：`724` 没有研判目标；`916` 请选择目标。
- 成功 toast 多数伴随 MOCK 写入（人工确认/改判）。权限不足走 err toast + `M.pushAudit` 失败。
- **假成功**：`lgRecalc`（约 `1126-1132`）toast「已按当前规则重新判定今日 N 个目标」，实际只 `refresh()`，**不会重跑判定引擎**。`1115`「无需重复降级」ok toast 是空操作。

### 2.5 告警 `AlarmsPage.vue`

- **读**：`M.alarms` `M.todayAlarms` `M.allTargets` `M.liveTargets` `M.airspaces` `M.DISTRICTS` `M.notifyChannels`（`54-355`）。排序注释明确 **不 sort `MOCK.alarms`**。
- **写（间接）**：`window.EVT.verify` / `startLinkedCounter` / `confirmPunish`（`290-348,415`）。会改告警对象字段（`verified`/`flowStatus`/`status`/`verifyLog`）、`M.cases.push`、`M.notifyPunish`（关告警、推进案件）、`M.authLogs`、`M.evidenceFiles`。本 SFC 不 `push` 告警数组。
- **写（弹窗）**：`AlarmNotifyModal.vue` 对当前告警 `notifyLog.push`，回执号是种子数据；文案写「Demo 未真实外发」。
- legacy `public/assets/js/pages/alarms.js` 加载期仍可能 `M.alarms.unshift` 一条待核实告警；Vue 页注释说明不再重跑。
- 空态：`179` 请选择告警。列表在 Mock 常驻数据下几乎不会空。
- 联动干扰完成是 `case.js` 约 3s 定时器，不是设备回执。失败路径有 toast err；**没有**「接口 500 → PageError」。

### 2.6 处罚 `PunishPage.vue`

- **读**：`M.cases` `M.reviewRequests` `M.users` `M.devices` `M.airspaces` `M.stats` `M.pendingSubjects` `M.allTargets` `M.can` `M.DISPOSAL_FLOW` `M.FINE`/`M.JAM_*` 等。
- **写**
  - 模块加载期从 sessionStorage 回放：改 `c.stage` / `c.docReady`、`M.rebuildCaseSteps`、`r.status = '已办结'`（`50-61`）——刷新后会改共享案件。
  - `M.auditLogs.unshift`（`89-93`）
  - `M.authLogs.unshift`（`912`，信号干扰授权）
  - `EVT.confirmPunish`（`946-953`）
- **假成功**
  - `604` 导出待办案源 xlsx
  - `643` 导出授权审计 csv（注释称「导出行为本身已记入审计」——需对话 2 勿把这类 toast 改成真成功除非真写审计）
  - `854` 文书下载 Demo，走 **err** toast（「不具法律效力」）
  - `984` 下载处罚决定书
  - `1006` 导出处罚案件明细 xlsx
- 空态：`410` 无待补充线索；`498` 请选择案件。

### 2.7 统计 `StatsPage.vue`

- **只读**：`M.stats` 全套 + `M.deviceStats` + `M.cases` 聚合排行（`14-40,59-97`）。
- **不写 MOCK。**
- **假成功（优先改成 PageError / 未就绪，不要维持 ok toast）**
  - `106` 已导出「近30天统计明细.xlsx」（还声称接口 `/api/v1/stats/export`，**后端无此接口**）
  - `107` 已生成月报 PDF（Demo）
- 无 `.empty`、无 loading、无 error。Mock 数据永真，接 API 后会直接把空分页画成「全 0」而不提示失败。

### 2.8 大屏 `bigscreen/BigScreenApp.vue`

- `App.vue:33,50` 独立挂载，不经 `registry.js`。
- **只读**：`M.liveTargets` `M.todayTargets` `M.todayAlarms` `M.cases` `M.devices` `M.deviceStats` `M.flightPlans` `M.airspaces` `M.stats.days` `M.evidenceFiles` `M.caseNoticeStatus` `M.systemNowStr`（`16-202,311-313`）。
- 地图 `setData` 消费 MOCK 切片。调度单要求：**不改地图引擎**。
- 无空/错组件。数值全是 Mock 实时推导。

---

## 3. 共享层（八页之外，但 B 会踩到）

| 文件 | MOCK 用法 | 对话 3 意见 |
| --- | --- | --- |
| `src/services/auth.js` | `M.users` `M.switchUser` `M.clearCurrentUser` `M.pushAudit` `M.nowStr` `M.currentUser` | 对话 1 独占。会话禁止再以 MOCK 为真源 |
| `src/services/accessControl.js` | `M.canMenu` | 菜单可暂留 MOCK；不要把它写成后端授权 |
| `src/services/workbenchEvents.js` | 设备/风险/告警适配 | 工作台动作真源；对话 2 不要改 |
| `src/layout/NavSidebar.vue` | `window.MOCK.canMenu` | 登录接通后仍可读 MOCK 藏菜单 |
| `src/layout/HeaderBar.vue` | `M.canMenu` `M.currentUser` + 本地 `logout` | logout 必须跟对话 1 一起改 |
| `src/ui/riskVerificationModal.js` | `M.plansOf` 等 | 工作台/风险核验 |
| `src/ui/counterAuthModal.js` | `M.devices` | 告警反制 |
| `src/components/modals/JamAuthModal.vue` | `M.cases` | 处罚干扰授权 |
| `src/components/modals/AlarmNotifyModal.vue` | `M` | 告警通知 |
| `public/assets/js/mock.js` | 数据与 `switchUser` `notifyPunish` `pushAudit` `can` | **禁止本晚改** |
| `window.EVT`（`public/assets/js/case.js`） | 告警五环节、`verify`/`advance`/`startLinkedCounter`/`confirmPunish`/`ensureCaseRecord`；写 `M.alarms` 对象、`M.cases.push`、`M.authLogs`、`M.evidenceFiles`、`M.notifyPunish` | 工作台/告警/处罚/合法性共用，禁止各页私自复制 |
| `window.RISK_IMPL`（`public/assets/js/pages/risk.js`） | `r.status`、`M.riskNotices.unshift`、`r.disposals`、`M.auditLogs`、`M.recalcRiskLevels` | 飞行计划「通知上级」与工作台风险共用 |
| `window.DEVICE_ACTIONS`（`public/assets/js/pages/monitor.js`） | 改 `M.devices[]` 并 `recalcDeviceStats`；假 POST | 工作台重启；不要当真实设备控制 |
| `src/hooks/usePageChrome.js` | 读 `window.MOCK.CONF.version` 写页脚 | 所有已迁页；对话 2 不要改 |

`CommissionPage.vue`（设备调测）也大量读写 `M.devices`，**不在今晚八页清单**，不要顺手改。

---

## 4. 「toast 成功但没有副作用」清单

这些是对话 2/3 波次 3 的优先改造点：应改为 PageError 或「接口未就绪」，禁止继续 ok toast。

| 页 | 行 | 文案 | 实际副作用 |
| --- | --- | --- | --- |
| 态势 | 239 | 已通知塔台与派出所（回执 2/2） | 无 |
| 态势 | 240 | 已派发驱离作业 | 无 |
| 飞行计划 | 481 | 已导出飞行计划.xlsx | 无文件 |
| 统计 | 106 | 已导出统计明细.xlsx（还写了不存在的 `/api/v1/stats/export`） | 无 |
| 统计 | 107 | 已生成月报 PDF | 无 |
| 处罚 | 604 | 已导出待办案源清单.xlsx | 无 |
| 处罚 | 1006 | 已导出处罚案件明细.xlsx | 无 |
| 处罚 | 984 | 已下载行政处罚决定书 | 无真实文书 |
| 合法性 | ~1131 | 已按当前规则重新判定今日 N 个目标 | 不重跑引擎，只 refresh |
| 告警通知弹窗 | `AlarmNotifyModal.vue` | 通知已发送 / 送达 | `notifyLog` 内存追加，回执是种子，无外发 |
| 工作台设备重启 | `monitor.js` DEVICE_ACTIONS | 声称 `POST /api/v1/device/control` | 2.6s 定时器改 `M.devices` 字段 |
| 告警联动干扰 | `case.js` | 干扰完成 / 待处置 | 3s 定时器，无设备回执 |

相对诚实、**不要拆掉**的成功 toast：工作台/告警经 `EVT.*` 返回 `ok` 后再 toast——那些会改共享状态。对话 2 只加壳，不要把这些改成假失败。

---

## 5. 空 / 错 / 加载 / 分页现状

仓库内 **不存在** `PageLoading` `PageEmpty` `PageError` `PagePager`（对话 2 的交付物）。

| 能力 | 现状 |
| --- | --- |
| 加载中 | 登录有 450ms `busy`；业务页无请求故无 loading |
| 空数据 | 多为 `.empty`：「请选择 X」或「当前筛选没有」——是 **Mock 筛选空**，不是 API 空分页 |
| 接口错 | **没有。** 后端 `GET /api/v1/alarms`、`/api/v1/devices` 已是空分页占位，但页面未调用 |
| 分页 | 工作台是 `visibleLimit += 30` 前端切片（`WorkbenchPage.vue:19,67,325`），**不是** `page/size/items/total`。统计/态势/大屏无分页。告警/计划/处罚/合法性是全量 Mock 列表 + 页内筛选 |

规范（调度单）：列表继续 `page/size/items/total`，页码从 1，默认 20，最大 100。今晚组件先做出来，**不要把八页列表改成打真实 API**。

---

## 6. 用户 / 角色页（一句）

`UsersPage.vue` / `RolesPage.vue` 读并会改 `M.users` / 角色权限（Mock CRUD）。A 未提供 RBAC 接口。今晚只允许加「管理接口未就绪」空态，**禁止**接不存在的 API，也禁止继续做假增删改当验收。

---

## 7. 对话 2 铺壳顺序（仍不接假后端）

文件不打架：不要改 `auth.js` `LoginPage.vue` `router/index.js` `vite.config.js`。

| 优先级 | 页 | 原因 |
| --- | --- | --- |
| 1 | 统计 | 只读；假导出最适合改成「导出接口未就绪」；调度单点名的演示壳 |
| 2 | 大屏只读数字区 | 只读；**不要动 MapView / 图层** |
| 3 | 态势列表/详情空态 | 只读为主；把 239-240 假通知改错态 |
| 4 | 飞行计划列表空态 | 可挂壳；不要改 `RISK_IMPL.act` |
| 5 | 工作台列表空态 | 已有 `.empty`；可换成公共组件；不要改 `workbenchEvents.js` |
| 6 | 告警 / 合法性 / 处罚 | 写入重、共享 EVT；只换展示壳，不动按钮业务 |

用户/角色：单独加「接口未就绪」，不要排进八页动作改造。

---

## 8. 今晚必须跑的验证命令（对话 3 建议）

本对话 **未改业务代码，未跑构建**。下列是调度/对话 1/2 收口时应实际执行的命令（从仓库根）：

```bash
# 对话 1 或 2 改了前端后
cd dongying-vue && npm run build

# 仅当改了 public/assets/js、mock.js、或 Vue 模板原生表单时
cd dongying-vue && node tools/scan.cjs
cd dongying-vue && node tools/falsify.cjs

# 任何交付
git diff --check
```

登录手测（对话 1 完成后，**本对话未测**）：

1. `cd server && ./mvnw spring-boot:run -Dspring-boot.run.profiles=local`
2. Vue `duty1` / `changeme` 能进工作台
3. 错密码走后端错误，**不会**出现 Mock 成功
4. 停后端后再登录必须失败
5. 刷新走 `GET /api/v1/auth/me`；退出后进业务路由回登录页

`node tools/scan.cjs`：本晚若只加 `src/components` 空错分页、且 Vue 模板不用原生 `<input>`，不是必跑；一旦动 legacy/Mock 就必跑。

---

## 9. 当期后端事实（B 不虚构）

已存在、B 可消费（A 已合 main）：

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`
- `GET /api/v1/alarms` 空分页占位
- `GET /api/v1/devices` 空分页占位

**不存在、B 不得假装已接：** 用户/角色 CRUD、告警写入、统计导出 `/api/v1/stats/export`、飞行计划、合法性、处罚、大屏生产数据。

---

## 10. 本对话未做

- 未建分支、未改 `dongying-vue/src`、未改 `server/`
- 未跑 `npm run build` / `scan.cjs` / 浏览器登录
- `feature/b-auth-client` 分支为空（与 `main` 无 diff），登录审查针对当前 `main` 前端；合入有实质 diff 后再审一遍越权/假成功/静默 Mock
