# 协作者 B 阶段 4–6 详细实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` in the existing leader/executor tasks, or `superpowers:subagent-driven-development` for explicitly delegated subtasks. Steps use checkbox (`- [ ]`) syntax for tracking. 用户已经指定“四个对话、领导 + 执行者 2 人 + 只读审查者”，无需再次询问工作模式；用户要求覆盖技能默认分支/提交建议，全部只在 `main`，禁止新建分支或 worktree。

**Goal:** 把现有告警、风险、工作台、交接、统计和大屏接到后端，让支持的按钮真正保存、刷新不丢、不同页面结果一致，并明确标出尚未接入的真实设备和外部系统。

**Architecture:** 来源告警、无人机核实、飞行风险、设备异常分别拥有自己的事实和状态。工作台只聚合、动作委托源模块；交接独立保存提交与投递事实；统计和大屏在同一权限范围与数据库快照中读取事实，不再以浏览器 Mock 或局部变量作为真源。

**Tech Stack:** Java 17、Spring Boot 3.4.5、MyBatis、Maven Wrapper、Flyway、PostgreSQL 16/PostGIS；H2 只用于快速测试。前端沿用 Vue 3、JavaScript、Vite、原生 CSS、Naive UI 和现有页面/地图，不新增依赖。

## Global Constraints

- 所有对话只允许在 `main` 分支修改；不得新建分支、Git worktree、合并、变基或拣选其他分支。
- 执行者不提交，领导在审查和验证通过后按阶段统一提交；禁止 `git add .` 混入他人文件。
- 以当前源码描述现状；业务文档描述目标，不把旧路线图或演示状态当成已有后端能力。
- 前端不重做布局、样式和导航；仅接接口、替换数据、补状态与权限提示。新表单使用现有公共 Naive UI 表单件。
- 不改 A 的协议、真实反制、射频发送和设备控制逻辑；保留 `/api/v1/sensing/*` 及阶段 2/3 标准接口。
- 不接真实短信、上级/处罚系统，不实施处罚立案、罚款、结案，不建设正式证据保管或正式报表导出。
- 生产不生成模拟数据；开发种子同时要求 `!production & (local | test)` 与 `app.dev-seed.enabled=true`。模拟/回放/真实来源显式区分。
- 动作权限、精确组织/区域范围、并发版本、幂等、事务和审计必须在服务端落实。
- ID 为字符串；REST 时间为 epoch 毫秒；业务取时使用 `AppClock`；仅展示可信 WGS-84，未知坐标不是 `(0,0)`。
- 关键业务逻辑必须加中文注释，说明为什么这样做；不逐行翻译代码。
- 每阶段先自动化验证，再浏览器验证；没有运行证据不能写“完成”“通过”。

---

## 1. 先说人话：每阶段交付什么

| 阶段 | 做完后你能测试什么 | 本阶段不会假装做完什么 | 预计时间 |
| --- | --- | --- | --- |
| 4：告警和风险 | 点开告警核实属实/误报/证据不足；对风险核验或排除；刷新看保存结果和操作历史 | 核实属实不等于反制成功；核验风险不等于已经通知上级 | 3–4 个工作日 |
| 5：工作台和交接 | 工作台与源页面显示同一状态；从工作台跳详情；提交风险通知后在交接页找到记录，刷新仍在 | 未接通渠道只显示“已提交，尚未发送”；设备恢复和无人机处罚交接缺前置能力时禁用 | 2–3 个工作日 |
| 6：统计、大屏和验收 | 统计数字能点回列表核对；大屏刷新真实数据；不同账号只看到自己有权看的记录 | 未建设的处罚数、正式导出等显示“尚未接入”，不填假数字 | 2–3 个工作日 |

合计 **7–10 个工作日**，两个执行者并行已计入工期，不再除以二。D1 指领导完成基线核验并启动阶段 4 的工作日；不承诺一晚上完成三个阶段。阶段 3 若回归存在阻断，先由原负责人修复，后续日期顺延。

本计划验收的是“可持久化、可点击验证的业务软件切片”，不等于生产上线、真实反制、真实通知送达或行政处罚全流程验收。

## 2. 计划依据与当前事实

编制时仓库为 `main`，基线提交 `1883a89`，阶段 2 目标/轨迹切片为 `150dfa6`。这只说明代码已落地，不代替领导启动时的新一轮测试。

- 已有阶段 2 目标/轨迹读取及阶段 3 计划、航线、空域、合法性读取；继续复用。
- `modules/alarm/api/AlarmController.java` 的标准告警接口仍是空列表占位，需原位替换，不能注册重复路由。
- `alarm` 是来源告警表，不是处置状态机；同目标可以有多条独立告警，不得按目标 ID 合并成一件事件。
- `assessment_result` 必须关联计划、航线版本与规则版本，不能拿它强行承载没有计划的无人机告警。
- 运维异常来自 `device_incident → ops_device`；`ops_device` 的单位/区域名称不能替代组织/区域 ID。它与阶段 2 `device` 是不同模型。
- 现有设备异常恢复/关闭尚无后端命令；`workbenchEvents.js` 的对应动作只改内存，本期禁用，不扩建 A 的设备恢复流程。
- `OutboxWorker` 当前处理设备主题，不能把通知交接直接塞进去；本期交接独立持久化待投递，不新增真实发送 Worker。
- 存储端口不等于证据服务，文件、真实哈希、下载授权和保管闭环未建成；交接只保存本期可证实的结构化核实材料，不生成假文件。
- 当前通用拒绝审计由 `GlobalExceptionHandler` 在业务事务退出后调用 `recordStandalone`；应测试数据库留痕，不能误称已有审计一定回滚。

启动时必读：根目录、前端、后端 `AGENTS.md`；`CONTEXT.md`；对应设计文档；`docs/后端开发基线.md`；阶段 3 接口契约。旧基线中的“尚未实现”可能已过期，领导以源码和验证更新事实说明，不覆盖业务确认约束。

## 3. 四个对话如何分工

领导使用现有任务 **“明早9点｜只汇总待确认事项”**。复用原有两名执行者和审查者任务；找不到原任务时由领导列清对应角色再建立缺失任务，避免重复启动两组执行者。

| 角色 | 阶段 4 | 阶段 5 | 阶段 6 |
| --- | --- | --- | --- |
| 领导 | 冻结接口/权限/状态，公共文件、迁移版本、顶栏接线，集成提交 | 冻结设备范围与交接资格，共享权限、统计粒度契约 | 共用快照组件、指标字典、全路由验收组织、最终提交 |
| 执行者 1 | 无人机告警/核实后端、测试、告警页 | 工作台后端、设备异常安全聚合、工作台页 | 统计后端与统计页、统计测试 |
| 执行者 2 | 飞行风险后端、测试、飞行计划页风险标签 | 交接后端、测试、处罚页最小改为交接展示 | 大屏后端与大屏页、刷新/退出清理测试 |
| 审查者 | 只读检查状态、越权、幂等、历史和页面误导 | 只读检查去重、设备范围、跨页状态与假送达 | 只读检查统计口径、全角色隔离、证据与结论一致 |

协作纪律：

