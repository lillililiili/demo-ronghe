# 前后台后端接通实施总计划

> 执行方式：按 `superpowers:executing-plans` 逐包推进，每包独立验证；本计划不要求新建分支、工作树或启用并行代理。涉及外部协议的工作包，取得该包列出的接入资料后再编写协议级实现步骤。

**Goal：** 补齐已确认业务中的前后台接口断点，接入真实数据与通知、视频、设备通道，并分别交付代码验证、模拟联调和真实通道验收证据。

**Architecture：** 业务前台 `dongying-vue`、管理端 `ruoyi-ui` 共用 `houtaiguanli/server` 和同一业务数据库。自动任务在后端运行；页面只读取状态及提交明确的人工动作。外部接入复用现有适配边界，真实模式失败不回退模拟。

**Tech Stack：** 保持现有 Vue 3、JavaScript、Naive UI／Element Plus、Java 17、Spring Boot、MyBatis、PostgreSQL/PostGIS、Flyway、MQTT／TCP，不预先引入新依赖。

**文档状态：** 2026-09-22 接通总计划，尚未执行。依据本轮源码与本地开发库审计；数据库状态是检查时快照，执行前重新读取。用户本轮要求列计划，不据此开启真实通知、反制设备或修改业务数据库。

## 1. 范围与成功标准

- 只在两个仓库的本地 `main` 工作，保留已有修改、删除与历史记录，不批量暂存或提交其他任务的改动。
- 保留 `/api/v1`、数据库 Bearer 会话、snake_case、`{ok,data,error}`、字符串 ID、幂等键及版本校验。
- 不扩展页面模块、风险类型、接收方分发规则或自动反制范围。风险通知统一“通知上级”；反制仍由人工发起。
- 新增 Flyway 迁移时根据执行时两个仓库的最新版本分配编号，不修改已应用脚本。
- 自动移送、通知发送、签收回执、反制执行和处罚办结分别保存事实，不互相代替。
- 真实供应商／设备协议未明确时，只完成公共接口与不可用状态；不得以假定字段完成所谓真实适配。
- “接口接通”须有前后台请求与后端持久化证据；“业务闭环”须包含失败、重试、并发与重启；“真实接通”须有实际来源和可信回执／画面／观测，三者分别验收。
- 本次总计划分成以下独立工作包。资料齐备的包可以先做，不让所有开发等待最后一个厂商；每包完成后再进入其后续步骤。

## 2. 执行顺序

| 顺序 | 工作包 | 交付结果 | 主要依赖 |
| --- | --- | --- | --- |
| 0 | 基线与契约确认 | 当前缺口、部署版本、数据口径和测试基线 | 本地两个仓库与隔离测试库 |
| 1 | 内部业务断点 | 自动处罚移送、人工执行通道关闭、核实结果一致 | 包 0；现有移送条件与自动任务身份 |
| 2 | 运行统计接业务事实 | 统计、列表、导出可按同一口径核对 | 包 0；现有指标口径逐项确认 |
| 3 | 当前目标实时视频 | 四处已有视频入口可读同一目标的真实画面 | 视频源、鉴权、目标到视频的关联契约 |
| 4 | 外部飞行计划 | 来源系统计划进入现有计划和研判链 | 计划输入协议与测试来源 |
| 5 | 天气预报／传感器 | 真实预报和传感器现有展示范围内的数据读取 | 各自供应商、设备协议；两者独立接入 |
| 6 | 短信、电话、上级与处罚通知 | 分渠道真实投递、回执和失败处理 | 通道资料、接收关系与测试授权 |
| 7 | 现场设备联调 | 已有设备适配与现场设备逐项核验 | 设备、网络、协议与受控动作授权 |
| 8 | 发布与全链验收 | 两套前端同库运行、历史保留、可回滚发布 | 所发布工作包各自通过验收 |

建议先完成包 0、1；包 2 核对口径后推进；同时收齐包 3—7 的资料。没有实际协议与联调窗口前，不承诺全部真实接通的固定日期。

## 3. 包 0：基线、接口与数据口径

**产出：** 一份按页面登记的接口清单，至少记录请求、响应关键字段、动作权限、数据范围、运行版本、来源模式和验收证据。

