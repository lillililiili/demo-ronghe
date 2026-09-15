# 阶段 19 决策记录：合法性研判与飞行计划关联

> 2026-09-15 仓库归属：本文后端 `server/` 路径指同级 `../houtaiguanli/server/`；历史验证记录保留原日期。迁入后台后的迁移版本与验证结果以后台 `docs/新后端迁移记录.md` 为准。

| 编号 | 决策 | 依据 |
| --- | --- | --- |
| 19-1（用户裁定） | **合法性研判与飞行计划关联**（需求确认表增补五 F23 的答复：主视角是计划，不是孤立的目标判定）。研判详情要显示所属飞行计划（编号、单位、飞手）并可点开该计划；研判列表支持按计划筛选（服务端 `plan_id` 已支持）；飞行计划页的"合法性判定"按钮对**待执行**计划不再落空 | 用户 2026-09-10："合法性研判没有关系。是和飞行计划关联的"；F23 原记：待执行计划必然没有匹配目标，点按钮进去是空页 |
| 19-2 | 合法性页四个方块改为**跟随当前筛选**（区域/复核状态/时间），不再固定"北京时间当日" | 实测：演示数据是 09-09 的，今天打开四格全是 0 而列表有 7 条，看起来像坏了；原版那 27/4/10/13 也是"这批数据"的计数 |
| 19-3 | 演示计划种子按启动时刻补三条（今天稍后的待执行、此刻执行中、今天早些时候的已完成），只在 local/test。**幂等的含义是"不重复建行"，不是"已存在就不管"：这三条的窗口每次启动都按 AppClock 当前时刻重新定位**，放在 `LocalStage3PlanningSeeder`（`local|test`，test 里跑得到才写得出用例；阶段七那个是 local-only） | 演示库里计划全是过去时间（23 已完成 + 1 已取消），飞行计划页 KPI 恒为 0，F23 的"待执行不给按钮"分支演示不到。**根因不是"种子写了过去时间"**：所有计划种子都 `where not exists` 插入、时间戳固定在第一次建库那一刻，而 `FlightPlanStatusAdvanceJob`（本地演示开着）按真实时钟把 `end_at` 已过的计划一律推成已完成——实测的 23+1 正好是种子计划总数。所以"已存在同编号就跳过"补三条，第二天又会全变已完成，等于没修。另：阶段七那个种子里本来就有 `vol-status-executing/completed/cancelled/today` 四条，它们不是缺失，是第二天被扫掉 |
| 19-4 | **不加飞手字段**：`flight_plan` 表只有 `uav_sn`，没有飞手/操作手/联系人；原版界面上的"飞手 黄勇"是 Mock 数据。飞手来自外部管服平台的计划报文，没有来源就不编，记入需求确认表待确认 | E2 19.1 查证：计划详情与研判 DTO 均无该字段 |
| 19-5 | A 的 `RiskNotificationService`（提交即已通知）与 `HandoffApiTest` 里随之新增的三条用例移除；被改名改断言的阶段 5 既有用例 `successStoresHeaderSnapshotFirstDeliveryAndAuditWithoutTouchingRisk` 恢复原样 | 该服务无任何调用方、缺仓储方法、编译不过（main 与 CI 34551695225 全红）；三条用例断言 `state_code='ACKNOWLEDGED'` 而 `ck_stage4_risk_state` 只允许四个值，且"提交即已通知"与用户裁定 18-14 相悖 |
| 19-6 | **模拟渠道的回执不得闭合 `source_mode='live'` 的风险**（`HandoffSubmissionService` 推进前加判 `channel.simulated()`）；演示数据照常闭环 | A 的 `simulatedAcknowledgmentCannotCloseLiveRisk` 指出的真洞：`MockSuperiorHandoffChannel` 由属性 `app.handoff.channel=mock` 开启而非 profile，生产误配即可让模拟回执把真实风险标成已通知。这一条与"演示数据不得冒充真实"同源，予以采纳 |
| 19-7 | 补迁移 `V202609100103` 插入 `rule-engine-space-risk-replay` 来源行（与 live/mock 同形、幂等），不回退代码映射 | A 的 11e7f4b 给 `SpaceRiskEvaluationService` 加了 replay 映射并把隔离用例断言改成三行，但没有插那条来源行；`space_risk_fact.source_id` 是外键，replay 模式真跑会插不进去，不只是两条测试红 |
| 19-8 | `DisposalExecutionTest.manualChannelRunsThroughToCompleted` 的抖动按"测试里把时钟拨一下"修（申请与批准不在同一刻），不给事件表加单调序号；但在代码注释里写明"同刻事件次序目前由 event_id 决定，自动链式流转若要求确定次序需另加序号" | E1 连跑三次一红两绿：两条事件 `occurred_at` 相同时次序由随机 UUID 决定。人不会在同一毫秒里既申请又批准；但机器连做两步（反制完成自动接干扰）会，留锚点不实现 |
