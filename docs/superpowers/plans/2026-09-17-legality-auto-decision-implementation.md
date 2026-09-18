# 合法性自动判定实施计划

> 执行：按 subagent-driven-development 技能分工实施与独立审查；仅本地 main，保留原有改动，不创建分支或工作树。

目标：实现规则算法的结论充分性判断，后端保存并提供分流结果，页面仅在需要人工处理时显示“核对信息缺口”。

架构：保留 C01–C03 的现有分类与风险口径，新增纯 Java `DecisionAssuranceAlgorithm`，在每次研判事务内按本次输入、质量门、实际规则命中计算 SUFFICIENT / INSUFFICIENT / NOT_APPLICABLE。历史没有算法结果时为 UNAVAILABLE，不回填虚假的当时算法结果。使用新增可空列冻结算法版本和理由；复核需求与操作权限分开。

技术：Java 17、Spring Boot、Flyway、PostgreSQL/PostGIS、Vue 3、Naive UI，不新增依赖。

## 约束与接口

- 可靠明确合法、非法均不要求人工复核；信息不足时显示同一人工复核功能。
- 不编造准确率；`accuracy_status=NOT_VALIDATED`，输入的目标置信度仅沿用质量门。
- 保留模拟/回放、演示参数标识；live 输入不能用演示参数认定依据充分。
- 不改变已有风险范围、反制授权、通知回执或处罚条件；ABNORMAL 保留并说明尚未形成明确二元结论。
- 后端新增 `decision_assurance={algorithm_version,status,review_required,reasons,accuracy_status}`；列表与详情同源。`review_required` 结合保存的充分性结果、是否待复核及当前适用性计算，不等于有 REVIEW 权限。
- 列表新增 `needs_review=true`，在服务端分页前筛选真正待处理的记录，包括旧记录可靠性未知的情况；不固定筛选 UNDETERMINED。
- 未提供新字段的旧服务响应保持“判定可靠性尚未提供”，不能视为可靠或编造低分。

## Task 1：后端算法与持久化

- [x] 先写纯算法测试：完整匹配合法、明确空域违规非法、身份缺失、无计划但无明确违规依据、质量不足、未知非决定性信息、无观测、live 使用演示参数。先确认新增能力测试失败。
- [x] 实现 `DecisionAssuranceAlgorithm.assess(context,hits,verdict,params)`，输出算法版本、充分性状态及原因。可靠非法须有确定的空域违规事实；可靠合法须完整匹配且必需检查有有效结果。
- [x] 追加迁移，为 `rule_evaluation` 增加算法版本、充分性码和原因 JSON 三个可空列，历史不 UPDATE。
- [x] 在 `LegalityEvaluationService` 事务内计算结果，`RuleEngineRepository` 一次 INSERT 保存，不使用事后 UPDATE 绕过只增约束。

## Task 2：接口与待处理队列

- [x] 先写 API 测试验证列表/详情一致、可靠非法不需复核、低可靠合法需复核、旧记录未知、无权限只读、复核后退出待处理队列以及筛选计数。
- [x] DTO 返回独立 `decision_assurance`；read service 与 repository 共用算法结果及复核状态，增加 `needs_review` 查询。
- [x] 保留既有复核历史、幂等、版本及纠正接口，核对后台管理端消费者。

## Task 3：页面

- [x] 在系统临时目录编写可失败的展示逻辑测试；不在前台目录新增临时测试产物。
- [x] 修改 `legalityReviewFocus.js`、`LegalityPage.vue`、`legalityReviewModal.js`：可靠结果隐藏人工任务区和主复核按钮，不可靠结果使用“核对信息缺口”；无权限显示只读原因，历史不删除。
- [x] “信息待核对”改为后端 `needs_review=true`；列表、详情与刷新使用相同分流结果，未知接口不回退成可靠。

## Task 4：验证与文档

- [x] 运行受影响 Java 单元/API 测试、后端 package；新增列与筛选在隔离 PostgreSQL/PostGIS 验证。
- [x] 前端执行 build、scan、admin-migration，并在真实浏览器验证两类可靠结果、低可靠结果、旧响应、刷新与权限分支。
- [x] 独立审查本次差异；更新 spec、两级 AGENTS、README、flow-map 及两仓接口说明，明确规则算法已实现与实测准确率未验证的区别。
- [x] 两仓 `git diff --check`，交付列明本次文件、方法、测试与运行环境生效状态。

## 完成记录

本轮源码与隔离验证已完成。后端 59 项受影响测试（含真实 PostgreSQL/PostGIS）通过，package 通过；前端展示逻辑/契约 13 项、受控浏览器场景、build、scan 及管理页面迁移回归通过。独立审查提出的两项参数确认问题已修复并补回归；旧记录省略算法版本的响应已补兼容验证。两仓保留本地 main 及既有改动。现有 8081 后端未重启，业务库尚未应用本轮迁移，实测准确率仍未验证。

完整改动、命令和验收边界见[交付记录](../../交付/合法性自动判定与复核分流-20260917.md)。
