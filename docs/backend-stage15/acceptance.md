# 阶段 15（小接线 + CI/E2E）验收记录

日期：2026-09-08。基线：`main@e06f76e`。计划 `docs/superpowers/plans/2026-09-08-collaborator-b-stage-15-small-wiring.md`，契约 `small-wiring-api-contract.md` v1.0，决策 15-1…。

## 执行者报告
| 任务 | 会话 | 结果 | 报告 |
| --- | --- | --- | --- |
| 15.1 后端 | Session 1 | actions landed 32 例（动作权限接口 + reviewer1 种子）；api landed 待填 | `task-15.1-report.md` |
| 15.2 前端 | Session 2 | 待填 | `task-15.2-report.md` |
| 15.3 PG + 隔离 + E2E 骨架 | Session 3 | `Stage15PostgresTest` 7/7（PG 16.9：动作目录⇔枚举逐一比对含总数、并发 PUT 动作行一成一 409、权限改动旧会话立刻失效、导出上限两侧、相同时刻分页稳定（故意打乱物理次序）、JSONB 方位读出且有位置不给、15-21 两半都钉且变异验证）+ `ProductionStage15SeedIsolationTest` 3/3（含 local 下必须注册的反面对照）+ E2E 39/39（17 路由 × 2 账号 + 大屏 × 2 + 3 条反空转自检，期望值取服务端 menu_keys，变异验证 14 红 5 绿）；发现两个 PG-only P0（15-18/15-20）与 occurred_at 可空（15-21）、区域筛选挂管理域权限（15-22） | `task-15.3-report.md` |