1. 领导开始每阶段前发“基线提交、文件归属、接口版本、迁移号、可并行任务、验收门槛”。
2. 两执行者只修改分配文件；公共文件或对方文件的修改请求交领导，不能抢写。
3. 公共所有者固定为领导：`PermissionCode.java`、共用授权/审计/异常组件、迁移目录分配、`apiClient.js`、`accessControl.js`、`navModel.js`、`registry.js`、`HeaderBar.vue`、共同契约文档。无必要不修改这些文件。
4. 独立单测可以并行；会共同写 `server/target` 的完整 Maven 构建、数据库迁移验证、共享开发库改动由领导串行运行。浏览器共享登录/服务启停同样由领导协调。
5. 执行者交付说明：改了哪些文件、接口、测试实际结果、尚未接入项、需要领导处理的事项。审查者不直接修复，指出文件位置、复现方法、风险和建议。
6. P0/P1 阻断阶段完成；P2 记录并决定修复或延期，不静默丢弃。修复后原审查者复核。
7. 领导仅提交本阶段已核验文件，保留其他任务未提交内容；每阶段结束更新接口文档和验收记录。

## 4. 公共契约：先冻结再并行

### 4.1 接口格式、过滤与权限

沿用 `{ok:true,data:...}` / `{ok:false,error:{code,message}}`、snake_case。禁止把数据库 Entity、原始 JSONB payload、设备凭据和内部网络地址直接返回。

列表沿用仓库已冻结契约：`page=1`、`size=20`，允许 1–100；响应为 `items/page/size/total`。页码必须正整数，溢出、重复、未知参数（包括 `page_size`）返回 400。超出最后一页返回空 `items`，`total` 仍是该用户同过滤条件下的总数。固定排序，不接受任意 SQL 字段排序。

| 数据 | 允许过滤 | 固定排序 |
| --- | --- | --- |
| 告警/无人机事件 | `state,severity,target_id,occurred_from,occurred_to,owner_org_id,district_id,source_mode` | `received_at DESC, alarm_id DESC` |
| 风险 | `state,severity,plan_id,occurred_from,occurred_to,owner_org_id,district_id,source_mode` | `received_at DESC, risk_id DESC` |
| 操作历史 | 仅分页 | `version ASC, history_id ASC` |
| 工作台 | `kind,state,severity,occurred_from,occurred_to,owner_org_id,district_id,source_mode` | `severity_rank DESC, received_at DESC, kind ASC, source_id DESC` |
| 交接 | `source_kind,source_id,delivery_status,created_from,created_to,source_mode` | `created_at DESC, handoff_id DESC` |

时间过滤统一半开区间 `[from,to)`，单位毫秒，起点必须小于终点；未知发生时间不伪造，按发生时间筛选时不匹配，页面显示“发生时间未知”。工作台 `state` 与 `kind` 必须成对过滤，禁止将三类状态混成统一状态。

权限目录：新增 `ALARM_VERIFY("alarm:verify")`、`RISK_READ("risk:read")`、`RISK_VERIFY("risk:verify")`、`WORKBENCH_READ("workbench:read")`、`HANDOFF_READ("handoff:read")`、`HANDOFF_CREATE("handoff:create")`、`REPORTING_READ("reporting:read")`、`BIGSCREEN_READ("bigscreen:read")`；复用已有 `alarm:read`、`target:read`、`flight:read` 等。

- 写核实要求源对象读权限 + 核实权限；创建通知要求源对象读权限 + `handoff:create`。所有 GET/POST 都先完成所需动作鉴权，再解析 query/path、查对象或判断幂等重放；缺任一动作权限时即使同时存在非法参数、无效 ID 或旧幂等键也先返回 403，避免借 400/404/409 差异探测接口与对象。
- `ALL` 不是无条件免校验：没有完整归属、归属已停用的数据不可见；`ASSIGNED` 使用同一条有效授权元组匹配组织和区域，不能分别做两个 IN 集合。
- 列表、详情、历史、关联记录、地图、KPI、`total` 共用范围谓词。源对象无权限/跨范围不回传 ID、摘要、计数或动作；直接访问按 404，缺动作权限 403。
- 工作台/统计/大屏除各自读权限，还检查每个源模块读权限。没有对应源读权限的分项返回 `FORBIDDEN` 可用性标记、`value:null`，不泄露其总数。
- 设备汇总要求 `device:read` 且沿用已有运维菜单读取许可；新权限不自动替代旧设备动作授权。源设备 API 的实际范围另做验收，不以聚合层过滤掩盖旧接口漏洞。
- `allowed_actions` 来自后端当前对象状态和操作者权限；隐藏按钮不替代写请求重新检查。

### 4.2 核实状态和原子写入

| 对象 | 当前状态 | 允许结论 | 新状态/显示文案 |
| --- | --- | --- | --- |
| 无人机 | `PENDING_VERIFICATION` 或 `EVIDENCE_REQUIRED` | `CONFIRMED` | 已核实，待处置；反制未接入 |
| 无人机 | 同上 | `FALSE_POSITIVE` | 误报，结束核实 |
| 无人机 | 同上 | `EVIDENCE_REQUIRED` | 证据不足，待补充；允许再次核实 |
| 风险 | `PENDING_VERIFICATION` | `CONFIRMED` | `PENDING_NOTIFICATION`，待通知 |
| 风险 | `PENDING_VERIFICATION` | `EXCLUDED` | `EXCLUDED`，已排除 |

每次结论必须填写去首尾空白后 1–1000 字的说明。证据不足后再次提交仍保存独立历史、递增版本。误报、已排除和已确认不可用同一核实接口反复改结论；撤销/重开不属于本期。`CONFIRMED` 不能显示“反制中”“已处置”。

所有新写请求带 8–128 字符 `Idempotency-Key` 和非负整数 `expected_version`。幂等 operation 使用明确类型、资源 ID、结论、说明、版本的稳定序列化，不只记录动作名。复用现有 `IdempotencyGuard`：同键同请求 409 `IDEMPOTENCY_REPLAY`，同键不同请求 409 `IDEMPOTENCY_KEY_REUSED`；不改造成影响旧接口的全局缓存响应协议。

写事务顺序固定为：

```text
取得当前会话 → 验证读/写权限 → 按范围查询并锁定源对象
→ 在本事务 claim 幂等键 → 检查版本、状态和前置条件
→ 带 version 条件更新一行 → 插入一条业务历史 → 写一条成功审计 → 提交
```

已成功请求再次同键提交时，在旧版本/终态检查前识别为 `IDEMPOTENCY_REPLAY`；权限已撤销或对象已不可见时仍优先拒绝访问，不为了重放泄漏旧结果。更新行数不为 1 时抛 409 `VERSION_CONFLICT`；状态不允许抛 409 `INVALID_TRANSITION`。任何一步失败回滚状态、历史、幂等占位和成功审计。失败审计复用事务退出后的统一异常路径，记录脱敏错误码，不在事务内另写一条“失败”导致重复。现有守卫遇到跨对象同键并发竞争可能返回 `IDEMPOTENCY_KEY_REUSED`，不擅改该既有契约。

页面第一次提交保留幂等键并禁用重复点击；请求超时显示“提交结果未确认，请刷新核对”，先 GET 当前版本和历史。409 刷新，不自动换新键重试，也不弹成功提示。服务端逻辑唯一约束仍必须存在，不能仅依赖浏览器防抖。

### 4.3 交接的真实边界

