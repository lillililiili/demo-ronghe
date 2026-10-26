# K03 未来位置预测与入区预警前端约定

日期：2026-10-20；2026-10-21 更新融合感知实时展示口径。本文记录业务前台约定与验证边界，后端事实及守卫仍由平台唯一后端负责。既有接口基线见 [融合接口契约](backend-stage8/fusion-api-contract.md)；平台对应文档见 [后台仓库融合接口契约](../../houtaiguanli/docs/backend-stage8/fusion-api-contract.md)。

## 业务入口

融合感知增加“未来预测”开关与“预测预警”页签。全图显示当前有效预警的预计入区菱形，接近的屏幕标记可合并计数；点击聚合标记定位到完整预测清单。选中目标才展示预测虚线、空心点、方向箭头及 +10／20／30 秒标签。地图聚合不改变任何坐标，不截断后端分页；预警列表、地图标记及数量统一只纳入 `ACTIVE` 预警且其预测为 `READY`、未过 `valid_until` 的事项。

预测详情显示实测基准、生成及失效时间、方向、速度、未来三个位置及高度、位置不确定范围、命中空域版本和来源。时间使用北京时间，三个时长以 `generated_at` 为基准。实测依据单列为 `based_on_observed_at`。高度有 AMSL／AGL 时分别注明海拔／离地；未知基准如实显示。默认误差范围、模型误差均不是命中准确率或已校准置信概率。

预测数据放入独立 `predictions` 图层，绝不追加到 `target.track`；已飞轨迹、证据回放、报备航线和历史丢点预测保持其原语义。

2026-10-21 用户确认：融合感知只显示当前有效预测。未知、失效或查询失败时，相关旧缓存退出本页实时清单、数量、地图图形和未来位置面板；若对应预测详情正被选中则一并收起。此条明确替代旧“未知事项继续留在本页预测列表”的约定，只改变本页展示，后端风险周期与告警历史继续保留。

## 状态与办理

| 预测／预警状态 | 页面展示 | 当前预测地图／清单 |
| --- | --- | --- |
| 稳定性尚未达到，预测 READY 且未过期 | 当前有效预测依据 | 选中目标可看未来位置，不进入正式预警列表或预警数量 |
| ACTIVE，且预测 READY、未过期 | 预测入区预警 | 显示预计入区点，进入实时清单及数量 |
| UNKNOWN、其他非 READY 结果，或预测过期／读取失败 | 本页不展示旧预测；告警事件仍可查询 | 退出实时清单、数量、图形和未来位置面板，收起对应已选详情；不认定已解除 |
| WITHDRAWN | 预测已撤销 | 退出当前清单；告警历史保留撤销事实与新实测依据 |
| ENTERED | 已进入（实测） | 退出预测当前清单；后端实测告警承接，预测历史保留 |

撤销、确认进入、告警创建和稳定性门槛均由后端判断。页面不以时间流逝、没有目标、没有返回点或一次读取失败推导撤销，也不把预测入区当作实测违规事实。退出本页展示不撤销后端风险周期、不删除冻结依据和历史，告警查询、处置及原有权限和证据守卫保持。

告警事件增加“告警类别”和“预测状态”筛选，交集保留原等级、原因、时间和目标条件；2026-10-21 已移除区域筛选。导出复用同一查询。目标深链会清除预测筛选，避免挡住指定事件。预测告警详情按同一事件展示当前预测。

2026-10-22 用户确认：告警事件和融合感知无人机预警卡片移除“算法与规则版本”“查看首次预警的冻结依据”“预测生命周期记录”，以及“查看预测预警与办理进度”专用入口和相关跳转提示。当前预测位置、预警原因与既有核实、处置操作保留；后端首次冻结快照、生命周期及历史数据不删除，核实和动作守卫继续使用原证据。

人工核实明确核实的是预测风险，提交当次预测快照标识和事件版本。短信、电话、反制仍读取后端资格及允许动作，不通过前端文案或按钮绕过证据、来源、权限、设备、有效期和幂等守卫。

## 接口契约

