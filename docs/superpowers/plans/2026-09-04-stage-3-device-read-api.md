# T02 雷达只读后端阶段 3：设备查询接口实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于阶段 2 已验收的权限和数据结构，把设备空壳接口替换为三个真实、只读、范围隔离的查询接口，完整实现分页、筛选、详情、状态历史、稳定错误码和空值语义，不扩展到目标、告警、摄取或控制。

**Architecture:** Controller 只解析与校验 HTTP 输入并映射显式 DTO；`DeviceQueryService` 先通过身份模块校验 `device:read`，再调用 MyBatis 查询。每条 items、total、详情和历史 SQL 都重新包含当前用户、启用角色、动作权限和精确范围谓词，防止授权检查与查询之间出现放大窗口。设备和 latest 状态按扁平只读行查询，由应用层组装视图，API 层转换 epoch 毫秒；历史 snapshot 在应用层使用白名单字段解析，不透传任意 JSON。H2 覆盖快速行为测试，PostgreSQL/PostGIS 覆盖空间字段和真实方言。

**Tech Stack:** Java 17、Spring Boot 3.4.5、MyBatis XML、Jackson、PostgreSQL 16/PostGIS 3.5、H2 test profile、MockMvc、JUnit 5、AssertJ、Maven Wrapper。

## Global Constraints

- 只有阶段 2 退出报告为 `READY` 且权限/迁移提交已合入同一基线后才能执行；阶段 2 未通过 PostgreSQL/PostGIS 验收时，不得以 H2 结果代替并启动本阶段。
- REST 契约以数据/API 契约修订提交 `7a384020b72b7a293386c8bd774b979788005e34` 为唯一命名和语义基线。
- 遵守仓库根 `AGENTS.md` 与 `server/AGENTS.md`；Maven 命令只在 `server/` 执行。
- 不增加依赖、不修改阶段 2 迁移、不修改前端、不实现目标/轨迹/告警查询、不实现 replay/live 摄取、不增加写接口或设备控制。
- 保留 `/api/v1`、Bearer `session_id`、`ApiResponse.ok/data/error`、snake_case、字符串 ID 和 `items/page/size/total`。
- 三个接口都先验证 `device:read`。缺权限返回 403；详情和状态历史的父设备不存在或越权均返回同一个 404 `DEVICE_NOT_FOUND`，不能泄露对象存在性。
- 范围过滤必须在 SQL 返回数据之前完成。items、total、详情和历史都使用同一授权语义；禁止先查全量再在 Java/Controller 过滤。
- `ASSIGNED` 只匹配同一 `(org_id,district_id)` 范围行；`ALL` 也排除任一归属为空的数据。请求的组织/区域参数只能继续收窄，不能扩大范围。
- latest 只来自 `device_state` 中已有可信 `observed_at` 的行。无 latest 时省略 `latest_state`；不得从 history、Inbox 或 `received_at` 合成。历史查询可以用 `COALESCE(observed_at,received_at)` 排序筛选，但不得复用为 latest 更新规则。
- `has_alarm=null` 在 JSON 中省略，显式 `false` 必须返回；`UNKNOWN` 是真实状态值，不等于没有状态。
- 不返回 `credential_ref`、`metrics`、Inbox payload、完整 snapshot 或其他原始消息。

## 预计工期与并行边界

**总工期：1–1.5 个工作日。** 总协调先冻结 DTO、Mapper 方法和 XML 共享片段名称。实现甲负责参数校验、Controller 和 DTO；实现乙负责 Mapper/XML 与应用服务；两者只在接口签名冻结后并行。集成任务负责合并、MockMvc/Postgres 测试和文档，独立审查任务不得代写业务代码。

| 时间 | 工作流 | 退出证据 |
| --- | --- | --- |
| 第 1 天上午 | 公共分页/输入校验与查询模型并行 | 参数边界红绿测试；Mapper 接口冻结 |
| 第 1 天下午 | SQL、服务、DTO、三个 Controller 路由集成 | 范围、total、详情 404、历史排序测试 |
| 第 2 天上午（最多半天） | PostgreSQL/PostGIS、全量回归、独立审查 | 空间 DTO、实际用例统计、无 P0/P1 |

---

### Task 1: 锁定阶段入口并建立分页、参数校验红灯测试

