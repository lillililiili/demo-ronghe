# 飞行计划：实测分段、人工核实与回告

> 2026-09-15 仓库归属：本文后端 `server/` 路径指同级 `../houtaiguanli/server/`；历史验证记录保留原日期。迁入后台后的迁移版本与验证结果以后台 `docs/新后端迁移记录.md` 为准。

> 后续用户已调整为系统生成设备检查结果、由报送单位确认起飞，见[最新自动检查口径](flight-plan-automatic-device-check.md)。下文人工填报接口与历史测试结果仅记录此前实现，不代表新流程已验收。

2026-09-14，依据用户提供的计划航路分段和 P8/P9 截图实施。

后续页面文案与可收起图例调整见[页面文案与图例调整](../页面文案与图例调整-2026-09-14.md)。页面将“回告”表达为“通知报送单位”，业务接口与记录含义不变；该轮按用户要求未运行测试或构建。

## 2026-09-16：合法性页统一红绿灰轨迹

### 同日追加：公共地图与其他页面补齐

- 公共地图此前仍使用目标合法性给整条轨迹着色，且计划线随待执行、执行中、已完成和风险变色。现计划几何统一灰色，实测逐段读取走廊关系；未知黄色，非无人机保留类别色。融合感知、空域页图例同步更新。
- 融合感知、事项定位、告警地图和回放保留 `point_id/track_id/point_seq/observed_at`、点型和显式断点。无效点两侧、不同轨迹、序号缺失和时间倒序不连接；预测、推算与实测分开。融合感知刷新不再生成五秒位置插值。
- 融合感知点选无人机后，复用该目标研判轨迹接口，按同一观测点 ID、轨迹、时间和坐标匹配后台关系。只缓存同一研判；后续新点和另一版本的研判保持未知，失败不替换原观测，也不退回合法性颜色。无需增加后端接口。
- 回放只绘制当前播放时刻及之前的点，拖动进度后重新截取；断点保留，模拟／回放来源在弹窗标明。

追加代码清单：`public/assets/js/map.js` 的 `strokePlannedRoute/strokeObservedTrack/trackContinuous/_targetAnchor/_drawFlightPlans/draw` 统一绘制与断点；`services/trackPoints.js` 的 `measuredMapPoints/applyTrackComparison` 保留观测并精确关联后台事实；`situationData.js` 的 `toTrack/attachRecentTracks`、`positionMap.js` 的 `loadTargetPosition`、`AlarmsPage.vue` 的 `focusMap` 复用观测转换；`trajectoryDrawing.js` 的 `strokePlanComparison` 复用公共绘制；`situationApiSource.js` 的 `withComparison/loadTargetDetail/refreshFast` 读取并缓存选中目标的分段结果；`trackReplayModal.js` 的 `trackPointsOf/withHeadings/mapTargetOf` 和 `TrackReplayModal.vue` 的 `paint` 保留断点、来源和回放时刻；`SituationPage.vue/situation.css/AirspacePage.vue` 的模板、样式与航线叠加层同步图例；`dongying-vue/AGENTS.md` 更正旧的“可传状态色”约定。

追加验证：7 组临时断言覆盖颜色、无效点、时间倒序、跨轨迹、点型转换、精确观测匹配与不补运动；133 文件扫描、经典脚本语法检查、旧地址迁移 1 项回归通过。生产构建直接调用本项目 Vite 通过，常规 npm 命令仍因已有跨项目链接失败。真实浏览器已点选当前无人机并收到分段接口 200、看到红色偏离片段；四档视口无横向溢出。回放验收使用浏览器内存中的明确模拟点，验证首帧仅一个点、进度末端四个点、关闭后清理；空域、合法性、飞行计划与大屏切页检查无脚本异常。未新增或改写业务观测，未修改后端，未重复执行后端测试。

用户确认规则已写入根目录与业务前端 AGENTS.md：符合规划的已飞片段绿色，偏离片段红色，计划底线灰色；观测中断保留缺口，不补造或平滑已有轨迹。灰色线保留规划参考，不能仅凭缺少观测认定未起飞。

