# 设备直连接入契约（阶段 8.5，A/B 边界）

> 状态：领导冻结稿 v1.1（2026-09-07：补冻结接口扩展、迁移编号、字段落点；v1.0 同日）。依据：会议纪要 V1.0 三路架构、凌云协议 A v8.6 / B V2.4 / C 20250826（`设备资料/凌云协议/`）、决策 8-30（云端只保留我们的平台）、对齐文档 `target-schema-v1-alignment.md` §5。配套计划：《协作者 A 直连接入计划》《协作者 B 直连切片计划》。

## 1. 边界

- **A（设备接入）**：MQTT/TCP 适配器、设备注册与在线态、光电边端中心、控制指令下发与回执。适配器把报文**原样**写入 `inbox_message`，不解释语义，不写 `target / track / track_point / target_latest_state / source_observation`。
- **B（统一目标库）**：从 `inbox_message` 领取并映射为 `SourceObservation`，驱动阶段 8 融合引擎与阶段 7 规则；提供 `fusion_event` 供 A 触发光电跟踪。
- 两侧共用同一套 Schema；厂家原生协议到位后只换 A 的适配器与 B 的对应映射分支。

## 2. inbox 信封（A 写、B 读）

| 列 | 值 | 说明 |
| --- | --- | --- |
| `source` | `lingyun:<deviceTypeAbbr>:<deviceId>` / `eo-edge:<edgeId>` / `live-radar:<deviceId>` | B 的 `FusionInboxRepository.claim` 前缀白名单从 `replay:` 扩到这三个；ops 的 `live-device:*` 行继续由设备模块自己处理，两侧互不触碰 |
| `source_msg_id` | 协议 A：`msgCnt`；协议 C：`metadata.extention.msgId`，缺则 `timestamp`；雷达：`<bootMicros>:<frameId>` | 与 `source` 构成唯一键去重；重复即丢弃并计数 |
| `source_id` | `integration_source.source_id`（A 注册设备时建） | `integration_source.source_type` 按 `deviceTypeAbbr`：`5ga→FIVE_G_A, radar→RADAR, oe→EO, tdoa→TDOA, aoa→AOA, dcd→DCD, rid→RID, isrs→FUSION_BOX` |
| `payload` | 原始 JSON（协议 A 整条 `SenseData`；协议 C 整条事件；雷达为解码后的轨迹批 JSON） | JSONB |
| `payload_hash` | SHA-256 十六进制 | `ck_stage2_inbox_payload_hash` |
| `status` | `RECEIVED` | B 领取后 `PROCESSING → DONE/FAILED`，`processed_at` 同时写 |
| `received_at` | A 收到报文的 epoch 毫秒 | |

雷达帧（P4-A）payload 结构：`{device_id, boot_micros, frame_id, items:[{external_track_id, longitude, latitude, z_m, velocity_x_mps, velocity_y_mps, velocity_z_mps, snr_db, rcs_m2, classification}]}`；受 `app.fusion.live-promotion.enabled` 控制，默认关。

## 3. 映射（B 实现，A 不做）

| 协议字段 | `SourceObservation` | 规则 |
| --- | --- | --- |
| 协议 A `objects[].objectId` / `time` / `ptTime` | `external_target_id` / `observed_at` / `received_at` | 毫秒 UTC |
| `longitude/latitude` | `location` | 光电（`oe`）与 AOA **置 NULL**；AOA 的 `extension.direction` 进 `quality.bearing_deg` |
| `altitude` | `quality.altitude_raw`；`altitude_amsl_m/height_agl_m` = `REFERENCE_UNKNOWN` | 基准（海拔 vs 椭球高）未确认前不进合法性比较 |
| `height` | `height_agl_m` + `quality.height_datum=DEVICE_GROUND` | 相对基站安装点地面 |
| `speed` / `extension.speedX/Y/Z` | `speed_mps` / `heading_deg`（X 正东、Y 正北）/ `quality.speed_xyz` | |
| `extension.objectType` | `class_code`：0 UNKNOWN / 3 PERSON / 7 VEHICLE / 30 UAV / 40 BIRD / 50 SHIP / 100 REMOTE_CONTROLLER / 255 → NULL + `quality.identifying=true` | `OBJECT_TYPE_LABEL` 字典同步扩展 |
| `extension.probability` | `class_confidence` | |
| `uavSN` / `uavModel` / `channel` / `bandWidth` | `identity_clue`（SN 优先）/ `quality.rf` | |
| `pilotLon/pilotLat` | 新列 `source_observation.pilot_location`（POINT 4326） | 阶段 7 C02-6 超视距、C01 身份维度输入 |
| `extension.taskId` | `source_session_key` | 5G-A |
| 协议 C `aiStatus.className/detectConfidence/trackConfidence` | `class_code`（drone→UAV, bird→BIRD，未知值 NULL + 原串进 `quality.class_name_raw`）/ `class_confidence` / `quality.track_confidence` | 光电唯一的类别来源 |
| `aiStatus.latitude/longitude/altitude` | `location`（高度同上） | 只在跟踪任务期间存在 |
| `taskId` / `edgeId` / `cameraStatus` / `objectData` | `source_session_key` / `quality.edge_id` / `quality.camera` / `quality.bootstrap_source_*`（**不作为观测入库**） | |
| 精度 | `fusion_config.filter.accuracy_default_m[source_type]`（新增 AOA/DCD/RID，DEMO） | 协议无精度字段 |