## 领导验收
- 15.0：CI 改动（PostGIS 服务、TargetRead 专属库、汇总、可选 e2e）经审查第 1 轮修订（15-13），YAML 校验通过；真实运行结果待推送后从 Actions 记录。
- 第二账号实跑（06:3x，jar 含 actions landed，库 `uav_stage10_verify`）：`reviewer1` 已种（`ROLE-DEMO-REVIEWER`，ALL），API 登录成功，能读授权；`GET /permissions/actions` 16 模块 42 动作，与 `PermissionCode` 枚举 42 个逐一相等（E1 diff 为空；领导先前记的 46 是探索代理数错）。
- **阶段 14 两人链路首次真实走通（用 reviewer1，API）**：`CASE-20260908-9001`（UNDER_REVIEW）→ admin1 自复核 409 `REVIEW_SELF_NOT_ALLOWED` → reviewer1 的 `allowed_actions=[REVIEW]` → UPHELD 200 → DECIDED → admin1 `allowed_actions=[ISSUE_DOCUMENT]` → 出具决定书 201 `CASE-20260908-9001-DEC-01` → 下载全文首行"演示模板 · 未经授权出具 · 金额档位未确认"、17 行、sha256 与 DTO 一致 → 结案 200 CLOSED；事件流 FILE → REVIEW_REQUESTED → DISCRETION_CONFIRMED → REVIEW_CONCLUDED → DOCUMENT_ISSUED → CLOSE。阶段 13/14 验收里"需第二账号"的缺口由此关闭一半。
- 阶段 13 两人链路：首跑 reviewer1 审批 403——查明是种子少授 `disposal:approve/execute/stop、target:read`（转 E1 修，非产品缺陷）；admin1 自审批 400 是领导请求体字段名写错（应为 `note`）。种子修好、jar 重启（06:5x，`ROLE-DEMO-REVIEWER` 现持 9 个动作码）后重跑 `AUTH-20260908-0003`（COUNTERMEASURE / LINGYUN_B）：admin1 自审批 409 `TWO_PERSON_RULE` → reviewer1 批准 200 APPROVED（`approved_by_name=演示复核员`）→ admin1 `allowed_actions=[EXECUTE,STOP,CANCEL]` → 执行 409 `DEVICE_CONTROL_UNAVAILABLE`，DTO `execution_block_reason=PROTOCOL_NOT_OPENED`、`device_stop_result=NOT_ATTEMPTED` → reviewer1 停止 200 STOPPED，`device_stop_result=NOT_BOUND`（设备未登记凌云，13-11）；事件流 REQUEST → APPROVE → PROTOCOL_NOT_OPENED → STOP → DEVICE_NOT_BOUND。阶段 13 验收里『审批→执行→四值→停止需第二账号』的缺口由此关闭。
- 双路径迁移记录（P1-8）之"空库安装"（06:47，jar 含 actions landed）：新建空库 `uav_stage15_fresh`（仅 PostGIS 扩展）→ 临时起 jar 于 8082 → Flyway "Successfully applied 68 migrations"，健康 200，种子落库：`app_user` 2（admin1、reviewer1）、`punishment_case` 1、`disposal_authorization` 3、`target` 27 → 进程关闭。对照升级路径库 `uav_stage10_verify`：`flyway_schema_history` 成功行 70（多出的是可重复脚本因校验和变化重跑的记录），业务表结构一致。"老库升级"一侧沿用各阶段的 `uav_stage10_verify` 重启记录（阶段 13/14 与本阶段均有）。
- 两个 H2 盖不住的 P0（助手在真实 PG 复现，领导复核）：①`TargetReadRepository` 方位粗筛对 JSONB 列裸 `LIKE`（PG 无 `jsonb ~~ text`），`/targets` 列表与详情 500——E1 改 `CAST(col AS VARCHAR) LIKE` 并抽成 `QualityFacts.mentionsBearing`（15-17/15-18）；重启后 PG 实测：列表 27 条、详情 200、AOA 目标 `目标-20250905-009` 带 `bearing_deg=82.5`/`bearing_device_id=seed-stage85-device-aoa`，13 条目标带风险/合法性/处置摘要。②导出方法 `@Transactional(readOnly=true)` 内写审计（PG 25006），两条 export.csv 500——裁定 15-20 去 readOnly，E1 去掉两处 readOnly 后重打 jar（07:12）重启，PG 实测：`GET /alarms/export.csv?sort=received_at&order=desc` 与 `GET /risks/export.csv` 均 200，`text/csv;charset=UTF-8`，`Content-Disposition: attachment; filename*=UTF-8''alarms-20260908.csv`，首三字节 BOM `EF BB BF`，中文列头，告警 14 行、风险 10 行；`/targets` 200；`sort=evil` 400；`audit_log` 两行 `alarms_exported`/`risks_exported`（SUCCESS，detail 带筛选条件与行数：告警 14、风险 10）。两条规则写进 `server/AGENTS.md`（15-18/15-20）。
- PG 回归（07:2x–07:4x，PostgreSQL 16.9 / PostGIS 3.5，隔离库 `stage456_verify_s15`；`TargetReadPostgresApiTest` 用 `stage2_target_verify_s13`）：14 套件 99/99——Stage2Compat 3、TargetRead 2、FlightRead 1、AirspaceRead 3、Stage4 5、Stage5 5、Stage7 8、Stage8 7、Stage85 15、Stage9 24、MqttP1 1、Stage13 10、Stage14 9、Stage15 6（日志中 `relation "device_command" does not exist` 仍是 Stage85 上下文里后台调度器在 schema 拆除期的噪音）。
- H2 全量首轮（E1 定稿后，07:3x）：152 类 / 869 run / 2 fail / 0 err / 99 skip；两处红均为阶段 15 有意的演示复核员角色撞上『只有管理员持动作码』的既有断言，按 15-23 收窄到按名字放行后复跑（结果见下）。
- 15-23 收窄后复跑：`LocalStage2AccessSeederTest` 5/5、`DeviceBusinessScopeTest` 6/6、`LocalStage15DemoReviewerSeederTest` 6/6、`ProductionStage15SeedIsolationTest` 3/3。
- round7 重启（07:3x）：`GET /alarms/districts` admin1 200（范围内出现过的区域列表）、reviewer1 200；`GET /risks/districts` admin1 200、reviewer1 403（无 `risk:read`，与列表权限一致）；旧 `GET /districts` 对 reviewer1 403（15-22 的动因）。`risk_summary` 按 15-21 取最新一条（两条目标分别 HIGH/MEDIUM）。
- round8 重启（07:4x，jar 含 0104 与 CSV 公式前缀）：`V202609080104` 在升级库套用成功，42 个 ACTION 行 `name/module_name` 全中文（如 `disposal:approve` = 处置授权 / 审批处置），`/permissions/actions` 返回中文；AUTH 级动作行在本次启动后再次为 42 条（`SuperAdminIntegrityInitializer` 每次启动把超管既有行全置 AUTH，0104 的归一被重启抹回）——助手 `Stage15PostgresTest` 第 8 例在修复前红在正确位置，E1 round9 收（15-25 修订）。
- 待填：round9（初始化器只碰 MODULE 行）重启核对 AUTH=0 / H2 全量终版 / 前端三项 / 浏览器 / E2E / CI 首跑。

## 未接入 / 已知限制
- 证据主体扩到 CASE/AUTHORIZATION 待 A（15-11）。
- 融合自动合并/分裂、工作台设备动作、统计切片不在本阶段。
