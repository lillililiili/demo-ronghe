# 协作者 B 阶段 15：小接线 + CI/E2E 补齐

日期 2026-09-08。基线 `main@e06f76e`。对应《自主可推进工作计划-2026-09-08》第 P1-6/8/10、P4 全部、P1-7 骨架。

## 代码事实（只读探索结论）
- 角色矩阵只处理 MODULE 码：`IdentityAdminMapper.listPermissionCatalog/listPermissionsForRole` 过滤 `permission_kind='MODULE'`；`SystemManagementService.validateRolePermissions:735` 要求提交整矩阵且大小等于目录。ACTION 码（46 个）只有 `LocalStage2AccessSeeder` 给 ROLE-ADMIN 直插。`AccessControlMapper.findGrantedScopeMode` 按 ACTION 行判权，无超管旁路。前端 `RolesPage.vue` 只渲染有 `route_key` 的行。
- 第二账号：`SuperAdminIntegrityInitializer` 只允许一个 ROLE-ADMIN；`requireAssignableRole` 禁止 API 给内置角色；JDBC 种子可绕过（`LocalStage2AccessSeeder` 先例）；`LocalUserSeeder` 用 BCrypt 与 `app.dev-seed.password`。
- KPI：飞行监管页"鸟类事件/涉及航线"两卡写死"尚未接入"，可由 `GET /risks?risk_type=SPACE_OBJECT&object_subtype=BIRD_FLOCK` 的 total 与 `GET /space-risks/summary` 的涉及航线数直接接；告警页六卡已接，只剩处置服务不可用时的回退文案。
- 排序/筛选/导出：告警与风险列表 ORDER BY 写死；无 sort 参数；告警页类别与区域筛选禁用；飞行监管页目标类型筛选禁用、三处导出禁用；CSV 先例 `EvidenceController:58-68`（BOM + Content-Disposition）。
- 目标读接口无风险等级、违规事由、处置状态；来源分别是 `flight_risk(target_id)`、`rule_evaluation(target_id, mode=ACTIVE, 最新)`、`disposal_authorization(target_id/subject)`。态势页 `renderTargetTip` 只显示合法性。
- AOA：方位只在 `source_observation.quality.bearing_deg`；`ObservationDto` 不透出 `quality` 与 `identity_confidence`；`map.js._drawBearing` 已实现（需 `azimuth/fromDeviceLon/fromDeviceLat`），`situationData.toTargets` 未填。
- 别名提示：`accessBlocker` 用原始键取页名，`#/risk` 提示"需要空间安全风险的查看权限"，实际要授"飞行活动管理"。
- 证据主体：`evidence_link` CHECK 六种主体、三条 CHECK + FK 列（A 的表）；链根只接受 EVENT/TARGET。
- CI：`.github/workflows/ci.yml` 无 PostgreSQL 服务；PG 用例靠 `@EnabledIfEnvironmentVariable(POSTGRES_TEST_URL…)` 逐类门禁。E2E 用例数 0。
- 约定：今日迁移下一号 `V202609080104`；种子下一 `@Order(120)`；权限 sort 980+。

