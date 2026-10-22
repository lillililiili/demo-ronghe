# 空域管理风险模块移除

## 用户范围

2026-10-20 用户明确要求：飞行计划风险相关功能全部保留并正常运行，只删除空域风险模块。

移除空域管理“空域监测”风险工作区及专属列表、详情、风险/近期目标地图图层、范围摘要、筛选与轮询。保留空域资料、维护、三维编辑、版本历史以及空域与航线地图参照。

共享后端 C04/C05、飞行任务风险列表/当前风险/详情/核验/通知/回执、融合感知航线风险、历史和冻结材料均保留。

## 代码变更说明

下列路径除特别注明外相对 `dongying-vue/`。工作区另有空域增删改、三维编辑、反制和坐标校验改动，本轮保留，未将它们计入本轮实现。

| 改动文件/类 | 改动方法/函数 | 方法作用 | 本次修改的代码作用 |
| --- | --- | --- | --- |
| `src/pages/airspace/AirspacePage.vue` | `refreshPage`、实时刷新回调、`allPoints`、`installOverlay`、`createMap`、`destroyMap`、`select`、挂载和卸载回调；页面模板和样式无具体方法 | 加载空域、地图绘制、选区和详情展示 | 删除空域监测、风险筛选/列表/图层/详情/范围摘要，以及 risk/target 订阅和请求；保留空域和航线资料 |
| `src/pages/airspace/AirspaceObjectMarkers.vue`、`AirspaceRiskList.vue`、`AirspaceRiskDrawer.vue`、`AirspaceRiskEventDetail.vue`、`AirspaceRiskPanel.vue` | 组件及其内部方法整体删除 | 原空域风险标记、列表、详情和处理入口 | 移除只属于空域风险模块的界面 |
| `src/pages/airspace/useAirspaceRisks.js`、`useAirspaceRiskList.js`、`useAirspaceMonitor.js` | 三个同名组合函数整体删除 | 原空域风险、目标读取与范围聚合 | 停止空域页后台读取和筛选风险/监测目标 |
| `src/pages/airspace/airspaceRiskModel.js` → `airspaceGeometry.js` | 移除风险模型，保留 `pointRelation`、`ringRelation` | 地图参照物的平面几何命中 | 保留普通空域/航线提示需要的几何，不保留空域风险聚合 |
| `src/pages/airspace/airspaceReferenceHover.js` | `hitMapReference` 的导入；删除无调用的 `REFERENCE_NOTES` 常量 | 命中地图参照物 | 改用通用几何模块，保持地图提示 |
| `src/pages/LegalityPage.vue` | `selectEvaluationById` | 加载研判及显示不适用原因 | 非无人机提示改为前往飞行任务的全部风险事件 |
| `tools/airspaceModuleScope.test.mjs` | `pageFixture`、三个测试 | 执行页面初始化、刷新及地图命中回归 | 覆盖 live/replay、不同位置和编号，验证没有风险/目标请求且保留空域资料 |
| `tools/airspaceRiskDetailSync.test.mjs` | 旧空域风险详情测试整体删除 | 验证旧专属详情同步 | 随已删除功能移除 |
| `tools/riskNoticeDialogText.test.cjs`、`riskNotificationAccess.test.cjs`、`weatherRiskMarkers.test.mjs` | 通知文案、权限夹具与天气图层测试 | 验证共享通知与天气显示 | 仅删除空域专属断言，保留飞行风险、共享通知和天气覆盖 |

范围说明同步至 `_rong/AGENTS.md`、`dongying-vue/AGENTS.md`、`dongying-vue/README.md`。本轮无后端源码修改，无飞行任务、融合感知页面及共享 `riskApi` 修改。

## 已完成验证

