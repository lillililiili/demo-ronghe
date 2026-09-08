# 协作者 B 阶段 14：处罚案件（材料包 + 案件 / 裁量 / 决定书 / 复核）

日期 2026-09-08。基线 `main@81b61ba`（阶段 13 六条提交已推送）。路线图第 3 项（决策记忆 `project-roadmap-after-stage-11`）。

## 背景与代码事实（只读探索结论）

- 阶段 13 把处罚交接前提改为"事件存在 COMPLETED 授权"，但材料包未定义：`HandoffSubmissionService:85-92` 对 `UAV_PUNISHMENT` 恒 409 `HANDOFF_MATERIALS_NOT_DEFINED`。`MaterialDto` 整套是风险形状（`RiskMaterialDto`），`schema_version=1`。
- 落地会撞的三处硬约束：`HandoffSubmissionService:113` 写死 `riskId=sourceId, eventId=null`（撞 `ck_stage5_handoff_source_ref`）；`:76` 无条件 `require(RISK_READ)`；`HandoffReadService:127` 非 RISK 来源一律 `SOURCE_NOT_VISIBLE`。
- `handoff_material_snapshot` 每交接一份（PK=handoff_id），`schema_version >= 1` 允许 v2。`handoff_recipient.handoff_type` CHECK 已含 `UAV_PUNISHMENT`，但库里只有两条 RISK_NOTICE 接收方。
- `uav_event` 只有状态与归属；类型/等级/时间/目标都在 `alarm`；核实历史在 `uav_event_verification`（conclusion + note 1–1000 字），没有证据字段。证据域（A）：`evidence_file`（`kind_code` 已含 `PENALTY_DOCUMENT`）、`evidence_link(subject_kind ∈ EVENT|DEVICE|TARGET|PLAN|COMMAND|COMMISSION)`，没有 CASE/HANDOFF 主体。
- 处置域：`disposal_authorization` + 只增事件流，`DisposalReadService` 可给 COMPLETED 授权的编号/动作/通道/审批人姓名/结果。
- 处罚页 `PunishPage.vue:44-50` 五个"本期未建设"块：案件管理 / 罚款与裁量 / 决定书生成下载 / 证据链 / 定性复核与待补线索；`:512-520` 渲染；`:307` 旧 caseId 深链降级提示。告警页"通知处罚部门"按钮禁用（阶段 4 未接入）。
- 原产品预期（legacy mock）：案件号 `CF2026MMDD+序号`、文书号 `<案件号>-01`、罚则表十项定额（未经业务确认；条例设定的是区间）、处罚方式 警告/罚款/驱离、案件状态三态。
- 约定：今日迁移段 `V202609080101–0199`；PG 专属触发器/CHECK 用 `db/postgresql/V…` 版本化迁移（13-32 修订）；种子 `@Order(110)`；权限 `sort_order` 975 起；`GlobalExceptionHandler.module()`、`AuditLabels` 三处要补；ACTION 码无角色矩阵入口（13-33），只有超管可用。

## 范围（本阶段做）

1. **处罚交接材料包 v2**（拆掉 409）：`schema_version=2` 事件形状——事件与告警事实、核实历史、已完成的处置授权（含事件流摘要）、证据引用（读 A 的 `evidence_link`/`evidence_file`，只读）、关联引用（目标/轨迹）。提交路径按来源种类选读权限（RISK→`risk:read`，UAV_EVENT→`alarm:read`），事件须 `CONFIRMED`，`expected_version` 对 `uav_event.version`，落库 `event_id=source_id`。读侧按同样的权限与范围裁剪。
2. **案件域 `modules/punishment`**：案件（`CASE-YYYYMMDD-NNNN`，一事件一案，从处罚交接立案）、承办人、调查线索、裁量（罚则档位表 DEMO、区间校验）、《行政处罚决定书》（结构化 + 渲染文本 + sha256 + 下载，DEMO 模板水印）、复核（结论 + 待补线索）、结案/撤案；只增事件流；到期无（案件不设时限）。
3. **前端**：处罚页五块接真实数据（不改页面结构）；告警页"通知处罚部门"按钮启用为"提交处罚交接"（选接收方）；字典与文案。
4. **PG 专项 + 隔离 + 并发**：编号并发、一事件一案并发、只增触发器、金额区间 CHECK、种子隔离。

## 不做 / 未接入（页面必须标注）

外部处罚系统与通知渠道（Q4）、真实回执、罚则金额档位确认（Q 罚则，全部 DEMO）、决定书的法律效力与出具主体（DEMO 水印）、证据主体扩到 CASE/HANDOFF（A 的表，本阶段只读引用，见契约 §6 提请 A）、当事人身份证件/联系方式等敏感字段（只存当事人名称与类型）、案件时限与催办、罚款收缴。

## 数据模型