**Files:**
- Read: `docs/backend-stage2/exit-report.md`
- Read: `docs/backend-stage1/data-api-contract.md`
- Read: `server/src/main/java/com/uav/lowaltitude/modules/device/api/DeviceController.java`
- Create: `server/src/main/java/com/uav/lowaltitude/platform/api/PageDto.java`
- Create: `server/src/main/java/com/uav/lowaltitude/platform/query/PageSpec.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/domain/Connectivity.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/application/DeviceListCriteria.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/application/DeviceStateHistoryCriteria.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/api/DeviceRequestParser.java`
- Create: `server/src/test/java/com/uav/lowaltitude/modules/device/api/DeviceRequestParserTest.java`

**Interfaces:**

```java
public record PageDto<T>(List<T> items, int page, int size, long total) {}

public record PageSpec(int page, int size, long offset) {}
```

`PageSpec` 放在 `platform.query` 供应用查询复用；offset 必须使用 long 并通过受检乘法计算，不能发生整数回绕。`DeviceListCriteria` 和 `DeviceStateHistoryCriteria` 只包含经过校验的筛选条件与 `PageSpec`，不包含 userId、角色、scope mode 或权限码。

- [ ] **Step 1: 核对阶段 2 退出与现有测试基线**

  ```bash
  git status --short
  git log --oneline --all -- docs/backend-stage1 docs/backend-stage2 server/src/main/resources/db/migration
  cd server
  ./mvnw test
  ```

  记录阶段 2 `READY`、实际迁移版本、全量用例数和未提交文件。若退出报告或 Postgres 证据缺失，本阶段保持未启动。

- [ ] **Step 2: 先写参数解析测试**

  覆盖以下固定行为：

  - `page/size` 缺省为 1/20；边界 1 和 100 合法。
  - page 小于 1、size 不在 1–100、超出 int、非整数返回 `400 INVALID_PAGE`。
  - 支持的标量参数出现两次返回 `400 VALIDATION_ERROR`。
  - 空字符串、纯空白、超长代码、非法 boolean、未知 connectivity 返回 `400 VALIDATION_ERROR`。
  - `time_from/time_to` 必须成对、均可解析为 Java long epoch 毫秒且 from 不晚于 to，否则 `400 INVALID_TIME_RANGE`。
  - 设备路径 ID 去除首尾空白后长度为 1–36；不满足时返回 `400 VALIDATION_ERROR`。

- [ ] **Step 3: 运行红灯测试**

  ```bash
  cd server
  ./mvnw -Dtest=DeviceRequestParserTest test
  ```

  预期：解析器和分页 DTO 尚未实现而失败。

- [ ] **Step 4: 实现无静默修正的解析器**

  `DeviceRequestParser` 从 `HttpServletRequest.getParameterValues()` 读取支持的标量参数，先检查出现次数，再进行 trim、长度、类型、枚举和时间范围校验。不得依赖 Spring 把重复参数折叠为单值，也不得把非法 page/size 夹到合法范围。

- [ ] **Step 5: 运行测试并提交**

  ```bash
  cd server
  ./mvnw -Dtest=DeviceRequestParserTest test
  git diff --check
  git add server/src/main/java/com/uav/lowaltitude/platform/api/PageDto.java server/src/main/java/com/uav/lowaltitude/platform/query/PageSpec.java server/src/main/java/com/uav/lowaltitude/modules/device/domain/Connectivity.java server/src/main/java/com/uav/lowaltitude/modules/device/application/DeviceListCriteria.java server/src/main/java/com/uav/lowaltitude/modules/device/application/DeviceStateHistoryCriteria.java server/src/main/java/com/uav/lowaltitude/modules/device/api/DeviceRequestParser.java server/src/test/java/com/uav/lowaltitude/modules/device/api/DeviceRequestParserTest.java
  git commit -m "feat(server): validate device query parameters"
  ```

---

### Task 2: 定义设备查询模型、应用视图与 Mapper 边界

**Files:**
- Create: `server/src/main/java/com/uav/lowaltitude/platform/query/PageResult.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/application/ScopedDeviceListQuery.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/application/ScopedDeviceStateHistoryQuery.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/application/DeviceStateView.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/application/DeviceSummaryView.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/application/DeviceDetailView.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/application/DeviceStateHistoryView.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/infrastructure/DeviceRow.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/infrastructure/DeviceStateHistoryRow.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/infrastructure/DeviceQueryMapper.java`
- Modify: `server/src/main/java/com/uav/lowaltitude/Application.java`

