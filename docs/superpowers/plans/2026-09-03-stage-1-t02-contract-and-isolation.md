# T02 雷达只读后端阶段 1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不修改生产业务代码的前提下，固化 T02 雷达只读后端首批开发所需的数据、REST、权限、协议、回放和测试契约，并建立可安全进入阶段 2 的开发基线。

**Architecture:** 阶段 1 由两个互不重叠的实现任务分别产出“数据/API 契约”和“T02 协议/回放契约”，独立审查任务只检查安全性、完整性与可执行性，总协调任务负责依赖、重复劳动和退出门槛。各任务使用 Codex 原生工作树隔离；只提交各自负责的文档，不修改 Java、SQL、YAML、前端或设备资料原件。

**Tech Stack:** Java 17、Spring Boot 3.4.5、MyBatis 3.0.4、Flyway、PostgreSQL 16/PostGIS 3.5、Maven Wrapper；协议依据为 T02 雷达 v3.0.0。

## Global Constraints

- 遵守仓库根 `AGENTS.md` 与 `server/AGENTS.md`；所有 Maven 命令只在 `server/` 执行。
- 以 `origin/main` 当前已合入的阶段 1 安全基线为代码事实，不修改 V1/V2 历史迁移。
- 本阶段不实现生产代码，不增加依赖，不创建数据库迁移，不修改前端。
- 仅允许提交协议实现所需的字段、常量和合成测试描述；不得提交设备协议原件、现场报文、真实 IP、账号或凭据。
- 首批能力固定为 `replay`；不设计 `live` 自动回退，也不设计任何雷达控制或反制指令。
- T02 轨迹不得自动生成黑飞告警；告警只表示明确来源的已入库记录。
- 未知坐标、高度、时间、权限或来源必须保持未知；不得使用 0、在线、成功或全域权限代替。
- 所有新增 REST 时间字段统一定义为 epoch 毫秒；数据库新增业务时间使用 `timestamptz`/Java `Instant`。
- 阶段 1 文档中的表、接口和类型必须有唯一名称，后续实现任务不得再自行改名或扩大范围。

---

### Task 1: 后端数据与 REST 契约

**Files:**
- Create: `docs/backend-stage1/data-api-contract.md`
- Read: `docs/后端开发基线.md`
- Read: `docs/数据库设计文档.md`
- Read: `server/src/main/java/com/uav/lowaltitude/modules/device/api/DeviceController.java`
- Read: `server/src/main/java/com/uav/lowaltitude/modules/alarm/api/AlarmController.java`

**Interfaces:**
- Consumes: 现有 `/api/v1`、Bearer `session_id`、`ApiResponse`、snake_case、`page/size` 分页规则。
- Produces: 阶段 2–5 唯一使用的数据表子集、DTO 字段、权限码、筛选参数、排序和错误码。

- [ ] **Step 1: 核对现有实现与历史迁移**

  记录 V1/V2 已有表、设备/告警 Controller 的当前空分页行为、`AuthUser` 与数据范围缺口；明确禁止修改历史迁移。

- [ ] **Step 2: 固化迁移批次与表关系**

  文档必须按“执行时取下一个可用 Flyway 版本”定义两个顺序批次：

  1. 最小只读权限：`app_org`、`app_district`、`app_role`、`app_permission`、`app_role_permission`、`app_user_data_scope`，并增量扩展 `app_user.scope_mode/permission_version`。
  2. 雷达只读数据：`integration_source`、`device`、`device_state`、`device_state_history`、`target`、`target_source_link`、`target_latest_state`、`track`、`track_point`、`alarm`，并增量扩展 `inbox_message`。

  每张表列出主键、外键、唯一范围、归属列、来源模式、时间、必要索引和未知值规则。`alarm` 本阶段不得依赖尚未建立的 `uav_event` 外键。

- [ ] **Step 3: 固化权限与范围语义**

  权限码固定为 `device:read`、`target:read`、`alarm:read`。生产无角色映射或无组织/区域范围时默认拒绝；仅 local/test 合成数据可以显式赋权。列表、详情、total 和历史查询使用相同范围过滤；无权对象统一按 404 隐藏存在性。