- [ ] 重新读取两级 AGENTS、后台 AGENTS、README 和当前 Git 状态；确认前后台代理与服务连接的是同一数据库。记录正在运行的构建版本，避免源码已改而运行服务未更新。
- [ ] 对计划、告警、研判、证据、移送、统计、设备、规则和通知配置做授权账号只读抽查；分别记录 404、权限不足、服务失败、无数据和未配置，不能统一归为“没接”。
- [ ] 复核上一轮的 `auto_handoff`、视频流、计划输入、天气、通知和设备模拟标记。旧文档中写“未接入”但源码已完成的项目从缺口中剔除。
- [ ] 核对 2026-09-22 新要求：合法性 `has_alarm` 筛选已存在服务端实现，重点验证实际关联、分页和统计；融合感知读取北京时间当天全部目标，地图和计数同源。
- [ ] 建立隔离 PostgreSQL/PostGIS 测试库并验证迁移历史；需要追加演示场景时先按项目规范确定批次、备份和停止条件，不改旧时间、不伪造成功结果。

**通过条件：** 每个缺口可定位到页面、接口、后端责任模块及可复现现象；空列表和没接通有明确区分。

## 4. 包 1：补齐内部业务断点

### 1A. 后端自动处罚移送

**现有文件：**

- `../houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/handoff/application/HandoffSubmissionService.java`
- `../houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/handoff/application/HandoffMaterialAssembler.java`
- `../houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/alarm/application/UavAdvisoryService.java`
- `../houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/alarm/api/UavAdvisoryDtos.java`
- `dongying-vue/src/components/disposal/UavAdvisoryPanel.vue`

**拟新增：** 后端 handoff 模块中的自动移送资格服务、持久任务仓储和调度器，以及任务迁移、API／PostgreSQL 测试。与现有提交用例共享资格和材料装配，不复制整套交接状态机。

- [ ] 先将现有移送资格整理成判定表：触发事件、研判依据、有效时间、材料要求、接收方、范围和既有交接。检查当前执行代码，不恢复旧文档中的前置条件；不擅自增加“必须反制成功”或“必须人工核实”。需要改变资格的事项单独列为业务决定。
- [ ] 明确后台自动执行身份、允许范围、启停策略和审计归属；调度器不冒用值班员会话，不伪造人工提交人。
- [ ] 资格成立时由后端建立持久任务，自动汇集并冻结材料、建立交接；同一事件已有交接则关联原记录。建立并发唯一保护和稳定幂等键，关闭页面、服务重启和重复调度不重复移送。
- [ ] 扩展 advisory 响应的 `auto_handoff`，至少定义 `status`、`reason`、`handoff_id`、`trigger_source` 及更新时间；与前台现有读取保持兼容。最终状态枚举在接口文档中固定，缺字段继续显示不可用。
- [ ] 移送资格不足、材料缺失、无接收方和任务失败分别记录原因；历史交接与冻结材料不回填。移送与外部投递拆开保存状态，通道失败不能抹掉已生成交接。
- [ ] 增加测试：同事件双任务并发、重启续跑、已有人工交接、条件变化、事务回滚、材料冻结、任务身份越权、GET 不写入。执行原有 Handoff API／材料／通知／PostgreSQL 测试。

**通过条件：** 页面关闭时符合资格的测试事件仍只生成一份交接；告警和移送页定位同一交接；不符合资格有原因，失败不伪装成功；不自动作出处罚决定。

### 1B. 服务端关闭新的人工执行通道

**文件：** 后端 `modules/disposal/application/DisposalAuthorizationService.java`、`modules/disposal/api/DisposalController.java`；测试 `DisposalAuthorizationApiTest`、`DisposalExecutionTest`、`DirectDisposalApiTest`。

- [ ] 验证并拒绝新建 `MANUAL` 反制、执行旧人工授权以及通过 `manual-result` 新写执行成功／失败；保留历史查询。使用现有错误契约，不只依赖前端隐藏入口。
- [ ] 回归普通设备反制、直接反制、撤销、急停及急停后现场停机核查；不得把停机核查一起关闭。
- [ ] 同步两套前端说明和契约，保留旧历史事实。

**通过条件：** 即使直接调用 API 也不能新造人工执行结果；设备执行和急停流程继续有效。

### 1C. 核实结果与当天目标查询的跨页一致性

**文件：** `dongying-vue/src/pages/LegalityPage.vue`、`AlarmsPage.vue`、`src/pages/situation/situationApiSource.js`；后端 `modules/alarm/application/UavEventVerificationService.java`、`modules/assessment/application/LegalityReviewService.java`、`modules/assessment/infrastructure/LegalityEvaluationReadRepository.java`。