## 4. `fusion_event`（B 写、A 读）

`event_type='STATUS_STABLE'` 的 `payload` 追加：`{target_id, target_no, class_code, latest_state:{longitude, latitude, altitude_raw, altitude_datum:'UNCONFIRMED', speed_mps, heading_deg, observed_at}, degradation_level, alarm_active:boolean, max_risk_severity}`。A 的光电跟踪触发只读该表（按 `event_id` 递增游标），不更新、不删除。

## 5. 待确认（客户/厂家）

高度基准；各源标称精度；`objectId` 生命周期与上报频率；光电 `className` 取值表与门限；云台角度控制与"执行中/急停"回执。确认前一律原样透传并标注，不猜测。

## 6. 冻结接口与落点（阶段 8.5，v1.1）

- `FusionContracts.SourceEstimate` 追加可空 `pilotLongitude / pilotLatitude / classSource`（旧 21 参构造器保留，新字段为 null）；`RuleContracts.TargetState` 追加可空 `pilotLongitude / pilotLatitude`（旧 12 参构造器保留）。
- 迁移 070（领导）：`source_type_catalog` 增 `AOA / DCD / RID`，EO/TDOA/5G-A/融合箱 `spec_ref` 指向凌云协议 A；`fusion_config demo-v1` 的 `accuracy_default_m` 与 `weights` 增三项（AOA 位置权重 0）。
- 迁移 071（E1）：`source_observation ADD pilot_location GEOMETRY(POINT,4326), class_source VARCHAR(16)`；`target_latest_state ADD pilot_location GEOMETRY(POINT,4326)`；`R__stage85_direct_access.sql`：两列 SRID/范围 CHECK + GIST。
- ~~迁移 072~~ 取消（决策 8.5-12）：C02-6 复用既有参数 `C02-6.vlos_m`（500 m，DEMO），不新增参数。
- 映射入口：`modules/fusion/ingest/InboxSourceRouter` 按 `source` 前缀分派 `FrameMapper`：`replay:`（现有解析迁出为 `ReplayFrameMapper`）、`lingyun:`（`LingyunSenseDataMapper`）、`eo-edge:`（`EoTrackingReportMapper`）、`live-radar:`（`LiveRadarFrameMapper`）；`FusionInboxRepository.claim` 白名单同四个前缀。
- `class_source` 取值：`SENSE_DATA`（协议 A objectType）、`EO_TRACKING`（协议 C aiStatus）、`RADAR`（雷达分类码）、`MANUAL`（人工修订）。
- C02-6：`TargetState.pilot*` 存在 → 目标与飞手位置大圆距离 > `C02-6.vlos_m` → FAIL `BVLOS_EXCEEDED`，≤ → PASS；不存在 → UNDETERMINED `PILOT_POSITION_UNAVAILABLE`（不变）。
- 高度：凌云来源 `altitude` 只落 `quality.altitude_raw`，`quality.altitude_datum=REFERENCE_UNKNOWN`，`altitude_amsl_m` 留空（决策 8.5-24）；`height` → `height_agl_m` + `quality.height_datum=DEVICE_GROUND`。
- 协议 C：`external_target_id` 与 `source_session_key` 同取 `taskId`（8.5-20）；未映射事件返回空帧、inbox DONE（8.5-22）。协议 A 帧级 `observed_at` 取首个对象 `time`（8.5-21）。
