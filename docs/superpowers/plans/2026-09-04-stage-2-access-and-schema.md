# T02 雷达只读后端阶段 2：权限与数据库基础实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在阶段 1 契约通过退出审查后，实现默认拒绝的读取权限与数据范围模型、两批不可逆向覆盖历史的 Flyway 迁移、隔离的 local/test 合成授权，以及 PostgreSQL/PostGIS 迁移验收，为阶段 3 的设备查询提供可靠底座。

**Architecture:** 权限真源保存在身份模块，业务模块只通过 `AccessControlService` 获取当前会话的动作权限和范围决策；不把权限复制进 `AuthUser`，也不缓存授权结果。数据库严格按“权限批次先、雷达只读数据批次后”迁移，业务归属使用组织与区域的精确元组；生产迁移只建权限目录，不授予任何角色。H2 只承担快速回归，空间类型、表达式索引、约束和升级路径必须另在隔离 PostgreSQL 16/PostGIS 3.5 中验收。

**Tech Stack:** Java 17、Spring Boot 3.4.5、MyBatis 3.0.4、Flyway、PostgreSQL 16/PostGIS 3.5、H2 test profile、JUnit 5、AssertJ、Maven Wrapper。

## Global Constraints

- 执行入口必须满足阶段 1 总协调结论为 `READY`，并已把数据/API 契约提交 `7a384020b72b7a293386c8bd774b979788005e34`、回放契约提交 `d60232f6f20e61d0d7bc89e76aa005f86657549d` 以及最终审查结论合入同一实现基线；任一契约再次变化时先更新本计划。
- 遵守仓库根 `AGENTS.md` 与 `server/AGENTS.md`；所有 Maven 命令只在 `server/` 执行。
- 开工前重新列出 `server/src/main/resources/db/migration`。若仍只有 V1/V2，批次 A 使用 V3、批次 B 使用 V4；若版本已被占用，两个新迁移整体顺延并同步本计划中的文件名，禁止修改 V1/V2 或复用已存在版本。
- 不增加或升级生产/测试依赖，不修改前端，不实现回放解析、目标/轨迹查询、告警查询、真实连接或任何设备控制。
- 生产迁移只创建 `device:read`、`target:read`、`alarm:read` 权限目录，绝不自动启用兼容角色、建立角色权限映射、授予 `ALL` 或回填虚构归属。
- `scope_mode=NONE`、`ASSIGNED` 无范围行、角色停用、用户停用或缺动作权限均拒绝访问；旧 `app_user.org_id` 不参与授权。
- `ASSIGNED` 只匹配同一行的 `(org_id,district_id)` 元组，不能把两个集合做笛卡尔积；`ALL` 也不能看到任一归属为空的记录。
- 新业务时间使用 `timestamptz`/Java `Instant`；既有 Inbox 时间列仍为 epoch 毫秒 `bigint`。未知坐标、高度、状态和时间保持 `NULL`，不得写入零点、在线或成功作为替代。
- `connectivity` 的唯一字典为 `ONLINE/OFFLINE/DEGRADED/UNKNOWN`；数据库和 Java 中均不接受 `ABNORMAL`。
- 阶段 2 不改现有 Controller 的响应形状；设备 Controller 的真实查询和显式分页错误留到阶段 3，目标和告警接口留给后续阶段。

## 预计工期与并行边界

**总工期：2–3 个工作日。** 迁移版本号和共享配置由总协调任务先锁定。实现甲负责权限批次与授权服务，实现乙负责雷达数据批次；二者不得同时修改同一个迁移或配置文件。两条实现线完成后，再由集成任务处理 local/test 合成数据与 PostgreSQL/PostGIS 验收，独立审查任务只出问题单和结论，不直接改实现分支。

