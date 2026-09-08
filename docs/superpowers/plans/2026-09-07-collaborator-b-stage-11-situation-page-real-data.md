# 阶段 11：融合感知页接真实数据（2026-09-07）

## 背景
`SituationPage.vue`（364 行）自合并 `b9265a3` 起整页读 `window.MOCK`（`public/assets/js/mock.js`）：目标、空域、设备点位、告警、图层字典全是演示数据；用户 2026-09-07 确认后要求"按原工作模式开一个阶段，把融合感知页接真实数据"。后端读接口已齐：`targetApi.list/detail/tracks/points(+All)`、`airspaceApi.list/detail/version`（boundary 为 GeoJSON MultiPolygon）、`deviceApi.list`（`longitude/latitude`、状态）、`alarmApi.listAlarms`（`target_id/severity/state`）、`legalityApi.listEvaluations(latest_only=true, mode=ACTIVE)`、`GET /fusion/status`。`git show 150dfa6:dongying-vue/src/pages/SituationPage.vue`（583 行）是曾经接过 `targetApi` 的版本，可作数据装配的参考。`map.js` 已支持轨迹点 `kind`、`posValid=false` 方位线、`layerKey`、精度圈。

## 不变量
- 保留当前 HUD 布局与 DOM（`sit-stage / sit-hud-alarms / sit-fuse-dock / 悬浮卡`），只换数据源；样式不重做。
- 本页删除全部 `window.MOCK` 依赖；`mock.js` 本身不删（其它 legacy 页面仍在用），`map.js` 里 `window.MOCK.airspaceType` 的兜底路径保留但本页不依赖它。
- 未知不补默认值：目标没有合法性研判 → "待确认"；没有位置（AOA）→ 只在列表出现、地图不画点；没有后端能力的按钮（实时视频）→ 禁用并标"未接入"。
- 文案走共享字典（`labels.js`），`check-ui-text.sh` 零新增命中；`node tools/scan.cjs`、`falsify.cjs`、`npm run build` 通过。
- 不改协作者 A 的文件；不改后端（如发现读接口缺字段，先报领导，不自行加）。

## 数据装配（`src/services/situationData.js`，纯函数，可单测）
| 地图/HUD 需要 | 来源接口 | 映射 |
| --- | --- | --- |
| `airspaces[]{id,name,type,color,poly,alt}` | `airspaceApi.list` + 当前版本 `boundary`（MultiPolygon 取每个外环；孔洞本期忽略并记 TODO） | `kind_code` → 类型/图层：PROHIBITED→禁飞(nofly)、RESTRICTED/TEMPORARY_CONTROL→限制(limit)、ALTITUDE_LIMIT→限高(limit)、PERMITTED→适飞(suit)；颜色沿用 `AIRSPACE_TYPES` 同名项 |
| `devices[]{id,name,lon,lat,status,alarm}` | `deviceApi.list`（分页取全） | 无经纬度不画；状态字典走 labels |
| `targets[]{id,no,type,legal,risk,lon,lat,alt,speed,heading,source,track[],posValid,fusion}` | `targetApi.listAll` + 选中目标 `detail/tracksAll/pointsAll`；`legalityApi.listEvaluations({latest_only:true,mode:'ACTIVE'})` 给 `legal`；`GET /fusion/status` 给来源在线态 | 位置缺失 → `posValid=false`；`fusion_confidence`/`degradation` 进融合面板；类别走 `OBJECT_TYPE_LABEL`、来源走 `SOURCE_TYPE_LABEL`、DEMO 标注走 `SCHEMA_STATUS_LABEL` |
| `alarms[]{id,targetId,level,title,time,state}` | `alarmApi.listAlarms({state:...})` 未关闭状态 | severity → level 字典 |
| 图层控制 | 本地常量（与 `AIRSPACE_TYPES` 同名同色），不再读 MOCK | — |
刷新：目标与告警 5 s 轮询（页面卸载清理），空域与设备进入页面加载一次 + 每 60 s。

## 任务与会话
| 任务 | 会话 | 独占文件 | 先写的测试 |
| --- | --- | --- | --- |
| 11.1 数据装配 + 页面接线 | Session 1（E1） | `src/services/situationData.js`（新）、`src/pages/SituationPage.vue`、`src/services/targetApi.js`（只加 `fusionStatus`）、`src/services/legalityApi.js`（若缺 `listEvaluations` 只加）、`tools/` 下若需新增 node 单测入口 | `tools/situationData.test.cjs`（node 直接跑，无框架）：空域 MultiPolygon→poly、kind→图层、无位置目标 `posValid=false`、无研判→待确认、告警等级字典；页面：build/scan/falsify/check-ui-text |
| 11.2 验收（浏览器） | 领导 | `docs/backend-stage11/acceptance.md` | 在 `uav_stage10_verify` 上：目标列表与地图一目标一次、tdoa-pilot 目标详情、AOA 目标不画点、空域五值图层、设备点位、告警栏、断后端无 Mock 回退、三视口 |
| 审查 | Session 4 | `review-log.md` | — |

## 决策（自动，记 `docs/backend-stage11/decisions.md`）
11-1 本页只换数据源不改布局；11-2 MultiPolygon 只取外环、孔洞记 TODO；11-3 无研判目标标"待确认"而非"合法"；11-4 "实时视频"禁用并标"未接入"；11-5 轮询 5 s / 60 s；11-6 图层字典本地常量与 `AIRSPACE_TYPES` 同名同色。