- [ ] **Step 4: 固化 REST 契约**

  精确定义以下接口的请求参数、响应 DTO、稳定排序、分页和错误：

  - `GET /api/v1/devices`
  - `GET /api/v1/devices/{device_id}`
  - `GET /api/v1/devices/{device_id}/states`
  - `GET /api/v1/targets`
  - `GET /api/v1/targets/{target_id}`
  - `GET /api/v1/targets/{target_id}/tracks`
  - `GET /api/v1/tracks/{track_id}/points`
  - `GET /api/v1/alarms`
  - `GET /api/v1/alarms/{alarm_id}`

  本阶段不得增加业务 `POST/PUT/PATCH/DELETE`。状态码使用 `ONLINE/OFFLINE/DEGRADED/UNKNOWN`；新时间字段均为 epoch 毫秒。

- [ ] **Step 5: 固化错误和兼容策略**

  至少定义 `UNAUTHENTICATED`、`FORBIDDEN`、`INVALID_PAGE`、`INVALID_TIME_RANGE`、`DEVICE_NOT_FOUND`、`TARGET_NOT_FOUND`、`TRACK_NOT_FOUND`、`ALARM_NOT_FOUND`；保持现有 `ApiResponse.ok/data/error` 结构。

- [ ] **Step 6: 自审并提交**

  运行：

  ```bash
  rg -n "TBD|TODO|自动判警|POST |PUT |PATCH |DELETE " docs/backend-stage1/data-api-contract.md
  git diff --check
  ```

  预期：无 TBD/TODO；只在明确声明“不增加写接口”时出现写方法；`git diff --check` 无输出。

  提交信息：

  ```bash
  git add docs/backend-stage1/data-api-contract.md
  git commit -m "docs(server): define stage 1 data and api contract"
  ```

---

### Task 2: T02 协议与回放契约

**Files:**
- Create: `docs/backend-stage1/t02-replay-contract.md`
- Read only: `/Users/frank/Desktop/dongyiwurenji/设备资料/雷达/低空监视雷达网络通信协议_v3.0.0.docx`
- Read: `server/src/main/java/com/uav/lowaltitude/integration/AdapterPort.java`
- Read: `server/src/main/java/com/uav/lowaltitude/integration/SourceMode.java`

**Interfaces:**
- Consumes: T02 v3.0.0 帧定义和阶段 1 的 replay-only、安全隔离边界。
- Produces: `AdapterPort` 扩展契约、回放记录格式、稳定去重键、解析消息类型、错误分类和可直接编码的测试向量说明。

- [ ] **Step 1: 提取协议事实**

  使用文档读取技能核对：TCP 客户端/服务端角色、默认连接信息仅作为文档示例、网络字节序、帧头 `0x55AA55AA`、帧长度、指令、帧 ID、CRC16-MODBUS 范围、LOGIN、HEARTBEAT、UPLOAD_TARGET_V3、UPLOAD_TRACK_V3、REQUEST_RTK、UPLOAD_RTK。

- [ ] **Step 2: 固化内部类型**

  文档定义以下唯一接口和类型名称：

  ```java
  interface AdapterPort {
      SourceMode mode();
      void start(InboundFrameSink sink);
      void stop();
  }

  interface InboundFrameSink {
      void accept(InboundFrame frame);
  }

  record InboundFrame(
      String sourceCode,
      String sourceNamespace,
      String sourceMessageId,
      long receivedAt,
      byte[] payload
  ) {}
  ```

  解析消息类型固定为 `LoginReply`、`Heartbeat`、`RtkUpload`、`TargetUploadV3`、`TrackUploadV3`；未知指令保留原始帧并返回 `UnsupportedMessage`，不得假装成功解析。

- [ ] **Step 3: 固化回放文件格式与幂等键**

  回放文件采用 UTF-8 NDJSON，每行结构固定为：

  ```json
  {"dataset_id":"t02-v3-synthetic-001","record_no":1,"received_at":1731464128000,"frame_hex":"55aa55aa..."}
  ```

  `source_namespace = replay:<source_code>:<dataset_id>`；`source_message_id = record_no` 的十进制字符串；`payload_hash = SHA-256(raw bytes)`。同一 namespace/message ID 不同 hash 必须隔离并报 `SOURCE_MESSAGE_CONFLICT`，不得覆盖原消息。

- [ ] **Step 4: 固化流式解析与失败语义**

  明确拆包、粘包、前导噪声、非法长度、CRC 错误、帧 ID 回绕、回放 EOF、文件损坏和重复启动行为。解析失败只更新 Inbox 失败状态，不写目标、轨迹或设备成功状态。

- [ ] **Step 5: 固化坐标、高度和时间规则**

  RTK 原点与航向不足时不生成 WGS-84 点；XYZ 和原始时间保留在 Inbox。协议中的 Z 仅为相对雷达高度，不写入 AGL/AMSL。只有安装高度及基准已确认后才能计算标准高度。迟到帧可补历史，但不能覆盖更新的最新状态。

