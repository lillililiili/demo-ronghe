# T02 雷达只读后端阶段 1 独立审查

- 审查轮次：第一轮（计划与现有基线预审）
- 审查日期：2026-09-03
- 审查基线：`origin/main` / `d0a0b4ee366687fdea6e4621f7d16cd31c406476`
- 当前结论：`NOT READY`

## 1. 结论和适用边界

本轮只审查阶段计划、仓库规则、现有后端基线、源码事实和基线测试证据。总协调尚未提供以下两份并行产物，因此本轮没有审查、也不假设已经看过它们：

- `docs/backend-stage1/data-api-contract.md`
- `docs/backend-stage1/t02-replay-contract.md`

两份文件在本审查基线的 `HEAD` 中均不存在。当前 `NOT READY` 表示阶段 1 的必要输入尚未齐备，且预审发现 P1 状态字典冲突；不表示对尚未完成契约作出了失败判定。只有第二轮逐项复核两份实际产物、关闭所有 P0/P1 后，才能把结论改为 `READY`。

本轮未读取、复制或修改设备协议原件，未访问现场报文、真实连接信息或凭据；未执行设备联调。未修改 Java、SQL、YAML、前端、设备资料或阶段计划，也未设计自动判警、`live` 连接、雷达控制或反制能力。

## 2. 审查输入与隔离证据

| 项目 | 第一轮证据 |
| --- | --- |
| 阶段计划 | `2026-09-03-stage-1-t02-contract-and-isolation.md`，由总协调通过原工作区提供；该文件不在本审查基线的 `origin/main` 中，本任务未复制它 |
| 仓库规则 | [仓库根规则](../../AGENTS.md)、[后端规则](../../server/AGENTS.md) |
| 后端事实入口 | [后端开发基线](../后端开发基线.md)、[数据库设计文档](../数据库设计文档.md)及下列源码 |
| 工作树 | Codex 管理的 linked worktree：`/Users/frank/.codex/worktrees/c38f/dongyiwurenji` |
| 分支状态 | detached HEAD；`HEAD`、`origin/main`、merge-base 均为 `d0a0b4e` |
| 初始状态 | `git status --short --branch` 仅显示 `## HEAD (no branch)`，无已跟踪或未跟踪改动 |
| 设备资料 | 不属于本轮所需输入；未读取、未复制进 Git |

## 3. 基线测试证据

执行命令：

```bash
cd server
./mvnw test
```

执行环境与结果：

| 项目 | 实际结果 |
| --- | --- |
| 执行结束时间 | 2026-09-03 23:39:48 -04:00 |
| Maven | 3.9.9（仓库 Wrapper） |
| 测试 JVM | Eclipse Adoptium Java 21.0.12，macOS aarch64 |
| 编译目标 | Maven Compiler `release 17` |
| Spring profile / 数据库 | `test` / H2 2.3.232，PostgreSQL compatibility mode |
| Maven 退出结果 | `BUILD SUCCESS`，退出码 0 |
| Surefire 汇总 | 13 tests，0 failures，0 errors，0 skipped |

Surefire 逐类报告：

| 测试类 | tests | failures | errors | skipped |
| --- | ---: | ---: | ---: | ---: |
| `SourceModeGuardTest` | 3 | 0 | 0 | 0 |
| `LoginFailurePersistenceTest` | 2 | 0 | 0 | 0 |
| `AuthApiTest` | 8 | 0 | 0 | 0 |
| **合计** | **13** | **0** | **0** | **0** |

计数来自 `server/target/surefire-reports/TEST-*.xml` 和对应文本报告，不仅依据 Maven 退出码。`target/` 为构建产物，未纳入提交。

测试日志还有两项非阻断限制，已登记为 P2：测试使用 Java 21 运行而不是 Java 17 运行时；Flyway 输出 H2 2.3.232 高于当前版本已测试支持的 H2 2.2.224 警告。本次 H2 测试也不证明 PostgreSQL 16/PostGIS 3.5 的迁移、约束、锁、索引或空间行为；第一轮未执行 `package`、PostgreSQL/PostGIS 测试、前端构建或设备联调，且不据此声称这些项目通过。

## 4. 现有代码事实

