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