- 风险 `PENDING_NOTIFICATION` 可以创建 `RISK_NOTICE`；接收方从启用的后端逻辑接收方目录选择，生产未配置时返回 409 `RECIPIENT_NOT_CONFIGURED`，不硬编码某部门。
- 提交成功只表示材料入库，返回 201，`delivery_status=PENDING_DELIVERY`、`blocked_reason=CHANNEL_NOT_CONNECTED`。源风险仍为 `PENDING_NOTIFICATION`。
- 普通已核实无人机没有可信反制/干扰完成事实，本期 `UAV_PUNISHMENT` 创建一律阻断为 `HANDOFF_PREREQUISITE_UNAVAILABLE`；前端禁用并解释。不能另造“提交材料”入口绕过已确认业务主线。
- 不开放浏览器可写送达/回执的接口；不将交接放入现有设备 Outbox。发送重试不在本期，因为渠道本身未接通。
- 逻辑唯一性为 `(source_kind,source_id,handoff_type,recipient_id)`；同一事项双人不同键提交也只有一份交接。命中唯一记录时返回 409 `HANDOFF_ALREADY_EXISTS`，错误体仍只有 code/message；有 `handoff:read` 的客户端再按 source_kind/source_id 查询已有交接，不扩展全局错误结构来塞业务 ID。
- 交接头、材料快照、首条待投递记录、幂等和成功审计同事务。创建前锁源对象，核对 `expected_version`；不把交接创建本身当作风险状态变化。
- 只冻结可授权的结构化材料：核实结论、说明、来源 ID、发生/接收时间、可见关联引用及其版本。没有实际文件就不生成文件名、哈希、视频、授权单或下载链接。
- 材料读取既检查交接归属，也重新检查源记录和引用对象当前权限，防止归属变化后旧快照泄漏。不可见关联从响应删除，不能泄漏为“有 3 个无权对象”。
- `delivery_status` 与 `receipt_status` 分开；已送达、等待回执超时可并存。历史样例只读并标记 mock；本期生产写入只会生成待投递。

## 5. 数据与文件分配

下列 `J/` 表示 `server/src/main/java/com/uav/lowaltitude/`，`T/` 表示 `server/src/test/java/com/uav/lowaltitude/`，`F/` 表示 `dongying-vue/src/`。这是文件清单缩写，不是可直接传入命令的路径。

### 5.1 新增数据表

| 表/所有者 | 必要字段与约束 |
| --- | --- |
| `uav_event` / 执行者 1 | `event_id` PK，`alarm_id` UNIQUE FK，state，version，owner_org_id，district_id，created_at，updated_at；一条来源告警默认一个事件，不跨告警合并 |
| `uav_event_verification` / 执行者 1 | history_id PK，event_id FK，version，previous_state，resulting_state，conclusion，note，actor_id，created_at；UNIQUE(event_id,version)，只增历史 |
| `flight_risk` / 执行者 2 | risk_id PK，source_id，source_risk_id，plan_id FK，route_version_id FK，assessment_result_id 可空 FK，risk_type，severity，state，summary，source_mode，occurred_at 可空，received_at，owner_org_id，district_id，version，created_at，updated_at；UNIQUE(source_id,source_risk_id) |
| `flight_risk_verification` / 执行者 2 | 与无人机历史同形但关联 risk_id，独立状态与结论；UNIQUE(risk_id,version) |
| `device_business_scope` / 领导 | ops_device_id PK FK ops_device，owner_org_id FK app_org，district_id FK app_district；两个范围字段非空，禁止名称推断或与新 device 按 ID 硬连 |
| `handoff_recipient` / 执行者 2 | recipient_id PK，display_name，handoff_type，enabled；逻辑部门目录，不存凭据/网络信息，生产不自动插入接收方 |
| `handoff` / 执行者 2 | handoff_id PK，source_kind，source_id，risk_id 可空 FK，event_id 可空 FK，handoff_type，recipient_id FK，source_version，owner_org_id，district_id，source_mode，submitted_by，created_at；source_kind 对应 FK 必须恰有一项，source_id 与 FK 一致；逻辑唯一约束见 4.3 |
| `handoff_material_snapshot` / 执行者 2 | handoff_id PK/FK，schema_version，结构化白名单 snapshot JSONB；快照只增不改、读取复核当前范围 |
| `handoff_delivery` / 执行者 2 | delivery_id PK，handoff_id FK，attempt_no，delivery_status，receipt_status，blocked_reason，created_at，submitted_at/delivered_at/acknowledged_at 可空；UNIQUE(handoff_id,attempt_no) |

`flight_risk` 必须证明计划与航线版本一致；关联研判时还须证明研判关联的是同计划和航线版本。风险不是合法性结论，`ILLEGAL` 不自动生成风险/告警。没有已确认生产规则就不建设距离、高度余量或鸟类风险评分算法。坐标和空间依据优先引用阶段 3 的不可变版本，不重复制造另一套几何数据。

风险内部入库用例接收可信、已归属的风险事实；没有来源则生产返回真实空列表。本期不提供任何用户可任意创建风险的公共接口，也不假称 A 已提供风险输出。

所有枚举、FK、逻辑唯一和非负版本有数据库约束；归属索引覆盖列表与 count。设备映射可由受控迁移/配置资料导入，本期不另建管理页面。

### 5.2 迁移和正式文档

建议预留新版本（执行前必须再次检查实际目录，由领导重新确认没有碰撞）：

```text
server/src/main/resources/db/migration/V202609050020__stage4_action_permissions.sql
server/src/main/resources/db/migration/V202609050021__uav_event_verification.sql
server/src/main/resources/db/migration/V202609050022__flight_risk_verification.sql
server/src/main/resources/db/migration/V202609050030__stage5_permissions_and_device_scope.sql
server/src/main/resources/db/migration/V202609050031__handoff_submission.sql
server/src/main/resources/db/migration/V202609050040__stage6_reporting_permissions.sql
docs/backend-stage4/alarm-risk-api-contract.md
docs/backend-stage4/acceptance.md
docs/backend-stage5/workbench-handoff-api-contract.md
docs/backend-stage5/acceptance.md
docs/backend-stage6/reporting-metric-contract.md
docs/backend-stage6/acceptance.md
```

原迁移不能修改；生产迁移只增加权限目录，不给管理员、默认角色或现有账号自动授权。新增 PostgreSQL 专用约束/索引沿用 `db/postgresql` 分离方式，并纳入实际迁移测试。

## 6. 阶段 4：告警和风险，3–4 个工作日

### Task 4.0：冻结契约和可测数据 / 领导，约半天

Files：修改 `J/modules/identity/domain/PermissionCode.java`；创建迁移 020；创建 `T/modules/identity/application/Stage4AccessControlServiceTest.java`；创建阶段 4 契约文档。仅在测试证实需要时小改共享审计/异常组件。

Consumes：`AccessControlService.require(PermissionCode)`、`AccessDecision`、`IdempotencyGuard.claim(String,String)`、`AppClock` 和现有审计服务。Produces：本文 4.1–4.2 的权限、请求/错误/状态契约，以及迁移号和字段归属表。

- [ ] 核验 `main`、HEAD、未提交文件及阶段 2/3 回归；保留无关文件，记录接口现状。
- [ ] 先写权限回归：只有菜单不能访问 ACTION；有写无读仍 403；有效元组只允许精确组合；production/local 混合 profile 不载入授权种子。
- [ ] 运行 `./mvnw -Dtest=Stage4AccessControlServiceTest test`，确认新增权限用例先失败且不是环境故障。
- [ ] 增加权限枚举和目录，按既有 ACTION 目录约定集成；复用授权服务，不重写认证系统。
- [ ] 验证现有 `J/modules/identity/application/LocalStage2AccessSeeder.java` 已遍历 `PermissionCode.values()`，能在双门禁下为唯一合成 admin1 补齐新增动作；不创建重复授权 Seeder。扩展 `T/modules/identity/application/LocalStage2AccessSeederTest.java`，证明新增权限在 production 不授予、permission_version 变化后旧会话不能继续使用，测试操作账号可重新登录。
- [ ] 用同命令验证通过，把冻结契约分别交两执行者；由领导独占配置现有开发库和角色样例。