| 迁移 | 归属 | 内容 |
| --- | --- | --- |
| `V202609080101__stage14_punishment_permissions.sql` | 领导 | ACTION 目录 `punishment:read/file/decide/review/close`（sort 975–979） |
| `V202609080102__punishment_cases.sql` | E1 | `penalty_rule`（DEMO 罚则档位）、`punishment_case`、`punishment_case_event`、`penalty_discretion`、`penalty_decision_document`、`punishment_review`、`punishment_no_counter`；`handoff_recipient` 不动（接收方由种子给） |
| `db/postgresql/V202609080103__stage14_punishment_pg.sql` | E1 | 只增触发器（case_event / review / decision_document 的 UPDATE 仅允许 status 列变化）、金额区间 CHECK 之外的 PG 专属约束 |

关键约束：`punishment_case.event_id UNIQUE`；`handoff_id` FK 且该交接必须是 `UAV_PUNISHMENT`；状态 `FILED|INVESTIGATING|UNDER_REVIEW|DECIDED|CLOSED|WITHDRAWN`；裁量 `fine_amount` 在规则 `[fine_min, fine_max]` 内（应用层 400 + 库层 CHECK 非负）；决定书只能基于 `CONFIRMED` 裁量；复核人 ≠ 承办人；结案要求 DECIDED（或 WITHDRAWN 路径）。

## API（契约 `docs/backend-stage14/punishment-api-contract.md`）

`POST /handoffs`（扩展 UAV_EVENT 分支）；`GET /penalty-rules`；`POST /punishment-cases`、`GET /punishment-cases`、`GET /{id}`、`GET /{id}/events`、`POST /{id}/assign`、`POST /{id}/leads`、`POST /{id}/discretions`、`POST /{id}/discretions/{did}/confirm`、`POST /{id}/decision-documents`、`GET /{id}/decision-documents`、`GET /decision-documents/{docId}/content`（text/plain 下载）、`POST /{id}/reviews`、`POST /{id}/close`、`POST /{id}/withdraw`。错误码见契约 §2.1。

## 任务与会话

| 任务 | 会话 | 简报 | 独占文件 |
| --- | --- | --- | --- |
| 14.0 契约/权限/码表 | 领导 | — | `PermissionCode`、迁移 0101、`GlobalExceptionHandler`、`AuditLabels`、`Stage14ContractTest`、契约、决策 |
| 14.1 材料包 v2 + 案件域 | Session 1 | `task-14.1-brief.md` | `modules/handoff/**`（提交/读侧的 UAV_EVENT 分支与 DTO）、`modules/punishment/**`、迁移 0102、PG 0103、`LocalStage14PunishmentSeeder @Order(110)`、对应 H2 测试 |
| 14.2 处罚页五块 + 告警页入口 | Session 2 | `task-14.2-brief.md` | `PunishPage.vue`、`AlarmsPage.vue`（只动"通知处罚部门"按钮与其弹窗）、`services/handoffApi.js`（只加方法）、新 `services/punishmentApi.js`、新 `ui/punishmentModals.js`、`ui/labels.js` 只加字典 |
| 14.3 PG 专项 + 隔离 | Session 3 | `task-14.3-brief.md` | `Stage14PostgresTest`、`ProductionStage14SeedIsolationTest` |
| 审查 | Session 4 | `reviewer-brief-stage14.md` | 只写 `review-log.md` |
| 14.9 验收 | 领导 | — | 验收文档、提交、决策清单 |

顺序：14.0 → 14.1（先落 0102 并写 `- 14.1 DDL 0102 landed`）‖ 14.2（先按契约桩做 UI）‖ 14.3（骨架）→ 14.1 `- 14.1 api landed` → 14.3 补齐 → 14.2 联调 → 14.9。PG 隔离库 `stage456_verify_s14`；验收库沿用 `uav_stage10_verify`（升级路径）。

## 验收口径

- H2 全量 + PG 套件（阶段 14 + 4/5/7/8/8.5/9/13 回归 + Stage2/TargetRead/Flight/Airspace/MqttP1）+ 前端 build/scan/check-ui-text + `git diff --check`。
- 升级路径：新 jar 起在 `uav_stage10_verify`。
- 浏览器：告警页对已核实且有 COMPLETED 授权的事件提交处罚交接（201）→ 处罚页出现该交接与材料快照 v2（事件/核实/授权/证据四段）→ 立案（案件号）→ 裁量（DEMO 档位、区间校验 400）→ 决定书生成、预览、下载（DEMO 水印）→ 复核（不足 → 回调查并列出待补线索；维持 → DECIDED）→ 结案；三视口无横向溢出；旧 caseId 深链仍降级。
- 单人可达路径：承办人与复核人须不同 → 复核步骤浏览器上验不了（13-33 同因），以 PG/H2 用例为证据。