- [ ] 核对同一研判的实际告警关联：需要复核且有关联告警时在告警页办理，无关联告警才在合法性页办理；可靠明确结论不强制复核。
- [ ] 先验证现有共享结果，确有重复或不同步再修复；告警事实确认与合法性结论纠错仍区分，不能机械地把“告警已确认”映射为“非法”。
- [ ] 验证 `has_alarm` 与其他筛选交集、分页、统计、深链及无权限／查询失败情形；保留已完成的当天目标范围修改并测试北京时间跨零点。

**通过条件：** 同一研判无需两页重复核实；历史无关告警不干扰分流；当天旧观测仍显示末次时间和原状态，不冒充实时跟踪。

## 5. 包 2：运行统计改接现有业务事实

**文件：** `dongying-vue/src/services/statsApi.js`、`src/pages/StatsPage.vue`；后端 `modules/reporting/application/ReportingService.java`、`BusinessReportingService.java`、`infrastructure/ReportingRepository.java`、`platform/report/ReportDatasetReader.java`；管理端 `ruoyi-ui/src/api/reports.js`。

- [ ] 为现有每个指标建立映射：业务实体、去重键、时间字段、状态、权限范围、来源模式和单位。不直接用两张不同业务表的 COUNT 替换旧样本数。
- [ ] 区分 `/stats/operations` 的旧样本数据与管理端现有业务报表读取路径；已有真实业务聚合优先复用，不重复建设。
- [ ] 能保持业务定义的指标切换到同源聚合；缺少轨迹时长、距离、高度或处罚结果依据时返回明确不可用，不计算虚构数值。会改变统计口径的指标在实施前形成可审阅对照表，再确定切换方式。
- [ ] 页面和 CSV／XLSX／PDF 的适用出口使用同一范围；保留旧样本及历史导出，不删除表、不回写样本冒充真实事实。
- [ ] 用同一隔离批次验证一个目标多条观测、多条告警、多个通知和一次处罚各自只按指标定义计数；验证区间边界、权限隔离和刷新后的差额。

**测试：** `ReportingApiTest`、`BusinessReportingApiTest`、管理端 `tests/businessReports.test.js`，以及新增的同源聚合 PostgreSQL 测试。

**通过条件：** 每项已切换指标都能从相同范围的业务记录复算，模拟／回放来源继续标识；没有依据的指标明确不可用。

## 6. 包 3：当前关联目标实时视频

**文件：** `dongying-vue/src/components/video/TargetLiveVideo.vue`、`targetVideoState.js`、`src/pages/SituationPage.vue`；后端 `modules/device/api/EoTrackingController.java` 及对应跟踪读取用例。视频会话接口为拟新增能力，路径与字段在拿到源协议后固定。

**接入资料：** 可用视频样本或测试设备、流协议、鉴权和地址有效期、视频设备／通道与跟踪任务的关联方法、允许的并发和网络访问方式。若仅有 RTSP 等浏览器不能直接播放的源，先确认已有转流设施；新增媒体服务或依赖另行评估。

- [ ] 后端按当前目标、关联跟踪任务和权限取得视频会话；跟踪指令成功不能自动等同有可播放视频。
- [ ] 前台共用一个播放器与状态逻辑，将融合感知的占位按钮接入同一能力；不扩展新的页面视频入口。
- [ ] 返回／显示未接入、无任务、无权限、流获取失败、失效和模拟状态；不把凭据放进日志或持久页面配置。
- [ ] 验证切换目标、收起、离开及会话过期时立即释放旧画面，迟到响应不能串目标；观看不触发跟踪启动、反制或历史证据写入。

**通过条件：** 告警、反制办理、合法性研判和融合感知现有入口能展示同一目标的真实画面；断流后显示真实异常，无旧画面串入。

## 7. 包 4：外部飞行计划输入

**文件：** 后端 `modules/integrationconfig/application/ExternalInterfaceService.java`、`modules/flight/application/FlightReadService.java` 及现有计划持久化、来源关联用例；管理端 `ruoyi-ui/src/views/operations/InterfacesView.vue`、`src/api/externalInterfaces.js`；业务前台 `src/services/flightApi.js`。

**接入资料：** 来源系统、推送或拉取协议、鉴权、计划唯一编号和版本、取消／变更语义、飞行时间及其时区、路线坐标、高度基准、报送单位与飞手关系、失败重发及签名规则。