测试矩阵的固定数据为两个元组 `(org-a,district-a)` 与 `(org-b,district-b)`，再造 `(org-a,district-b)` 反例；只授权前两元组的账号必须看不到反例。

### Task 4.1：无人机告警查询和核实 / 执行者 1，约 1.5–2 天

Files：原位修改 `J/modules/alarm/api/AlarmController.java`；新增同模块 `api/UavEventController.java`、`application/AlarmReadService.java`、`application/UavEventVerificationService.java`、`domain/UavEventState.java`、`infrastructure/AlarmReadRepository.java`、`infrastructure/UavEventRepository.java`；迁移 021；`J/integration/mock/LocalStage4AlarmSeeder.java`；`F/services/alarmApi.js`、`F/pages/AlarmsPage.vue`。Tests：`T/modules/alarm/api/AlarmReadApiTest.java`、`UavEventVerificationApiTest.java`、`T/integration/mock/LocalStage4AlarmSeederTest.java`。

Consumes：阶段 2 alarm/target、4.0 契约。Produces：

```text
GET  /api/v1/alarms
GET  /api/v1/alarms/{alarm_id}
GET  /api/v1/uav-events/{event_id}
GET  /api/v1/uav-events/{event_id}/verifications
POST /api/v1/uav-events/{event_id}/verifications
body: {"conclusion":"CONFIRMED","note":"已核对目标轨迹","expected_version":0}
data: {"event_id":"evt-a","state":"CONFIRMED","version":1,"updated_at":1788570000000,"allowed_actions":[]}
```

告警响应包含 `alarm_id`、已存在的 `event_id`、来源/时间/等级、安全摘要；无关联事件时 `event_id:null`。GET 不创建事件。生产事件创建由接收告警的内部事务用例负责；本期 local/test Seeder 调用同一内部用例证明去重，不能要求 GET 首次访问建记录。

- [ ] 写并运行查询失败测试：分页边界、空数据、未知字段、跨范围 404、无目标权限不暴露目标引用；source_id/source_alarm_id 重复入库不新增事件，同 target 不同 alarm 必须形成不同事件。
- [ ] 实现表和查询，`items/total` 复用范围条件；对来源 `detail` 只取明确允许的字段。
- [ ] 写并运行状态测试：三种核实结果、证据不足再次核实、终态拒绝、空说明、旧版本、双人并发、同键重放、同键改说明、审计写失败回滚。
- [ ] 实现状态方法与事务；注释明确“核实属实不代表反制已执行”。状态函数最小逻辑如下，结论词典与请求校验共同约束：

```java
// 放入 UavEventState；ApiException 与 HttpStatus 使用当前后端公共类型。
static String nextUavState(String current, String conclusion) {
    if (!java.util.Set.of("PENDING_VERIFICATION", "EVIDENCE_REQUIRED").contains(current)) {
        throw new com.uav.lowaltitude.platform.api.ApiException(
            org.springframework.http.HttpStatus.CONFLICT, "INVALID_TRANSITION", "当前状态不允许核实");
    }
    if (!java.util.Set.of("CONFIRMED", "FALSE_POSITIVE", "EVIDENCE_REQUIRED").contains(conclusion)) {
        throw new com.uav.lowaltitude.platform.api.ApiException(
            org.springframework.http.HttpStatus.BAD_REQUEST, "INVALID_CONCLUSION", "核实结论无效");
    }
    return conclusion;
}
```

- [ ] 补固定种子：三种待核实事件、同目标两条告警、证据不足、无坐标、无关联目标、跨范围反例；种子重启不重置人工结果。
- [ ] 改告警页数据源和核实表单，取消 `window.EVT/window.MOCK` 对该流程的写入；关联目标走标准目标 API；不渲染无权或不可信地图点。
- [ ] 运行 `./mvnw -Dtest=AlarmReadApiTest,UavEventVerificationApiTest,LocalStage4AlarmSeederTest test`，再执行前端检查并交只读审查。不要自行提交。

前端 `alarmApi.js` 提供 `listAlarms(query)`、`getAlarm(alarmId)`、`getUavEvent(eventId)`、`listUavVerifications(eventId,query)`、`verifyUavEvent(eventId,body,idempotencyKey)`，均返回解包后的 `data`；以现有 `apiRequest` 为唯一请求入口，工作台后续复用。

### Task 4.2：飞行风险查询、核验和排除 / 执行者 2，约 1.5–2 天，与 4.1 并行

Files：新增 `J/modules/risk/api/RiskController.java`、`application/RiskReadService.java`、`application/RiskVerificationService.java`、`domain/RiskState.java`、`infrastructure/RiskRepository.java`；迁移 022；`J/integration/mock/LocalStage4RiskSeeder.java`；`F/services/riskApi.js`、`F/pages/FlightsPage.vue`。Tests：`T/modules/risk/api/RiskReadApiTest.java`、`RiskVerificationApiTest.java`、`T/integration/mock/LocalStage4RiskSeederTest.java`。

Consumes：4.0 契约与阶段 3 计划/航线/空域版本。Produces：

```text
GET  /api/v1/risks
GET  /api/v1/risks/{risk_id}
GET  /api/v1/risks/{risk_id}/verifications
POST /api/v1/risks/{risk_id}/verifications
body: {"conclusion":"EXCLUDED","note":"核对后未影响计划航线","expected_version":0}
data: {"risk_id":"risk-a","state":"EXCLUDED","version":1,"updated_at":1788570000000,"allowed_actions":[]}
```

- [ ] 写查询/入库失败测试：计划航线版本不匹配拒绝、非法关联研判拒绝、未知高度不判断安全、跨范围计划/轨迹不返回、来源重复不增风险。
- [ ] 实现风险表和安全查询；必要依据从已保存版本读取，不用当前最新规则覆盖历史。
- [ ] 写核验测试：待核验能确认/排除，待通知不能再排除，重复/旧版 409，不写 `NOTIFIED`；成功和失败审计入库。
- [ ] 实现独立状态方法和核实事务：

```java
// 放入 RiskState；不要把业务拒绝作为原生异常交给全局处理器，否则会返回500。
static String nextRiskState(String current, String conclusion) {
    if (!"PENDING_VERIFICATION".equals(current)) {
        throw new com.uav.lowaltitude.platform.api.ApiException(
            org.springframework.http.HttpStatus.CONFLICT, "INVALID_TRANSITION", "当前风险状态不允许核验");
    }
    return switch (conclusion) {
        case "CONFIRMED" -> "PENDING_NOTIFICATION";
        case "EXCLUDED" -> "EXCLUDED";
        default -> throw new com.uav.lowaltitude.platform.api.ApiException(
            org.springframework.http.HttpStatus.BAD_REQUEST, "INVALID_CONCLUSION", "风险核验结论无效");
    };
}
```

