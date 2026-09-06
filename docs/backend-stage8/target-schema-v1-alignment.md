# 阶段 6.5 Schema 对齐关卡：Target Schema V1 与设备资料对照

> 状态：2026-09-06 领导冻结。`设备资料/` 只有雷达（T02 v3.0.0 协议、两份规格书）与反制文档，**没有 5G-A、TDOA/AOA、光电资料**。按用户决定，本关卡只对齐雷达；其余三路以 Demo 字段建模，`source_type_catalog.schema_status=DEMO`，页面与文档必须标"演示字段 / 待确认"。资料到位后只改映射层（`SourceObservation` 适配），不改融合算法与表结构。

## 1. 来源类型目录

| source_type | schema_status | 资料依据 | 位置 | 精度 | 类别 | 身份线索 | 高度基准 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RADAR | CONFIRMED | `低空监视雷达网络通信协议_v3.0.0`（已接入 `RadarV300PayloadDecoder`） | 雷达体坐标 `x/y/z_m` → 经站址 RTK（`Rtk.latitudeDeg/longitudeDeg/headingDeg`）换算 WGS-84；已接入代码给出 `longitude_deg/latitude_deg` | 协议无精度字段 → Demo 缺省 15 m（`filter.accuracy_default_m.RADAR`） | `classification 0–5`（待识别/人/车辆/无人机/鸟/未识别），**无类别置信度** | 无 | `z_m` 为雷达站相对高度，站址高程未知 → AGL/AMSL 均不可判定，记 `NOT_REPORTED` |
| EO（光电） | DEMO | 无资料 | Demo：WGS-84 点（若给出） | Demo 25 m | Demo：`class_code + class_confidence [0,1]` | 无 | Demo：AMSL |
| TDOA | DEMO | 无资料 | Demo：WGS-84 点 | Demo 60 m | 无 | Demo：`identity_clue`（射频指纹/遥控器标识） | 无 |
| FIVE_G_A | DEMO | 无资料 | Demo：可选 WGS-84 点 | Demo 80 m | 无 | Demo：`identity_clue`（小区/终端标识） | 无 |
| FUSION_BOX | DEMO | 无资料（融合感知箱输出格式未见） | Demo：WGS-84 点 | Demo 20 m | Demo 可选 | 无 | Demo：AMSL |

## 2. Target Schema V1 字段对照

| V1 字段（`target` / `target_latest_state` / `track_point`） | 雷达 T02 来源 | 换算 / 判定 | Demo 三路 |
| --- | --- | --- | --- |
| `target_no` | 平台生成 | 融合层分配统一编号（B02） | 同 |
| `object_type_code` | `classification`→{0 UNKNOWN,1 PERSON,2 VEHICLE,3 UAV,4 BIRD,5 UNKNOWN} | 雷达类别不带置信度，`classification_confidence` 保持 `NOT_REPORTED` | EO 提供类别与置信度；TDOA/5G-A 无 |
| `location` (POINT 4326) | `x/y/z_m` + 站址 RTK | 无站址 RTK → 位置 `REFERENCE_UNKNOWN`，不补 (0,0) | 直接 WGS-84 |
| `position_accuracy_m`（新增于 `source_observation`/`track_point`） | 无 | 取目录缺省值并在页面标 DEMO | 各自缺省 |
| `altitude_amsl_m` / `height_agl_m` | `z_m`（相对站址） | 站址高程与地形基准未知 → 两者皆 `REFERENCE_UNKNOWN` | EO/融合箱 Demo 给 AMSL；不互推 |
| `speed_mps` / `heading_deg` | `velocity_x/y/z_mps` → 水平速度与航向（需 `northFlag`/站址航向） | 缺站址航向 → 航向 `REFERENCE_UNKNOWN` | 同源提供或由滤波推导（标 DERIVED） |
| `observed_at` / `received_at` | `radarBootMicros + 帧时间` / 平台接收 | 开机微秒相对时钟，需帧时间对齐；本期回放数据集直接给 epoch | 同 |
| `source_session_key` / `external_target_id` / `external_track_id` | `deviceId:bootMicros` / `externalTrackId` | 与 `ops_target_source_link` 一致 | 数据集 / 来源目标号 |
| `classification_confidence` | 无 | `NOT_REPORTED` | EO 有 |
| `fusion_confidence` | 平台计算 | `1 − confidence_deficit`（B05） | 同 |
| `unknown_fields` | 平台计算 | 每个缺失字段带原因码（`NOT_REPORTED / REFERENCE_UNKNOWN / DERIVED`…） | 同 |
| 质量：`snr_db`、`rcs_*`、`latency_ms` | `snrDb`、`legacyRcsM2/highResolutionRcsM2` | 进 `source_observation.quality` JSONB，参与异常源降权 | Demo：`latency_ms` |

## 3. 待确认清单（资料到位即问）

1. 内部统一坐标系与高程基准：雷达 `z_m` 的站址高程/基准；各源 AGL/AMSL 声明与换算依据。
2. 5G-A、TDOA 的目标 ID 生命周期、精度字段含义、上报频率、身份线索字段与语义。
3. 光电分类字段、置信度语义、分类置信度门限。
4. B03 正式权重、异常源降权、无数据降级策略（当前 `fusion_config demo-v1` 全部 DEMO）。
5. 是否允许跨组织/区域关联（本期 `fusion_domain=(source_mode, owner_org_id, district_id)` 内关联）。
6. 融合感知箱输出格式（若存在），以及它与平台融合的分工。
7. 实测雷达 ops 模型 → 统一目标库的提升（本阶段不做，见契约与 `decisions.md` 8-1）。

## 4. 给 A 的回放场景需求（阶段 8 自建生成器已覆盖）

同目标三路可见、单路缺失（TDOA 20 s 空窗）、交叉、分裂/合并、迟到乱序、精度差异；信封沿用 `docs/backend-stage1/t02-replay-contract.md`（`replay:<source_code>:<dataset_id>`、`record_no`、`payload_hash`）。若 A 后续提供真实回放数据集，替换生成器输出即可，字段以 §2 为准。
