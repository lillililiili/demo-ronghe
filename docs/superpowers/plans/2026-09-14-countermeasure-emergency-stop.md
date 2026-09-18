# 反制急停实施计划

> 执行方式：使用 subagent-driven-development 分配独立后端任务，当前任务完成前端集成、文档和整体验证。用户已确认设计并授权修改代码，连续执行，不再等待设计审批。

**目标：**在告警与工作台当前事件中直接急停，持续跟踪逐设备停止反馈，原因事后补写。

**架构：**服务端提供同一事件的急停概览、急停记录、设备停止任务和追加记录；复用现有权限、授权和四通道控制。前端共享组件读取该概览，不在页面模拟成功。业务中止与设备反馈分开维护。

**技术栈：**现有 Vue 3 / JavaScript / 原生 CSS / Naive UI，Java 17 / Spring Boot 3.4.5 / PostgreSQL。保持依赖不变。

## 全局约束

- 仅 main；不建分支、不建 worktree、不覆盖已有改动、不提交无关代码。
- 全关回执不等于实际停机；未知、不支持、离线均须如实展示。
- 急停覆盖同一事件反制和干扰；已完成历史保留；后续继续执行需新授权。
- SQL/并发变更在隔离 PostgreSQL 验证；不以现有业务库充当测试库。

## 任务一：事件急停后端

- [x] 在 `server/src/test/java/com/uav/lowaltitude/modules/disposal/` 添加流程测试，先验证新急停入口尚未实现而失败。
- [x] 在 `modules/disposal/api/application/infrastructure` 建立职责清晰的急停 DTO、Controller、服务和仓储，添加新的 Flyway 迁移，保留旧单授权 stop 接口兼容。
- [x] 接口约定以 `/api/v1/uav-events/{eventId}/emergency-stop` 为 GET/POST 起点；后端先输出精确 DTO/补充原因/重试/核查路径，由前后端共同使用。
- [x] 服务端验证范围与 `disposal:stop`，记录请求及停止任务，协调联动、迟到回执与旧启动指令；按设备停止能力返回真实进度。
- [x] 原因追加、未确认项重试、现场核查均关联原记录并审计，幂等重放不产生重复指令。
- [x] 运行受影响测试和隔离 PostgreSQL 测试，报告实际用例数量及未验收边界。

## 任务二：公共反制急停组件与接线

- [x] `dongying-vue/src/services/disposalApi.js` 增加后端约定的概览与写操作封装。
- [x] `dongying-vue/src/components/disposal/` 新增公共卡片与局部状态管理；固定红色急停，先提交后补原因，持续状态与设备明细，同一事件回读。
- [x] 接入 `AlarmsPage.vue`、`WorkbenchPage.vue` 当前事件区域及 `punish/AuthorizationQueue.vue` 事件上下文，不遮挡原流程与历史。
- [x] 超时先查询、请求去重、无权限禁用、切换事件清除旧数据、卸载清理；未知反馈不得显示成功。
- [x] 运行 `npm run build`、`node tools/scan.cjs` 和相关 JS 语法检查。

## 任务三：整体验证与交付

- [x] 对照设计检查正常、提交中、未确认、全关回执、现场核查、无权限、刷新、重复操作与跨页一致性。
- [x] 在真实浏览器检查受影响入口、操作链、控制台和 1280×720 / 1366×768 / 1440×900。
- [x] 运行后端 `./mvnw package`、认证测试及必要回归，核对 surefire 结果。
- [x] 更新 `docs/flow-map.md`、后端基线、最近接口文档及设计稿实施状态。
- [x] 独立审查本次修改，修复重要问题；运行 `git diff --check`，交付页面变化、代码清单、实际验证和运行环境边界。

验收细节及未通过的全量测试边界见 [代码交付](../../反制急停代码交付-2026-09-14.md)。任务完成不表示已上线或真实设备联调通过。