- [ ] **Step 6: 设计合成测试向量并提交**

  逐项列出应构造的最小字节向量及预期结果：完整帧、逐字节拆包、双帧粘包、CRC 错误、非法长度、未知指令、RTK 缺失、重复记录和相同键不同载荷。测试向量必须程序化构造，不复制完整协议文档或现场抓包。

  运行：

  ```bash
  rg -n "TBD|TODO|0xCCCC|live|控制|反制" docs/backend-stage1/t02-replay-contract.md
  git diff --check
  ```

  预期：`0xCCCC` 只能作为协议事实并明确禁止在验收测试中绕过 CRC；`live`、控制和反制只出现在排除范围；无 TBD/TODO；`git diff --check` 无输出。

  提交信息：

  ```bash
  git add docs/backend-stage1/t02-replay-contract.md
  git commit -m "docs(server): define T02 replay protocol contract"
  ```

---

### Task 3: 独立审查与基线验证

**Files:**
- Create: `docs/backend-stage1/independent-review.md`
- Review: `docs/backend-stage1/data-api-contract.md`
- Review: `docs/backend-stage1/t02-replay-contract.md`
- Review: `docs/后端开发基线.md`
- Review: `server/AGENTS.md`

**Interfaces:**
- Consumes: 两份阶段 1 契约及现有代码事实。
- Produces: 按 P0/P1/P2 分级的审查结论、基线测试证据和是否满足退出门槛的独立判断。

- [ ] **Step 1: 运行只读基线检查**

  ```bash
  cd server
  ./mvnw test
  ```

  记录实际测试数量、失败和跳过；不得只记录退出码。

- [ ] **Step 2: 检查契约冲突**

  重点检查：历史迁移是否被要求修改、表关系是否悬空、权限是否默认放大、total 是否绕过范围、未知坐标是否伪造、重复消息是否覆盖、T02 是否自动判警、replay 是否可能回退/冒充 live、是否出现任何控制指令。

- [ ] **Step 3: 检查可实现性和重复劳动**

  核对两份契约中的名称、ID、时间单位、来源键和错误码是否一致；指出会让实现任务重复造类型、平行建表或修改同一文件的地方。

- [ ] **Step 4: 给出退出判断并提交**

  P0/P1 未解决时结论必须为 `NOT READY`；只有无 P0/P1 且基线测试证据完整时才能为 `READY`。P2 必须列明后续归属，不得静默忽略。

  ```bash
  git diff --check
  git add docs/backend-stage1/independent-review.md
  git commit -m "docs(server): review stage 1 backend contracts"
  ```

---

### Task 4: 总协调与阶段退出

**Files:**
- Create: `docs/backend-stage1/exit-report.md`
- Read: 三个并行任务的最终输出、提交和验证证据。

**Interfaces:**
- Consumes: 实现甲、实现乙和独立审查任务 ID，以及它们的最终结果。
- Produces: 唯一阶段退出报告、未解决事项负责人和阶段 2 是否允许启动的决定。

- [ ] **Step 1: 持续监控而不代写实现**

  使用任务等待/读取工具检查三个任务是否阻塞、重复、越界或缺少验证。只有发现具体冲突时才发送修正指令；不向任务要求阶段 2 代码。

- [ ] **Step 2: 对齐两份契约**

  逐项比对来源命名空间、消息 ID、时间单位、source_mode、表名、DTO 名、权限码和错误码。若不一致，退回责任任务修改并再次等待。

- [ ] **Step 3: 核验独立审查**

  审查任务若仅复述契约、未运行基线测试、未给出实际用例数或遗漏安全边界，必须要求补审。

- [ ] **Step 4: 输出退出报告**

  报告必须包含：三项提交、改动文件、基线测试实际结果、P0/P1/P2、待补现场资料、未执行项，以及 `READY/NOT READY`。只有 `READY` 才允许进入数据库与权限实现阶段。

## Stage 1 Exit Criteria

- 数据/API 契约与 T02/回放契约均无 TBD/TODO，名称和时间单位一致。
- 无生产代码、历史迁移、前端或设备原件改动。
- 无自动判警、真实联网、雷达控制或反制能力。
- 权限和数据范围默认拒绝，回放来源不可冒充 live。
- 独立审查无未解决 P0/P1，并报告 Maven 实际用例数。
- 总协调给出 `READY` 后，阶段 2 才能创建 Java、SQL 和正式测试代码。
