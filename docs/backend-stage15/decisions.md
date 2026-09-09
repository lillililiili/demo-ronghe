# 阶段 15（小接线 + CI/E2E）决策记录

| 编号 | 决策 | 理由 |
| --- | --- | --- |
| 15-1 | 动作权限进角色矩阵：新增 `GET /permissions/actions`（ACTION 目录按 module 分组）；`PUT /roles/{code}/permissions` 请求体增可选 `actions[]`，缺省不动既有动作行，给了就整组替换该角色的动作行；`GET /roles/{code}` 返回 `actions[]`；MODULE 矩阵仍要求整矩阵 | 不改既有 MODULE 语义（`PERMISSION_SET_INCOMPLETE` 不变），动作行独立成组，前端可分区渲染 |
| 15-2 | 动作等级只允许 `NONE|READ|OP`（AUTH 只属菜单模块）；`users/roles/audit` 模块下若有动作码沿用 `SYSTEM_PERMISSION_PROTECTED`；`disposal:*`、`punishment:*`、`evidence:destroy` 允许授自定义角色，但审计 detail 记录授予的动作码 | 两人规则需要非超管持有这些动作；高风险动作靠审计而不是禁授 |
| 15-3 | 本地第二账号 `reviewer1`（角色 `ROLE-DEMO-REVIEWER`，非内置，`scope_mode=ALL`）由 `LocalStage15DemoReviewerSeeder @Order(120)` 造，密码同 `app.dev-seed.password`；只在 local/test + dev-seed 开关下；生产零数据 | 演示与 E2E 都需要第二人；与 `LocalUserSeeder` 同一密码来源，不再多一个环境变量 |
| 15-4 | 目标三摘要（`risk_summary/legality_summary/disposal_summary`）各取最新一条，无则省略键；列表与详情同形；查询用每目标子查询（列表 size ≤ 100，不做 N+1 的 HTTP） | 悬浮卡要的是"现在怎么样"，不是历史 |
| 15-5 | AOA 方位透出：`ObservationDto.bearing_deg/identity_confidence/device_id`；`TargetStateDto.bearing_deg/bearing_device_id` 取最近一条无位置且带方位的观测；设备位置由前端从已加载的设备列表解析，不在目标接口里再联表 | 后端只给事实，位置来源已在页面上 |
| 15-6 | 列表排序白名单：告警 `received_at|occurred_at|severity|state`，风险 `received_at|occurred_at|severity|state`；`order ∈ asc|desc`；非法值 400；缺省不变 | 稳定分页要求次序键唯一，白名单外一律拒绝 |
| 15-7 | 导出 CSV：与列表同权限同筛选，上限 5000 行（超出 400 `EXPORT_TOO_LARGE`，提示缩小范围），UTF-8 BOM，文件名带日期；审计 `alarms_exported/risks_exported` 记筛选条件与行数 | 沿用证据导出的形状 |
| 15-8 | 别名路由提示：`accessBlocker` 在 `ROUTE_ALIAS` 命中时写"需要『<承载页>』的查看权限（<原页名>由它承载）" | 审查阶段 14 第 9 轮建议；页名与应授模块分家时两段都说 |
| 15-9 | CI：backend 作业加 `postgis/postgis:16-3.5` 服务并注入三个环境变量，PG 套件在 CI 上跑；job summary 打印 run/fail/err/skip；E2E 作为独立可选作业（`continue-on-error: true`）直到稳定 | 让"看起来绿"变成"真的绿"；E2E 初期不阻断合并 |
| 15-10 | E2E 骨架：Playwright，登录经 API 注入 `sessionStorage`，用例矩阵 = 全部路由 × {admin1, reviewer1}，断言可达/拒绝、无控制台错误、三视口无横向溢出；不做业务流程 | 先把"页面进不进得去"钉住 |
| 15-11 | 证据主体扩到 CASE/AUTHORIZATION 不在本阶段：A 的表与三条 CHECK，契约 §6 提请 A | 范围控制 |
| 15-12 | 本阶段无新表；如需迁移只用 `V202609080104+`；权限 sort 980+ | 约定 |
| 15-13 | CI 修订：主跑排除 `TargetReadPostgresApiTest`（其守卫要求库名 `stage2_target_verify_*`，在 `ci_verify` 上会拒绝加载）并用专属库单独跑；`package` 加 `-DskipTests`；汇总放在所有测试步骤之后；去掉重复的 `AuthApiTest,SystemManagementApiTest` 单跑；e2e 作业改为 checkout 后按 `playwright.config.js` 存在与否逐步判断（作业级 `hashFiles` 在 checkout 前恒空） | 审查阶段 15 第 1 轮 P0-1/P1-1/建议 |
| 15-14 | 动作权限接口三处口径：`ROLE_LOCKED`（本次提交带了 actions 且角色是 ROLE-ADMIN）与 `BUILTIN_ROLE_PROTECTED` 分开；`NO_CHANGES` 只在矩阵与动作都没变时才报；`users/roles/audit` 域动作守卫按 `module_code` 判并先于任何此类动作行存在 | E1：前端要分得清"内置角色整体不可改"与"多带了动作行"；只调动作也是有效变更；守卫先于对象存在，否则谁加谁顺手授出去 |
| 15-15 | `latest_state.bearing_deg/bearing_device_id` 只在目标自身 `location` 为空时给（`location` 非空则省略键；与 `pilot_location` 无关——只测到飞手、目标未定位的场景正需要方位线），前端"有值就画"；`ROLE_LOCKED` 文案改为"内置角色的动作权限不可修改" | 审查第 3 轮 P2-1 与建议：一个目标不能同时有位置点和方位线两套线索；锁覆盖所有内置角色，话要说对 |
| 15-16 | 三摘要与方位按整页批量取回（每页固定四条查询），不在主查询挂相关子查询；列表与详情共用同一套取数；JSON 列在 SQL 里只做可移植粗筛（`LIKE`），取值交给 Java——PG 专属 `->>` 一律不用（H2 直接语法错） | E1：`TargetRow` 已二十多字段；单测库与生产库要跑同一条 SQL |
| 15-17 | `.gitignore` 加 `dongying-vue/test-results/`、`dongying-vue/playwright-report/`；`bearingOf`（从 quality JSON 取方位）抽到一处共用，目标读侧与观测读侧都用它 | 审查第 4 轮 P2-2 与建议：排除项写进 ignore 才自动生效；键名一变改一份漏一份且两边都不报错 |
| 15-18 | JSON/JSONB 列做字符串粗筛必须写 `CAST(col AS VARCHAR) LIKE …`：PG 没有 `jsonb ~~ text` 运算符，裸 `LIKE` 只在 H2 能跑（H2 把该列当字符串）；`Stage15PostgresTest` 加一条真实 PG 上 `GET /targets` 200 的断言 | 助手在真实 PG 上复现 `/targets` 500（领导已复核）；与 13-15（JSON 插入要 CAST）同族，写进 `server/AGENTS.md` |
| 15-19 | 前端按权限决定发不发请求：外壳的工作台事项拉取只在持 `workbench.read` 时发；告警页证据链只在持 `evidence.read` 时拉；别名提示只有 `airspace` 会走到（`risk/overview` 在 router 层已重定向），提示里的页名必须取 `navModel.pageTitle`，不另写一套 | 助手 E2E 观察：每加载一页四次越权 403 不该是常态；12-14 要求页名与菜单一致 |
| 15-20 | 导出方法去掉 `@Transactional(readOnly = true)`（会写审计行的方法不是只读；PG 只读事务禁写 INSERT，H2 不落实该语义）；规则：凡调用 `audit.record` 的方法不得标 readOnly；`Stage15PostgresTest` 导出用例钉"恰 5000 行 200"与"5001 行 400"两侧 | 助手在真实 PG 复现两条导出 500（SQLSTATE 25006）；只测超限一侧全绿而真正能导出的那条路必挂 |
| 15-21 | 目标 `risk_summary` 取"最新一条"的判据用 `COALESCE(occurred_at, received_at)` 再附 `risk_id` 兜底（`flight_risk.occurred_at` 可空，元组比较遇 NULL 两行都满足 NOT EXISTS，悬浮卡会在两次刷新间跳变） | 助手发现；`rule_evaluation.created_at`、`disposal_authorization.requested_at` 非空不受影响 |
| 15-22 | 告警页"区域"筛选不再拉 `GET /districts`（那是用户管理域，要 `users.read`）；后端加 `GET /alarms/districts`（调用者告警范围内出现过的区域，`alarm:read`），风险页同理 `GET /risks/districts`；前端读不到时把下拉标"不可用"而不是空表 | 业务筛选项不能挂在管理域权限下 |
| 15-23 | 两条"只有管理员持动作码"的既有断言按名字放行 `ROLE-DEMO-REVIEWER`（`LocalStage2AccessSeederTest` 改为断言非管理员持码角色恰为该角色；`DeviceBusinessScopeTest` 排除该名字），不按 `builtin=false` 整面放开 | 15-3 的演示复核员是有意的、只在 dev-seed 下存在；再出现第二个持码角色仍要红 |
| 15-24 | ACTION 目录行的 `module_name`/`name` 改为中文（数据迁移 `V202609080104`，逐码 UPDATE；`/permissions/actions` 直接上屏），前端字典只作兜底 | E2 联调：目录里是英文开发描述，直接给一线人员看英文；服务端给中文才能一处改处处对 |
| 15-25 | 动作行等级只允许 `READ|OP`：同一迁移把 ACTION 行上的 `AUTH` 归一为 `OP`；前端遇到非法档位锁行显示原码而不是悄悄降档 | E2 发现部分动作行已是 AUTH（来源待 E1 查明），契约只收 NONE/READ/OP |
| 15-26 | `CsvExport.escape()` 在引号包裹之前，对首字符为 `= + - @`、制表符或回车的单元格加 `'` 前缀（公式注入防护）；注释写明：当前两张表无数值列，将来加可能为负的数值列时规则要收窄为"不是合法数字才加前缀"；用例覆盖四个前缀与一个负数样例 | 审查第 8 轮 P1-3：`reason_text`、`source_*` 来自自由文本与上游，按"上游不可信"处理 |
| 15-24（补充） | ACTION 目录的中文取动作域名（设备/告警/处置授权…），不取 MODULE 行的菜单分组名（七个动作域都归"飞行监管"会出现七个同名分组）；措辞与前端字典逐字一致，前端字典退为兜底 | E1 偏离指示的理由成立 |
| 15-25（修订） | 真实库上 ROLE-ADMIN 的动作行确为 AUTH（`uav_stage10_verify` 42 行）：来源是 `SuperAdminIntegrityInitializer` 每次启动把 ROLE-ADMIN 既有行全置 AUTH，而 `LocalStage2AccessSeeder` 在首次启动后已插入动作行，第二次启动即被抹成 AUTH——H2 单次上下文看不到。修法：该 UPDATE 只作用于 MODULE 行（JOIN `app_permission.permission_kind='MODULE'`），0104 的归一 UPDATE 保留作升级兜底；用例：模拟两次启动后动作行仍为 READ/OP | E1 的"没有路径能造出 AUTH"只在单次启动成立；升级路径实测推翻 |
| 15-27 | 初始化器修好之后再加一支版本化迁移 `V202609080105` 重跑动作行 AUTH→OP 归一（0104 的归一在升级库上已被同一次启动的初始化器抹回，且版本号已记账不会重跑）；不用 R__（`app_role_permission` 是版本化迁移建的表，13-32 规则）。`Stage15PostgresTest` 加分两步升级用例：迁到 0104 → 调一次 initializer → 迁到最新 → 断言动作行无 AUTH | 助手在 `uav_stage10_verify` 核实：0104 成功记账，动作行仍 AUTH 42；修成因不清存量等于没修 |
| 15-28 | 审查第 10 轮建议（0105 加 `role_code='ROLE-ADMIN'` 过滤）**不采纳**：0105 已在验收库应用，再改就得再走一次删历史行；非超管 AUTH 动作行没有产生路径（入口 `@Pattern` 只收 NONE/READ/OP，初始化器已限 MODULE 行），且 0105 只碰 ACTION 行、方向是降到 OP 不是提权到 AUTH | 迁移不改、宁可让防线在入口与初始化器上 |
| 15-29（修订） | 角色页动作矩阵：等级为 AUTH 的历史行从提交体过滤，提示改为"历史遗留等级，保存后将被清除"（后端整组替换会删掉它，这是事实；0105 之后这类行本就不该存在） | 审查第 11 轮 P2-3 及补充："保持不变"与整组替换的语义矛盾；不放宽入口 @Pattern（15-2/15-25），也不删分支（升级前的库可能仍有该状态） |
| 15-30 | `sort=state` 的排序列改为 `e.state_code`（告警表无 `state` 列，`ORDER BY a.state` 在 PG/H2 都 500）；`sort=severity` 按严重程度排（CASE：CRITICAL>HIGH>MEDIUM>LOW，次序键后仍附 id）而不是按枚举字符串；用例覆盖两张表的全部四个排序键两个方向 | 领导接管代理在 8081 实测；既有用例只请求过 received_at 所以全绿 |
| 15-31 | 演示复核员 `ROLE-DEMO-REVIEWER` 的模块授权补齐 `punishment`（READ + 菜单）与 `sensing`、`flights`（READ + 菜单），使其能进处罚页做审批/复核；E2E 期望取自服务端 `menu_keys`，不需要改夹具 | E2 联调：动作权限有了但没有处罚页菜单，审批入口在处罚页，页面上仍走不到两人链路 |
| 15-32 | 两条 CSV 导出的枚举列（类别、等级、状态、风险类型）正文翻成中文（服务端字典，未知码原样保留），列头已是中文 | E2 联调：列头中文正文英文码，一线人员在 Excel 里看不懂；导出是给人看的 |
| 15-31 修订 | 种子对升级库上已存在的 MODULE 行做幂等 UPDATE（NONE→READ、菜单打开，只升不降），动作行同样只升不降；有改动才递增 `permission_version`；`MODULE_READ` 最终名单 `monitoring, alarms, punishment, sensing, flights`（`risk` 无 route_key 且 reviewer1 无 `risk:read`，不列）；名单中出现目录外的码时种子直接抛异常 | 升级库 `uav_stage10_verify` 上该角色 18 行 MODULE 早以 NONE 存在，`INSERT … WHERE NOT EXISTS` 碰不到；先前"重启即补齐"的说法是错的，用旧包重启后 reviewer1 菜单仍只有 3 项 |
| 15-33 | `GET /targets/{id}/observations` 的 `identity_confidence` 不强制出键：DTO 已有该字段，值为 null 时按"未知即省略"约定不输出（AOA 观测本就无身份置信度） | E2 报"没有 identity_confidence"，核对后是契约约定行为而非缺陷，不改 |
| 15-34 | 演示复核员种子的动作授权补七个 READ：`device/flight/route/airspace/assessment/risk/fusion`，与 15-31 给的 `sensing`、`flights` 菜单配套；用例把"菜单→页面所需读动作"的对应写死；不加 `rule:read`（只有不在菜单里的合法性页请求 `/rule-sets`） | 助手 E2E 34/39，5 条红全是 reviewer1：菜单给了、页面打的读接口全 403（`/airspaces`、`/devices`、`/legality-evaluations`、`/fusion/status`、`/flight-plans`、`/risks*`）；菜单与动作不配套正是本阶段要收的缝，不进白名单 |
| 15-35 | 处罚页处置授权行按服务端 `allowed_actions` 渲染动作按钮（审批/驳回/执行/人工结果/停止），复用 `ui/disposalAuthModal.js` 与 `disposalApi` 现有函数，不新写请求，不改页面结构 | E2 浏览器联调：reviewer1 与 admin1 在处罚页都看不到任何审批入口——`openDisposalApproval/Execution/ManualResult/Stop` 全仓无页面调用，授权行是纯只读渲染；13-33 拖两个阶段的真正原因是申请之后三步没有入口，而不是缺第二个账号 |
| 15-34 修订 | `/devices` 由 A 的 `DeviceAccessPolicy` 按模块码 `devices.read` 把关，不是动作码 `device:read`；种子新增 `MODULE_DATA_ONLY=[devices]`，只把等级抬到 READ、不开菜单（设备管理是运维页面，不进复核员菜单）；用例把 situation→device/target/fusion/airspace/assessment、flights→flight/route/airspace/risk 的对应写死 | E1 实测：全仓模块级鉴权点 9 个，五条 403 里只有 `/devices` 是模块级；只加七个动作码态势页仍 403 |
| 15-36（开放） | `/auth/me` 的 `permission_codes` 只有模块码，不下发动作码，前端无法据此决定动作按钮显隐（现靠服务端 `allowed_actions` 或等 403）；是否下发动作码留到下阶段与 E2 定口径，本轮不动 | E1 观察 |
| 15-37 | CI：PG 专项主跑改用 `stage456_verify_ci` 库（与本机隔离库同一命名规则，不放宽用例的库名守卫）；E2E 作业下载 backend 作业的 jar，在作业自带的 PostGIS 服务上以 local 配置真跑后端再跑用例，仍不阻断合并 | 首跑 34295804430：PG 专项因库名被守卫拒绝、E2E 因无后端全红；放宽守卫会让本机误连生产库的防线失效，所以改 CI 不改用例 |
