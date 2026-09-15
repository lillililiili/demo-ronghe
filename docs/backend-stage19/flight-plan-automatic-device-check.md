# 飞行计划自动设备检查（2026-09-14 最新口径）

> 2026-09-15 仓库归属：本文后端 `server/` 路径指同级 `../houtaiguanli/server/`；历史验证记录保留原日期。迁入后台后的迁移版本与验证结果以后台 `docs/新后端迁移记录.md` 为准。

## 起飞前检查补充（2026-09-14）

最新补充取代下文“未到时间隐藏”和“只展开异常设备”的描述：待执行计划在详情中显示起飞前设备检查，按同一航线 5 公里范围读取设备当前状态和仍未关闭的告警。检查结果新增只读结论 `PREFLIGHT_DEVICE_NORMAL`、`PREFLIGHT_DEVICE_ABNORMAL`；信息不足仍为 `CHECK_INCOMPLETE`。这些结论不写入起飞核实记录，POST automatic 仍拒绝未来计划。设备列表展示正常、故障、离线及未知状态，异常优先，地图仍只突出异常设备。

指定补充批次的数据由 `LocalFlightPlanEnrichmentSeeder` 追加：local 且开发种子开启，并显式设置 `app.dev-seed.flight-enrichment-prefix=seed-refill-YYMMDD-HHMMSS` 才执行。给该批次 1–5 号待执行计划各加一条模拟气象风险与范围，给 6 号执行中计划加 21 个模拟轨迹点并由既有规则引擎计算匹配。重复运行保留已有风险、轨迹与办理记录；不移动计划时间。只支持本地 PostgreSQL/PostGIS 演示环境。

已有演示库更新时可带 `--preserve-existing-flight-demos`，跳过旧计划浮动时间刷新与旧轨迹场景补种，保留历史。此开关用于已有完整演示库，不用于首次初始化。

## 后续部署与 MQTT 模拟（已完成）

用户反馈“资源不存在”后确认运行进程仍使用 04:48 的旧 JAR，未包含 device-check 接口。已用 `./mvnw -Dmaven.test.skip=true package` 跳过测试编译和执行，部署新 JAR、应用 V202609140002，并重启本项目后台。启动与迁移日志成功；未做浏览器或业务流程测试。此节替代下文此前“未部署”状态。

新增 LocalFlightDeviceMqttSeeder.run 幂等登记独立 broker 与 FP-CHECK-R1/T1/I1/R2；simulate_flight_check_mqtt.py 的 main 通过真实 MQTT 链路持续发布模拟工参，独立于既有 S85 保活。R1 workState=2 表示故障，T1 每 90 秒上报形成间歇离线，I1/R2 每 5 秒报正常。没有手工更新设备状态表、没有发送探测目标报文。

FlightDeviceCheckService.read 在 local、开发种子启用和 `app.flight-device-check.mqtt-demo-enabled=true` 时，仅对 mock 计划选择这些带模拟标记的专用 replay 设备，结果返回 mqtt_simulation=true；其他来源沿用原隔离规则，production 永不启用此替代。inspect 按凌云协议 A 的工作状态识别设备故障；不把协议 C 的状态 2 当故障。FlightVerificationService.automatic 将 MQTT 模拟来源写入通知依据。PlanDeviceCheck 模板显示“MQTT 模拟数据”和“设备故障”，保留原监测跳转。

可自行查看：计划-0905-001（演示航线合法样例）附近为异常场景；计划-0905-004（跨范围样例）附近为正常场景。后台启动、模拟器运行、报文入库及迁移状态已核对，不等同页面验收。最终后端日志 `/private/tmp/dongying-backend-runtime/backend-device-check-final.log`，模拟器日志 `mqtt-flight-check.log`（同目录）；PID 文件在同目录。

本节取代此前“值班员填写未起飞/设备异常结论、依据、说明”的办理方式。以前的人工结论及通知保留原样，不改写历史。这里只交付源码：按用户要求不测试、不构建、不做浏览器验收；本次新迁移尚未应用，运行中的后端尚未更新。

## 页面与流程

到计划开始时间但未找到飞机 → 自动检查附近设备 → 同页显示异常设备及告警 → 值班员点“通知报送单位确认” → 服务端重新检查并保存结果 → 提交来源通知 → 同一记录显示送达、回执、处理结果。

