# 阶段 8 决策记录（领导代用户决定）

依据同阶段 7（用户经会话转达的指令：需要用户决定的事项按推荐选项直接执行并逐项记录）。

| # | 决策 | 选择 | 放弃的选项 | 理由 |
| --- | --- | --- | --- | --- |
| 8-1 | 实测雷达 ops→阶段 2 提升 | 不在本阶段；只留 `SourceObservationPort` 与 `app.fusion.live-promotion.enabled=false` | 纳入（+2 天，需 A 确认） | 用户已在计划阶段选定 |
| 8-2 | 三路来源 Schema | 雷达 CONFIRMED，EO/TDOA/5G-A/融合箱 DEMO；缺省精度 15/25/60/80/20 m | 等资料 | 用户已选定 Demo Schema 先做 |
| 8-3 | 融合事件发射落点 | 独立表 `fusion_event`（只增，供 A 消费/轮询），不放入设备 `outbox_event` | 复用 outbox 主题 | `DeviceOperationsProcessor.process` 对未知主题抛异常并死信；处理器属设备模块（A 边界），不改 |
| 8-4 | 态势页模板基底 | 保留当前 HUD DOM（`sit-stage/sit-hud-*/sit-fuse-dock`），逻辑取自 `150dfa6` | 字面恢复 150dfa6 模板 | 保住"融合感知样式"合并成果 |
| 8-5 | `TargetReadRepository` 的 source_mode 一致性 JOIN | 不改；融合只在同一 `fusion_domain=(source_mode, org, district)` 内进行 | 改为按 link 各自模式过滤 | 该仓库是阶段 2 读契约，跨模式关联本期不需要 |
| 8-6 | Worker 是否递增 `target.version` | 不递增（`version` 留给人工写：修订/合并/分裂） | 每帧递增 | 否则页面 `expected_version` 持续冲突 |
| 8-7 | 迁移与权限编号 | 迁移 050–054，权限 sort 950–952，种子 `@Order` 75/80，PG 隔离库 `stage456_verify_s8` | — | 按计划 |
| 8-8 | A 的 `V202609050001` 迁移编号低于已应用版本 | 用户要求重启并不停：仅 `application-local.yml` 开 `spring.flyway.out-of-order=true`（生产配置不放开）；不改 A 的迁移编号 | 请 A 重编号 / 全局放开 | 只影响本地开发库；A 的已推送迁移不能改名 |
| 8-10 | A 的 `LocalReportingSeeder` 缺双门禁导致生产 profile 隔离测试与生产启动失败 | 用户要求不停：领导补一行 `@Profile("!production & (local | test)")`，与仓库其他种子一致；已在决策记录知会 A | 留给 A | 阶段门槛要求全量绿；改动一行且符合 `server/AGENTS.md` §5 |
| 8-9 | 阶段 7 种子污染 `test` 列表断言 | 阶段 8/9 简报要求所有列表计数断言按自身归属过滤；JSON/JSONB 非 INSERT 表达式、CHECK、触发器必须先过 PG 专项再报 GREEN | — | 阶段 7 审查建议固化 |
| 8-11 | 融合感知页前端 | 不改 `SituationPage.vue`、不扩 `services/targetApi.js`；融合结果经既有 `GET /targets`、`/targets/{id}`、`/targets/{id}/tracks`、`/tracks/{id}/points` 可见；新增读写接口只供后端与 A 的页面接线 | 按总计划由 E2 重写页面 | 用户 2026-09-06 指示"融合感知页面已经有前端接口了，不用再加" |
| 8-12 | 融合轨迹的落表 | 不建 `fused_track/fused_track_point`，融合轨迹写成 `track(layer='FUSED', link_id NULL)` + `track_point` 扩展列（`point_kind/observation_id/position_accuracy_m/contributing/degradation_level`）；`/targets/{id}/tracks` 默认两层并加可选 `layer=` 过滤 | 独立融合表 + 新接口 | 8-11 要求既有轨迹接口直接看到融合层；`track.link_id` 放开可空由 PG CHECK 守住只有 FUSED 层可空 |
| 8-13 | 阶段 8 工作区携带的前端改动 | 只做"数据接到前端"的翻译（枚举经共享字典、版本显示为第 N 次核实、内部 ID 进 title、空值不渲染），涉及 `WorkbenchPage.vue`、`PunishPage.vue`、`labels.js`；既有标题/副标题/提示语不改；另开 Session 5（`task-fe-1-brief.md`）修 B 线其余页面；提交说明单列 | 按另一会话的可读性规则全面改写页面 | 用户 2026-09-06 指示"不要随意改之前的页面，只把数据接到前端"；审查 P1-1 要求登记 |
| 8-14 | 迁移 054 列名与契约不一致 | 契约改为实现列名：`replay_ground_truth(dataset_id, scenario, record_no, true_target_key, source_code, external_target_id, observed_at)`、`fusion_effect_daily(... id_switch_count, interrupt_rate, duplicate_target_rate, association_accuracy)` | 改实现 | 实现已在真实 PG 验证（Stage8PostgresTest 6/6），且 `source_code` 比 `source_id` 更适合跨库回放对账 |
| 8-15 | `interrupt_rate` 口径 | PRED 点数 / FUSED 层全部点数（实现口径），验收文档写明 | 简报口径 "SHORT_LOST 帧/总帧" | `target_track_status` 只存当前状态，历史帧状态不可回溯；PRED 点是可回溯的等价事实 |
| 8-16 | 引擎自动合并/分裂的触发 | 本阶段：状态机与 alias/lineage 写入已就绪且有单测，人工合并/分裂经 API（E2）；`processFrame` 内自动触发 MERGE/SPLIT 留到集成后视时间补，未补则记入验收"未接入" | 阻塞验收直到自动触发落地 | 退出标准"同一物理目标只显示一次"由关联保证；自动合并只处理关联后仍重复的目标，可人工兜底 |
| 8-17 | inbox 毒帧重领上限 | 051 加 `inbox_message.fusion_attempts`，领取只取 `< app.fusion.max-attempts`（默认 5），Worker 每轮先把耗尽且过期的行置 FAILED | 无上限 / 复用 outbox 退避 | 审查 P2：毒帧否则每 500 ms 无限重领 |
| 8-18 | 执行者独占文件被他人直接修改 | 领导记录并重申：只改自己简报列出的文件，跨界改动写进报告由领导转达；E1 已把 `ON CONFLICT` 改回 H2/PG 通用的 `INSERT … SELECT … WHERE NOT EXISTS`，采纳 | — | `ON CONFLICT` 在 H2 PostgreSQL 模式不解析，曾让全部 Spring 上下文测试失败 |
| 8-19 | 双源时的降级档 | 两源归入 `FUSION_BOX_ONLY` 档的 deficit 0.2（等级名不改，DEMO 参数） | 新增 `TWO_SOURCE` 枚举 | 契约枚举已冻结；deficit 表只有 0/0.2/0.35 三档，双源介于三源与单源之间 |
| 8-20 | `fusion_event.event_type` 命名 | 按简报枚举 `STATUS_STABLE / MERGED / SPLIT / UNDETERMINED / CLASS_REVISED`；契约正文的 `fusion.target.*` 主题措辞改为该枚举 | 主题串 | 独立表不走 outbox 主题（8-3） |
| 8-21 | `POST /targets/{id}/split` 的 `source_codes` 入参 | 本期只支持 `link_ids`，契约 v1.2 删除 `source_codes` | 补实现 | 页面（A）按 link 选择即可 |
| 8-22 | E2 额外仓库文件 `ObservationReadRepository`、`TargetWriteRepository` | 接受（在 `modules/fusion/infrastructure` 独占目录内） | — | 目录级独占 |
| 8-23 | PG 上 `CAST(location AS VARCHAR)` 回读为 EWKB | 领导集成修复：`FusedTrackRepository.lastPoint` 在 PostgreSQL 用 `ST_AsText`，H2 保持 CAST | 交助手先验后再改 | E2 报告已指出，修法明确；PRED 点"保留最后可信点"在 PG 上否则退化 |
| 8-24 | 工作区里非阶段 8 的前端改动 | `dongying-vue/src/assets/css/reset.css`（webkit autofill 深色适配）来自其他会话、未认领，**不进阶段 8 提交**；`b2d1359`（另一会话已提交：overlay.css 的 `.tabs .tab` 全局重置、FlightsPage/PunishPage 布局修复）影响面含 A 的页面页签样式，在本阶段提交说明与验收文档知会 A | 一并提交 / 回退他人改动 | 不覆盖、不提交他人未认领的工作区改动 |
| 8-25 | 无源 TERMINATED 帧写最新状态时丢位置 | 领导集成修复：`DefaultFusedLayerWriter.writeLatestState` 用本帧的融合轨迹取最后可信点（不再查"开放轨迹"，因为 TERMINATED 已先关闭轨迹）；保留位置时移除 `location` 未知标记；新增 `DefaultFusedLayerWriterTerminalFrameTest` | 交 E2 返工 | 真实 PostgreSQL 验收暴露：7 个回放目标 6 个最新状态无位置；H2 单测未覆盖终止帧 |
| 8-26 | 目标详情缺 `version` | `GET /targets/{id}` 追加可空 `version`（`target.version`），供修订/合并/分裂的 `expected_version` | 客户端另查 | 验收时写接口无法拿到期望版本；阶段 2 读契约只加字段不改既有字段 |