| 时间 | 工作流 | 退出证据 |
| --- | --- | --- |
| 第 1 天上午 | 基线、迁移版本锁定、权限迁移红灯测试 | 基线用例数；缺表测试先失败；迁移版本无冲突 |
| 第 1 天下午至第 2 天 | 权限服务与雷达数据迁移并行 | 两条定向测试均通过；生产无自动授权 |
| 第 2 天下午 | local/test 合成授权、全量 H2 回归 | 鉴权矩阵通过；原认证测试不回退 |
| 第 3 天 | PostgreSQL/PostGIS 空库与 V1/V2 升级验收、独立审查 | 两条迁移路径、约束和空间索引证据；无 P0/P1 |

---

### Task 1: 锁定实现基线、迁移版本和失败测试

**Files:**
- Read: `docs/backend-stage1/data-api-contract.md`
- Read: `docs/backend-stage1/t02-replay-contract.md`
- Read: `docs/backend-stage1/exit-report.md`
- Read: `server/src/main/resources/db/migration/`
- Create: `server/src/test/java/com/uav/lowaltitude/migration/AccessSchemaMigrationTest.java`
- Create: `server/src/test/java/com/uav/lowaltitude/migration/RadarSchemaMigrationTest.java`

**Interfaces:**
- Consumes: 阶段 1 的唯一名称、字段、约束、状态和来源映射。
- Produces: 被后续两批迁移满足的可执行结构断言，以及不会撞号的迁移文件名。

- [ ] **Step 1: 核对阶段入口**

  ```bash
  git status --short
  git log --oneline --all -- docs/backend-stage1
  find server/src/main/resources/db/migration -maxdepth 1 -type f -print | sort
  ```

  记录工作树未提交状态并保留用户文件。确认阶段 1 最终报告为 `READY`、两份契约修订均在实现基线中、当前最高迁移版本及两个连续可用版本。缺任一条件时不开始写 SQL。

- [ ] **Step 2: 记录后端基线测试**

  ```bash
  cd server
  ./mvnw test
  ```

  从 `target/surefire-reports` 统计 tests/failures/errors/skipped，记录实际数字；不能只写“命令成功”。任何既有失败先单独定位，不混进阶段 2 改动。

- [ ] **Step 3: 先写迁移结构测试**

  `AccessSchemaMigrationTest` 必须断言权限批次中的 6 张新表、`app_user.scope_mode/permission_version`、角色外键、默认 `NONE`、三条权限目录和“无角色权限映射”。

  `RadarSchemaMigrationTest` 必须断言 10 张新业务表、Inbox 8 个增量字段、四值 connectivity、`has_alarm` 无默认值、设备高度/基准同空约束、归属外键、关键唯一键以及 `alarm` 不含 `uav_event_id`。

- [ ] **Step 4: 运行红灯测试**

  ```bash
  cd server
  ./mvnw -Dtest=AccessSchemaMigrationTest,RadarSchemaMigrationTest test
  ```

  预期：因新表或列不存在而失败。若测试在迁移实现前通过，说明断言没有覆盖新增事实，必须补强测试。

---

### Task 2: 实现批次 A——最小只读权限结构

**Files:**
- Create: `server/src/main/resources/db/migration/V3__access_control.sql`（仅当预检确认下一个版本为 V3）
- Modify: `server/src/test/java/com/uav/lowaltitude/migration/AccessSchemaMigrationTest.java`

**Schema contract:**
- Creates: `app_org`、`app_district`、`app_role`、`app_permission`、`app_role_permission`、`app_user_data_scope`。
- Alters: `app_user.scope_mode`、`app_user.permission_version`、`app_user.role_code` 外键。
- Catalog rows only: `device:read`、`target:read`、`alarm:read`。

- [ ] **Step 1: 创建组织、区域、角色与权限目录**

  按数据契约 §3.1 实现全部字段、非空、CHECK、FK、唯一键、版本列和可移植查询索引。`app_org.parent_id` 和 `app_district.parent_id` 在版本化迁移中用 CHECK 禁止自指；任意深度的循环由 Task 4 的 PostgreSQL 约束触发器阻断。本阶段不猜造层级闭包或自动继承。

