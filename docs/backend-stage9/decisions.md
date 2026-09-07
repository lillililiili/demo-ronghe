# 阶段 9 决策记录（领导代用户决定）

依据同阶段 7/8：需要用户决定的事项按推荐选项直接执行并逐项记录，阶段提交后发清单。

| # | 决策 | 选择 | 放弃的选项 | 理由 |
| --- | --- | --- | --- | --- |
| 9-1 | 空域版本变更方式 | 接替式新版本：新版本插入时把上一开放版本 `valid_to` 关闭为新版 `valid_from`；PG 触发器只放开 `valid_to` 从 NULL→非 NULL，其余列不变，DELETE 仍禁止 | 原地修改 / 完全不可变 | 用户已在计划阶段选定；历史研判引用的版本几何/高度不漂移 |
| 9-2 | 人工与导入空域的来源 | `source_id=NULL, source_mode='live'`；操作者痕迹落 `airspace_version_origin(MANUAL|GEOJSON_IMPORT|SEED)` | 造一条"人工来源"行 | 人工数据不是外部来源；生产不造模拟来源 |
| 9-3 | `kind_code` 字典 | CHECK `PROHIBITED|RESTRICTED|ALTITUDE_LIMIT|PERMITTED|TEMPORARY_CONTROL`；图层映射 nofly/limit/suit 由前端字典完成 | 自由文本 | 阶段 3 只要求非空，页面需要稳定图层映射 |
| 9-4 | 航线编辑 | 不在本期；空域页右侧只读展示航线 | 一并做航线版本编辑 | 被计划引用的 `route_version` 不可变，改动面涉及阶段 3 触发器 |
| 9-5 | C04 产出落点 | `flight_risk(risk_type='SPACE_OBJECT')` 经 `RiskIngestionService.ingest` 幂等入库，细节落 `space_risk_fact(risk_id PK)`；无活动计划不生成风险，只计 `targets_seen` | 独立风险表 | 复用阶段 4 核验/交接闭环；`flight_risk.plan_id` 非空 |
| 9-6 | 异物细类字典 | `space_object_subtype(BIRD_FLOCK|BALLOON|KITE|SKY_LANTERN|OTHER_OBJECT, aliases JSON)`，按 `target.subtype` 精确/别名匹配，匹配不到不进 C04 | 未匹配归 OTHER | 不伪造分类；气球/风筝/孔明灯只能是 subtype（A4） |
| 9-7 | C04/C05 参数机制 | 迁移 062 建规则集 `SPACE-RISK-DEMO` v1（PUBLISHED，DEMO）与 C04/C05 `rule_version`+`rule_param`；评估器经阶段 7 `RuleParamsImpl` 读参数；不接 `RuleEngineWorker` | 新参数表 / `source_snapshot` | 阶段 7 已落地，参数机制统一 |
| 9-8 | 规则引擎来源行 | 复用阶段 7 已有 `rule-engine-legality-live/mock`？否——C04 风险用新来源 `rule-engine-space-risk-{live,mock}`（迁移插入） | 复用合法性来源 | 风险与合法性告警来源分开，统计口径可分 |
| 9-9 | C05 通报对象 | 新表 `airport_notification_target`（逻辑名，不存号码/凭据），不复用 `handoff_recipient` | 扩 `handoff_recipient` CHECK | 交接接收方 CHECK 只允许两种类型且属阶段 5 契约 |
| 9-10 | `#/risk` 与飞行计划页 | `#/risk` 成为独立 `SpaceRiskPage`（按 legacy risk.js DOM 恢复）；`FlightsPage` **保留** events 页签与全部 `risk*` 状态，只去掉 hash 互写并在详情既有占位区块接数据 | 总计划 D10 的"迁出 400 行" | 用户 2026-09-06："不要随意改之前的页面，只把数据接到前端" |
| 9-11 | "计划与实际对照"数据源 | 优先读阶段 7 `rule_evaluation` 最新 C01 匹配（`plan_match_code` + hit_details C01）；无研判时 `availability=NO_EVALUATION` | 前端自算 | 前端不做几何/高度计算 |
| 9-12 | GeoJSON 导入 UX | `openFormModal` 内 textarea 粘贴为真源；"选择文件"按钮在脚本里 `createElement('input')` 读文本填入（模板不出现原生控件） | 只保留粘贴 | 满足 `tools/scan.cjs` 且可用 |
| 9-13 | 编号 | 迁移 060–064，`R__stage9_*`，权限 sort 960–964，种子 `@Order` 85/90，PG 隔离库 `stage456_verify_s9`，验收库 `uav_stage9_verify` | — | 按计划 |
| 9-14 | 新页面文案与布局 | 走技能 `writing-user-readable-ui-text`（共享字典、第 N 次、ID 进 title、空值不渲染）+ `b2d1359` 布局规则；报告前 `check-ui-text.sh` 零命中（既有页面的既有文案除外）+ 浏览器截图 | — | 两个会话转达的用户要求 |