**Mapper interface:**

```java
long countDevices(ScopedDeviceListQuery query);
List<DeviceRow> findDevices(ScopedDeviceListQuery query);
DeviceRow findVisibleDevice(String userId, String deviceId);
boolean existsVisibleDevice(String userId, String deviceId);
long countDeviceStates(ScopedDeviceStateHistoryQuery query);
List<DeviceStateHistoryRow> findDeviceStates(ScopedDeviceStateHistoryQuery query);
```

两个 `Scoped*Query` 只能由应用服务根据已校验 criteria 与 `AccessDecision.userId()` 创建；不得接收客户端提供的 userId、角色、scope mode 或权限码。

- [ ] **Step 1: 复核唯一连接状态类型**

  Task 1 创建的 `Connectivity` 只含 `ONLINE/OFFLINE/DEGRADED/UNKNOWN`，解析未知值时抛 `VALIDATION_ERROR`。不得添加 `ABNORMAL` 或厂商原码。

- [ ] **Step 2: 定义应用层只读视图**

  视图使用 String ID、`Instant` 时间、可空可选字段和显式嵌套状态；不使用 `Map<String,Object>`。`DeviceStateView.observedAt` 与 `receivedAt` 必填，`DeviceStateHistoryView.observedAt` 可空。`PageResult` 保留请求 page/size 和数据库精确 total。

- [ ] **Step 3: 定义扁平持久化行**

  `DeviceRow` 同时承载 summary/detail 所需列及 latest 列，但不承载 `credential_ref/metrics/Inbox`。`DeviceStateHistoryRow` 只额外承载 snapshot 的 JSON 文本，后续由应用层白名单解析。共享 `PageResult` 放在 `platform.query`，只表达 items/page/size/total，不依赖 HTTP DTO。

- [ ] **Step 4: 注册 Mapper 扫描**

  只把 `com.uav.lowaltitude.modules.device.infrastructure` 加入现有 `@MapperScan`；不改身份或审计 Mapper 行为。

- [ ] **Step 5: 编译并提交类型边界**

  ```bash
  cd server
  ./mvnw -DskipTests compile
  git diff --check
  git add server/src/main/java/com/uav/lowaltitude/Application.java server/src/main/java/com/uav/lowaltitude/modules/device
  git commit -m "feat(server): define device query model"
  ```

---

### Task 3: 实现范围内的 MyBatis 设备查询

**Files:**
- Create: `server/src/main/resources/mybatis/device/DeviceQueryMapper.xml`
- Create: `server/src/main/java/com/uav/lowaltitude/platform/config/MyBatisDatabaseVendorConfig.java`
- Create: `server/src/test/java/com/uav/lowaltitude/modules/device/infrastructure/DeviceQueryMapperTest.java`
- Create: `server/src/test/resources/sql/device-query-cleanup.sql`
- Create: `server/src/test/resources/sql/device-query-fixtures.sql`

**SQL fragments:**
- `deviceProjection`: 设备、来源和 latest 状态列。
- `activeDeviceReadScope`: 当前用户、启用角色、`device:read` 与范围谓词。
- `deviceFilters`: 六类可选筛选。
- `deviceFromAndWhere`: items/count 共享的 FROM、授权与筛选。

- [ ] **Step 1: 先写 Mapper 范围和计数测试**

  使用只含合成值且可清理的夹具覆盖：精确元组可见、跨组织或跨区域不可见、拆分的组织/区域集合不能组合、`ALL` 看不到空归属、角色或权限在授权后被撤销也不会返回数据、筛选只收窄、items 与 total 完全一致。

- [ ] **Step 2: 运行红灯测试**

  ```bash
  cd server
  ./mvnw -Dtest=DeviceQueryMapperTest test
  ```

  预期：XML 查询尚不存在而失败。