- [ ] **Step 2: 安全兼容现有角色码**

  在给 `app_user.role_code` 添加外键之前，用 `SELECT DISTINCT role_code FROM app_user` 创建同码、`enabled=false`、无权限关系的兼容角色。技术名称必须由完整角色码确定且满足唯一和长度约束，不改变已有用户角色码。

- [ ] **Step 3: 扩展用户授权字段**

  增加：

  ```sql
  scope_mode VARCHAR(16) NOT NULL DEFAULT 'NONE'
      CHECK (scope_mode IN ('NONE', 'ASSIGNED', 'ALL')),
  permission_version BIGINT NOT NULL DEFAULT 0
      CHECK (permission_version >= 0)
  ```

  不根据 `role_code`、`org_id`、账号名或环境自动回填范围。

- [ ] **Step 4: 写入权限目录但不授予角色**

  只插入三个稳定权限码及其 `module_code/ACTION/read/name`。迁移完成后必须断言 `app_role_permission` 和 `app_user_data_scope` 都为空，所有既有用户仍为 `NONE`，兼容角色仍为禁用。

- [ ] **Step 5: 运行定向与认证回归**

  ```bash
  cd server
  ./mvnw -Dtest=AccessSchemaMigrationTest,AuthApiTest,LoginFailurePersistenceTest test
  ```

  预期：结构测试和既有认证测试通过；报告实际测试数、失败数和跳过数。

- [ ] **Step 6: 提交权限迁移**

  ```bash
  git diff --check
  git add server/src/main/resources/db/migration/V3__access_control.sql server/src/test/java/com/uav/lowaltitude/migration/AccessSchemaMigrationTest.java
  git commit -m "feat(server): add read access schema"
  ```

  若预检选用的不是 V3，命令中的文件名使用已锁定版本。

---

### Task 3: 实现当前会话的动作权限与范围决策

**Files:**
- Create: `server/src/main/java/com/uav/lowaltitude/modules/identity/domain/PermissionCode.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/identity/domain/ScopeMode.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/identity/domain/AccessDecision.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/identity/application/AccessControlService.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/identity/application/DatabaseAccessControlService.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/identity/infrastructure/AccessControlMapper.java`
- Create: `server/src/test/java/com/uav/lowaltitude/modules/identity/application/AccessControlServiceTest.java`

**Interfaces:**

```java
public enum PermissionCode {
    DEVICE_READ("device:read"),
    TARGET_READ("target:read"),
    ALARM_READ("alarm:read");

    private final String value;
    PermissionCode(String value) { this.value = value; }
    public String value() { return value; }
}

public enum ScopeMode { NONE, ASSIGNED, ALL }

public record AccessDecision(String userId, ScopeMode scopeMode) {}

public interface AccessControlService {
    public AccessDecision require(PermissionCode permission);
}
```

- [ ] **Step 1: 先写拒绝优先的服务测试**

  覆盖：无会话返回 `UNAUTHENTICATED`；用户停用、角色缺失/停用、权限映射缺失、`NONE`、`ASSIGNED` 无范围行均返回 HTTP 403/`FORBIDDEN`；`ASSIGNED` 有至少一个精确元组和显式 `ALL` 才返回决策。

- [ ] **Step 2: 运行红灯测试**

  ```bash
  cd server
  ./mvnw -Dtest=AccessControlServiceTest test
  ```

  预期：类型或实现尚不存在而失败。

- [ ] **Step 3: 实现 Mapper 和服务**

  `DatabaseAccessControlService` 实现 `AccessControlService`。Mapper 以 `AuthContext.require().userId()` 为唯一用户输入，从当前数据库联查：用户状态为 `正常`、角色存在且启用、角色具有请求的权限码、当前 `scope_mode`。`ASSIGNED` 再核对至少存在一条有效的组织/区域元组；组织停用或区域不存在不计入有效范围。

  服务不使用授权缓存，因此角色、范围或权限变化会在下一次请求生效；`permission_version` 仍作为未来受控缓存的失效依据保留。不得信任 `AuthUser.roleCode()` 直接放行。