- [ ] 提供固定风险和范围反例；无生产规则/来源时保持真实空集合，不把 mock 的评分公式移入生产。
- [ ] 飞行计划页风险标签接 API，保留 `#/risk` 别名；显示依据、核验、排除及保存历史，通知按钮在阶段 5 前禁用。
- [ ] 运行 `./mvnw -Dtest=RiskReadApiTest,RiskVerificationApiTest,LocalStage4RiskSeederTest test`，执行前端检查后交审查。

`riskApi.js` 提供 `listRisks(query)`、`getRisk(riskId)`、`listRiskVerifications(riskId,query)`、`verifyRisk(riskId,body,idempotencyKey)`；请求/返回约定与 4.1 相同但不共用业务状态机。

### Task 4.3：集成、审查、浏览器验收 / 领导和审查者，约 1–1.5 天

Files：领导修改 `F/layout/HeaderBar.vue` 中告警铃的数据来源；新建 `T/modules/alarm/api/Stage4PostgresTest.java`、`T/integration/mock/ProductionStage4SeedIsolationTest.java`；补阶段 4 验收文档。

- [ ] 顶栏未处理告警数使用与列表相同的权限/状态条件，无权限清空旧数字；不引入第二个 Mock 总数。
- [ ] PostgreSQL 验证实际迁移、FK、唯一约束、带版本更新和两并发事务；测试断言一条成功历史，不只断言 HTTP。
- [ ] 审查者检查越权、失败审计、Mock 消费者、未知坐标、结论文案；执行者分别修复，领导处理公共文件。
- [ ] 串行运行完整后端测试、前端构建/scan/falsify、差异检查并记录实际失败/跳过。
- [ ] 浏览器单击进入告警 → 填说明核实 → 刷新/重进仍存在 → 证据不足可继续 → 属实不显示反制成功；飞行计划风险核验/排除后刷新保持。
- [ ] 两浏览器会话同时提交同对象；一方成功、另一方冲突并刷新。断后端时显示接口错误，无 Mock 回退；核实输入含 HTML 时作为文本展示。
- [ ] 领导确认 P0/P1 为零并完成阶段提交；阶段 4 不以通知按钮仍禁用判失败，禁用原因必须明确。

## 7. 阶段 5：工作台和交接，2–3 个工作日

### Task 5.0：源事项身份和设备范围 / 领导，约半天

Files：迁移 030；`J/modules/identity/domain/PermissionCode.java`；`J/modules/device/infrastructure/DeviceBusinessScopeRepository.java`；`T/modules/device/api/DeviceBusinessScopeTest.java`；阶段 5 契约文档。

Consumes：stage4 源状态、既有 `device_incident/ops_device`。Produces：明确源身份 `(kind,source_id)`；kind 为 `UAV_EVENT/RISK/DEVICE_INCIDENT`，source_id 分别为 event_id/risk_id/incident_id，不是 target_id/device_id。

- [ ] 写设备范围失败测试：同名不同设备不误映射、无映射不出现在列表/count/地图、精确元组不可交叉授权、禁用归属隐藏。
- [ ] 建显式映射，local/test 配置固定运维设备归属，生产不按名称猜测；无可用设备数据源时返回 `UNCONFIGURED` 可用性，不将未知解释为“无异常”。
- [ ] 在 `DeviceBusinessScopeRepository.java` 提供安全子查询给工作台/统计复用，过滤必须发生在数据库分页和 count 之前。谓词核心：

```sql
EXISTS (
  SELECT 1 FROM app_user_data_scope s
  JOIN app_org o ON o.org_id=s.org_id AND o.enabled=TRUE
  JOIN app_district d ON d.district_id=s.district_id AND d.enabled=TRUE
  WHERE s.user_id=:user_id
    AND s.org_id=device_scope.owner_org_id
    AND s.district_id=device_scope.district_id
)
```

- [ ] 实测现有设备列表/详情/异常的范围；若旧路径越权，领导把相关只读范围补丁明确交设备范围负责人并审查，不得只隐藏入口。需要改 A 正在修改文件时协调文件所有权，不能并发覆盖。
- [ ] 运行 `./mvnw -Dtest=DeviceBusinessScopeTest,DeviceOperationsApiTest test`。无法建立安全设备读取时，禁用对应数据块并将“全设备权限验收”列为阻断，不宣称阶段 6 全量通过。

### Task 5.1：工作台只读聚合与动作接线 / 执行者 1，约 1–1.5 天

Files：新增 `J/modules/workbench/api/WorkbenchController.java`、`application/WorkbenchReadService.java`、`infrastructure/WorkbenchReadRepository.java`；修改 `F/services/workbenchEvents.js`、`F/pages/WorkbenchPage.vue`；新增 `F/services/workbenchApi.js`；测试 `T/modules/workbench/api/WorkbenchReadApiTest.java`。

Consumes：4.1/4.2 源读写 API、5.0 设备范围。Produces：

```text
GET /api/v1/workbench/items
GET /api/v1/workbench/items/{kind}/{source_id}
data.items[]: {kind,source_id,state,severity,received_at,updated_at,version,
               title,summary,allowed_actions,blocked_reason,source_mode,links}
data: {items,total,page,size,counts_by_kind,source_availability,as_of}
```

- [ ] 写去重和排序失败测试：同目标两条无人机事件都保留、同设备两次故障都保留；不同类型 ID 相同不冲突；跨三类数据全局排序分页后无重复/漏数。
- [ ] 使用数据库 `UNION ALL` 或等价单查询先按各源权限/范围过滤，再统一排序分页/count；禁止分别取一页再在 Java 合并。counts 与列表采用同样筛选条件和快照。
- [ ] 详情时间线读取有范围的核实历史、交接记录和已有设备事实；禁止拉全局 audit 查询再让前端筛选。
- [ ] 改 `workbenchEvents.js` 为后端摘要/导航适配，删除本流程内存状态写入；各按钮委托 `verifyUavEvent`/`verifyRisk`/后续 `createHandoff`，不要增加工作台自己的核实 API。
- [ ] 无人机属实显示“已核实，待处置”；未实现反制、设备恢复/关闭和缺前置条件的处罚通知禁用；设备只读跳监测页，不暗示已恢复。
- [ ] 源动作成功后刷新当前事项、队列和计数；路由进入重新 GET，活动页面每 15 秒刷新摘要并在卸载/退出清理。跨页不要求新增 WebSocket。
- [ ] 运行 `./mvnw -Dtest=WorkbenchReadApiTest,DeviceBusinessScopeTest test`；浏览器从告警页核实后切工作台，状态与详情一致，反向核实同样成立。

`workbenchApi.js` 提供 `listWorkbenchItems(query)` 与 `getWorkbenchItem(kind,sourceId)`；`links` 只含经过授权的现有 hash 路由，不允许任意外部 URL。点击地图与列表同一 source_id，未知位置不画点。

### Task 5.2：风险通知提交与交接查询 / 执行者 2，约 1–1.5 天，与 5.1 并行

Files：新增 `J/modules/handoff/api/HandoffController.java`、`application/HandoffSubmissionService.java`、`application/HandoffReadService.java`、`infrastructure/HandoffRepository.java`；迁移 031；`J/integration/mock/LocalStage5HandoffSeeder.java`；`F/services/handoffApi.js`、`F/pages/PunishPage.vue`，阶段 4 完成后接管 `F/pages/FlightsPage.vue` 通知按钮；测试 `T/modules/handoff/api/HandoffApiTest.java`、`T/integration/mock/LocalStage5HandoffSeederTest.java`。

