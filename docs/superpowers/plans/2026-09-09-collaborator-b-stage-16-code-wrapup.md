# 协作者 B 阶段 16 执行计划：代码收尾（自动合并/分裂、空域孔洞、动作码下发、Worker 租约证据）

日期 2026-09-09。基线提交 `012e4af`（阶段 15 全部收口，CI 第三跑待用户推送）。原则（用户 2026-09-08）：**只改真缺陷与交付物，不做冗余改动**——本阶段每一项都对应一个现在能观察到的缺口。

## 红线
- 另一个会话（"启动 dongying-vue 项目"）正在改 bug，其未提交文件**任何人不得触碰、不得提交**：`dongying-vue/src/pages/{AlarmsPage,FlightsPage,PunishPage,WorkbenchPage}.vue`、`src/ui/labels.js`、`src/services/workbenchEvents.js`、`src/services/positionMap.js`、`server/.../platform/export/CsvLabels.java`、`modules/flight/{api/FlightDtos,application/FlightReadService,infrastructure/FlightReadRepository}`、`modules/workbench/application/WorkbenchReadService`、`modules/airspace/api/Airspace*Test.java`、`integration/mock/LocalDemoVolume*Seeder`、`modules/handoff/**`（渠道/端口）。开工前 `git status` 核对，冲突即停并报领导。
- A 的模块只读：`modules/device/**`、`modules/evidence/**`、`modules/reporting/**`。
- 不新增迁移（`association_pending` 的 `MANY_TO_ONE/ONE_TO_MANY`、`fusion_event` 的 `MERGED/SPLIT`、`target_lineage.operator_kind='SYSTEM'` 均已在 CHECK 内）。
- Maven 只经 `/private/tmp/dongying-mvn.sh`；执行者不提交；报告写 `task-16.x-report.md`，账本 `progress.md` 行首 `- 16.x … landed/DONE`。

## 任务与归属
| 任务 | 会话 | 缺口（现状） | 独占文件 |
| --- | --- | --- | --- |
| 16.1 管线自动合并/分裂 | E1（Session 1） | 决策 8-16 遗留：`processFrame` 只写 `GATE_AMBIGUOUS`，`association_pending` 无消费者；`IdentityStateMachine.chooseSurvivor/mergeEligible/newSplitIds` 只有测试调用；同一目标被重复建为两个目标时只能人工合并 | `modules/fusion/application/{FusionPipeline,MergeSplitEvaluator(新)}`、`modules/fusion/domain/**`（不含 FusionContracts 记录形状）、`modules/fusion/infrastructure/{AssociationPendingRepository,IdentityRepository,LineageRepository}`、`integration/replay/FusionReplayDatasetGenerator`（新增 `converge-merge` 场景）、对应测试 |
| 16.2 空域多边形孔洞 | E2（Session 2） | `situationData.outerRings` 明说"孔洞 map.js 画不了，本期忽略"；`map.js` 一环 `fill()`；大屏只取第一个多边形第一环且缺 `layer` 被整条跳过 | `dongying-vue/public/assets/js/map.js`、`src/services/situationData.js`、`tools/situationData.test.cjs`、`src/pages/bigscreen/BigScreenApp.vue`（仅空域几何与 layer 两处） |
| 16.3 `/auth/me` 下发动作码 | E1（16.1 之后） | 15-36：`permission_codes` 只有模块码，`FlightsPage` 已按冒号码嗅探 `actionAllowed`，其余页面靠 403 | `modules/identity/application/AccessService`、`infrastructure/IdentityAdminMapper`（只加查询）、`AuthApiTest`、`LocalStage15DemoReviewerSeederTest` 的措辞 |
| 16.4 Worker 租约/重启/超时证据 + PG 专项 | 助手（Session 3） | P1-9：融合过期租约重领、outbox 过期/在途领取、退避与 6 次死信在测试里为零命中；自动合并需在 PostGIS 上留证据 | `Stage16PostgresTest`（新）、`OutboxWorkerRecoveryTest`（新，H2）、`FusionInboxRecoveryTest`（新，H2）、E2E 复跑 |
| 审查 | Session 4 | — | `review-log.md` |
| 16.9 验收/提交 | 领导 | — | `docs/backend-stage16/{decisions,acceptance}.md`、提交 |

顺序：16.1 ‖ 16.2 ‖ 16.4（先写 H2 恢复用例，等 16.1 落地再补 PG 自动合并）→ 16.3 → 16.9。PG 隔离库 `stage456_verify_s16`。

## 冻结的设计（决策 16-1…16-4，详见 `docs/backend-stage16/decisions.md`）
- 自动合并：同域两个 `STABLE` 目标，预测位置互距 ≤ `merge_max_dist_sigma·max(σa,σb)` 连续 ≥ `merge_min_frames` 帧 → `association_pending(MANY_TO_ONE)` 计帧，达阈后 survivor=`chooseSurvivor`（更早 first_seen_at），被并者 `target_track_status=MERGE`、`target_current_alias` 写入并重定向链、`target_lineage(op=MERGE, operator_kind=SYSTEM)`、`fusion_event MERGED`、pending `resolution=MERGED`；**links 不迁移、不递增 `target.version`（8-6）**；被并者从本帧 `estimatesByTarget` 移除后再进 ⑤。
- 自动分裂：同源同帧对同一目标出现第二回波（今天它会直接成为新目标并写 `CREATE` 血缘）→ 改为 `association_pending(ONE_TO_MANY)` 计帧；连续 ≥ `split_min_frames` 帧且间距 ≥ `split_min_separation_m` 后，新目标的血缘写 `op=SPLIT, origin_target_id=原目标`、`fusion_event SPLIT`、pending `resolution=SPLIT`；**原目标保留原 ID 继续存活**（偏离契约 v1.2 的"两个新 ID"，理由：ID 稳定优先，见 16-2）。未达阈值前第二回波按现状建新目标，不阻塞。
- 孔洞：`map.js` 每个空域一次 `beginPath`、遍历全部环、`fill('evenodd')`，阴影线 `clip()` 与 bbox 同样用全部环；`situationData` 输出 `rings`（外环 + 内环）并保留 `poly`=外环以兼容既有消费者；大屏改为遍历全部多边形与环并补 `layer`。
- 动作码：`permission_codes` 追加该角色等级 ≥ READ 的 ACTION 码原文（冒号形式），超管为目录内全部 ACTION 码；模块码不变。
- Worker 证据：融合 `lease_until` 过去 + `fusion_attempts<max` → 重领并完成；未过期不重领（已有）；outbox `available_at` 未来 → 跳过、过去 → 重领；失败退避 `min(60s, 1s<<attempts)`；第 6 次 → `timeout` + 完成（死信）。

## 验收门槛（16.9）
- H2 全量（`test` + `package`）0 红；PG：`Stage16PostgresTest` + 阶段 8/8.5/15 回归各一遍；E2E 40 条；`git diff --check`。
- 浏览器：隔离库回放 `converge-merge` 后 `GET /targets` 该目标只出现一次、详情 `lineage_summary` 有 `MERGE`、`GET /targets/{id}/lineage` 有 SYSTEM 行；态势页一个带孔空域按孔洞渲染（截图）；reviewer1 `/auth/me` 的 `permission_codes` 含 `disposal:approve`。
- `docs/backend-stage16/acceptance.md` 记录命令与数字；一次提交，显式文件清单。