- [ ] **Step 4: 验证数据库变更立即生效**

  在同一测试类中先成功授权，再删除角色权限关系或递增 `permission_version` 并切换范围，下一次调用必须立即按新状态拒绝或返回新决策。

- [ ] **Step 5: 运行定向测试并提交**

  ```bash
  cd server
  ./mvnw -Dtest=AccessControlServiceTest,AuthApiTest,LoginFailurePersistenceTest test
  git diff --check
  git add server/src/main/java/com/uav/lowaltitude/modules/identity server/src/test/java/com/uav/lowaltitude/modules/identity
  git commit -m "feat(server): enforce read permissions and scopes"
  ```

---

### Task 4: 实现批次 B——雷达只读数据结构

**Files:**
- Create: `server/src/main/resources/db/migration/V4__radar_read_model.sql`（仅当批次 A 为 V3）
- Create: `server/src/main/resources/db/postgresql/R__stage2_postgres_constraints_and_indexes.sql`
- Modify: `server/src/main/resources/application.yml`
- Modify: `server/src/test/resources/application-test.yml`
- Modify: `server/src/test/java/com/uav/lowaltitude/migration/RadarSchemaMigrationTest.java`

**Schema contract:**
- Creates: `integration_source`、`device`、`device_state`、`device_state_history`、`target`、`target_source_link`、`target_latest_state`、`track`、`track_point`、`alarm`。
- Alters: `inbox_message`，保留原主键、原四列及 `UNIQUE(source, source_msg_id)`。

- [ ] **Step 1: 隔离公共迁移和 PostgreSQL 专属 DDL**

  `db/migration` 保留 V1/V2 和两个可由 H2 快速执行的新增版本迁移；`db/postgresql` 只保存 PostgreSQL 专属、可重复执行且幂等的 DDL。生产 `application.yml` 的 Flyway locations 同时加载两处，test profile 只加载 `classpath:db/migration`。不得移动或复制 V1/V2，也不得关闭 Flyway 校验。

  PostgreSQL 专属脚本必须使用 `CREATE INDEX IF NOT EXISTS`、`CREATE OR REPLACE FUNCTION` 和可重复的 trigger drop/create，负责：geometry GiST、WGS-84 经/纬度范围约束、部分唯一索引、`COALESCE` 表达式排序索引，以及组织/区域任意深度循环检测。H2 不声称验证这些能力；Task 6 必须在 Postgres 上实际验收。

- [ ] **Step 2: 建立来源并增量扩展 Inbox**

  先创建 `integration_source`，再给 Inbox 增加 `source_id/payload_hash/payload/status/processed_at/last_error/lease_token/lease_until`。状态只允许 `RECEIVED/PROCESSING/DONE/FAILED`，租约两列必须同空或同非空。

  新 T02 写入的精确列映射以回放契约 §5.2 为准：payload JSONB 只能包含 `dataset_id/record_no/received_at/frame_hex` 四个键；本阶段只建承载结构，不实现摄取逻辑。同一来源键不同哈希不能插入第二条正常 Inbox。

- [ ] **Step 3: 建立设备及状态表**

  按数据契约 §3.2 创建 `device/device_state/device_state_history`，包括：

  - `geometry(Point,4326)`；GiST 索引和只针对非空位置的经纬度范围约束由 PostgreSQL 专属脚本创建。
  - `altitude_m` 与 `altitude_datum` 同空或同非空。
  - `external_device_id` 与 `source_id` 同空或同非空；非空条件唯一键由 PostgreSQL 专属脚本创建。
  - `device_state.connectivity` 四值 CHECK，无默认值。
  - `has_alarm` 为可空 boolean 且无默认值；`UNKNOWN` 与 `unknown_reason` 保持契约一致。
  - 历史为追加事实；PostgreSQL 表达式索引服务 `COALESCE(observed_at,received_at)` 查询，但该表达式不得成为 latest 胜负规则。

