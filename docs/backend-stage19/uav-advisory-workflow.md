# 无人机劝离处置

2026-09-16 追加：短信之外增加电话录音通知。告警详情与融合感知共用各渠道记录，电话默认禁用、真实通道尚未接入；电话状态、录音配置及本轮验收边界见[飞手电话录音通知](uav-voice-notification.md)。下述短信的既有历史验收不等于电话通知已投入真实运行。

## 页面与操作

告警事件详情：短信由后台按有效策略自动模拟发送，未人工核实但已有明确有效违规研判的事件也可通知。页面先展示通知结果、异常原因与数据时间；失败且后台允许时提供“重新发送通知”。常规流程不再要求点击“短信劝离”。核实后的现场补充、反制申请、授权查看与独立移送仍按各自条件办理，自动短信不会替代反制授权或处罚决定。联系与观察历史继续保留，新联系不沿用之前的现场观察。

反制申请复用现有授权。申请后可点击“查看本次授权”直接进入相同授权详情。目标已飞离、无法确认或危险度降低时，服务端阻止基于旧判断继续升级；设备回执与现场效果分别核查。没有擅自增加固定等待时间，也没有自动根据模拟风险分数执行设备。

“移送处罚”不再要求先完成反制，仍校验核实、版本、权限和接收方。提交时将联系与观察记录冻结进材料；“查看处罚交接”打开同一记录。处罚详情新增“处罚办理结果”：读取关联案件的办理状态、当事人、承办人与金额；决定前标为拟罚金额，决定后显示决定金额，没有案件时显示待反馈。提交不表示已经罚款。“刷新送达状态”读取真实通道记录，不再使用仅改变页面的通知标记。

融合感知通过后端目标与告警精确关联事件：点击目标异常或地图目标后，右侧显示同一事件的短信通知状态、时间、接收对象、触发依据与记录，异常重试可在当前页面完成。“查看此事件的处置详情”进入同一告警。没有近期目标观测时仍可查看被点击事件的历史，明确提示缺少近期观测，不沿用上一个目标或假称飞离。

## 自动通知策略（2026-09-16）

| 要素 | 本次实现 |
| --- | --- |
| 触发数据 | 同一事件、目标最新观测、最新 ACTIVE 研判及已有联系/观察记录 |
| 自动依据 | 最新有效研判明确 ILLEGAL、没有未知原因、精确关联本事件；没有规则研判时使用近期人工确认及近期 UAV 观测 |
| 时效 | 本地演示默认观测/研判 120 秒、事件/人工确认 300 秒，服务端可配置；演示数值不代表正式规范 |
| 自动动作 | 后台约 10 秒检查一次；符合条件后经短信适配接口模拟发送，一事件一自动任务，稳定渠道幂等键，不依赖浏览器 |
| 人工介入 | 通道失败、数据过期/未知、身份或关联不足时显示原因；后台允许的异常任务可带说明重试 |
| 失败处理 | 发送中、失败、未接通、阻断与模拟送达分开记录；页面读取不发送，失败不冒充送达，失联不算飞离 |
| 来源边界 | LOCAL_AUTO_SMS_DEMO_V1 仅在 local/test 且已启用时运行；mock/replay 使用模拟接收人，live 不回退为模拟成功 |
| 执行身份 | 独立后台 SYSTEM 身份，记录“系统自动”与策略，不借用登录会话 |

告警与融合感知共用展示组件，每 5 秒只读回读；页面隐藏暂停回读，重新可见恢复，卸载清理。后台任务继续运行。发送记录不等于飞手已读、目标离场或反制已授权。本次没有实现连续自动现场观察。

## 2026-09-16 对话补充：发送历史与过期提示

- 用户确认短信应在满足条件时自动发送，之后查看当时的发送结果。发送资格的时效检查与已存在的历史发送/送达结果分开，后续观测过期不抹掉发送事实。
- 尚未发送且依据失效时，说明是哪项依据超过自动通知时效；不把它写成事件已结束或风险解除。没有发送记录不能推定当时已发。
- 追加历史演示事件时，若场景表示当时已经通知，应同时补齐有对应时间、明确模拟来源的发送及回执链路；若没有这些记录，如实保留未发送/待核查，不伪造真实送达。
- 上述前次对话仅补文档时，源码 `autoSmsView.js` 将“事件已超过自动通知时效”简写为“事件已过期”，当天静态演示批次也缺少配套模拟短信记录。后续用户已授权补齐该批历史模拟通知，结果见下节；持续违规时基于新依据再判定等实时策略问题不属于本次补录，不能通过取消时效校验、改写旧告警时间或无记录显示送达来处理。