- 前端生产构建成功（4316 modules）；源码扫描通过；`git diff --check` 通过。
- 前端核心风险/空域回归 37 项通过，融合感知 API 契约 118 项通过，现用空域体积测试 5 项通过。
- 后端保留功能回归 68 项通过，0 失败、0 错误、0 跳过：`SpaceRiskEvaluationJobTest`、`SpaceRiskScheduledEvaluationTest`、`RuleEvaluationApiTest`、`SpaceRiskReadApiTest`、`RiskReadApiTest`、`RiskVerificationApiTest`、`HandoffReceiptResultApiTest`。在隔离 H2 测试上下文运行，不等于 PostgreSQL/PostGIS 全量计算验收。
- 强制启动检查 `scripts/check-local-startup.mjs --business-dir E:\rwurenji\_rong\dongying-vue` 于 `2026-10-21T02:39:19.504Z` 完成，退出码 0、7 项全部通过。该报告的账号登录字段为 NOT_TESTED；其后另行完成下述真实浏览器登录，未改写自动检查原报告。

## 真实浏览器操作与回读

2026-10-21 北京时间约 10:40–10:45，在本机 Edge 专用验收标签使用用户已填写的账号成功登录。未发送通知、提交核验、修改风险或创建业务数据。

1. 空域管理：点击刷新、选择空域、展开版本历史；空域资料、地图和版本正常。无“空域监测”和“范围内风险”入口。网络只读空域、航线及其版本，未请求 `/risks` 或 `/targets`。
2. 飞行任务 → 全部风险事件：列表显示 276 条已有风险；实际切换异物（248 条）与气象（28 条）。数字为验收时已有数据，不作为固定业务口径。
3. 鸟群风险：风险位置、关联航线、风险依据、核验历史及通知回执正常，保留模拟来源及过期/未知的如实说明。
4. 气象风险：预报范围和天气图层、有效时段、风险依据、核验历史及通知回执正常；点击“查看关联飞行任务”定位到对应天气风险任务。
5. 风险列表、`/space-risks/summary`、风险详情、核验历史、气象事实、航线版本、通知与回执接口均返回 200；此次验收标签未捕获 console error。
6. 空域页在实际 CSS 视口 1518×853 和 1280×720 均无文档横向溢出。截图已检查；已恢复窗口并关闭专用标签，不影响用户原标签。

本机证据：

- `E:\houtaiguanlii\artifacts\local-runtime\airspace-risk-removal\browser-evidence.json`
- `E:\houtaiguanlii\artifacts\local-runtime\airspace-risk-removal\airspace.jpg`
- `E:\houtaiguanlii\artifacts\local-runtime\airspace-risk-removal\airspace-1280.jpg`
- `E:\houtaiguanlii\artifacts\local-runtime\airspace-risk-removal\flight-risks.jpg`
- `E:\houtaiguanlii\artifacts\local-runtime\airspace-risk-startup-check.json`
- `E:\houtaiguanlii\artifacts\local-runtime\airspace-risk-preserved-tests.log`

## 登录故障与运行恢复

用户尝试登录时，原 8081 服务无监听；旧 JVM 的 devtools 重启日志报告三条既有 Flyway 迁移无法解析。当前源码与迁移资源均存在。未修改迁移脚本、历史表或密码，未执行 repair。

已按进程身份停止本项目原服务，以当前源码构建的独立 JAR 启动，关闭 devtools 重启并保持 `local,qa`、`app.dev-seed.enabled=false`。正常验证 203 条迁移，并应用工作区此前已有的 `202610200001 disposal countermeasure mode` 和 `202610200002 local airspace lifecycle`。两条迁移属于其他已存在改动，本轮未编写或改写。服务恢复后登录及上述接口读取成功。

运行 JAR 位于 `E:\houtaiguanlii\server\target\airspace-risk-recovery\low-altitude-server-0.1.0-SNAPSHOT.jar`；仅生产 classpath，不使用测试种子。临时构建配置、JAR、日志及进程恢复脚本均在忽略目录，不提交。

## 验证边界

- 扩展检查发现既有 `tools/situationFlow.test.cjs` 加载器仅重写别名导入，对现有相对导入 `../../services/situationData.js` 报 `ERR_UNSUPPORTED_RESOLVE_REQUEST`。该测试及对应被加载模块无本轮改动，未扩大本轮删除范围修复此测试工具问题。
- 实际浏览器核对的是已有风险、核验与通知历史及读取链路；没有为验收重新发通知或变更风险状态。核验、通知和回执写入分支由上述隔离后端测试覆盖。
- 未清理业务数据、重写历史或启用运行环境演示种子；未部署服务器、未提交 Git。