- `GET /api/v1/predictions/current?page&size`：完整分页读取；无目标读取权限时不请求或清空旧预测。
- `GET /api/v1/targets/{target_id}/prediction`：选择目标时读取，拒绝目标不匹配响应。
- 预测对象：`prediction_id,target_id,target_no,version,status,based_on_observed_at,generated_at,valid_until,source_mode,simulated,anchor,points,heading_deg,speed_mps,reason_codes,model_version,rule_version`。
- `points` 含 `horizon_seconds,predicted_at,location,altitude_m,altitude_datum,uncertainty_m`；缺失位置不默认 `(0,0)`，三个时长不完整时不补线。
- 同目标多区使用 `warnings[]`；`warning` 是最近摘要或告警所对应事件。每项含 `alarm_id,event_id,state,version,airspace_id,airspace_name,airspace_version_id,airspace_version_ids,entry_at,entry_location`。空域多版本和预警状态版本均保留。
- `proximity[]` 为尚未形成正式预警的接近提示，选中目标有效预测显示 `CONFIRMING`（稳定性确认中）／`POSSIBLE`（可能接近，暂不能确认），同区已有正式 warning 时不重复；不生成告警入口或动作。预测未知／过期／请求失败后隐藏旧接近提示。
- 告警 `origin_kind=PREDICTED_AIRSPACE_ENTRY`，筛选使用 `origin_kind,prediction_status`。`prediction` 为当前结果，`prediction_snapshot` 为首次不可变快照；`prediction_history` 保留 `history_id,episode_id,prediction_id,version,state,reason,created_at`。
- 核实沿用事件核实接口，追加 `prediction_id`；保留 `expected_version` 与原幂等键。优先使用重新读取事件中的 `verification_basis.prediction_id`。
- `prediction` SSE 通知只触发读取；目标及告警变化也可刷新预测。页面隐藏时暂停，重新可见时补读，失效图形由每秒的平台时间更新撤下。

## 验证边界

权限刷新先清空预测缓存；分页 403 清空并停止重复读取；单目标 403 清空旧范围后重新读取当前分页。请求失败或目标错配撤下相关旧预测，失效响应不得继续计入本页实时清单、数量或未来位置面板；旧访问代次的在途响应不能覆盖新权限结果。此展示清理不修改后端事项状态。

前端行为回归应覆盖不同编号／位置及真实／模拟来源、多区预警、完整分页、ACTIVE／READY／时效联合筛选、读取失败与未知退出列表和计数、对应详情收起、权限清空、终态与历史边界、独立地图层、聚合不改坐标、冻结依据、筛选交集及核实版本。本次文档更新不代表这些回归或浏览器验收已经执行。

命令在 `dongying-vue/` 执行：

```text
node --test tools/situationSetup.test.mjs tools/predictionView.test.mjs tools/uavVerificationBasis.test.cjs tools/alarmLinkedFilters.test.cjs tools/alarmPagination.test.cjs
node tools/situationApiContract.test.cjs
node tools/situationData.test.cjs
node tools/situationRiskSelection.test.cjs
node --check public/assets/js/map.js
npm run build
```

这些检查不代表实际浏览器流程、通知通道、反制设备或真实算法准确率验收。统一启动当前前后端后仍须执行后台 `scripts/check-local-startup.mjs --business-dir <业务前台绝对路径>`，并单独记录真实登录、地图交互、预测创建／未知／撤销／实测进入及核实办理结果。保持 `app.dev-seed.enabled=false`，不得通过恢复演示种子补齐页面。

## 2026-10-22 实时地图提醒与模拟航线

- 新的当前有效预测预警首次出现时，自动展开右上角“实时风险”并切到“预测预警”。按事件标识记忆本次页面会话已提醒事项，同一事件重算、短暂未知后恢复或用户切换页签，不重复抢占视图；新风险周期仍会提醒。未知、过期、已撤销和已实际入区的记录不触发这一提醒，且不自动核实或启动处置。
- 任务航线列表使用 `exclude_retired_simulation=true`，后台按已登记模拟批次、单位和区域排除退出当前批次的旧任务，再执行计数与分页。真实及未登记模拟批次的资料保持原查询规则；历史任务、轨迹和航线版本保留，不按名称或几何形状过滤。