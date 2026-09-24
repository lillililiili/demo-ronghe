# 外部接口模拟 Implementation Plan

> 在当前本地 main 实施，用户已确认设计与接通本地联调。按 subagent-driven-development 分离页面任务与后端任务，保留所有无关工作区修改，不提交混合改动。

**Goal:** 给现有信号模拟器增加输入推送及外部接收回执页面，四种接口实际进入本地业务链。
**Architecture:** 模拟器Python固定路径代理；后端local/test接入、持久化收件箱；复用flight/forecast/handoff应用服务与权限。
**Tech Stack:** 现有Python标准库、原生JS/CSS、Java17 Spring Boot、PostgreSQL/Flyway。

## Global Constraints

- 仅本地 main，不建分支或工作树；不改用户无关修改。
- 不新增依赖；不读 .env.local，不记录密码或会话。
- 不模拟真实成功，不覆盖历史，不变更风险解除或处罚决定业务。
- local/test且非prod/production；每个对象按原权限范围检查。
- 文案完整，不用省略号截断；新页复用现有模拟器视觉。

## Tasks

- [x] 1. 后端失败测试：LocalInterfaceSimulatorApiTest 验证计划/预报输入及本地接收、回执；无接口时404应失败。
- [x] 2. 追加 V202609240001，新增integrationconfig本地接入DTO、repository、service、controller；输入幂等、时间范围、mock来源。Existing Forecast API读取指定计划的外部模拟快照。
- [x] 3. MockSuperiorHandoffChannel 接入明确绑定对象的持久化外部收件箱；handoff应用服务校验消息marker、投递状态和版本后接收回执。未绑定对象保留现有行为。
- [x] 4. Python独立连接与固定路径代理、external.html/js/css、导航与测试。详细接口见 /private/tmp/external-ui-brief.md。
- [x] 5. 受影响测试、package、隔离PG迁移及SQL、真实本地API与浏览器全流程验收。双仓库diff检查，README/flow-map与交付文档同步。

验收命令：Python unittest discover；Maven LocalInterfaceSimulatorApiTest,ExternalInterfaceApiTest,MockSuperiorHandoffChannelTest,HandoffApiTest,HandoffNotificationApiTest；package；git diff --check。新增接口不更改已有公共DTO响应结构，核对业务Vue及后台消费者。

最终记录：已执行本地API与初版外部页面联调，54后端、18Python、14Node通过，构建/扫描/PG及差异检查通过。业务前台旧入口E2E及独立深链接抽查因auth/me会话超时未通过，详见交付文档；不将其写成全部验收通过。用户在并发任务的新要求将通知页改为只读收件箱，保留该调整。

恢复补验：共享PostgreSQL恢复后context持久化回读成功，旧管理入口同一E2E 1项通过；未变更认证超时或放宽断言。

最终业务浏览器补验通过：同一新计划天气、同一自动交接签收；旧测试定位错误修正后通过，无产品代码改动。