| 事实 | 第二轮必须据此检查的影响 |
| --- | --- |
| [V1](../../server/src/main/resources/db/migration/V1__init.sql) 与 [V2](../../server/src/main/resources/db/migration/V2__outbox_inbox.sql) 仅建立 `app_user`、`app_session`、`audit_log`、`outbox_event`、`inbox_message`、`idempotency_request` 六张表 | 契约只能规划新迁移和增量扩展，不得要求改写 V1/V2，也不得把拟建表描述成已实现 |
| [DeviceController](../../server/src/main/java/com/uav/lowaltitude/modules/device/api/DeviceController.java) 和 [AlarmController](../../server/src/main/java/com/uav/lowaltitude/modules/alarm/api/AlarmController.java) 只检查登录并返回固定空分页；非法 `page/size` 当前会被夹到允许区间 | 新契约若固定 `INVALID_PAGE`，必须明确它是阶段 2 目标行为，不可误述为当前行为；列表、详情、`total` 和历史查询需统一数据范围 |
| [AuthUser](../../server/src/main/java/com/uav/lowaltitude/platform/security/AuthUser.java) 只有用户、账号、名称和单一角色码；当前没有权限码、组织/区域范围或权限版本 | `device:read`、`target:read`、`alarm:read` 及默认拒绝语义必须可实现，不能把“已登录”写成权限完成 |
| V2 `inbox_message` 只有 `source`、`source_msg_id`、`received_at` 及 `(source, source_msg_id)` 唯一约束 | 两份契约必须共同固定 `source_namespace/source_message_id` 到现有列的映射、payload hash、冲突隔离和失败状态的增量方案 |
| [AdapterPort](../../server/src/main/java/com/uav/lowaltitude/integration/AdapterPort.java) 当前只有 `mode()`；[SourceMode](../../server/src/main/java/com/uav/lowaltitude/integration/SourceMode.java) 为小写 `mock/replay/live`；仅有 `MockAdapter` | 回放契约中的 `start/stop`、sink 和 frame 类型是后续目标契约，不得写成现有能力；`replay` 不得回退或冒充 `live`/`mock` |
| [SourceModeGuard](../../server/src/main/java/com/uav/lowaltitude/integration/SourceModeGuard.java) 会拒绝空模式、未知模式及缺少对应 Adapter 的模式；测试已覆盖缺少 `live` Adapter | 回放契约不得削弱 fail-fast 隔离；没有 replay Adapter 时不能假装启动成功 |
| 当前没有目标、轨迹、设备状态、告警业务表、Mapper 或真实查询 | 两份契约需要明确唯一表名、类型名和所有权边界，避免阶段 2 平行建表或重复造类型 |
| 当前 JSON 使用 snake_case 且忽略 null，既有会话时间使用 epoch 毫秒；数据库设计稿规定新业务时间为 `timestamptz` / Java `Instant` | REST 时间必须统一为 epoch 毫秒，同时明确未知字段在忽略 null 配置下的线格式；不得混用数据库时刻与传输单位 |

## 5. 分级规则

- **P0**：会造成越权、来源混淆、原始事实覆盖、未知事实伪造、受控动作启用、敏感资料进入 Git，或突破阶段 1 禁止范围；必须阻止阶段退出。
- **P1**：契约冲突、缺失或不可实现，足以导致悬空外键、重复建模、接口不稳定、幂等失效或实现任务各自猜测；必须在阶段退出前解决。
- **P2**：不阻断阶段 1 契约固化，但影响可追溯性、环境一致性或后续验收质量；必须给出后续归属，不能静默忽略。

## 6. 第一轮发现