合法性页新增只读 `GET /api/v1/legality-evaluations/{evaluationId}/trajectory`，复用本节轨迹响应。后台固定该研判的目标、航线版本及 `min(as_of, evaluated_at)`，复用已有 PostGIS 距离与版本绑定的轨迹间隔；优先同目标最新融合轨迹，原始轨迹退路需核对归属。不同于计划的最新目标入口，不能因一条计划有多个目标而串数据。关联航线不可见时拒绝读取；无可比对航线则保留 UNKNOWN，不假定红或绿。

两页共用轨迹画法：实测点之间只有连续时才连线，缺点、跨轨迹、时间倒序或超时断开；预测和弥合不混成已飞实测。合法性页的位置图标单独读取，不再重复读取整条轨迹。地图初始视野优先覆盖当前轨迹、位置和计划线，避免周边大空域把轨迹缩小。原计划接口及业务状态保持兼容。

本轮验证：后端轨迹、实际对照及认证相关 22 项测试通过，package 成功；前端绘制断言、132 文件控件扫描、旧管理地址迁移测试通过。常规 npm 构建仍受已有跨项目 Vite 链接影响，直接调用本项目 Vite 完成生产构建。实际本地接口与浏览器确认同一目标的绿/红片段、灰色计划线、无计划 UNKNOWN、研判截止时间、刷新及 1280×720 / 1366×768 / 1920×1080 无横向溢出，页面无脚本异常。底图加载完成后的截图已核对；本次未重造观测数据，未执行全量后端测试。两仓库 git diff --check 通过。

### 代码变更说明

| 文件 / 类 | 方法 / 区块 | 作用与变化 |
| --- | --- | --- |
| 根目录及 dongying-vue/AGENTS.md | 无具体方法，地图约定 | 固定真实时序、断点和红绿灰规则 |
| LegalityPage.vue | renderEvidenceMap、地图图例 | 读取当前研判分段结果，绘制红绿实际轨迹与灰色计划线 |
| legalityApi.js | trajectory | 读取研判专属轨迹接口 |
| positionMap.js | loadTargetPosition(positionOnly) | 仅取位置，避免重复加载轨迹 |
| services/trajectoryDrawing.js | trustedTrajectoryPoints、strokePlanComparison | 两页共享可信点、分段颜色、灰色计划线与断点绘制 |
| pages/flights/planTrajectory.js | 绘制函数再导出 | 飞行计划沿用共享绘制，保留原文案转换 |
| FlightTrajectoryService | readEvaluation、compare、read | 固定研判关联并复用后台空间对照，原计划接口兼容 |
| FlightTrajectoryController | evaluationTrajectory | 新增只读路由 |
| LegalityTrajectoryServiceTest | 6 项用例 | 固定目标/航线/时间、红绿关系、未知、断点及权限 |
| server/README.md、docs/flow-map.md | 无具体方法，契约与流程 | 同步前后台约定；管理端未发现该接口消费者 |

## 2026-09-14 追加：页面超时及各类轨迹演示

用户已明确授权重启后端、更新核实/回告表，并补齐执行、未执行5条、计划匹配、计划偏离等演示数据。

- 旧进程直接运行 target 下的 jar，构建覆盖该文件后发生 NoClassDefFoundError，连健康检查也超时。已改为校验哈希后复制到独立运行目录，再启动；后续构建不会覆盖正在运行的包。
- 旧“完全匹配”样例的5个观测点位置相同，不能把计划灰线直接染绿。轨迹接口增加“实测点都在同一位置”的说明，保留位置点，不补造旧轨迹。
- 新增本地专用 LocalFlightPathDemoSeeder，每天独立标识，保存移动观测后由现有规则引擎计算结论。四个名称为“执行中·计划匹配（演示）”“执行中·计划偏离（演示）”“已完成·计划匹配（演示）”“已完成·轨迹中断（演示）”。匹配有绿线，偏离有红绿片段，中断保留缺口；重启不改已有观测及研判。
- 保留原有5条待执行通知演示计划。额外的旧纯状态待执行样例，仅在mock且无核实历史时转为取消，避免变成6条待执行；不删除历史，不影响真实计划。
- 飞行计划列表、详情和顶部“偏离报备计划”统一读取C01走廊 MISMATCH。PARTIAL可能只是身份线索不足，不能按偏离计数。
- 新数据只在 local 且 app.dev-seed.enabled=true 时加入，不向 production 注册。执行中样例记录的是已观测历史片段，不是持续实时模拟器；状态随计划时段推进。

