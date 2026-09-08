# 阶段 13：处置授权域（2026-09-07）

## 背景
用户路线图第二项。现状：反制/干扰/驱离在四个页面全部禁用，处罚交接因"缺反制完成事实"一律 409；前端曾有读 Mock 的假授权弹窗（阶段 12 已删）。协作者 A 的 P5（`bdd8d0e`）已把设备侧控制做好：`POST /devices/{id}/commands/lingyun-control` 需要 `authorizationId`，`lingyun_control_command.authorization_id NOT NULL`，`device_command.authorization_id` 列已加——A 在等 B 的授权域给编号。急停接口 A 目前返回 409 `CONTROL_NOT_ENABLED`（设备协议未提供）。客户的授权条件/审批依据/时限（Q5）未答复 → 策略参数全部 DEMO。

## 边界
- B 建"处置授权"业务域：申请 → 审批 → 执行（调 A 的控制接口）→ 回执同步 → 完成/失败/停止/过期，编号、审批人、时限、设备通道、审计、幂等、范围元组。
- A 的设备控制、协议 B 编解码、回执入库不动；B 只调用 `LingyunControlService.enqueue(...)` / 读 `device_command` 状态。
- 前端只启用现有禁用按钮、填充现有"未建设"区块、新增一个弹窗（替代已删的假弹窗），不改页面结构。
- 设备不支持急停时如实显示"设备协议未提供急停"，授权本身仍可撤销。

## 数据模型（迁移按实际日期编号，决策 10-14；今日 B 用 `V202609070101–0199` 段避开 A 的 0081–0084）
- `V202609070101__stage13_disposal_permissions.sql`（领导，五个权限目录行——超级管理员种子按枚举授权，目录行必须先于代码枚举存在）；`V202609070102__disposal_authorization.sql`（E1）：
  - `disposal_policy(policy_code PK, params JSON, schema_status DEMO|CONFIRMED, status ACTIVE|RETIRED, version, note)` 预置 `demo-v1`：`approval_required=true`、`two_person_rule=true`（申请人≠审批人）、`time_limit_min{COUNTERMEASURE:30,JAMMING:30,DISPERSAL:15,DECOY:30}`、`requires_confirmed_event{COUNTERMEASURE:true,JAMMING:true,DISPERSAL:false,DECOY:true}`、`max_active_per_subject=1`。
  - `disposal_authorization(authorization_id PK, authorization_no UNIQUE, action_type CHECK(COUNTERMEASURE|JAMMING|DISPERSAL|DECOY), subject_kind CHECK(UAV_EVENT|RISK|TARGET), subject_id, target_id, device_id, channel CHECK(LINGYUN_B|COUNTERMEASURE_4CH|MANUAL), reason, requested_by, requested_at, approved_by, approved_at, decision_note, valid_from, valid_until, status CHECK(REQUESTED|APPROVED|REJECTED|EXECUTING|COMPLETED|FAILED|STOPPED|EXPIRED|CANCELLED), execution_command_id, result_code, result_detail, policy_version, owner_org_id, district_id, source_mode, version, created_at, updated_at)`，索引 `(subject_kind, subject_id)`、`(status, valid_until)`。
  - `disposal_authorization_event`（只增：event_kind CHECK(REQUEST|APPROVE|REJECT|EXECUTE|RECEIPT|STOP|COMPLETE|FAIL|EXPIRE|CANCEL)、actor_id、note、snapshot JSON、occurred_at）。
  - `disposal_no_counter(day_key PK, next_no)` 供 `AUTH-YYYYMMDD-NNNN` 编号（行锁递增，PG/H2 皆可）。
  - `R__stage13_disposal.sql`（PG）：事件表只增触发器；`valid_until > valid_from` CHECK。
- `HandoffRules.requirePrerequisite`（E1）：`UAV_PUNISHMENT` 改为"该事件存在 COMPLETED 授权"才放行，否则仍 409 `HANDOFF_PREREQUISITE_UNAVAILABLE`。

## 状态机（`DisposalRules`）
REQUESTED →(approve) APPROVED →(execute) EXECUTING →(receipt ok) COMPLETED / (receipt fail|timeout) FAILED；REQUESTED →(reject) REJECTED；REQUESTED/APPROVED →(cancel by requester) CANCELLED；APPROVED/EXECUTING →(stop) STOPPED（同时尝试设备急停，失败只记事件 `DEVICE_STOP_UNAVAILABLE`）；APPROVED 超过 `valid_until` 未执行 →(job) EXPIRED。执行只允许在 `valid_from..valid_until` 内。所有写操作：`Idempotency-Key` + `expected_version`，成功审计同事务、失败审计事务外，越权 404、跨元组 404。