| ID | 级别 | 状态 | 发现与证据 | 关闭条件 / 后续归属 |
| --- | --- | --- | --- | --- |
| P1-001 | P1 | OPEN，待二审 | 阶段计划固定设备状态 `ONLINE/OFFLINE/DEGRADED/UNKNOWN`，而[数据库设计文档](../数据库设计文档.md)第 6 节仍使用 `ONLINE/OFFLINE/ABNORMAL/UNKNOWN` | 数据/API 契约必须确定一个唯一内部字典，并说明数据库 CHECK、DTO 与既有设计稿之间的兼容/替代关系；归属：数据/API 契约产物 |
| P2-001 | P2 | OPEN | `pom.xml` 编译目标为 Java 17，但本次测试 JVM 为 Java 21.0.12；当前证据不能替代 Java 17 运行时验证 | 在阶段 2 首次生产代码验收或 CI 基线中使用 Java 17 复跑；归属：总协调指定的后端实现/CI 负责人 |
| P2-002 | P2 | OPEN | Flyway 在测试日志中警告 H2 2.3.232 高于其已测试支持的 2.2.224 | 后续测试基线需决定接受并记录该警告或在获准的依赖基线任务中处理；不得由本阶段擅自改依赖；归属：后端构建基线负责人 |
| P2-003 | P2 | OPEN | 本轮阶段计划来自原工作区绝对路径，不在 `origin/main` / `d0a0b4e` 中，审查基线无法仅靠 Git 还原计划版本 | 总协调的退出报告应固定计划文件内容版本或可追溯提交；归属：总协调 |

除 P1-001 外，本轮不能对契约内容报告“无 P0/P1”：两份契约尚未取得，相关项均保持待二审。

## 7. 第二轮 P0/P1/P2 审查清单

### 7.1 P0：安全与阶段边界

| 检查项 | 合格标准 | 第一轮状态 |
| --- | --- | --- |
| P0-C01 提交范围 | 两个实现提交各自只包含约定文档；不含 Java、SQL、YAML、前端、设备原件、现场报文、真实 IP、账号或凭据 | 待二审 |
| P0-C02 历史迁移 | 明确 V1/V2 不可修改；新结构执行时取下一个可用 Flyway 版本 | 待二审 |
| P0-C03 权限默认拒绝 | 无角色映射、无组织/区域范围、未知归属均拒绝；列表、详情、历史、`total` 使用同一范围；无权对象以 404 隐藏存在性 | 待二审 |
| P0-C04 未知事实 | 未知坐标、高度、时间、来源、状态和权限保持未知，不以 0、在线、成功、合法或全域代替 | 待二审 |
| P0-C05 来源隔离与去重 | `replay` 命名空间不能冒充 `live`；同 namespace/message ID 不同 hash 返回 `SOURCE_MESSAGE_CONFLICT`、隔离且不覆盖原消息 | 待二审 |
| P0-C06 解析失败副作用 | 非法长度、CRC、文件损坏、未知指令等不写目标、轨迹、设备成功状态；未知指令保留原始帧并返回 `UnsupportedMessage` | 待二审 |
| P0-C07 禁止能力 | T02 轨迹不自动生成黑飞告警；无 `live` 自动回退、真实联网、雷达控制或反制指令 | 待二审 |
| P0-C08 坐标与高度 | RTK 原点/航向不足时不生成 WGS-84 点；协议 Z 不冒充 AGL/AMSL；转换依据不足时只保留原始事实 | 待二审 |

### 7.2 P1：一致性与可实现性