## 2026-09-16 历史模拟通知配套结果

- 范围：`demo-day-20260916-event-1` 至 `demo-day-20260916-event-6`，以及同批目标产生的“告警-0916-003”（事件 `2f17591b-94d0-472e-b006-c11743f74982`）。仅本地 mock 数据，其他事件未批量置为已送达。
- 补齐 7 条 `SMS_SIMULATED` 历史记录、对应自动任务与模拟回执、7 条补录审计；事件只递增记录版本并更新实际修改时间，原业务状态不变。场景触发/送达时间写入历史记录，实际补录时间、旧任务与旧事件状态写入审计。
- 每条均说明“模拟历史补录”，未调用短信网关、未重放当时规则，不冒充实际实时执行。没有为通知成功伪造或改写规则研判、观测、人工确认、授权及现场飞离；任务不硬填不存在的历史研判引用。
- 7 份说明与模拟回执 JSON 经证据接口实际入库，均为 `NOTICE_RECEIPT`、`source_mode=mock`，哈希校验通过；分别关联原事件，事件 5、6 的文件另关联相应案件。原交接冻结快照保持不变，迟补内容通过补充材料查看。
- 告警详情及融合感知相同事件显示“已送达”与“模拟短信”，含历史触发和送达时间；联系记录注明模拟补录，结果不会再因当前观测失效变成未发送。该状态不代表飞手已读、目标已飞离、风险解除或后续反制获准。
- 验证：修复前 7 条配套断言命中 0 条；最小隔离 PostgreSQL 首次补录 7 条、再次补录 0 条，链路断言通过。当前本地库 7 条 API 回读及文件校验通过，原告警/研判/冻结快照共 15 项指纹未变。
- 浏览器：7 个告警逐条打开并刷新，融合感知同事件、新浏览器会话重新登录均显示模拟送达；无页面未捕获异常；无效会话读取返回 401。未重启共享后端，未重新验收实时自动短信触发；本次未改业务代码，未重跑构建和全量测试。

后续新增数据强制遵循[演示数据跨模块配套规范](../演示数据跨模块配套规范.md)及两级 `AGENTS.md`。本节的历史模拟补录结果不能作为真实短信通道验收证明。

## 接口

### 2026-09-16 处置预案与页面分工补充

- 用户明确：本流程的短信通知仅指飞手提醒/劝离，不指值班岗通知。预案配置与发布归后台管理端；空域管理查看适用预案，合法性研判查看触发依据，告警事件查看通知、现场和授权进度。
- 当前空域 DTO 没有预案关联字段或独立查询能力，前台如实显示“关联信息待接入”，不能据此断言未配置、预案生效或已触发执行。后台预案配置、发布、关联和事件执行快照仍待实现。
- 研判详情新增观测时间和“查看此告警的处置进度”，只使用服务端 `alarm_id` 并检查告警菜单与读取权限，不按目标名称猜测关联。历史研判的原始时间与结论保留。
- 告警详情分别呈现飞手短信、已有现场观察及其记录时间、反制授权；无观察不认定飞离，无授权记录不推导已授权。人工核实保留为独立操作，不显示为所有短信的前置步骤。
- 反制申请仅预填已保存的最近现场观察、时间、说明及模拟来源，用户核对后提交；无观察时不编造事由。申请事由按后端约束在提交前检查 2–500 字，不截断原始观察；切换事件或离开页面后，迟到的申请表单不再打开，已打开表单也不能向旧事件提交。授权、执行前校验和服务端写入门槛不变。
- 自动短信超过发送时效显示“通知依据已超过发送时效，需核对最新情况”，不再缩写为事件已过期；已发送历史仍由后端事实决定。

本次前台验证（2026-09-16）：