- 设备异常由系统生成，不再提供人工选择结论、填写设备依据的表单。已有记录中的“更多操作”改为“重新检查并通知”。旧核实人的标识保留，新自动记录显示提交人。
- 页面只展开异常设备，列名称、距离、在线/故障状态、状态上报时间、计划时段告警原因和起止时间；“打开设备监测页”仍保留。
- 检查完整且附近有设备、没有异常时显示“附近无异常设备，疑似未按计划起飞，待报送单位确认”。没有附近设备、坐标缺失、状态未知、历史未读全都不能当作“附近无异常”。请求失败显示错误，不自动生成正常结论。
- 设备当前异常和计划时段告警分别展示；当前异常不能反推它在过去计划时段也异常。无告警时明确异常开始时间不明。
- 未到时间、取消、已匹配飞机且无历史的计划不显示此办理块。有历史则保留，已保存未提交通知可继续通知；已提交的通知不重复创建，未新增渠道重投/真实回执能力。
- 每 30 秒只读刷新，卸载清理。状态更新中或读取失败暂停新检查提交，通知时服务端再次读取。保存与通知是两个持久化步骤，一次点击依次完成；通知失败不丢失已保存结果。

## 范围与事实边界

默认按航线中心线周边 5000 米，配置为 `app.flight-device-check.nearby-meters`，环境变量 `FLIGHT_DEVICE_CHECK_NEARBY_METERS`；这是暂定筛选距离，尚未收到用户距离选择，不代表实际覆盖能力。页面显示当前范围。

通过现有授权后的设备服务和计划钉住的航线版本，复用 PostGIS geography 米制距离，取消区县名称硬匹配；跨区县仍按距离筛选。设备类型先统一大小写，兼容台账既有 radar/oe/5ga 等值。模拟、回放、真实来源模式仍严格隔离，缺坐标/非 WGS-84 不估算位置。未定位设备会使检查不完整；没有选到设备不能证明没有设备故障。

服务端最多读取 2000 台设备与每台 2000 条告警；超限明确不完整。没有覆盖绑定、没有完整历史正常状态或真实起飞回执，都不产生“已确认未起飞”，所有自动结果的 takeoff_status 为 UNKNOWN。不写计划执行状态，不自动创建处置告警。

## 接口与存储

路径前缀 `/api/v1/flight-plans/{planId}/verifications`。

| 接口 | 说明 |
| --- | --- |
| GET /device-check | 只读自动检查；计划/航线权限与设备权限沿用各应用服务，返回 message、conclusion、checked_at、nearby_meters、complete、unchecked_locations、rows |
| POST /automatic | 只接受 expected_revision；需要原 flight:verify 权限及幂等键，服务端收集设备事实、生成结论/依据/说明并追加记录，拒绝使用客户端自行认定的故障或起飞结论 |
| POST 根路径（旧人工提交） | 返回 409 MANUAL_VERIFICATION_DISABLED；旧记录继续可读 |
| POST /feedback | 沿用最新记录、来源接收方、权限、幂等与唯一记录规则；UI 自动串联提交 |

新增自动结论 AUTO_DEVICE_ABNORMAL、SUSPECTED_NOT_TAKEN_OFF、CHECK_INCOMPLETE。V202609140002 Java 迁移按 H2/PostgreSQL 当前表约束定义扩展结论与起飞一致性约束，不修改已应用的 V202609140001，不修改历史数据。新的来源通知材料继续引用完整检查记录。

旧 FlightVerificationApiTest 等用例针对旧人工提交契约；本轮未更新或运行测试，不能声称旧用例验证了新接口。

## 代码变更说明

| 文件/类 | 方法/块 | 作用 |
| --- | --- | --- |
| FlightDeviceCheckService | read / inspect / positionKnown | 按地理距离筛选设备，读取现有状态与时段告警，生成系统检查结果 |
| FlightVerificationService | deviceCheck / automatic / verify / displayTime / deviceLabel | 禁用新增人工判断；重新检查、生成中文依据并追加历史 |
| FlightVerificationController / FlightVerificationDtos | check / automatic / AutomaticRequest | 新增只读与保存接口，不接收人工结论 |
| V202609140002__flight_automatic_check | migrate | 扩展枚举和一致性约束，保留历史 |
| application.yml | 无具体方法 | 附近范围配置 |
| flightApi.js / planDeviceCheck.js | deviceCheck / automaticCheck / checkPlanDevices | 接新接口，移除前端区县与类型过滤 |
| PlanDeviceCheck.vue | reload / abnormalRows / 模板 | 同页只展示异常设备，保留刷新和页面跳转 |
| PlanVerificationPanel.vue | verify / feedback / isAutomatic / 模板 | 移除人工表单，一次点击保存系统结果并通知，保留失败恢复和历史 |
