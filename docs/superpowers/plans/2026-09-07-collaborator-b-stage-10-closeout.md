# 阶段 10：B 线收尾与联调准备（2026-09-07）

## 背景
阶段 7/8/8.5/9 已提交（`b17c95d`、`f7eae07`、`2ef0fc5`）。B 线计划（P0/P2/P4-B）已完成；P6 联调等厂家资料。本阶段清掉累计的 B 线遗留项，并为协作者 A 的 P1/P3 联调准备输入物。不新增页面，不改既有 `.vue`。

## 遗留清单（来源）
1. 契约 §4 承诺 `fusion_event` `STATUS_STABLE` 的 payload 含 `latest_state` 摘要，实现只写 `status/degradation_level/determined`（A 的 P3 光电跟踪触发依赖）。
2. 阶段 7 种子仍写 `HEIGHT_LIMIT`/`TEMPORARY`（决策 9-22 留给领导 9.5 后做）；迁移 061 的 CHECK 因此容忍历史写法；用户会话的 065 只在 PG 归一存量行。
3. 未映射路径返回 500 `INTERNAL_ERROR` 而非 404（阶段 9 验收记录的平台问题）。
4. 六个测试文件各自硬编码来源类型目录（审查建议）。
5. A 的 P1 退出条件是"用 B 的模拟数据集经真实 MQTT 发布"，但 v2 数据集只存在于回放种子里，没有带主题的可发布文件。
6. `docs/后端开发基线.md` 事实段停留在阶段 6 之前。

## 任务与会话
| 任务 | 会话 | 独占文件 | 先写的测试 |
| --- | --- | --- | --- |
| 10.0 计划、契约 v1.2 §8、简报 | 领导 | 本文件、契约、简报、`progress.md` | — |
| 10.1 凌云 MQTT 回放导出 | Session 1（E1） | `integration/replay/LingyunMqttReplayExporter.java`（新）、`FusionReplayDatasetGenerator` 只加方法、`docs/直连接入计划/stage85-lingyun-demo.mqtt.ndjson`（生成物）、`docs/直连接入计划/凌云回放说明.md` | `LingyunMqttReplayExporterTest`：每条记录 `{topic, qos, payload, record_no, received_at}`；协议 A 主题 `bridge/{provider}/device_data/{abbr}/{deviceId}`；协议 C 主题 `iot-reporting/cmlc/edge/{edgeId}`；payload 与 inbox 里的原文逐字一致；导出可重复且哈希一致 |
| 10.2 `fusion_event` 摘要 + kind_code 归一 | Session 2（E2） | `DefaultFusedLayerWriter.emitEvents`、`FusionEventEmitter`（只加）、`LocalStage7RuleEngineSeeder`（h1/t1 与 C02-2 `kinds`）、`TestRuleParams`、`C02ChecksTest`/`LocalStage7RuleEngineSeederTest`/`RuleReplayRegressionTest` 预期、迁移 `V202609050074__stage10_airspace_kind_code_strict.sql`（重建 `ck_stage9_airspace_kind_code` 只留五值；先 UPDATE 归一再加约束，H2/PG 都能跑）、`AirspaceKind` 注释 | `FusionEventPayloadTest`：STATUS_STABLE/UNDETERMINED payload 含契约 §4 字段（`target_no`、`class_code`、`latest_state{longitude,latitude,altitude_raw,altitude_datum,speed_mps,heading_deg,observed_at,pilot_location?}`、`alarm_active`、`max_risk_severity`），缺失字段不出键；kind_code：种子只写五值、C02-2 用 `ALTITUDE_LIMIT`、十场景结论不变 |
| 10.3 平台 404 + 目录夹具 + PG | Session 3（助手） | `platform/api/GlobalExceptionHandler`（加 `NoHandlerFoundException`/`NoResourceFoundException` → 404 `NOT_FOUND`，先鉴权语义不变）、`application.yml` 的 `spring.mvc.throw-exception-if-no-handler-found`/`static-path-pattern` 若需要、`test/.../SourceTypeCatalogFixture.java`（新）并把六处断言改为引用、`Stage9PostgresTest` 加 074 用例（PG 上 `HEIGHT_LIMIT` 被 CHECK 拒） | `UnmappedPathApiTest`：未登录 401、登录后未映射路径 404 且包络 `{ok:false,error.code=NOT_FOUND}`、已映射路径不受影响；六个目录断言类回归 |
| 10.4 基线文档 + 验收 + 提交 | 领导 | `docs/后端开发基线.md` 事实段、`docs/backend-stage10/acceptance.md`、`decisions.md` | — |
| 审查 | Session 4 | `review-log.md` | — |

顺序：10.0 → 10.1 ‖ 10.2 ‖ 10.3 → 10.4。迁移 074 归 E2；助手的 PG 用例等 progress.md "10.2 DDL 074 landed"。

## 验收口径
- H2 全量 + PG 专项（阶段 4/5/7/8/8.5/9）全绿；`git diff --check`。
- `fusion_event` 在 v2 数据集回放后每个 STABLE 目标恰一条 STATUS_STABLE，payload 含 `latest_state` 摘要，tdoa-pilot 目标含 `pilot_location`。
- 导出文件可被 A 直接用 MQTT 客户端发布（每行一个主题+报文），与 inbox 原文哈希一致。
- 未映射路径 404；`HEIGHT_LIMIT` 在 H2/PG 都被 CHECK 拒；种子与十场景不变。
- 基线文档事实段覆盖阶段 7–9 与 8.5。

## 决策（自动，记 `docs/backend-stage10/decisions.md`）
10-1 `fusion_event` payload 只放摘要，不放原始观测（沿用阶段 8 原则），`altitude_datum` 固定 `UNCONFIRMED` 直到客户答复。10-2 kind_code CHECK 收紧在 074 做，H2/PG 同一句；PG 上 065 已归一存量行，074 再 UPDATE 一次是幂等的。10-3 未映射路径 404 不带路径回显（避免泄露探测信息）。10-4 导出文件放 `docs/直连接入计划/`，生成器可重复执行；不入 `resources`。