本次追加文件：LocalFlightPathDemoSeeder.run/seed（保存独立模拟场景并调用引擎）；FlightTrajectoryService.read（解释静止/无实测）；planMatch.js.hasRouteDeviation（读取明确偏离事实）；FlightsPage.vue.rowMatch/pageMatchCounts/matchMetricText（统一列表、详情、统计）；FlightPathDemoPostgresTest（移动、偏离、断点、旧静止样例及幂等回归）。

追加验收结果：8个PostgreSQL接口/场景测试及2个轨迹单元测试通过，0失败/错误/跳过；前端3个匹配边界断言、107文件控件扫描、Vite构建、后端package和git diff --check通过。当前业务库实际状态为待执行5、执行中3、已完成26、已取消2（04:49时点，后续随时间推进）。核实/回告迁移已应用，健康检查HTTP200。用户重新登录后，已在当前Chrome localhost:5173页面实际查看绿线、红绿偏离及缺口；未匹配计划的核实按钮可点击且表单正常打开，未提交测试业务结论。实际回告通道仍待接入。

## 行为

- 待执行计划为“暂不判定”；执行中/已完成以计划航线版本作底图。实测范围内绿、偏离红、未知或边界黄，无观测计划段灰虚线。
- 只画计划时段内实测点，不用预测/桥接点补历史。跨轨迹、点序号缺失、时间倒序或超过已有 C03 gap_seconds 时断开；参数缺失只画点。DEMO 参数明确提示。
- 颜色是实测点横向走廊关系，不是合法性结论。相邻点连线仅辅助显示，不证明两点之间持续观测或整段在走廊内。
- 计划开始后未匹配目标，值班员填写结论、依据、说明；办理人/时间由服务端记录。设备异常保留起飞 UNKNOWN，未按计划起飞为 NOT_TAKEN_OFF。不修改计划状态、不生成处置告警。
- 页面通过“保存并通知报送单位”一次提交，依次调用核实和来源通知接口；接收方为本计划登记且启用的来源。核实和通知独立存储，提交、投递、回执、处理结果分别保存。核实成功而通知提交失败时保留核实结果，刷新核对后只继续通知；缺通知权限或接收单位时明确仅保存。本轮只修改前端，未测试、未构建。

## 接口与持久化

统一前缀 `/api/v1/flight-plans/{plan_id}`，Bearer、ApiResponse、snake_case；ID 字符串，时间 epoch 毫秒，坐标 WGS-84 度。null 沿用全局省略规则，不代表成功或零。

| 接口 | 权限与输入 | 输出 |
| --- | --- | --- |
| GET /trajectory | flight:read；实际对照另需 assessment:read、target:read、route:read及各自范围 | availability、target_id、gap_millis、param_status、points、note；点含 point_id、track_id、point_seq、observed_at、longitude/latitude、corridor_relation、break_before |
| GET /verifications | flight:read及计划范围 | revision、来源接收方、动作许可/阻断原因、verifications、feedback |
| POST /verifications | flight:verify及flight:read；Idempotency-Key；conclusion、evidence（1–4000字）、note（1–2000字）、expected_revision（首次0） | 核实记录及服务端办理人/时间 |
| POST /verifications/feedback | handoff:create及flight:read；Idempotency-Key；verification_id、recipient_id | 独立回告记录和渠道状态 |

trajectory availability：AVAILABLE / NOT_APPLICABLE / UNAVAILABLE / NO_EVALUATION；corridor_relation：WITHIN / OUTSIDE / BOUNDARY / UNKNOWN。授权失败403，对象不可见404，分页不完整409，不回退Mock。

flight_plan_verification 追加历史，唯一(plan_id,revision_no)；flight_plan_feedback 每条核实记录唯一。行锁、expected_revision、幂等键与数据库约束防重复/旧版本提交。仅最新结论可回告；错误来源、未核实、旧版本返回409。取消、未到时、已匹配目标、不能读取对照时阻断核实。