Consumes：风险当前版本和归属、核实记录、4.3 交接规则。Produces：

```text
GET  /api/v1/handoff-recipients?handoff_type=RISK_NOTICE
POST /api/v1/handoffs
body: {"source_kind":"RISK","source_id":"risk-a","handoff_type":"RISK_NOTICE",
       "recipient_id":"recipient-local-a","expected_version":1}
GET  /api/v1/handoffs
GET  /api/v1/handoffs/{handoff_id}
GET  /api/v1/handoffs/{handoff_id}/deliveries
POST data: {"handoff_id":"handoff-a","delivery_status":"PENDING_DELIVERY",
            "receipt_status":"NOT_EXPECTED","blocked_reason":"CHANNEL_NOT_CONNECTED"}
```

- [ ] 写失败测试：待核验风险不能交接、已排除不能交接、无收件方拒绝、普通已核实无人机拒绝、无权源对象404、无权接收方拒绝、客户端夹带回执字段400。
- [ ] 写逻辑唯一和回滚测试：两用户不同幂等键只生成一份交接/一条首投记录；失败后无残留快照或成功审计；重放不新增记录；断连接后能 GET 找到已提交结果。
- [ ] 实现有 FK 的源引用、逻辑唯一约束、白名单快照、事务和待投递记录；不修改设备 Worker、不创建发送定时器、不注册送达写接口。
- [ ] UI 提交后显示“已提交，尚未发送”，链接到交接详情；源状态保持“待通知”。无收件方时显示“接收方未配置”，不以默认部门补值。
- [ ] 处罚页保留现有外壳，真实展示交接清单、材料、提交时间、投递阻断原因；原 Mock 案件/罚款/裁量/证据下载功能停止执行，未实现区域明确禁用。当前不存在真实案件源，不能用交接 ID 伪装 case_id。
- [ ] local/test 提供待投递及明确 mock 历史交接样例；模拟已送达样例只读，不能把生产或普通核实对象推进到处置完成。
- [ ] 运行 `./mvnw -Dtest=HandoffApiTest,LocalStage5HandoffSeederTest test`，执行前端检查与审查。

`handoffApi.js` 提供 `listHandoffRecipients(handoffType)`、`createHandoff(body,idempotencyKey)`、`listHandoffs(query)`、`getHandoff(handoffId)`、`listHandoffDeliveries(handoffId,query)`；工作台只调用该适配，不复制逻辑。

### Task 5.3：跨页和失败场景验收 / 领导和审查者，约半天至 1 天

Files：`T/modules/handoff/api/Stage5PostgresTest.java`、`T/integration/mock/ProductionStage5SeedIsolationTest.java`；阶段 5 验收文档。

- [ ] PostgreSQL 两连接并发验证逻辑唯一、外键、事务失败回滚；检查范围过滤后的全局分页和 count。
- [ ] 浏览器路径：风险核验 → 工作台找到该风险 → 通知上级 → 交接页查到“已提交，尚未发送” → 刷新后保留 → 风险仍待通知。
- [ ] 双击/双窗口重复提交仅一条交接；切换账号不能看到前账号缓存；无权关联、快照和历史不能泄漏。
- [ ] 检查无人机处罚交接、反制、设备恢复、真实发送均未被错误启用；已有设备重启只走原受控接口，不能假装拥有新 expected_version 协议。
- [ ] 运行完整后端/前端检查，审查通过后领导提交。无法测试的真实渠道明确写“不在本期”，不是“联调通过”。

## 8. 阶段 6：统计、大屏和全角色验收，2–3 个工作日

### 8.1 指标口径，领导先冻结

统计默认展示北京时间当天，查询用 `from,to` 毫秒、`timezone=Asia/Shanghai`，最大 31 天；前端显示对应时间窗口。生产统计只取 `source_mode=live`，本地测试明确选择 `mock` 并显示“本地模拟数据”。`replay` 单独筛选，不与 live 静默相加。

| 指标代码 | 事实/粒度 | 计时字段/集合 | 禁止混淆 |
| --- | --- | --- | --- |
| `observed_targets` | target，distinct target_id | first_seen_at 落窗口 | 不是架次、航班数或轨迹点数 |
| `source_alarms` | alarm，distinct alarm_id | received_at 落窗口 | 不是当前无人机待办数 |
| `uav_pending_verification` | uav_event，distinct event_id | alarm.received_at 落窗口且当前 PENDING_VERIFICATION/EVIDENCE_REQUIRED | 同目标多事件不能按目标去重 |
| `flight_risks` | flight_risk，distinct risk_id | received_at 落窗口 | 不是合法性违规数 |
| `risk_pending_notification` | flight_risk，distinct risk_id | received_at 落窗口且当前 PENDING_NOTIFICATION | 提交通知后仍在此计数 |
| `device_incidents` | device_incident，distinct incident_id | detected_at 落窗口，有有效运维设备映射 | 不是离线设备数量；源模拟标志映射为 mock |
| `handoff_submissions` | handoff，distinct handoff_id | created_at 落窗口 | 不是发送次数或处罚案件数 |
| `handoff_pending_delivery` | handoff，distinct handoff_id | created_at 落窗口且最新 delivery 为 PENDING_DELIVERY | 不能因多条尝试重复计数 |
| `illegal_assessments` | assessment_result，distinct assessment_id | assessed_at 落窗口，conclusion_code=ILLEGAL | 标题写“违法研判记录”，不是“违法飞行架次” |

已核对当前研判表字段为 `assessment_id`、`assessed_at`、`conclusion_code`；`UNDETERMINED` 和 `NOT_APPLICABLE` 不计入合法或非法，不另造 UNKNOWN 结论枚举。研判归属按其关联计划过滤，仍要求 `assessment:read` 与 `flight:read`。未知时间不落入时间窗口，另给已授权同来源范围内、尚未套时间窗口的 `unknown_time_count` 说明；趋势按同一计时字段和时区分桶。

指标核对使用新的同口径统计明细接口，不把 received_at 指标跳到只支持 occurred_at 的旧列表，也不把“研判记录数”拿去对比“计划数”。统计页复用现有弹窗/抽屉展示明细，再按记录跳转已有源详情。这样无需为统计重新改造所有阶段2/3列表过滤器。

无事实支持的指标（处罚案件数、罚款额、正式处置完成率、飞行架次、推断里程/时长）返回 `{value:null,availability:"NOT_CONNECTED"}`；禁止填 0。无权返回 FORBIDDEN；源未配置返回 UNCONFIGURED。已接入源的 SQL/接口运行失败则整个快照失败，不能拼接旧值冒充本次成功。

### Task 6.0：同一快照与共享指标字典 / 领导，约半天

Files：迁移 040；`J/modules/identity/domain/PermissionCode.java`；`J/modules/reporting/domain/MetricDefinition.java`、`J/modules/reporting/application/ReportingSnapshotReader.java`；`T/modules/reporting/api/ReportingMetricContractTest.java`；阶段 6 指标文档。

Consumes：阶段 2–5 真实表及范围谓词。Produces：统计/大屏共享只读入口 `ReportingSnapshotReader.read(ReportingQuery query)`，`ReportingQuery` 与 `ReportingSnapshot` 定义在 reporting/domain 下，字段如下：