- [ ] **Step 4: 建立目标、轨迹和告警表**

  按固定依赖顺序创建 `target → target_source_link → target_latest_state → track → track_point → alarm`。`target.first_seen_at/last_seen_at` 可同时为空；latest 的 `observed_at` 必填，只有严格更晚的可信事件时间才允许应用层原子覆盖。`alarm` 必须有明确来源，不含 `uav_event_id`，且没有触发器从轨迹、设备状态或目标自动插入告警。

- [ ] **Step 5: 覆盖关键约束和索引测试**

  H2 快速测试除元数据断言外，必须实际尝试并拒绝：`ABNORMAL`、单独高度/基准、单独租约字段、来源模式非法值和无来源告警；另断言 location 默认 `NULL`、任何 seed 都不把 `POINT(0 0)` 当未知值写入，target 的两个摘要时间可同空但不能倒序。经纬度范围、部分唯一键、表达式索引、GiST 和层级循环触发器只在 Task 6 的 PostgreSQL 测试中验收。

- [ ] **Step 6: 运行定向测试并提交**

  ```bash
  cd server
  ./mvnw -Dtest=RadarSchemaMigrationTest,AccessSchemaMigrationTest test
  git diff --check
  git add server/src/main/resources/application.yml server/src/test/resources/application-test.yml server/src/main/resources/db/migration/V4__radar_read_model.sql server/src/main/resources/db/postgresql/R__stage2_postgres_constraints_and_indexes.sql server/src/test/java/com/uav/lowaltitude/migration/RadarSchemaMigrationTest.java
  git commit -m "feat(server): add radar read model schema"
  ```

  若锁定版本整体顺延，命令中的迁移文件名同步替换。

---

### Task 5: 添加仅 local/test 可用的合成授权

**Files:**
- Create: `server/src/main/java/com/uav/lowaltitude/modules/identity/application/LocalAccessSeeder.java`
- Modify: `server/src/main/java/com/uav/lowaltitude/modules/identity/application/LocalUserSeeder.java`
- Create: `server/src/test/java/com/uav/lowaltitude/modules/identity/application/LocalAccessSeederTest.java`

**Interfaces:**
- Guard: `@ConditionalOnProperty(prefix = "app.dev-seed", name = "enabled", havingValue = "true")`。
- Input: 已有合成用户及 `app.dev-seed.password` 门禁。
- Output: 确定性的合成组织、区域、角色启用、读取权限和范围，不创建任何业务设备/目标/告警数据。

- [ ] **Step 1: 先写环境门禁和幂等测试**

  覆盖 dev seed 关闭时无新增授权；开启时 `duty1` 只获得明确的读取权限和一条精确范围元组；执行两次不重复；不会把所有角色启用或赋予 `ALL`。

- [ ] **Step 2: 实现有序、幂等的初始化**

  使用稳定 UUID 与显式 SQL upsert/存在性检查，使 `LocalAccessSeeder` 在 `LocalUserSeeder` 完成后运行。若已有用户但缺部分合成目录，也必须补齐本初始化负责的合成关系，不能因 `app_user` 非空整体跳过。

- [ ] **Step 3: 保持生产默认拒绝**

  在未启用 `app.dev-seed` 的应用上下文中断言三条权限目录存在，但角色权限、范围和 `ALL` 用户均不存在。不得把合成授权写进 Flyway migration。

- [ ] **Step 4: 运行身份与初始化回归并提交**

  ```bash
  cd server
  ./mvnw -Dtest=LocalAccessSeederTest,AccessControlServiceTest,AuthApiTest,LoginFailurePersistenceTest test
  git diff --check
  git add server/src/main/java/com/uav/lowaltitude/modules/identity/application server/src/test/java/com/uav/lowaltitude/modules/identity/application
  git commit -m "feat(server): seed isolated read access"
  ```

---

### Task 6: 在 PostgreSQL 16/PostGIS 3.5 验证迁移和升级路径

**Files:**
- Create: `server/src/test/java/com/uav/lowaltitude/migration/PostgresStage2SchemaTest.java`
- Create: `server/src/test/resources/application-postgres-test.yml`
- Modify: `server/README.md`