- 直接调用本地 Vite 构建入口通过；`node tools/scan.cjs` 通过（134 个文件）；六个旧管理地址的 `admin-migration.spec.js` 通过；`git diff --check` 通过。当前环境的 npm/npx 可执行入口存在依赖链接问题，因此分别使用 `node node_modules/vite/bin/vite.js build` 与 `node node_modules/@playwright/test/cli.js test e2e/admin-migration.spec.js`，未重装依赖。
- 隔离浏览器验证覆盖 1280×720、1366×768、1440×900 三种尺寸，无整页横向溢出。12 项检查覆盖对应告警跳转、已有观察草稿、500 字上限、迟到表单丢弃、切换事件、空域关联缺口、详情折叠重置、待核实事件保留已发送事实、通知时效文案、重试入口、只读状态与读取失败；页面脚本错误为 0，业务写入为 0。测试数据仅由浏览器拦截提供，不落库。
- 真实环境登录及迁移页可访问，但 `GET /legality-evaluations` 的 ACTIVE 列表在 size=10、60 秒超时设置下仍未返回；本次未解决该接口超时，不能据隔离测试宣称真实业务链全部验收通过。未验收真实短信通道和反制设备。

同日后续补验：用户授权优化后，后台拆分目标与计划的最新记录查询，22 项受影响回归通过；本地完整列表接口实测约 0.22–1.82 秒，真实页面刷新及研判到关联告警的通知卡片展示已通过，历史仍为 29,141 条。上段超时是优化前的阶段记录；性能与验证边界见[最新研判列表查询优化](../../../houtaiguanli/docs/最新研判列表查询优化-2026-09-16.md)。这不代表真实短信或反制设备已经验收。

以下为已有通知接口，本次页面调整未新增预案配置接口：

- `GET /api/v1/uav-events/{eventId}/advisory`：事件版本、模拟短信可用性、可办理动作、反制阻断原因、联系/观察记录；追加 `auto_sms` 的状态、原因、时间、策略与重试权限。读取不创建或发送通知。
- `POST /api/v1/uav-events/{eventId}/advisory/auto-sms/retry`：`expected_version`、`note` 与 `Idempotency-Key`；登记同一任务重试，不重复建通知。
- 联系记录追加 `trigger_mode`（AUTO/MANUAL）和 `policy_code`，原记录兼容。
- `POST /api/v1/uav-events/{eventId}/advisory/actions`：`expected_version`、`kind`，并带 `Idempotency-Key`。动作包括 `SMS_SIMULATED`、`CONTACT_RECORDED`、`OBSERVATION`。
- 观察结果：`DEPARTED`、`STILL_INSIDE`、`UNKNOWN`；危险度：`HIGH`、`MEDIUM`、`LOW`、`UNKNOWN`；保存核查说明，紧急申请额外记录 `urgent` 和依据。
- 处罚材料的 `advisory_records` 为新增可选字段，旧材料继续读取。

短信服务端已拆出适配接口。当前 local/test + mock/replay 数据用模拟提供方，显示 `SIMULATED_DELIVERED`；真实来源不回退为模拟成功。正式短信服务商、真实联系人渠道、观察预案和正式风险规则仍需后续对接。模拟记录不含真实手机号。

## 代码分工

| 文件/类 | 方法或模块作用 | 本次变化 |
|---|---|---|
| `AlarmsPage.vue` | `advisoryProps/updateAdvisory/loadPageProgress` | 告警选择、列表进度、事件版本及后续入口同步；去掉重复的旧处置步骤 |
| `UavAdvisoryPanel.vue` | `openAction`、状态模板 | 自动通知及当前适用人工动作，迟到响应只关闭本操作弹窗 |
| `AutoSmsNotice.vue`、`autoSmsView.js` | `retry/autoSmsView` | 两页统一通知状态与异常重试 |
| `useUavAdvisory.js` | `load/schedule` | 只读轮询、事件切换和卸载保护 |
| `SituationAdvisoryCard.vue`、`SituationPage.vue` | `selectAlarm/targetAlarm/updateNotification` | 当前事件通知卡、异常补发、无近期目标时保留正确事件 |
| `modal.js` | `openModal/closeModal` | 弹窗归属句柄，迟到请求不关闭新表单 |
| `AdvisoryRecords.vue`、`advisoryView.js` | 展示模板、`advisoryProgress` | 联系和观察历史，未知与飞离分别显示 |
| `uavAdvisoryApi.js` | `get/act/retrySms` | 标准读取与幂等写入，异常重试仍是同一事件 |
| `PunishPage.vue`、`AuthorizationQueue.vue` | `refreshDelivery`、材料模板、授权深链 | 展示移送快照，回读送达状态，打开同一授权 |
| `PunishmentOutcome.vue` | `load`、`decided`、`money`、结果模板 | 读取同一交接的案件，区分拟罚与决定金额，不将移送写成已罚款 |
| `SituationPage.vue` | `openLinkedDisposal` | 统一处置入口，未关联目标明确说明 |
| `situationFlow.js`、`labels.js` | 后端状态展示及文字约定 | 旧模拟流程模块已移除，处置入口复用告警流程，处罚不依赖反制完成 |
| 后端 alarm advisory、短信适配、授权守卫与交接材料 | 持久化、权限/版本/幂等、执行前复核 | 详见同级后端接口说明；追加数据库迁移，未修改旧迁移 |