- [ ] 根据实际协议选定推送或拉取中的适用实现；不为未使用方式提前新增采集任务。校验来源、范围与消息身份，保存输入版本和接收事实。
- [ ] 复用计划、航线版本及单位关联结构；重复报文不重复建计划，旧版本不覆盖新版本，撤销和变更保留历史。
- [ ] 将来源计划接入已有匹配与合法性研判链；外部“审批通过”字段不能替代实际飞行是否合法的判定。
- [ ] 配置保存、连接可用、收到数据和业务入库分别验证；只有真实读取成功后才能显示可用，不能因填了地址就变为已接通。
- [ ] 使用有效计划、变更、撤销、重复、乱序、无权限、错误时区／坐标／高度基准的样例验证。

**通过条件：** 一条外部计划可在前台精确定位，版本、时间和航线正确，并参与现有研判；失败记录能定位原因，历史关系不丢失。

## 8. 包 5：真实天气预报与天气传感器

**文件：** 后端 `modules/integrationconfig/application/ExternalInterfaceService.java`、`modules/device/application/WeatherSensorService.java`、`DeviceService.java`；管理端 `InterfacesView.vue`、`WeatherSensorDialog.vue`、`DeviceCatalogPreview.vue`；前台 `src/pages/flights/components/PlanWeatherForecast.vue`。

**接入资料：** 预报服务商、区域编码、时间分辨率、发布时间和有效期、字段单位、限流；传感器另需设备型号、传输协议、采样周期、时间和质量标记。传感器接入不能用预报接口代替。

- [ ] 先接真实预报适配器与缓存／更新，验证超时、限流、无覆盖、字段缺失和过期；真实模式不回退模拟，模拟批次仍独立保留。
- [ ] 保持计划时间交集展示：只显示与计划飞行时间重叠的预报，卡片裁剪到交集，仅端点相接不算覆盖。
- [ ] 传感器在协议确认后再实现采集、原始观测和质量／时效读取；只有真实能力满足时解除 `WEATHER_PENDING` 对应限制。
- [ ] 只在现有天气设备展示范围内显示实测，不新增计划关联站点、气象风险规则或跨页对照分析。

**测试：** `ExternalInterfaceApiTest`、`WeatherSensorApiTest`、管理端 `tests/weatherInterfaces.test.js`、前台 `e2e/weather-expiry.spec.js`，追加真实适配契约测试。

**通过条件：** 真实预报和设备实测来源可辨、时效正确、异常明确；无资料的子项继续保持待接入，不冒充完成。

## 9. 包 6：真实通知通道与可信回执

**文件：** 后端 `modules/alarm/application/AdvisorySmsPort.java`、`AdvisoryVoicePort.java`、`AutoSmsPolicy.java`、`AutoVoicePolicy.java`、`AutoSmsService.java`、`AutoVoiceService.java`、`modules/directory/application/NotificationDirectoryService.java`、`modules/handoff/domain/HandoffChannelPort.java`、`modules/handoff/application/HandoffNotificationService.java`；管理端 `ruoyi-ui/src/views/system/NotificationSettingsView.vue`；前台现有短信、电话和处罚通知组件。

**接入资料：** 短信供应商和模板、外呼服务及已批准录音、测试号码、上级和处罚部门接口、计划报送单位反馈协议、鉴权／回调验签／查询对账规则、各类接收关系及测试额度。真实发送前明确测试对象和范围。

- [ ] 分开实现短信、电话、风险通知、计划反馈和处罚通知的适配契约，不因共用一个适配接口合并业务回执。
- [ ] 检查现有策略的 local/test 限制和仅模拟可用判断，设计真实与模拟各自明确的启用条件；不能只新增供应商客户端就认定生产调度已接通，也不能直接删掉模拟环境隔离。
- [ ] 自动短信／电话仍按现有有效观测和研判条件触发；没有有效联系人或录音时阻断。两个渠道独立推进，任何一个成功都不替代另一个。
- [ ] 下发前持久化任务及幂等键，外部请求在数据库事务外执行；处理受理、送达／接通、播放、拒绝、超时、迟到和重复回执。
- [ ] 验证回执来源、业务关联与幂等；结果未知先查询或对账，不盲目重发／重拨；配置变化不能覆盖历史投递事实。
- [ ] 后台配置准确反映未配置、已停用、可用和异常；风险始终通知固定“上级”，不新增按地区／类型分发。
- [ ] 保留处罚送达与签收两组状态；交接建立、真实通知、签收与案件办理结果独立。