**Interfaces:**
- Environment: `POSTGRES_TEST_URL`、`POSTGRES_TEST_USER`、`POSTGRES_TEST_PASSWORD` 只指向可丢弃的隔离测试数据库。
- Safety guard: 测试只操作自己生成的随机 schema；schema 名带固定 `stage2_` 前缀，创建和清理目标均由测试直接持有，禁止连接或清理生产 schema。

- [ ] **Step 1: 写 Postgres 专属迁移测试**

  使用项目现有 Flyway API 在随机 schema 中执行两条路径：空 schema 同时加载 `db/migration` 和 `db/postgresql` 从 V1 迁到最新；另一随机 schema 第一遍只加载 `db/migration` 并以 target V2 停止，第二遍再加载两处 locations 迁到最新，避免 V3/V4 建表前提前执行 PostgreSQL repeatable。测试结束只删除本次生成且通过前缀校验的 schema。

- [ ] **Step 2: 验证 PostgreSQL/PostGIS 特性**

  断言扩展可用、`geometry(Point,4326)` 类型、GiST 索引、JSONB、timestamptz、部分唯一索引、表达式索引、层级循环触发器、CHECK/FK 和第二次 `migrate()` 无新增变更。测试必须实际插入非法样本验证约束，包括重复非空来源外部 ID 和组织/区域循环，而非只查建表文本。

- [ ] **Step 3: 运行 Postgres 专属和全量回归**

  ```bash
  cd server
  ./mvnw -Dtest=PostgresStage2SchemaTest test
  ./mvnw test
  ./mvnw package
  ```

  运行前在本地进程环境中设置三项 `POSTGRES_TEST_*` 变量；凭据不写入源码、README、命令历史截图或提交。

- [ ] **Step 4: 更新运行说明并提交**

  README 记录迁移顺序、PostGIS 前置条件、local/test 合成授权门禁、Postgres 验收命令与生产“无自动授权”事实，不声称真实雷达或业务查询已实现。

  ```bash
  git diff --check
  git add server/src/test/java/com/uav/lowaltitude/migration/PostgresStage2SchemaTest.java server/src/test/resources/application-postgres-test.yml server/README.md
  git commit -m "test(server): verify stage 2 postgres schema"
  ```

---

### Task 7: 独立审查与阶段退出

**Files:**
- Create: `docs/backend-stage2/exit-report.md`
- Review: 阶段 2 全部提交和测试报告

- [ ] **Step 1: 做安全和契约审查**

  阻断条件包括：生产自动授权、角色码直接放行、`AuthUser` 范围直通、`ASSIGNED` 元组被拆开、`ALL` 暴露空归属、修改 V1/V2、H2 代替 PostGIS 验收、接受 `ABNORMAL`、伪造坐标/时间、自动建告警、业务表结构偏离 `7a38402`。

- [ ] **Step 2: 核验实际测试证据**

  汇总 H2 全量、package 和 PostgreSQL/PostGIS 专属测试的实际 tests/failures/errors/skipped；保留无法运行项及原因，不用“预计通过”代替证据。

- [ ] **Step 3: 输出 `READY/NOT READY`**

  只有无未解决 P0/P1，两个迁移路径均通过 Postgres 验证，默认拒绝授权矩阵完整，且 `git diff --check` 无输出时，阶段 2 才可标记 `READY` 并允许阶段 3 启动。

## Stage 2 Exit Criteria

- 两批迁移按连续新版本执行，V1/V2 未修改；空库和 V1/V2 升级均通过。
- 生产只有权限目录，没有角色授权、范围、`ALL` 或演示业务数据。
- 授权服务从当前数据库验证用户、角色、权限、scope mode 与范围存在性；无缓存陈旧窗口。
- 雷达只读结构、Inbox 增量、四值 connectivity、未知值和 latest 所需的非空可信事件时间结构与阶段 1 契约一致；本阶段不声称已实现摄取侧的 latest 更新算法。
- H2 回归、Maven package 和隔离 PostgreSQL/PostGIS 验收都有实际用例统计。
- 独立审查无 P0/P1，总协调结论为 `READY`。