```text
ReportingQuery: from(long), to(long), timezone(String), sourceMode(String),
                ownerOrgId(String nullable), districtId(String nullable)
ReportingSnapshot: asOf(long), from(long), to(long), timezone(String), sourceMode(String),
                   metrics(Map<String,MetricValue>), trends(List<TrendBucket>)
MetricValue: value(Long nullable), availability(String), unknownTimeCount(Long nullable),
             drilldown(Map<String,String>)
TrendBucket: bucketStart(long), metricCode(String), value(long)
```

文件同时新增 `ReportingQuery.java`、`ReportingSnapshot.java`、`MetricValue.java`、`TrendBucket.java`。服务从当前会话决定范围，不允许 query 携带 user_id/role/scope_mode。

- [ ] 以固定数据库数据写指标测试：1 个目标 2 条告警计 1/2，1 条交接 2 个历史尝试计 1，证据不足算待核实，非法研判与 UNDETERMINED/NOT_APPLICABLE 分开，边界时刻等于 to 不计入。
- [ ] 为统计/大屏共同入口设置 PostgreSQL `REPEATABLE_READ` 只读事务，所有源 SQL 在同一连接/事务内读取；不能在事务外异步多路查询后拼接。实现边界注解：

```java
@org.springframework.transaction.annotation.Transactional(
    readOnly = true,
    isolation = org.springframework.transaction.annotation.Isolation.REPEATABLE_READ)
```

- [ ] `as_of` 在该事务首次读取前由 `AppClock` 取值；它是响应观察时刻，不代替数据库一致性。大屏补充图层查询也必须在外层同一快照事务内。
- [ ] 精确记录各指标表、主键、时间字段、状态、权限和 drilldown 参数；单测 `./mvnw -Dtest=ReportingMetricContractTest test` 通过后，冻结文件并交两执行者。

### Task 6.1：统计后端和页面 / 执行者 1，约 1 天

Files：`J/modules/reporting/api/ReportingController.java`、`infrastructure/ReportingRepository.java`；`F/services/reportingApi.js`、`F/pages/StatsPage.vue`；`T/modules/reporting/api/ReportingApiTest.java`。

Consumes：6.0 指标字典、快照事务与源范围。Produces：`GET /api/v1/reporting/summary`，查询字段为 `from,to,timezone,source_mode,owner_org_id,district_id`，返回冻结的快照契约；以及 `GET /api/v1/reporting/metrics/{metric_code}/records`，接受相同查询字段加 page/size，返回 `{items,total,page,size,as_of}`。每条明细为 `{record_id,source_kind,title,time,state,detail_link,source_mode}`；按指标计时字段 DESC、事实主键 ASC 固定排序。

指标代码只能取8.1已定义集合；不存在400，无读权限403，NOT_CONNECTED/UNCONFIGURED指标不返回假明细而报409 `METRIC_UNAVAILABLE`。明细 SQL 必须复用汇总指标的事实粒度、范围、时间和状态谓词；illegal_assessments 一行一条研判，handoff_submissions 一行一份交接，不能用计划列表或投递尝试替代。

- [ ] 写 API 失败测试：无权限403、混合源读权限只显示可见指标、交叉元组不可见、超过31天/重复参数/非法时区400、窗口空数据与未接入明确区分。
- [ ] 实现范围内聚合和按天趋势；联表时先以事实主键去重，不能 COUNT 多表展开行。源 SQL 失败返回真实接口错误。
- [ ] 统计页切换接口，保留现有卡片/图表结构；按指标真实含义改必要标签，无真实指标显示“尚未接入”。过滤变更重新请求，旧响应不能覆盖新筛选。
- [ ] KPI 点击携带 `drilldown` 的 metric_code 和相同时间/来源/范围条件读取统计明细；复用统计页现有弹窗能力显示明细再跳源详情，不改导航。明细与摘要各自返回 as_of，发生新提交导致时刻不同时重新刷新摘要，不声称跨HTTP请求天然同一数据库快照。
- [ ] 禁用演示 XLSX/PDF 成功 toast；图表销毁、页面重进、登录身份变化时不残留数据。
- [ ] 运行 `./mvnw -Dtest=ReportingApiTest,ReportingMetricContractTest test` 和前端检查，在固定数据集逐个核对卡片值与指标明细 total；并验证新数据提交后两者刷新到新快照，旧响应不能覆盖新筛选。

### Task 6.2：大屏快照和刷新 / 执行者 2，约 1 天，与 6.1 并行

Files：`J/modules/reporting/api/BigscreenController.java`、`application/BigscreenSnapshotService.java`、`infrastructure/BigscreenReadRepository.java`；`F/services/bigscreenApi.js`、`F/pages/bigscreen/BigScreenApp.vue`；`T/modules/reporting/api/BigscreenApiTest.java`。

Consumes：6.0 统一统计读取和权限，目标/告警/风险安全字段。Produces：`GET /api/v1/bigscreen/snapshot`，接受与 reporting 相同 query；返回 `as_of,from,to,timezone,source_mode,metrics,trends,map_targets,recent_events,limits`。

`map_targets` 上限500个，`recent_events` 上限20个，均稳定排序；`limits` 明确返回上限/是否截断。总数不等于地图点数，未知位置目标不绘制，不用0,0补点。没有 target:read 时不返回目标坐标。

- [ ] 写失败测试：无大屏权限403；无源权限不泄漏数量/点位；unknown 坐标不绘制；源查询失败整个快照失败；列表截断标记不改变 total。
- [ ] 同一 REPEATABLE_READ 外层事务读取 metrics、图层、最近事项，调用共享 reader 加入该事务；禁止前端多个 API 拼“同一快照”。
- [ ] 改大屏源数据，移除该页 `window.MOCK`、演示证据异常和处罚案件计数；每15秒刷新，页面隐藏时暂停，恢复时立即刷新；卸载中止请求、清理计时器、地图、图表和监听。
- [ ] 刷新失败显示“更新失败”及最后成功时间；可以保留明确标注的旧快照，但不更新 as_of、不伪装最新、不回退 Mock。重新登录不同账号立即清空旧快照。
- [ ] 运行 `./mvnw -Dtest=BigscreenApiTest,ReportingMetricContractTest test`；浏览器进出大屏10次只保留一个活动地图和一套定时器。

### Task 6.3：完整回归、只读审查和最终交付 / 领导统筹，约 1–1.5 天

Files：`T/modules/reporting/api/Stage6PostgresTest.java`、`T/integration/mock/ProductionStage6SeedIsolationTest.java`；阶段 6 验收文档；按实际变化更新 `docs/后端开发基线.md`、`server/README.md`。

- [ ] PostgreSQL 两连接测试：统计事务开始后另一连接提交新风险，当前快照所有分项一致，下次刷新才看到新增；验证空间引用、范围索引和聚合不重复。
- [ ] 全角色遍历当前权限目录：有读无写、有读写、只授权一个精确元组、交叉元组、无范围、已停用、会话撤销、超级管理员但未获业务动作权限。测试角色只在隔离测试环境创建。
- [ ] 浏览器逐项检查现有路由：`workbench,situation,flights,legality,alarms,punish,stats,evidence,devices,monitor,commission,users,roles,archive,bigscreen`；检查 `risk/airspace/overview` 别名、登录/退出/改密及直接URL访问。未改造页面只做兼容与安全回归，不借此承诺整页已后端化。
- [ ] 检查已接线页面单击生效、忙态防重复、错误态、空态、无权限态、无坐标态、XSS文本、刷新保存、后端断开、两用户并发、切号清缓存；地图故障不影响普通列表。
- [ ] 视口验收1280×720、1366×768、1440×900；大屏1920×1080和实际测试屏幕。无 document 横向滚动，局部表格可以滚动，不为联调重新设计页面。
- [ ] 审查者逐条核对计划约束、所有消费者和测试证据；不能以 H2、单次 build 或模拟回执证明生产/实联通过。
- [ ] 领导串行执行第9节命令、核对失败/跳过、关闭P0/P1；提交明确文件并给出 commit、测试数字、浏览器路径和遗留事项。