## 执行通道
- `LINGYUN_B`：调 A 的 `LingyunControlService.enqueue(deviceId, idempotencyKey, authorizationId, operationType, operationCmd, params, reason)`，指令码由 `action_type` 映射（反制→干扰/诱骗码、驱离→驱鸟炮/光电引导，码表在 `docs/backend-stage8/target-schema-v1-alignment.md` §5.3，DEMO，落 `disposal_policy.params.command_map`）；`device_command.status` 同步：`SUCCEEDED→COMPLETED`、`FAILED/TIMED_OUT→FAILED`。
- `COUNTERMEASURE_4CH`：A 的四通道适配器只有状态查询、无执行能力 → 执行返回 409 `DEVICE_CONTROL_UNAVAILABLE`，授权保持 APPROVED 并记事件；不伪造回执。
- `MANUAL`：人工执行，执行人点"已执行"并填写结果 → COMPLETED/FAILED，事件记 `MANUAL_EXECUTION`。

## API（契约 `docs/backend-stage13/disposal-authorization-api-contract.md`）
`POST /disposal-authorizations`、`GET /disposal-authorizations?subject_kind&subject_id&status&action_type&page&size`、`GET /{id}`、`GET /{id}/events`、`POST /{id}/approve|reject|execute|stop|cancel|manual-result`、`GET /disposal-policies`。错误码：`POLICY_REQUIRES_CONFIRMED_EVENT`、`TWO_PERSON_RULE`、`ACTIVE_AUTHORIZATION_EXISTS`、`AUTHORIZATION_NOT_APPROVED`、`AUTHORIZATION_EXPIRED`、`DEVICE_CONTROL_UNAVAILABLE`、`DEVICE_STOP_UNAVAILABLE`、`INVALID_TRANSITION`。

## 任务与会话
| 任务 | 会话 | 独占文件 | 先写的测试 |
| --- | --- | --- | --- |
| 13.0 契约/权限/模块骨架 | 领导 | 契约、`PermissionCode`、`GlobalExceptionHandler.module()`（`/disposal`）、`AuditLabels`、`Stage13AccessControlServiceTest` | 权限只登记不授权 |
| 13.1 后端域 | Session 1（E1） | `modules/disposal/**`、迁移 0101、`R__stage13_disposal.sql`、`HandoffRules`（只改前提）、`LocalStage13DisposalSeeder @Order(100)`（local/test：一条 APPROVED 反制授权 + 一条 COMPLETED，供页面与处罚交接演示） | `DisposalRulesTest`（状态机纯单元）、`DisposalAuthorizationApiTest`（403→400→409 顺序、两人规则、时限、幂等、审计回滚、越权 404）、`DisposalExecutionTest`（LINGYUN_B 经 A 的 enqueue 落 `device_command`/`lingyun_control_command`、4CH 409、MANUAL）、`HandoffPunishmentPrerequisiteTest` |
| 13.2 前端接线 | Session 2（E2） | `services/disposalApi.js`（新）、`ui/disposalAuthModal.js`（新：申请/审批/执行/停止/人工结果四种形态）、`AlarmsPage.vue`（启用"发起联动反制/信号干扰"、KPI 两项接数、详情尾部三项）、`SituationPage.vue`（启用"派发驱离"）、`WorkbenchPage.vue` + `services/workbenchEvents.js`（反制动作与步骤状态）、`PunishPage.vue`（"反制与公安信号干扰授权记录"区块列表）、`labels.js` 字典 | `check-ui-text`、scan、build；浏览器：申请→审批→执行（4CH 设备显示"设备不支持自动执行"）→处罚交接不再 409 |
| 13.3 PG + 隔离 + 到期任务 | Session 3（助手） | `DisposalExpiryJob`（`app.disposal.expiry.enabled` 缺省关，local 开）、`Stage13PostgresTest`（事件只增、并发审批一成一 409、编号并发唯一、到期）、`ProductionStage13SeedIsolationTest`（policy demo-v1 存在、零授权数据、job 不注册） | 同左 |
| 审查 | Session 4 | `review-log.md` | — |
| 13.9 验收 | 领导 | 验收文档、提交、决策清单 | — |

顺序：13.0 → 13.1 ‖ 13.2（先按契约桩数据做 UI）‖ 13.3 骨架 → 13.3 补齐 → 13.9。E1 先落迁移并在 progress.md 追加 "13.1 DDL 0102 landed"。

## 决策（自动，记 `docs/backend-stage13/decisions.md`）
13-1 策略参数全部 DEMO，客户 Q5 答复前不得标 CONFIRMED；13-2 两人规则与时限走 `disposal_policy`，代码无裸阈值；13-3 执行只经 A 的控制接口，不另开通道；4CH 无执行能力时 409 不伪造；13-4 急停失败不阻塞撤销授权，事件记 `DEVICE_STOP_UNAVAILABLE`；13-5 授权编号 `AUTH-YYYYMMDD-NNNN` 由计数表行锁生成；13-6 处罚交接前提改为存在 COMPLETED 授权；13-7 前端只启用既有按钮/填充既有区块，新增一个弹窗；13-8 迁移编号 `V202609070101` 起（0101 权限目录归领导，0102 起归 E1）。
