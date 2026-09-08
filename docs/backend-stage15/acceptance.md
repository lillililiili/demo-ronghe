# 阶段 15（小接线 + CI/E2E）验收记录

日期：2026-09-08。基线：`main@e06f76e`。计划 `docs/superpowers/plans/2026-09-08-collaborator-b-stage-15-small-wiring.md`，契约 `small-wiring-api-contract.md` v1.0，决策 15-1…。

## 执行者报告
| 任务 | 会话 | 结果 | 报告 |
| --- | --- | --- | --- |
| 15.1 后端 | Session 1 | actions landed 32 例（动作权限接口 + reviewer1 种子）；api landed 待填 | `task-15.1-report.md` |
| 15.2 前端 | Session 2 | 待填 | `task-15.2-report.md` |
| 15.3 PG + 隔离 + E2E 骨架 | Session 3 | 待填 | `task-15.3-report.md` |

## 领导验收
- 15.0：CI 改动（PostGIS 服务、TargetRead 专属库、汇总、可选 e2e）经审查第 1 轮修订（15-13），YAML 校验通过；真实运行结果待推送后从 Actions 记录。
- 第二账号实跑（06:3x，jar 含 actions landed，库 `uav_stage10_verify`）：`reviewer1` 已种（`ROLE-DEMO-REVIEWER`，ALL），API 登录成功，能读授权；`GET /permissions/actions` 16 模块 42 动作，与 `PermissionCode` 枚举 42 个逐一相等（E1 diff 为空；领导先前记的 46 是探索代理数错）。
- **阶段 14 两人链路首次真实走通（用 reviewer1，API）**：`CASE-20260908-9001`（UNDER_REVIEW）→ admin1 自复核 409 `REVIEW_SELF_NOT_ALLOWED` → reviewer1 的 `allowed_actions=[REVIEW]` → UPHELD 200 → DECIDED → admin1 `allowed_actions=[ISSUE_DOCUMENT]` → 出具决定书 201 `CASE-20260908-9001-DEC-01` → 下载全文首行"演示模板 · 未经授权出具 · 金额档位未确认"、17 行、sha256 与 DTO 一致 → 结案 200 CLOSED；事件流 FILE → REVIEW_REQUESTED → DISCRETION_CONFIRMED → REVIEW_CONCLUDED → DOCUMENT_ISSUED → CLOSE。阶段 13/14 验收里"需第二账号"的缺口由此关闭一半。
- 阶段 13 两人链路：首跑 reviewer1 审批 403——查明是种子少授 `disposal:approve/execute/stop、target:read`（转 E1 修，非产品缺陷）；admin1 自审批 400 是领导请求体字段名写错（应为 `note`）。种子修好、jar 重启（06:5x，`ROLE-DEMO-REVIEWER` 现持 9 个动作码）后重跑 `AUTH-20260908-0003`（COUNTERMEASURE / LINGYUN_B）：admin1 自审批 409 `TWO_PERSON_RULE` → reviewer1 批准 200 APPROVED（`approved_by_name=演示复核员`）→ admin1 `allowed_actions=[EXECUTE,STOP,CANCEL]` → 执行 409 `DEVICE_CONTROL_UNAVAILABLE`，DTO `execution_block_reason=PROTOCOL_NOT_OPENED`、`device_stop_result=NOT_ATTEMPTED` → reviewer1 停止 200 STOPPED，`device_stop_result=NOT_BOUND`（设备未登记凌云，13-11）；事件流 REQUEST → APPROVE → PROTOCOL_NOT_OPENED → STOP → DEVICE_NOT_BOUND。阶段 13 验收里『审批→执行→四值→停止需第二账号』的缺口由此关闭。
- 双路径迁移记录（P1-8）之"空库安装"（06:47，jar 含 actions landed）：新建空库 `uav_stage15_fresh`（仅 PostGIS 扩展）→ 临时起 jar 于 8082 → Flyway "Successfully applied 68 migrations"，健康 200，种子落库：`app_user` 2（admin1、reviewer1）、`punishment_case` 1、`disposal_authorization` 3、`target` 27 → 进程关闭。对照升级路径库 `uav_stage10_verify`：`flyway_schema_history` 成功行 70（多出的是可重复脚本因校验和变化重跑的记录），业务表结构一致。"老库升级"一侧沿用各阶段的 `uav_stage10_verify` 重启记录（阶段 13/14 与本阶段均有）。
- 待填：H2 全量 / PG 套件 / 前端三项 / 浏览器 / CI 首跑。

## 未接入 / 已知限制
- 证据主体扩到 CASE/AUTHORIZATION 待 A（15-11）。
- 融合自动合并/分裂、工作台设备动作、统计切片不在本阶段。