新动作 flight:verify 不自动授予普通角色。部署后端运行 V202609140001__flight_verification_feedback.sql，不修改已应用迁移。

## 边界与验证

已实现记录持久化、审计、权限/范围、并发保护、页面读写和现有通知端口复用。来源暂以 integration_source 标识。真实单位投递地址、适配器、异步回执/结果协议、自动重投尚未接入。未接通保持 PENDING_DELIVERY / NOT_EXPECTED、结果为空，不代表已发送。live 禁止模拟成功；模拟送达也不自动生成回执/结果。

每点复用现有空间距离查询，大规模轨迹仍需性能验收。首次交付时业务后端未重启；用户追加授权后已重启并应用核实/回告迁移。现场设备和真实回告仍未验收。

- H2 定向测试24例：核实5、实际对照5、轨迹2、认证9、模拟通知3。
- 独立 PostgreSQL/PostGIS 核实测试5例：迁移、落库、未知起飞、来源、重复/版本保护、待执行轨迹。库为 stage_flight_verify_20260914，不写业务库。
- 浏览器使用隔离组件夹具，所有API被测试夹具拦截，不登录业务系统。验证核实、回告、计划切换及状态展示，不能视为真实登录联调。
- 源码控件扫描106文件通过。常规 npm run build 因现有 .bin/vite 跨项目链接失败，替代构建命令：`node node_modules/vite/bin/vite.js build --configLoader runner`。
- 自动审批拒绝预置管理员凭据登录，未绕过；真实登录路由仍未联调。
- 最终结果：上述24个H2/单元测试与5个PostgreSQL测试均为0失败/错误/跳过；后端离线 `-DskipTests package` 和替代Vite构建通过。1280×720、1366×768、1440×900 隔离浏览器检查无document横向溢出，地图保留一个canvas，控制台无error。隔离地图因未接底图桥接使用既有简化示意图，不能视为现场地图验收。

## 代码变更说明

| 文件/类 | 方法/函数 | 方法作用与本次修改 |
| --- | --- | --- |
| FlightsPage.vue | rowMatch/loadRowActuals/loadDetail/loadMatchedTarget/renderRouteMap、卸载钩子 | 待执行不判定、实测分段、旧请求保护、核实入口及地图高度 |
| planTrajectory.js | trustedTrajectoryPoints/strokePlanComparison | 可信点、红绿分段、灰虚线、断点 |
| PlanVerificationPanel.vue | reload/verify/feedback、卸载钩子 | 必填表单、历史、来源回告、状态分列与切换保护 |
| flightApi.js | trajectory/verifications/verifyPlan/feedbackPlan | 新接口与幂等请求 |
| labels.js | 无具体方法 | 核实权限中文标签 |
| FlightTrajectoryController、FlightTrajectoryService | trajectory/read/measured/continuous | 计划时段实测读取、空间关系、断点 |
| FlightActualsRepository | trackGapMillis | 读取研判版本的已有间隔参数 |
| FlightVerificationController、FlightVerificationDtos | read/verify/feedback；DTO无具体方法 | 核实与回告传输契约 |
| FlightVerificationService | read/verify/feedback/blocker | 权限、结论追加、回告、审计与并发守卫 |
| FlightVerificationRepository | lockPlan/verifications/feedback/sourceEnabled/insert | 独立持久化和来源检查 |
| PermissionCode | 无具体方法 | 新增FLIGHT_VERIFY |
| MockSuperiorHandoffChannel | deliver | 模拟送达不等于回执完成 |
| V202609140001__flight_verification_feedback.sql | 无具体方法 | 两张表、外键/唯一/状态约束及动作权限 |
| FlightVerificationApiTest、FlightVerificationPostgresTest | 5个接口测试及隔离配置 | 核实、来源、重复/版本冲突、待执行轨迹回归 |
| FlightTrajectoryServiceTest | 2个轨迹规则测试 | 断点和预测/桥接排除 |

前端在 dongying-vue/src，后端类在 server/src/main/java/com/uav/lowaltitude/modules，测试在 server/src/test/java 同包。仅列本次飞行计划修改，保留原有其他工作区改动。