**测试：** 原有 `AutoSmsApiTest`、`AutoSmsPostgresTest`、`AutoVoiceApiTest`、`AutoVoicePostgresTest`、`HandoffNotificationApiTest`、`HandoffNotificationPostgresTest`；每个真实适配器增加认证失败、超时结果未知、回调重复／乱序的契约测试。

**通过条件：** 受控测试对象实际收到各自通知，后台保存可核验的真实受理及回执；无回执只显示未知／待确认；前后台与服务重启后保持一致。

## 10. 包 7：现场设备接入与联调

**文件：** 后端 `integration/mqtt/MqttSessionSupervisor.java`、`integration/device/radar/RadarTcpV300Adapter.java`、`integration/device/countermeasure/CountermeasureTcp4ChV20Adapter.java`、`modules/fusion/ingest/LiveRadarFrameMapper.java`、`LingyunSenseDataMapper.java`、`modules/disposal/application/DisposalExecutionGateway.java`；后台现有设备、监测和调测页面。

- [ ] 对照实际设备清单逐台确认协议、网络、凭据引用、坐标、高度基准和分类码，先验证只读心跳、状态、目标和轨迹。不能将原模拟设备改标为真实设备。
- [ ] 核实雷达航迹提升到融合消费的开关与运行路径；仅收到 TCP／MQTT 报文不代表业务目标已生成。
- [ ] 高度基准或分类码不明确时保留未知，不能为生成超高／无人机告警随意映射。资料确认后再补对应适配测试。
- [ ] 按现有能力验证目标关联、轨迹断点、规则研判和异常恢复，随后验证光电跟踪及视频关联。
- [ ] 设备反制仅在明确的现场授权与测试窗口验证申请／直接权限、下发、真实回执、停止、超时及重启恢复；不因本计划自动执行真实反制。
- [ ] 协议暂未支持的雷达启停、指令码或设备能力保持明确受阻，不借联调擅自开通新的动作。

**通过条件：** 每台设备都有“已收到原始报文—已归一化—已进入业务—已取得实际回执”的适用证据；模拟联调与现场结果分别记录。

## 11. 包 8：回归、发布与交付

- [ ] 每包先写可复现缺口的测试，确认失败原因，再修改实现；修复后运行受影响测试。SQL、并发、迁移和事务必须在隔离 PostgreSQL/PostGIS 验证。
- [ ] 前台在 `dongying-vue/` 运行 `npm run build`、`node tools/scan.cjs`、`npx playwright test e2e/admin-migration.spec.js`，并执行本包新增业务用例。核对长文字、错误态和跨页切换。
- [ ] 后台管理端在 `../houtaiguanli/ruoyi-ui/` 运行 `npm run lint`、`npm test`、`npm run build`。
- [ ] 后端在 `../houtaiguanli/server/` 运行受影响测试及 `./mvnw package`；先检查测试类对隔离库的配置，不能指向现有业务数据库。共享权限改动另跑当前认证测试。
- [ ] 两个仓库运行 `git diff --check`；已有无关问题单独记录，不能用清理用户改动的方式获得通过。仅按文件提交本包内容。
- [ ] 发布前备份数据库与必要文件，校验新增迁移、两套前端契约、服务配置和依赖通道。先部署兼容的后端，再发布适配前端，最后按已授权范围启用任务／通道。
- [ ] 回滚采用兼容应用版本和停用新任务，不删除已执行迁移、历史通知或冻结材料；结果未知的外部请求先对账。
- [ ] 使用同一批次串联计划、目标、研判、告警、通知、适用的反制、交接、处罚结果和统计。不是所有场景都必须反制，也不是所有事件都必须处罚。
- [ ] 验证页面关闭、刷新、重新登录、服务重启、网络中断、回执迟到和权限不足；证明自动任务不依赖页面在线。
- [ ] 更新两套 README、接口专题和验收记录；只有新增稳定约束才写 AGENTS。交付逐项标明“代码完成／模拟通过／真实通过／外部资料缺失”，不笼统写全部接通。

## 12. 首批启动清单

1. 包 0：复核当前版本与最新改动。
2. 包 1A：形成自动移送资格表和接口契约，补后台任务与前台状态读取。
3. 包 1B／1C：关闭新人工执行写入，验证核实入口与共享结果。
4. 包 2：列出运行统计逐项映射，保留需确定口径的项目，不偷偷切换计数方式。
5. 收集视频、计划、天气、通知、设备五类外部资料；按资料到齐顺序实施包 3—7。

这份文件是执行范围与验收顺序，不表示代码已经修改、通道已经启用或现场已经验收。