## 9. 验证命令与真实证据

所有 Maven 命令仅在 `/Users/frank/Desktop/dongyiwurenji/server` 运行；所有 npm/前端脚本仅在 `/Users/frank/Desktop/dongyiwurenji/dongying-vue` 运行。以下是实施时要运行的命令，本次写计划没有执行这些功能测试。

后端每阶段完整回归：

```bash
./mvnw test
./mvnw package
```

PostgreSQL 专项分别运行：

```bash
./mvnw -Dtest=Stage4PostgresTest test
./mvnw -Dtest=Stage5PostgresTest test
./mvnw -Dtest=Stage6PostgresTest test
```

执行前通过现有安全环境配置提供 `POSTGRES_TEST_URL/USER/PASSWORD`，不打印或写入报告。新测试仅接受独立库名 `stage456_verify_` 前缀，并使用每次随机创建的 `stage456_` schema；清理仅该已校验 schema，禁止生产库、日常联调库或清空公共 schema。PostGIS 扩展在隔离库预备，测试迁移使用 `db/migration` 与 `db/postgresql`。如果缺环境导致用例被跳过，记录“未验证”，不能勾选阶段验收。

前端检查：

```bash
npm run build
node tools/scan.cjs
node tools/falsify.cjs
```

没有 `npm test` 或 `npm run lint`，不得虚构。修改经典 JS/CJS 时另运行 `node --check` 对应实际文件。浏览器自动化脚本/截图放仓库外系统临时目录，正式回归测试遵循前端 AGENTS 文件限制；后端正式测试正常保留在 `server/src/test/`。

差异检查在仓库根目录：

```bash
git diff --check
git status --short --branch
```

新增未跟踪文件也需单独检查内容和空白。扫描 Mock 消费者时检查所有实际调用链，不把仓库仍保留 `mock.js` 本身判成失败；失败标准是本期已接线页面仍从其读业务状态、推导成功、填补接口错误或在后台触发相关旧写动作。

每阶段验收报告至少包含：基线/交付提交、文件列表、测试总数/失败/跳过、PostgreSQL确实执行证据、浏览器URL/账号权限特征/视口/步骤/结果、未接入项。截图必须对应实际运行；失败不得被删除或换成总结性“通过”。

## 10. 注释要求和审查清单

必须有中文注释的地方：

- 状态迁移为什么允许/拒绝，属实为何不等于反制成功。
- 组织/区域为何匹配同一元组，聚合为何还需源读权限。
- 幂等和逻辑唯一为何同时存在，失败审计为何在事务退出后记录。
- 版本检查与条件更新为何不能省略，快照为何使用 REPEATABLE_READ。
- 未知坐标/高度基准为何不补默认值；禁止把 AGL 与 AMSL 直接比较。
- 交接提交不等于送达，发送和回执为何分列。
- 本地种子为何双门禁、为何不得重置人工处理结果。

好注释示例：

```java
// 同一目标可以触发多次独立告警，不能用目标 ID 去重，否则会吞掉后续核实事项。
// 先锁定源风险并检查版本，再创建交接；不同用户使用不同幂等键仍受业务唯一约束保护。
// 渠道未接通只保存待投递记录，不将风险改为已通知，也不生成模拟送达时间。
```

审查者同时检查注释与实际代码是否相符；不能写了注释却没实现约束。无关简单赋值不要求逐行注释。

## 11. 时间安排与阶段停止线

| 工作日 | 两执行者并行主线 | 领导/审查主线 |
| --- | --- | --- |
| D1 | 告警查询与风险查询，先写失败测试 | 基线、契约、迁移、权限、第一轮只读审查 |
| D2 | 两类核实写入、历史、种子、最小页面接线 | 事务/范围/幂等审查，整理阻断问题 |
| D3–D4 | 修复告警/风险回归 | 阶段4完整测试、PostgreSQL、浏览器验收和提交 |
| 阶段5第1天 | 工作台聚合 / 交接提交并行 | 设备归属映射、交接资格、逻辑唯一审查 |
| 阶段5第2–3天 | 页面联动、失败恢复、修复 | 跨页/重复提交/权限验收和提交 |
| 阶段6第1天 | 统计页面 / 大屏快照并行 | 指标字典、公共快照、源权限审查 |
| 阶段6第2–3天 | 回归修复和证据整理 | 全角色全路由验收、提交、最终清单 |

阶段未过验收，不为了赶日期进入依赖它的下一阶段。每阶段最后半天停止新增功能，只修阻断和回归。没有资料的真实能力保持安全关闭，不把外部依赖拖成无期限伪实现。

## 12. 待确认事项怎样汇总

本计划发送给 **“明早9点｜只汇总待确认事项”** 后，由该任务沿用既有领导工作方式分发；标题不是要求创建新提醒，不新建重复自动化或擅改原定时间。

09:00 按原约定只发需要用户决定的事项：每项一句问题、推荐选择、影响哪个功能、期间安全处理方式。没有事项只发“无待确认事项”。过程技术问题由领导和执行者处理，不把普通测试日志当成用户待确认事项。

可能进入该清单、但不阻塞本期安全开发的外部资料：

1. 生产告警/风险来自哪个权威来源、风险规则谁确认；资料未齐则只验证明确标记的 local/test 样例，生产不自动判定。
2. 真实运维设备的组织/区域归属；未映射的数据不进入工作台和统计，不用单位名称推断。
3. 通知接收方、接口、认证方式及什么结果算通知成功；未齐只保存待投递，生产未配置接收方则不开放提交。
4. 无人机反制/干扰完成事实由哪个已授权模块提供；未齐禁止处罚交接，不以人工核实替代。
5. 正式统计监管口径、证据制度和导出格式；本期明确展示软件事实计数，正式指标/导出仍关闭。

上述不是要求现在逐条重问用户；先检查现有任务和文档是否已有结论，只汇总仍然缺失、实际影响决策的事项。工期若因新确认范围变化，领导报明具体影响，不悄悄扩大实施范围。

## 13. 最终交付判定

- [ ] 阶段4：核实/排除真实入库，历史/审计一致，范围和并发验证通过，页面可单击测试。
- [ ] 阶段5：工作台不拥有第二套状态，风险交接持久化且不伪造送达，设备范围安全，未建写能力明确关闭。
- [ ] 阶段6：指标能按同口径对账，大屏一致快照，全角色/全路由兼容与安全测试有证据。
- [ ] 后端、PostgreSQL/PostGIS、前端构建/扫描和浏览器验收均报告实际结果，未验证项显式列出。
- [ ] 四角色分工、main-only、只读审查、中文注释和领导统一提交均落实。
- [ ] 不把模拟数据测试、待投递交接或禁用的控制入口写成真实设备/外部系统/生产流程已完成。

配套设计：`docs/superpowers/specs/2026-09-05-collaborator-b-stages-4-to-6-design.md`；领域术语：`CONTEXT.md`。本文件是后续执行依据，本轮仅编写/审查/发送计划，不表示上述功能已经实现。
