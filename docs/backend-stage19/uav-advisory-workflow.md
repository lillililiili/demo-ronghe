# 无人机劝离处置

## 页面与操作

告警事件详情：核实后按当前状态突出一个主动作：首次联系、补充现场情况、申请反制、查看有效授权，或飞离后的处罚移送。补充操作与独立移送收进可展开区域，历史联系与观察记录继续保留。短信表单默认使用模拟接收人，明确显示模拟发送；也可以记录人工电话或现场联系。观察表单填写当前情况、危险度及核查依据，服务端允许时才开放反制申请。再次联系后需要重新观察，不沿用旧结论。记录按时间留存，刷新读取数据库。

反制申请复用现有授权。申请后可点击“查看本次授权”直接进入相同授权详情。目标已飞离、无法确认或危险度降低时，服务端阻止基于旧判断继续升级；设备回执与现场效果分别核查。没有擅自增加固定等待时间，也没有自动根据模拟风险分数执行设备。

“移送处罚”不再要求先完成反制，仍校验核实、版本、权限和接收方。提交时将联系与观察记录冻结进材料；“查看处罚交接”打开同一记录。处罚详情新增“处罚办理结果”：读取关联案件的办理状态、当事人、承办人与金额；决定前标为拟罚金额，决定后显示决定金额，没有案件时显示待反馈。提交不表示已经罚款。“刷新送达状态”读取真实通道记录，不再使用仅改变页面的通知标记。

融合感知当前使用后端领域接口读取目标与告警。其“处置流程”入口只有明确关联业务告警 ID 时才带入该事件；缺少关联时说明情况并提供告警列表入口，不自动选择替代对象或用本地状态表示反制已经执行。

## 接口

- `GET /api/v1/uav-events/{eventId}/advisory`：事件版本、模拟短信可用性、可办理动作、反制阻断原因、联系/观察记录。
- `POST /api/v1/uav-events/{eventId}/advisory/actions`：`expected_version`、`kind`，并带 `Idempotency-Key`。动作包括 `SMS_SIMULATED`、`CONTACT_RECORDED`、`OBSERVATION`。
- 观察结果：`DEPARTED`、`STILL_INSIDE`、`UNKNOWN`；危险度：`HIGH`、`MEDIUM`、`LOW`、`UNKNOWN`；保存核查说明，紧急申请额外记录 `urgent` 和依据。
- 处罚材料的 `advisory_records` 为新增可选字段，旧材料继续读取。

短信服务端已拆出适配接口。当前 local/test + mock/replay 数据用模拟提供方，显示 `SIMULATED_DELIVERED`；真实来源不回退为模拟成功。正式短信服务商、真实联系人渠道、观察预案和正式风险规则仍需后续对接。模拟记录不含真实手机号。

## 代码分工

| 文件/类 | 方法或模块作用 | 本次变化 |
|---|---|---|
| `AlarmsPage.vue` | `advisoryProps/updateAdvisory/loadPageProgress` | 告警选择、列表进度、事件版本及后续入口同步；去掉重复的旧处置步骤 |
| `UavAdvisoryPanel.vue` | `load/openAction` | 三段操作区，保存后回读，按服务端条件开放反制 |
| `AdvisoryRecords.vue`、`advisoryView.js` | 展示模板、`advisoryProgress` | 联系和观察历史，未知与飞离分别显示 |
| `uavAdvisoryApi.js` | `get/act` | 标准读取/写入接口，携带幂等键 |
| `PunishPage.vue`、`AuthorizationQueue.vue` | `refreshDelivery`、材料模板、授权深链 | 展示移送快照，回读送达状态，打开同一授权 |
| `PunishmentOutcome.vue` | `load`、`decided`、`money`、结果模板 | 读取同一交接的案件，区分拟罚与决定金额，不将移送写成已罚款 |
| `SituationPage.vue` | `openLinkedDisposal` | 统一处置入口，未关联目标明确说明 |
| `situationFlow.js`、`labels.js` | 后端状态展示及文字约定 | 旧模拟流程模块已移除，处置入口复用告警流程，处罚不依赖反制完成 |
| 后端 alarm advisory、短信适配、授权守卫与交接材料 | 持久化、权限/版本/幂等、执行前复核 | 详见同级后端接口说明；追加数据库迁移，未修改旧迁移 |