| 检查项 | 合格标准 | 第一轮状态 |
| --- | --- | --- |
| P1-C01 表和迁移批次 | 两个顺序批次、表集合、主外键、唯一范围、归属、时间、索引及未知值规则完整；`alarm` 不依赖尚未建立的 `uav_event` 外键 | 待二审 |
| P1-C02 权限模型 | 权限码仅为 `device:read`、`target:read`、`alarm:read`；`AuthUser`/范围缺口及 local/test 显式赋权边界有可实现说明 | 待二审 |
| P1-C03 REST 完整性 | 九个只读 GET 的参数、DTO、稳定排序、分页、错误码和状态码完整；没有新增业务写接口 | 待二审 |
| P1-C04 当前兼容差异 | 明确当前空分页和参数夹取只是基线行为；阶段目标的 `INVALID_PAGE` 等错误不会与现状混写 | 待二审 |
| P1-C05 名称和单位 | 表、DTO、ID、状态、字段、错误码均有唯一名称；REST 时间全为 epoch 毫秒，数据库新业务时间为 `timestamptz` / `Instant` | P1-001 OPEN；其余待二审 |
| P1-C06 现有 Inbox 映射 | `source_namespace`、`source_message_id`、`payload_hash` 与 V2 `source/source_msg_id` 的映射和增量扩展一致，无第二套 Inbox/去重表 | 待二审 |
| P1-C07 适配类型 | `AdapterPort` 扩展、`InboundFrameSink`、`InboundFrame` 和五种解析消息类型名称与字段唯一，两个契约引用一致 | 待二审 |
| P1-C08 回放格式和流式语义 | UTF-8 NDJSON 字段、命名空间、记录号、SHA-256、拆包/粘包/噪声/长度/CRC/回绕/EOF/损坏/重复启动语义可直接编码 | 待二审 |
| P1-C09 迟到与历史 | 迟到帧可补历史但不覆盖较新 latest state；设备时间、接收时间、更新条件和确定性排序一致 | 待二审 |
| P1-C10 测试向量 | 合成向量覆盖完整帧、逐字节拆包、双帧粘包、CRC、非法长度、未知指令、RTK 缺失、重复记录、同键异载荷；不复制现场报文 | 待二审 |
| P1-C11 文件所有权与重复劳动 | 两份契约不会要求不同任务修改同一文件、平行建表、重复造 DTO/消息类型或各自定义来源键 | 待二审 |
| P1-C12 文档收口 | 两份契约无 `TBD/TODO`，排除范围不会被写成待实现能力，交叉引用与现有路径有效 | 待二审 |

### 7.3 P2：可追溯性与后续验收

| 检查项 | 合格标准 | 第一轮状态 / 归属 |
| --- | --- | --- |
| P2-C01 运行时矩阵 | 阶段 2/CI 补 Java 17 运行时证据 | P2-001 OPEN；后端实现/CI 负责人 |
| P2-C02 测试依赖警告 | 明确处理或接受 Flyway/H2 支持范围警告，不在本阶段擅自升级 | P2-002 OPEN；后端构建基线负责人 |
| P2-C03 计划追溯 | 退出报告可唯一还原本轮计划版本 | P2-003 OPEN；总协调 |
| P2-C04 数据库验收边界 | 契约明确 H2 不替代 PostgreSQL/PostGIS；阶段 2 的迁移/约束/空间验证另有归属 | 待二审；总协调分配阶段 2 数据库实现负责人 |
| P2-C05 现场资料边界 | 列明仍需确认的设备台账、来源 ID 范围、时间/坐标/高度基准和脱敏样例，不虚构完成 | 待二审；总协调跟踪资料提供方 |

## 8. 阶段退出判断

| 退出条件 | 第一轮判断 | 说明 |
| --- | --- | --- |
| 两份契约无 TBD/TODO，名称与时间单位一致 | 未满足 | 产物尚未提供，不能审查 |
| 无生产代码、历史迁移、前端或设备原件改动 | 当前基线满足；实现提交待核验 | 本任务开始时工作树干净，本轮只创建审查文档 |
| 无自动判警、真实联网、控制或反制 | 未判定 | 必须读取两份实际契约后确认 |
| 权限默认拒绝，回放不可冒充 live | 未判定 | 必须读取两份实际契约后确认 |
| 独立审查无未解决 P0/P1且有实际测试数 | 未满足 | 已取得 13/0/0/0 证据，但 P1-001 未关闭且契约未审 |

**第一轮最终判断：`NOT READY`。不得据此进入阶段 2。**

## 9. 第二轮触发条件与复审动作

总协调提供两份实际文档及对应提交 SHA 后，第二轮将：

1. 以提交 diff 验证每个实现任务只改其负责文档，并确认设备原件未进入 Git。
2. 完整阅读两份产物，不以提交说明或实现者摘要代替内容审查。
3. 按第 7 节逐项填写证据，交叉比对来源命名空间、消息 ID、时间单位、`source_mode`、表名、DTO 名、权限码、状态和错误码。
4. 对 P0/P1 给出可定位的发现和关闭证据；P2 明确后续归属。
5. 若审查基线不再是 `d0a0b4e` 或测试相关文件发生变化，重新运行 `cd server && ./mvnw test` 并从新 surefire 报告统计实际数量。
6. 更新本文件的退出判断，运行 `git diff --check`，只提交本审查文档。