- [ ] **Step 3: 实现共享授权范围谓词**

  `activeDeviceReadScope` 必须在查询内部以 `userId` 联查当前 `app_user/app_role/app_role_permission`，验证用户正常、角色启用、权限码精确为 `device:read`，并执行：

  ```text
  owner_org_id IS NOT NULL
  AND district_id IS NOT NULL
  AND (
    scope_mode = ALL
    OR (scope_mode = ASSIGNED AND EXISTS 当前用户同一 org_id + district_id 的有效范围行)
  )
  ```

  `NONE` 永不返回记录。items、count、detail、exists、history count/history items 都复用同一语义，不能仅依赖之前的 Java 授权结果。

- [ ] **Step 4: 实现列表、详情和历史 SQL**

  - 列表固定 `device_no ASC, device_id ASC`，offset/limit 只来自已验证 `PageSpec`。
  - `source_code/device_type_code/connectivity/enabled/owner_org_id/district_id` 均精确匹配；connectivity 只匹配实际 latest 行。
  - 详情在同一 SQL 中完成对象 ID 和范围过滤。
  - 历史 JOIN 可见父设备，闭区间过滤 `COALESCE(observed_at,received_at)`，排序为该值 DESC、`received_at DESC,state_id ASC`。
  - snapshot 用 `CAST(snapshot AS VARCHAR)` 返回内部文本，不在 SQL 中展开不受控字段。

- [ ] **Step 5: 隔离空间投影的数据库方言**

  提供 `VendorDatabaseIdProvider`：PostgreSQL 映射为 `postgresql`，H2 映射为 `h2`。XML 的 PostgreSQL 专用投影片段使用 `ST_X(location)/ST_Y(location)`；H2 快速测试只对 location 返回空投影，空间值和 DTO 在 Task 6 的 Postgres 测试验收。不得为了 H2 通过而降低生产 geometry 或 GiST 迁移。

- [ ] **Step 6: 运行 Mapper 测试并提交**

  ```bash
  cd server
  ./mvnw -Dtest=DeviceQueryMapperTest test
  git diff --check
  git add server/src/main/resources/mybatis/device/DeviceQueryMapper.xml server/src/main/java/com/uav/lowaltitude/platform/config/MyBatisDatabaseVendorConfig.java server/src/test/java/com/uav/lowaltitude/modules/device/infrastructure/DeviceQueryMapperTest.java server/src/test/resources/sql
  git commit -m "feat(server): query scoped device data"
  ```

---

### Task 4: 实现设备查询应用服务和 snapshot 白名单

**Files:**
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/application/DeviceQueryService.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/application/DefaultDeviceQueryService.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/application/DeviceSnapshotReader.java`
- Create: `server/src/test/java/com/uav/lowaltitude/modules/device/application/DeviceQueryServiceTest.java`
- Create: `server/src/test/java/com/uav/lowaltitude/modules/device/application/DeviceSnapshotReaderTest.java`

**Service interface:**

```java
public interface DeviceQueryService {
    PageResult<DeviceSummaryView> list(DeviceListCriteria criteria);
    DeviceDetailView get(String deviceId);
    PageResult<DeviceStateHistoryView> states(String deviceId, DeviceStateHistoryCriteria criteria);
}
```

`DefaultDeviceQueryService` 实现该接口。Controller 构造的 criteria 不携带 userId。服务先执行 `accessControlService.require(PermissionCode.DEVICE_READ)`，再用返回的当前 userId 生成 `ScopedDeviceListQuery` 或 `ScopedDeviceStateHistoryQuery`。

- [ ] **Step 1: 先写服务层失败与空值测试**

  覆盖 403 在 SQL 前发生、详情不存在和越权均为 `DEVICE_NOT_FOUND`、可见设备无历史时返回 200 空页、无 latest 时 summary 不创建状态、显式 UNKNOWN 保留、total 不由当前页长度推算。

- [ ] **Step 2: 写 snapshot 白名单测试**

  只读取 `work_state_code/health_code/unknown_reason/has_alarm/last_heartbeat_at/source_seq`。未知键、嵌套对象、metrics、凭据样式键和原始载荷不得进入应用视图。JSON 非对象、字段类型错误或越界必须作为数据完整性错误失败，不能静默伪造为空状态。

- [ ] **Step 3: 实现只读事务服务**

  三个用例都使用只读事务：

  1. 调用 `AccessControlService.require(DEVICE_READ)` 得到当前用户。
  2. 使用当前 userId 执行范围内查询。
  3. detail 未命中抛 `404 DEVICE_NOT_FOUND`；states 先用范围 SQL验证父设备，再查询 count/items。
  4. 把 `Instant`、三值 boolean、latest 缺失和 snapshot 白名单保持为应用视图，不在此处构造 JSON Map。

- [ ] **Step 4: 运行服务测试并提交**

  ```bash
  cd server
  ./mvnw -Dtest=DeviceQueryServiceTest,DeviceSnapshotReaderTest,AccessControlServiceTest test
  git diff --check
  git add server/src/main/java/com/uav/lowaltitude/modules/device/application server/src/test/java/com/uav/lowaltitude/modules/device/application
  git commit -m "feat(server): serve scoped device queries"
  ```

---

### Task 5: 用显式 DTO 替换设备空壳 Controller

**Files:**
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/api/SourceRefDto.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/api/LocationDto.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/api/DeviceStateDto.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/api/DeviceSummaryDto.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/api/DeviceDetailDto.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/api/DeviceStateHistoryDto.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/device/api/DeviceApiMapper.java`
- Modify: `server/src/main/java/com/uav/lowaltitude/modules/device/api/DeviceController.java`
- Modify: `server/src/main/java/com/uav/lowaltitude/platform/api/GlobalExceptionHandler.java`
- Create: `server/src/test/java/com/uav/lowaltitude/modules/device/api/DeviceApiTest.java`