## 功能实现阶段验证记录

- 浏览器连接当前本地前后端，实测三条操作链：模拟短信→高风险观察→开放申请；提交人工通道申请→待审批→同一授权详情；模拟短信→确认飞离→不反制也可移送→同一交接冻结材料。刷新后记录及状态保留。
- 页面在 1280×720、1366×768、1440×900 检查，无整页横向溢出，实测期间无页面未捕获异常。
- 前端生产构建、126 文件源码扫描、旧管理地址迁移回归（1 项）、处置进度边界检查（3 项）通过；构建仍有现有的大文件分包提示。
- 后端受影响测试共 15 类、190 次用例执行通过；打包通过。PostgreSQL 隔离测试覆盖迁移、并发、幂等、权限、旧处置与急停回归。未运行全仓库所有测试。
- 当前服务已能通过新接口保存并回读记录。本次使用本地系统模拟事件：告警-0905-003（高风险观察及待审批人工申请）、告警-0905-004（飞离后独立移送）。未批准或执行反制，未接入真实短信提供方。
- 前后端 `git diff --check` 通过。详细后端文件与测试清单见下节。


## 后端修改清单



- [README.md](/Users/frank/Desktop/houtaiguanli/server/README.md)
- [src/main/resources/db/migration/V202609150005__uav_event_advisory.sql](/Users/frank/Desktop/houtaiguanli/server/src/main/resources/db/migration/V202609150005__uav_event_advisory.sql)
- [src/main/java/com/uav/lowaltitude/integration/mock/LocalAdvisorySmsAdapter.java](/Users/frank/Desktop/houtaiguanli/server/src/main/java/com/uav/lowaltitude/integration/mock/LocalAdvisorySmsAdapter.java)
- [src/main/java/com/uav/lowaltitude/modules/alarm/api/UavAdvisoryController.java](/Users/frank/Desktop/houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/alarm/api/UavAdvisoryController.java)
- [src/main/java/com/uav/lowaltitude/modules/alarm/api/UavAdvisoryDtos.java](/Users/frank/Desktop/houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/alarm/api/UavAdvisoryDtos.java)
- [src/main/java/com/uav/lowaltitude/modules/alarm/application/AdvisorySmsPort.java](/Users/frank/Desktop/houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/alarm/application/AdvisorySmsPort.java)
- [src/main/java/com/uav/lowaltitude/modules/alarm/application/UavAdvisoryService.java](/Users/frank/Desktop/houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/alarm/application/UavAdvisoryService.java)
- [src/main/java/com/uav/lowaltitude/modules/alarm/domain/UavAdvisoryRules.java](/Users/frank/Desktop/houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/alarm/domain/UavAdvisoryRules.java)
- [src/main/java/com/uav/lowaltitude/modules/alarm/infrastructure/UavAdvisoryRepository.java](/Users/frank/Desktop/houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/alarm/infrastructure/UavAdvisoryRepository.java)
- [src/main/java/com/uav/lowaltitude/modules/disposal/application/DisposalAuthorizationService.java](/Users/frank/Desktop/houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/disposal/application/DisposalAuthorizationService.java)
- [src/main/java/com/uav/lowaltitude/modules/disposal/application/DisposalCommandGuard.java](/Users/frank/Desktop/houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/disposal/application/DisposalCommandGuard.java)
- [src/main/java/com/uav/lowaltitude/modules/disposal/application/DisposalJammingChain.java](/Users/frank/Desktop/houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/disposal/application/DisposalJammingChain.java)
- [src/main/java/com/uav/lowaltitude/modules/device/application/Countermeasure4ChControlService.java](/Users/frank/Desktop/houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/device/application/Countermeasure4ChControlService.java)
- [src/main/java/com/uav/lowaltitude/modules/device/application/LingyunControlService.java](/Users/frank/Desktop/houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/device/application/LingyunControlService.java)
- [src/main/java/com/uav/lowaltitude/modules/handoff/domain/HandoffRules.java](/Users/frank/Desktop/houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/handoff/domain/HandoffRules.java)
- [src/main/java/com/uav/lowaltitude/modules/handoff/api/HandoffDtos.java](/Users/frank/Desktop/houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/handoff/api/HandoffDtos.java)
- [src/main/java/com/uav/lowaltitude/modules/handoff/application/HandoffMaterialAssembler.java](/Users/frank/Desktop/houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/handoff/application/HandoffMaterialAssembler.java)
- [src/main/java/com/uav/lowaltitude/modules/handoff/application/HandoffReadService.java](/Users/frank/Desktop/houtaiguanli/server/src/main/java/com/uav/lowaltitude/modules/handoff/application/HandoffReadService.java)
- [src/test/java/com/uav/lowaltitude/modules/alarm/api/UavAdvisoryApiTest.java](/Users/frank/Desktop/houtaiguanli/server/src/test/java/com/uav/lowaltitude/modules/alarm/api/UavAdvisoryApiTest.java)
- [src/test/java/com/uav/lowaltitude/modules/alarm/api/UavAdvisoryPostgresTest.java](/Users/frank/Desktop/houtaiguanli/server/src/test/java/com/uav/lowaltitude/modules/alarm/api/UavAdvisoryPostgresTest.java)
- [src/test/java/com/uav/lowaltitude/integration/mock/LocalAdvisorySmsAdapterTest.java](/Users/frank/Desktop/houtaiguanli/server/src/test/java/com/uav/lowaltitude/integration/mock/LocalAdvisorySmsAdapterTest.java)
- [src/test/java/com/uav/lowaltitude/modules/disposal/api/DisposalAuthorizationApiTest.java](/Users/frank/Desktop/houtaiguanli/server/src/test/java/com/uav/lowaltitude/modules/disposal/api/DisposalAuthorizationApiTest.java)
- [src/test/java/com/uav/lowaltitude/modules/disposal/api/DisposalExecutionTest.java](/Users/frank/Desktop/houtaiguanli/server/src/test/java/com/uav/lowaltitude/modules/disposal/api/DisposalExecutionTest.java)
- [src/test/java/com/uav/lowaltitude/modules/disposal/api/EmergencyStopApiTest.java](/Users/frank/Desktop/houtaiguanli/server/src/test/java/com/uav/lowaltitude/modules/disposal/api/EmergencyStopApiTest.java)
- [src/test/java/com/uav/lowaltitude/modules/disposal/api/EmergencyStopPostgresTest.java](/Users/frank/Desktop/houtaiguanli/server/src/test/java/com/uav/lowaltitude/modules/disposal/api/EmergencyStopPostgresTest.java)
- [src/test/java/com/uav/lowaltitude/modules/disposal/api/Stage13PostgresTest.java](/Users/frank/Desktop/houtaiguanli/server/src/test/java/com/uav/lowaltitude/modules/disposal/api/Stage13PostgresTest.java)
- [src/test/java/com/uav/lowaltitude/modules/handoff/api/HandoffPunishmentMaterialsApiTest.java](/Users/frank/Desktop/houtaiguanli/server/src/test/java/com/uav/lowaltitude/modules/handoff/api/HandoffPunishmentMaterialsApiTest.java)
- [src/test/java/com/uav/lowaltitude/modules/handoff/domain/HandoffPunishmentPrerequisiteTest.java](/Users/frank/Desktop/houtaiguanli/server/src/test/java/com/uav/lowaltitude/modules/handoff/domain/HandoffPunishmentPrerequisiteTest.java)

未触碰其他任务的 EoManualTrackService、EoEdgeRepository、LocalAirspaceDemoTarget*、TargetRead* 等同期改动；未提交、撤回或清理它们。