### 2026-09-16 自动通知后端切片

| 文件/类 | 方法/函数 | 本次作用 |
| --- | --- | --- |
| `AutoSmsJob`、`AutoSmsService` | `poll/process/claim/finish/eligible/overview/retry` | 后台自动检查、锁定任务、调用模拟通道、保存回执；读取不发送，失败重试不重复创建任务 |
| `AutoSmsPolicy` | `enabled/fresh/description` | 限定演示环境与可配置数据时效 |
| `AutoSmsRepository` | `candidates/facts/latestEvaluation/initialize/claim/finish/queueRetry` | 同事件事实与持久化任务，公平扫描和发送租约恢复 |
| `UavAdvisoryController`、`UavAdvisoryService` | `retryAutomatic/view/act` | 重试接口权限、范围、版本与幂等检查；返回自动通知状态 |
| `UavAdvisoryDtos` | 无具体方法，响应记录定义 | 追加自动状态、证据时间与自动/人工记录来源 |
| `UavAdvisoryRepository`、`AdvisorySmsPort` | `appendAutomatic/records/simulate` | 独立系统执行身份、通道幂等参数，兼容原人工记录与交接材料 |
| `V202609160001__automatic_advisory_sms.sql`、`application-local.yml` | 无具体方法，表结构与配置 | 自动任务、执行主体、策略和演示时效配置 |
| `AutoSmsApiTest`、`AutoSmsPostgresTest`、`AutoSmsSchedulingTest`、`AutoSmsPolicyTest`、`UavAdvisoryPostgresTest`、`HandoffPunishmentMaterialsApiTest` | 行为、迁移及材料快照用例 | 规则触发、过期/未知阻断、并发去重、无浏览器运行、环境隔离、权限和自动记录兼容验证 |
| 后端 `README.md` | 无具体方法，接口说明 | 记录触发条件、模拟边界、字段与重试契约 |

## 2026-09-16 自动通知与融合感知验证

- 页面变化：融合感知右侧新增当前事件通知卡，查看状态、时间、依据和历史；异常时可补发，点击处置详情打开同一事件。告警处置复用相同通知组件，首条短信由后台策略触发。
- 前端生产构建、131 文件源码扫描、旧管理地址迁移回归（1 项）、通知状态边界检查（8 项）通过。当前运行环境使用 Vite 与 Playwright 的 Node 入口完成等效构建与回归；未声称执行不存在的 test/lint npm 脚本。构建仍有既有的大文件分包提示。
- 真实浏览器以隔离响应覆盖自动状态更新、页面读取不发送、切换事件不串数据、失败补发、重复请求防重、迟到响应不关闭新表单、同事件跳转及卸载停止读取。1280×720、1366×768、1440×900 检查无整页横向溢出，无页面未捕获异常；这些模拟响应没有写入共享业务数据。
- 最后以实际本地后端只读联查告警-0916-002：融合感知与告警处置均显示事件过期阻断，记录仍为 0，没有把旧数据显示成自动发送成功。后端健康检查为 UP，迁移已至 202609160001。
- 后端受影响的 9 类最新用例结果合计 91 项通过，0 失败、错误或跳过；末次打包通过。其中首轮 88 项后，补充并发幂等冲突与 AUTO 材料快照用例，最小 3 类重跑 51 项，再重跑策略类 2 项。包含隔离 PostgreSQL 升级、实际定时线程、权限、跨事件幂等冲突回滚及冻结材料兼容；未运行全仓所有测试。
- 前后端 git diff --check 通过。真实短信供应商尚未接入；当前自动通知仅在 local/test 显式模拟策略下运行，production 混合 profile 也禁用。本次不新增自动反制或自动处罚决定。

## 前期功能实现阶段验证记录

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