**HTTP interfaces:**

```text
GET /api/v1/devices
GET /api/v1/devices/{device_id}
GET /api/v1/devices/{device_id}/states
```

- [ ] **Step 1: 先写 MockMvc 契约测试**

  覆盖：

  - 无 Token 401 `UNAUTHENTICATED`；无动作权限、角色停用、NONE、ASSIGNED 无元组均为 403 `FORBIDDEN`。
  - 精确范围和 ALL 的返回边界；跨范围项既不在 items 也不在 total。
  - 默认分页、1/100 边界、非法分页、重复参数、未知枚举、合法超末页空结果。
  - 六个列表筛选、固定排序及并列 ID 稳定性。
  - 详情 ID 校验、存在、缺失和越权 404 同码。
  - 历史时间成对校验、闭区间、connectivity、父设备 404 和固定排序。
  - 无 latest 与显式 UNKNOWN 的差异；latest 必含 `observed_at/received_at`；历史可省略 observed_at。
  - `has_alarm=false` 明确返回而 null 省略；高度两字段成对；所有时间为 epoch 毫秒。
  - 响应不包含 `credential_ref/metrics/snapshot/payload`。

- [ ] **Step 2: 运行 Controller 红灯测试**

  ```bash
  cd server
  ./mvnw -Dtest=DeviceApiTest test
  ```

  预期：现有 Controller 仍只返回空 Map，新增契约断言失败。

- [ ] **Step 3: 实现 DTO 与 API 映射**

  DTO 字段与契约 §5.2、§6.1–6.3 完全一致。`LocationDto.coordinateSystem` 固定为 `WGS84`；`DeviceApiMapper` 负责 `Instant.toEpochMilli()`，不得改变全局 Jackson null 配置。

- [ ] **Step 4: 实现三个 GET 路由**

  Controller 只调用 `DeviceRequestParser → DeviceQueryService → DeviceApiMapper`。删除旧的 size/page 静默夹紧和 `Map<String,Object>`；不在 Controller 中写 SQL、授权或范围过滤。

- [ ] **Step 5: 收口 API 错误格式**

  `GlobalExceptionHandler` 对未分类服务端错误返回 500/`INTERNAL_ERROR` 和固定脱敏消息；日志可记录异常栈但不得包含 Authorization、session ID、credential_ref 或原始 payload。既有 `ApiException` 和 validation 处理优先级保持不变。

- [ ] **Step 6: 运行 API 与认证回归并提交**

  ```bash
  cd server
  ./mvnw -Dtest=DeviceApiTest,AuthApiTest,LoginFailurePersistenceTest test
  git diff --check
  git add server/src/main/java/com/uav/lowaltitude/modules/device/api server/src/main/java/com/uav/lowaltitude/platform/api/GlobalExceptionHandler.java server/src/test/java/com/uav/lowaltitude/modules/device/api
  git commit -m "feat(server): implement device read APIs"
  ```

---