## 范围
1. **角色矩阵动作权限**（E1 + E2）：`GET /permissions/actions`（ACTION 目录，按 module 分组）；`PUT /roles/{code}/permissions` 的请求体增可选 `actions[] {permission_code, level ∈ NONE|READ|OP}`，缺省不动既有动作行；`GET /roles/{code}` 返回 `actions[]`；受保护模块的动作（`users/roles/audit` 域内的动作若有）沿用 `SYSTEM_PERMISSION_PROTECTED`；`disposal:*`、`punishment:*` 允许授给自定义角色（这就是两人规则的前提）。前端矩阵页加"动作权限"分区。
2. **本地第二账号种子**（E1）：`LocalStage15DemoReviewerSeeder @Order(120)`，双门禁；角色 `ROLE-DEMO-REVIEWER`（非内置）：MODULE `alarms/punishment/sensing/flights` READ + 菜单，ACTION `alarm:read, handoff:read, target:read, disposal:read/approve/execute/stop, punishment:read/review`；用户 `reviewer1`，同 `app.dev-seed.password`，`scope_mode=ALL`，`must_change_password=false`；重跑不重复；生产零数据。
3. **目标读接口三摘要**（E1 + E2）：`TargetSummaryDto/DetailDto` 增可空 `risk_summary{severity,state,risk_id}`、`legality_summary{legal_status,grade,violation_reasons[]}`、`disposal_summary{authorization_no,action_type,status}`（各取最新一条；无则省略键）；态势页悬浮卡显示三项。
4. **AOA**（E1 + E2）：`ObservationDto` 增 `bearing_deg`（来自 `quality`）、`identity_confidence`、`device_id`；`TargetStateDto` 增 `bearing_deg`、`bearing_device_id`（最新无位置观测的方位）；前端 `toTargets` 填 `azimuth/fromDeviceLon/fromDeviceLat`（设备位置取态势页已加载的设备列表），来源面板显示分路置信度。
5. **列表排序、筛选、导出**（E1 + E2）：告警与风险列表加 `sort`（白名单列）+ `order`；告警列表加 `alarm_type`、`district_id` 筛选（区域字典用既有 `/districts` 或范围内目录）；风险列表加 `target_type`；`GET /alarms/export.csv`、`GET /risks/export.csv`（同筛选，上限 5000 行，UTF-8 BOM，审计 `*_exported`）。前端启用对应列头排序、筛选项与导出按钮。
6. **KPI 与别名提示**（E2）：飞行监管页两卡接现有接口；告警页处置 KPI 回退文案保留；`accessBlocker` 有别名时写"需要『飞行活动管理』（承载 空间安全风险）的查看权限"。
7. **CI**（领导）：backend 作业加 `services: postgres`（`postgis/postgis:16-3.5`），注入 `POSTGRES_TEST_URL/USER/PASSWORD`，PG 套件在 CI 上跑；surefire 输出跳过数并在 job summary 打印。
8. **E2E 骨架**（助手）：Playwright，`dongying-vue/e2e/`，登录经 API 注入会话（不在表单输口令），用例：全部路由 × 两个角色（admin1、reviewer1）可达/拒绝矩阵、无控制台错误、三视口无横向溢出；本地跑通并接入 CI 的可选作业（不阻断）。
9. **双路径迁移记录**（领导，验收）：空库安装一次 + 阶段 14 库升级一次，记进验收文档。

## 不做
证据主体扩到 CASE/AUTHORIZATION（A 的表，契约 §6 提请）；融合自动合并/分裂（下一阶段）；工作台设备动作（A 的设备侧）；统计切片（A）。

## 任务与会话
| 任务 | 会话 | 简报 | 独占文件 |
| --- | --- | --- | --- |
| 15.0 计划/契约/CI | 领导 | — | `.github/workflows/ci.yml`、契约、决策、`Stage15ContractTest` |
| 15.1 后端 | Session 1 | `task-15.1-brief.md` | `modules/identity/{api/RoleAdminController, api/SystemDtos, application/SystemManagementService, infrastructure/IdentityAdminMapper}` 的动作权限部分、新 `LocalStage15DemoReviewerSeeder`、`modules/target/**` 读侧、`modules/fusion/api/FusionDtos+FusionReadService`（只加字段）、`modules/alarm/{api,infrastructure}` 与 `modules/risk/{api,infrastructure}` 的排序/筛选/导出、迁移（如需，`V202609080104`）、对应测试 |
| 15.2 前端 | Session 2 | `task-15.2-brief.md` | `RolesPage.vue`（动作权限分区）、`accessControl.js`（别名提示）、`FlightsPage.vue`/`AlarmsPage.vue`（KPI、排序、筛选、导出）、`SituationPage.vue` + `services/situationData.js`（三摘要、方位、分路置信度）、`services/*Api.js` 只加方法、`labels.js` 只加字典 |
| 15.3 PG + 隔离 + E2E 骨架 | Session 3 | `task-15.3-brief.md` | `Stage15PostgresTest`、`ProductionStage15SeedIsolationTest`、`dongying-vue/e2e/**`、`dongying-vue/playwright.config.*` |
| 审查 | Session 4 | `reviewer-brief-stage15.md` | `review-log.md` |
| 15.9 验收 | 领导 | — | 验收、提交 |

顺序：15.0 → 15.1（先落动作权限接口与种子，写 `- 15.1 actions landed`）‖ 15.2（桩）‖ 15.3（E2E 骨架可先起）→ `- 15.1 api landed` → 15.2 联调 → 15.3 补 PG → 15.9。PG 隔离库 `stage456_verify_s15`；验收库沿用 `uav_stage10_verify`（升级）+ 新建 `uav_stage15_fresh`（空库安装）。
