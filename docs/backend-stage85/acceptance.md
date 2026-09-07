# 阶段 8.5（设备直连切片）验收记录

日期：2026-09-07。基线：`main@46752c5`（阶段 9 收尾）。契约 `docs/backend-stage8/device-direct-access-contract.md` v1.1，决策 `docs/backend-stage85/decisions.md` 8.5-1…8.5-24。

## 执行者报告
| 任务 | 会话 | 用例 | 报告 |
| --- | --- | --- | --- |
| 8.5.0 契约收口、迁移 070、冻结接口扩展 | 领导 | `Stage85ContractTest` 3/3，`Stage8AccessControlServiceTest` 4/4 | — |
| 8.5.1 凌云映射、路由、数据集 v2、迁移 071 | Session 1 | 7 类 37/37（`FusionPipelineReplayTest` 11/11，审查后新增 `FusionInboxClaimPrefixTest` 3、`MIXED_TASK_ID` 用例 1） | `.superpowers/sdd/task-8.5.1-report.md` |
| 8.5.2 C02-6 超视距、`pilot_location` 写读、DTO、字典 | Session 2 | 7 类 47/47 + E1 11 = 58 | `task-8.5.2-report.md` |
| 8.5.3 实测雷达端口、PG 专项、生产隔离 | Session 3 | 最终 18/18：`Stage85PostgresTest` 12/12（PostgreSQL 16.9 + PostGIS 3.5.2，含 v2 端到端、四前缀两连接并发领取无交集、开关关时 `live-radar:` 不领且 `fusion_attempts` 不动、`source_observation` UPDATE/DELETE 以 23514 被拒、`payload_hash` Java 侧逐行复核 180 行）、`ProductionStage85SeedIsolationTest` 3/3、`LiveRadarSourceObservationPortTest` 3/3 | `task-8.5.3-report.md` |

## 8.5.9 领导验收
- H2 全量（`/private/tmp/dongying-mvn.sh test`）：109 类 / 551 run / 2 fail / 0 err / 62 skip（skip 为 env 门禁的 PG 类）。两个失败都在 `ProductionStage8SeedIsolationTest`，原因是目录断言仍写五行（预期漂移，决策 8.5-26），改为八行后单独重跑 2/2。
- PostgreSQL 专项与回归（PostgreSQL 16.9 + PostGIS 3.5.2，库 `stage456_verify_s85`，随机 schema）：`Stage9PostgresTest` 20/20、`Stage7PostgresTest` 8/8、`Stage5PostgresTest` 5/5、`Stage4PostgresTest` 5/5、`Stage8PostgresTest` 7/7（目录计数 5→8 为预期漂移，8.5-26，改后重跑）、`PostgresStage2CompatibilityTest` 3/3、`FlightReadPostgresApiTest` 1/1、`AirspaceReadPostgresApiTest` 3/3；`TargetReadPostgresApiTest` 2/2（需库名 `stage2_target_verify_*`，用 `stage2_target_verify_s85`）。`Stage85PostgresTest`：领导首跑 8 例 7 过 1 红——助手新增的 v2 端到端用例被用例 4 的探针 inbox 行污染（同 schema 残留），助手修隔离（探针行用完即 DONE、端到端用例排到夹具之前）后 12/12，连跑两次一致。
- 前端：`npm run build` 通过、`node tools/scan.cjs` 全部通过、`node tools/falsify.cjs` 全部必抓注入被捕获；`git diff --stat -- src` 只有 `src/ui/labels.js`（+14/−1），零 `.vue` 改动。
- API 路径（全新库 `uav_stage85_verify`，jar 8081，local profile，回放种子 v2 `stage85-lingyun-demo` 启动即跑）：`inbox_message` 180 行全部 DONE（`lingyun:` 138、`eo-edge:` 42，零 FAILED）；`source_observation` 按来源：RADAR 102（SENSE_DATA，有位置）、TDOA 42（12 条带 `pilot_location`）、EO 35（EO_TRACKING，只在 BeginTracking 期间）、AOA 12（无位置、无测量点）；`target_latest_state.pilot_location` 落在 tdoa-pilot 目标 `POINT(118.92 37.42)`；`GET /targets` 27 条（16 条 mock 种子 + 11 条 replay 融合目标，一物理目标一次），tdoa-pilot 目标 `latest_state.pilot_location={118.92,37.42}`；`GET /targets/{id}/observations` 返回 `class_source=SENSE_DATA` 与 `pilot_location`；`GET /fusion/status` 列出四个回放来源含 AOA（DEMO）；`POST /legality-evaluations` 对该目标：C02-6 由恒 UNDETERMINED 变为 **PASS**（`distance_m=113.56`，facts 含 `pilot_location`），整体 UNDETERMINED/LOW_CONFIDENCE（无计划、C01 NONE，属预期）；雷达目标详情无 `pilot_location` 字段（缺失不下发）。
- 浏览器（Vite 5174 → 8081，API 登录后注入会话，不在表单输口令）：`#/situation`（协作者 A 的页面，本期零改动）在 v2 数据集上正常渲染地图、目标与实时告警栏，登录后无新增控制台错误。
- 审查（Session 4，7 轮）：P0 0；P1 4（070 `version=0` 静默失效、AOA 无位置拆箱 NPE、`ProductionStage8SeedIsolationTest` 与 `Stage8PostgresTest` 目录漂移）全部闭合；P2 5（070 注释、路由互为前缀、`source_observation` 只增触发器、`claim` 静态白名单、帧内混合 taskId）全部闭合；建议 1（六处目录断言抽共享常量）记入后续。
- 提交后跟进（E2）：多源目标 `target_attribute_selection` 三个来源列为 NULL（验收库 10 行中 9 行），`pilot_location` 仍按帧内身份主源写入且 C02-6 可判定，但选源表语义待 E2 核实；同毫秒多源帧的处理顺序对每帧重写的 `pilot_location` 是否有影响一并核。
- 工作区外部改动说明：`31f9ece`（用户另一会话，非 B 线四个会话）修改了已提交的迁移 061（去掉两条 UPDATE，H2/PG 校验和随之变化，已按旧 061 迁移过的库需 `flyway repair` 或重建）并新增 `db/postgresql/V202609050065`（该目录首个版本迁移，`DISABLE TRIGGER USER` 一次性订正）。本验收库 `uav_stage85_verify` 按 31f9ece 之后的内容全新迁移（061 校验和 1141526906、065 已应用）。

## 未接入 / 未验证
- 高度基准（海拔 vs 椭球高）未确认，凌云/雷达高度不进合法性比较（契约 §5）。
- 真实设备联调未做；AOA/DCD/RID/EO/TDOA/5G-A/融合箱仍 DEMO。
- `class_source` 仅到接口，页面未消费（本期不改 `.vue`）。
- 逐对象 `observed_at`（8.5-21）不在本期。

- 提交前最终复跑（执行者全部冻结后）：8.5 相关 H2 19 类 114 用例 0 失败 0 错误；`Stage85PostgresTest` 12/12、`Stage8PostgresTest` 7/7（真实 PG）；`git diff --check` 通过。