### Task 6: PostgreSQL/PostGIS 接口验收、消费者核对和文档

**Files:**
- Create: `server/src/test/java/com/uav/lowaltitude/modules/device/api/PostgresDeviceApiTest.java`
- Modify: `server/README.md`
- Modify: `docs/后端开发基线.md`
- Create: `docs/backend-stage3/exit-report.md`

- [ ] **Step 1: 在随机隔离 schema 运行真实方言 API 测试**

  复用阶段 2 的 Postgres test profile 和随机 `stage3_` schema 守卫，插入带 `ST_SetSRID(ST_MakePoint(longitude,latitude),4326)` 的合成设备。通过 MockMvc 断言 detail 返回正确 `longitude/latitude/WGS84`，列表、count、详情和历史在 Postgres 上与 H2 行为一致。

- [ ] **Step 2: 验证时间与 latest 边界**

  准备以下状态事实：无 latest 的设备、UNKNOWN latest，以及事件时间相同但接收时间更晚和事件时间未知的历史行。断言列表/详情只读取 `device_state` 中已存在的 latest，不会拿更晚的 history received_at 替代；历史仍按 `COALESCE` 稳定排序。本阶段只验收读取语义，不声称验证尚未实现的摄取侧 latest 更新算法。

- [ ] **Step 3: 运行真实方言与全量构建**

  ```bash
  cd server
  ./mvnw -Dtest=PostgresDeviceApiTest test
  ./mvnw test
  ./mvnw package
  ```

  运行前在本地进程环境中设置阶段 2 约定的三项 `POSTGRES_TEST_*` 变量。从 Surefire 报告记录每条命令的实际 tests/failures/errors/skipped。无法提供隔离 Postgres 时把本阶段标为 `NOT READY`，不以 H2 替代。

- [ ] **Step 4: 只读核对前端消费者**

  ```bash
  rg -n "/api/v1/devices|device_no|latest_state|connectivity" ../dongying-vue
  ```

  记录现有消费者是否依赖旧空分页或静默 page/size 修正。本阶段不改前端；若发现必须同步的破坏性依赖，作为明确阻塞交回总协调，不自行扩大范围。

- [ ] **Step 5: 更新真实实现状态**

  README 记录三个已实现 GET、参数、错误、local/test 启动方式和 Postgres 测试方法；开发基线只把“设备读取”提升为已实现，不把目标、告警、回放或 live 标为完成。

- [ ] **Step 6: 独立审查并形成退出报告**

  阻断条件包括：仅登录不查权限、Java 过滤范围、items/total 条件不同、详情先查后隐藏、ALL 暴露空归属、重复标量被折叠、非法分页被夹紧、latest 从 received_at 合成、history snapshot 透传、空间只在 H2 验证、返回敏感内部字段。

  ```bash
  git diff --check
  rg -n "Map<String, Object>|ABNORMAL|credential_ref|metrics|payload" server/src/main/java/com/uav/lowaltitude/modules/device
  git add server/src/test/java/com/uav/lowaltitude/modules/device/api/PostgresDeviceApiTest.java server/README.md docs/后端开发基线.md docs/backend-stage3/exit-report.md
  git commit -m "docs(server): verify stage 3 device APIs"
  ```

  `rg` 命中只允许出现在明确的内部行或禁止透传测试中；生产 API DTO 和响应映射不得包含这些字段。只有无未解决 P0/P1、真实方言与全量构建均有证据时，退出报告才能为 `READY`。

## Stage 3 Exit Criteria

- 三个设备 GET 使用显式 DTO 和真实数据库查询；旧空 Map 与静默分页夹紧已移除。
- 所有路径执行当前动作权限和 SQL 范围隔离；items、total、详情、父设备和历史语义一致。
- 分页、重复标量、枚举、路径 ID、成对时间、固定排序和错误码与 `7a38402` 一致。
- 无 latest、UNKNOWN、三值 has_alarm、历史 observed_at 缺失、WGS-84 位置和 epoch 毫秒均有自动化断言。
- API 不返回凭据引用、metrics、snapshot、Inbox payload 或原始消息。
- H2、PostgreSQL/PostGIS、认证回归和 Maven package 均有实际测试统计；`git diff --check` 无输出。
- 独立审查无 P0/P1，总协调结论为 `READY`。
