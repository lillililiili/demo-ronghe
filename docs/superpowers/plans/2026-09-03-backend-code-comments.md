# 后端阶段一代码注释 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为已经通过 PR #2 合入 `main` 的后端阶段一安全基线补充准确、可维护的中文注释，覆盖全部 9 个本轮后端代码、配置和测试文件，不改变任何运行行为。

**Architecture:** 从 `origin/main@d0a0b4e` 创建独立注释分支，以类级 Javadoc 说明职责与安全边界，以方法级或局部注释解释事务、失败关闭和测试意图。注释仅描述已经由代码与测试证明的事实，不把空接口、Mock 模式或审计 Mapper 夸大为生产能力。

**Tech Stack:** Java 17、Spring Boot 3.4.5、Spring Security、Spring JDBC/MyBatis、Maven Wrapper、JUnit 5、MockMvc、H2 测试库、YAML、Maven XML。

## Global Constraints

- 只添加注释，不修改条件、注解、方法签名、SQL、配置值、依赖、错误码或响应字段。
- 每个本轮后端增量文件至少有一处解释“为什么”的注释；不对 import、getter、明显赋值逐行复述。
- 安全和事务注释必须与现有测试一致；注释不能作为功能完成或生产可用的证据。
- `integration` 模式仍要求显式设置 `APP_SOURCE_MODE`，没有对应 Adapter 时继续启动失败。
- 登录失败记录仍由 `REQUIRES_NEW` 独立事务提交；登录成功的会话与成功审计仍在主事务中提交。
- 不新增依赖，不改 Flyway，不接触前端文件，不修改用户当前工作区的未跟踪文件。
- 所有 Maven 命令在 `server/` 目录运行；交付前必须执行 `git diff --check`。

---

## Scope Map

| 文件 | 现有职责 | 计划注释重点 |
| --- | --- | --- |
| `server/src/main/java/com/uav/lowaltitude/integration/SourceModeGuard.java` | 启动期校验来源模式及 Adapter | 失败关闭、配置与实现必须匹配 |
| `server/src/main/java/com/uav/lowaltitude/integration/MockAdapter.java` | 仅在显式 Mock 模式注册适配器 | 不允许缺配置时默认启用 Mock |
| `server/src/main/resources/application-integration.yml` | 集成环境数据源与来源模式 | `APP_SOURCE_MODE` 无默认值的原因 |
| `server/pom.xml` | Java 版本及构建插件 | `release=17` 与 CI/运行基线一致性 |
| `server/src/main/java/com/uav/lowaltitude/modules/identity/application/AuthService.java` | 登录、退出、当前用户和会话解析 | 主事务、失败记录委托、会话有效性 |
| `server/src/main/java/com/uav/lowaltitude/modules/identity/application/LoginFailureRecorder.java` | 独立持久化登录失败和锁定信息 | `REQUIRES_NEW`、失败次数与锁定阈值 |
| `server/src/test/java/com/uav/lowaltitude/integration/SourceModeGuardTest.java` | 来源模式启动门禁测试 | 三个边界场景的业务意义 |
| `server/src/test/java/com/uav/lowaltitude/modules/identity/api/AuthApiTest.java` | 认证 API 与受保护空列表回归 | 测试环境边界及 token 辅助方法 |
| `server/src/test/java/com/uav/lowaltitude/modules/identity/api/LoginFailurePersistenceTest.java` | 失败计数、审计和锁定持久化回归 | 为什么必须直接查询数据库 |

## 阶段与时间概览

| 阶段 | 交付物 | 预计时间 |
| --- | --- | ---: |
| 1. 建立隔离分支并确认基线 | 精确文件清单、干净基线、初始测试证据 | 20–30 分钟 |
| 2. 来源模式与构建配置注释 | Guard、Mock Adapter、integration YAML、Maven 注释 | 45–60 分钟 |
| 3. 认证事务与失败审计注释 | `AuthService`、`LoginFailureRecorder` 注释 | 60–75 分钟 |
| 4. 回归测试代码注释 | 三个测试类的意图与隔离说明 | 30–45 分钟 |
| 5. 全量验证、复审与 PR | 测试、打包、差异检查、提交和 PR | 45–60 分钟 |

**总预计：3 小时 20 分钟至 4 小时 30 分钟。** 若 Maven 依赖已缓存且 GitHub CI 无排队，通常约 3.5 小时；网络或 CI 较慢时接近 4.5 小时。

---

### Task 1: 建立隔离分支并锁定注释范围

**Files:**
- Inspect: `server/src/main/java/com/uav/lowaltitude/integration/SourceModeGuard.java`
- Inspect: `server/src/main/java/com/uav/lowaltitude/integration/MockAdapter.java`
- Inspect: `server/src/main/java/com/uav/lowaltitude/modules/identity/application/AuthService.java`
- Inspect: `server/src/main/java/com/uav/lowaltitude/modules/identity/application/LoginFailureRecorder.java`
- Inspect: `server/src/main/resources/application-integration.yml`
- Inspect: `server/pom.xml`
- Inspect: `server/src/test/java/com/uav/lowaltitude/integration/SourceModeGuardTest.java`
- Inspect: `server/src/test/java/com/uav/lowaltitude/modules/identity/api/AuthApiTest.java`
- Inspect: `server/src/test/java/com/uav/lowaltitude/modules/identity/api/LoginFailurePersistenceTest.java`

**Interfaces:**
- Consumes: `origin/main@d0a0b4e` 中已经合入的阶段一实现。
- Produces: 一个只允许上述 9 个文件出现注释差异的隔离分支。

- [ ] **Step 1: 使用 `superpowers:using-git-worktrees` 创建独立工作树**

```bash
git fetch origin
comments_root=$(mktemp -d /private/tmp/dongyiwurenji-backend-comments.XXXXXX)
git worktree add "$comments_root/worktree" -b codex/backend-code-comments origin/main
```

Expected: `mktemp -d` 返回唯一绝对目录；新工作树分支为 `codex/backend-code-comments`，起点为最新 `origin/main`。

- [ ] **Step 2: 核对基线和用户工作区隔离**

```bash
git status --short
git rev-parse HEAD origin/main
git diff --name-status d0a0b4e^1 d0a0b4e -- server
```

Expected: 新工作树状态为空，`HEAD` 与 `origin/main` 一致；阶段一后端差异只对应 Scope Map 中的 9 个文件。

- [ ] **Step 3: 运行修改前基线测试**

```bash
cd server
./mvnw test
```

Expected: `BUILD SUCCESS`；Surefire 汇总至少包含 `AuthApiTest` 8 个、`LoginFailurePersistenceTest` 2 个、`SourceModeGuardTest` 3 个测试，失败数为 0。

---

### Task 2: 注释来源模式与构建配置

**Files:**
- Modify: `server/src/main/java/com/uav/lowaltitude/integration/SourceModeGuard.java`
- Modify: `server/src/main/java/com/uav/lowaltitude/integration/MockAdapter.java`
- Modify: `server/src/main/resources/application-integration.yml`
- Modify: `server/pom.xml`
- Test: `server/src/test/java/com/uav/lowaltitude/integration/SourceModeGuardTest.java`

**Interfaces:**
- Consumes: `AppProperties#getSourceMode()`、`AdapterPort#mode()`、`SourceMode` 枚举。
- Produces: 不改变 Bean 注册与启动结果的类级、配置级中文注释。

- [ ] **Step 1: 为 `SourceModeGuard` 添加类级安全边界说明**

在 `@Component` 前添加：

```java
/**
 * 在 Spring 启动阶段校验数据来源模式。
 * 配置缺失、枚举未知或没有对应 Adapter 时直接拒绝启动，防止集成/生产环境静默降级为 Mock。
 */
```

并在 Adapter 匹配判断前添加：

```java
// 配置值存在还不够，运行时必须确实装配同模式的 Adapter 实现。
```

- [ ] **Step 2: 为 `MockAdapter` 添加显式启用说明**

在类注解前添加：

```java
/** 仅在明确配置 app.source-mode=mock 时注册；缺少配置不会自动启用演示适配器。 */
```

- [ ] **Step 3: 注释 integration 配置的失败关闭规则**

在 `source-mode` 前添加：

```yaml
  # 集成环境必须由部署方显式选择来源模式，禁止缺省回落到 mock。
  source-mode: ${APP_SOURCE_MODE}
```

- [ ] **Step 4: 注释 Maven Java 版本约束**

在 `maven-compiler-plugin` 前添加：

```xml
<!-- 显式按 Java 17 API 与字节码级别编译，使本地构建和 CI 使用同一后端基线。 -->
```

- [ ] **Step 5: 运行来源模式定向测试**

```bash
cd server
./mvnw -Dtest=SourceModeGuardTest test
```

Expected: 3 tests run，0 failures，`BUILD SUCCESS`。

- [ ] **Step 6: 检查并提交本阶段**

```bash
git diff --check
git diff -- server/src/main/java/com/uav/lowaltitude/integration server/src/main/resources/application-integration.yml server/pom.xml
git add server/src/main/java/com/uav/lowaltitude/integration/SourceModeGuard.java server/src/main/java/com/uav/lowaltitude/integration/MockAdapter.java server/src/main/resources/application-integration.yml server/pom.xml
git commit -m "docs(server): explain source mode safety boundary"
```

Expected: 差异只有 Java/YAML/XML 注释，没有条件或配置值变化。

---

### Task 3: 注释认证事务与失败审计

**Files:**
- Modify: `server/src/main/java/com/uav/lowaltitude/modules/identity/application/AuthService.java`
- Modify: `server/src/main/java/com/uav/lowaltitude/modules/identity/application/LoginFailureRecorder.java`
- Test: `server/src/test/java/com/uav/lowaltitude/modules/identity/api/AuthApiTest.java`
- Test: `server/src/test/java/com/uav/lowaltitude/modules/identity/api/LoginFailurePersistenceTest.java`

**Interfaces:**
- Consumes: `UserMapper`、`SessionMapper`、`AuditService`、`AppClock`、`PasswordEncoder`。
- Produces: 对登录成功主事务、失败独立事务、锁定阈值和会话解析规则的准确说明。

- [ ] **Step 1: 为 `LoginFailureRecorder` 说明独立事务目的**

在 `@Service` 前添加：

```java
/**
 * 在独立事务中持久化登录失败事实。
 * 外层登录用例随后抛出 401 异常时，本类写入的失败次数、锁定时间和失败审计不会随外层事务回滚。
 */
```

在 `badPassword(...)` 的计数逻辑前添加：

```java
// 本次失败达到阈值时同时写入 locked_until，避免计数已到上限但账号仍可继续尝试。
```

- [ ] **Step 2: 为 `AuthService#login` 说明事务分界**

在方法前添加：

```java
/**
 * 校验账号并创建数据库会话。成功时会话、计数重置和成功审计在同一主事务提交；
 * 失败事实委托给 LoginFailureRecorder 的独立事务后再返回稳定的认证错误码。
 */
```

在成功路径重置失败次数前添加：

```java
// 只有密码验证成功才清零失败状态，并与新会话及成功审计一起提交。
```

- [ ] **Step 3: 为退出和会话解析添加边界说明**

在 `logout(...)` 前添加：

```java
/** 使当前会话失效，并在同一事务中记录退出审计。 */
```

在 `resolve(...)` 前添加：

```java
/**
 * 只解析未过期且用户仍为正常状态的会话；返回 null 由认证过滤器统一转换为未认证响应。
 */
```

- [ ] **Step 4: 运行认证和失败持久化定向测试**

```bash
cd server
./mvnw -Dtest=AuthApiTest,LoginFailurePersistenceTest test
```

Expected: 10 tests run，0 failures，`BUILD SUCCESS`。

- [ ] **Step 5: 检查并提交本阶段**

```bash
git diff --check
git diff -- server/src/main/java/com/uav/lowaltitude/modules/identity/application
git add server/src/main/java/com/uav/lowaltitude/modules/identity/application/AuthService.java server/src/main/java/com/uav/lowaltitude/modules/identity/application/LoginFailureRecorder.java
git commit -m "docs(server): explain authentication transaction boundaries"
```

Expected: 只新增 Javadoc 和局部注释，Java 语句逐字保持不变。

---

### Task 4: 注释后端回归测试意图

**Files:**
- Modify: `server/src/test/java/com/uav/lowaltitude/integration/SourceModeGuardTest.java`
- Modify: `server/src/test/java/com/uav/lowaltitude/modules/identity/api/AuthApiTest.java`
- Modify: `server/src/test/java/com/uav/lowaltitude/modules/identity/api/LoginFailurePersistenceTest.java`

**Interfaces:**
- Consumes: 阶段一现有 JUnit 5、MockMvc、JdbcTemplate 测试。
- Produces: 清楚说明每组测试防止哪类回归的中文注释，不改变断言或测试数据。

- [ ] **Step 1: 注释 `SourceModeGuardTest` 的三类门禁**

在测试类前添加：

```java
/** 覆盖来源模式的失败关闭边界：缺配置、缺实现必须失败，显式 Mock 且有 Adapter 才能通过。 */
```

- [ ] **Step 2: 注释 `AuthApiTest` 的接口级职责**

在测试类前添加：

```java
/** 通过 MockMvc 验证认证响应契约，以及告警/设备空列表仍必须经过 Bearer 会话鉴权。 */
```

在 `loginToken(...)` 前添加：

```java
// 复用真实登录端点取得会话，避免测试绕过认证链直接伪造 token。
```

- [ ] **Step 3: 注释 `LoginFailurePersistenceTest` 的数据库证据**

在测试类前添加：

```java
/** 直接查询数据库证明 401 返回后失败计数和审计已经提交，而不是只验证 HTTP 表象。 */
```

在 `resetDuty1()` 前添加：

```java
// 前后都清理同一合成账号，保证锁定阈值测试可重复且不污染其他测试。
```

- [ ] **Step 4: 运行三个测试类**

```bash
cd server
./mvnw -Dtest=SourceModeGuardTest,AuthApiTest,LoginFailurePersistenceTest test
```

Expected: 13 tests run，0 failures，`BUILD SUCCESS`。

- [ ] **Step 5: 检查并提交本阶段**

```bash
git diff --check
git diff -- server/src/test/java
git add server/src/test/java/com/uav/lowaltitude/integration/SourceModeGuardTest.java server/src/test/java/com/uav/lowaltitude/modules/identity/api/AuthApiTest.java server/src/test/java/com/uav/lowaltitude/modules/identity/api/LoginFailurePersistenceTest.java
git commit -m "docs(test): explain backend security regression intent"
```

Expected: 测试方法、请求、SQL 和断言不变，只新增注释。

---

### Task 5: 全量验证、差异复审与交付

**Files:**
- Verify: Scope Map 中全部 9 个文件。
- Do not modify: `server/src/main/resources/db/migration/**`
- Do not modify: `dongying-vue/**`

**Interfaces:**
- Consumes: 前四个任务的三个注释提交。
- Produces: 可审查的后端注释 PR、完整 Maven 证据和注释文件清单。

- [ ] **Step 1: 运行后端完整测试**

```bash
cd server
./mvnw test
```

Expected: `BUILD SUCCESS`，0 failures；记录 Surefire 实际测试数量。

- [ ] **Step 2: 运行后端打包**

```bash
cd server
./mvnw package
```

Expected: `BUILD SUCCESS`，生成可打包产物；不得把 `target/` 加入提交。

- [ ] **Step 3: 证明差异只包含注释**

```bash
git diff --check origin/main...HEAD
git diff --name-status origin/main...HEAD
git diff --numstat origin/main...HEAD
git diff --unified=0 origin/main...HEAD -- server
```

Expected: 恰好 9 个 Scope Map 文件；无删除行；逐项人工确认新增行全部位于 Java、YAML 或 XML 注释中。

- [ ] **Step 4: 检查工作区与禁止范围**

```bash
git status --short
git diff --name-only origin/main...HEAD -- dongying-vue server/src/main/resources/db/migration
```

Expected: 工作区干净；前端与 Flyway 迁移没有差异。

- [ ] **Step 5: 推送并创建独立 PR**

```bash
git push -u origin codex/backend-code-comments
gh pr create --base main --head codex/backend-code-comments --title "docs(server): 补充阶段一安全基线代码注释" --body "仅补充后端阶段一安全基线的中文维护注释；不改变运行行为。已执行 ./mvnw test、./mvnw package 和 git diff --check。"
```

Expected: PR 仅包含 9 个后端文件，GitHub 前后端 CI 均成功，合并前仍需一名非作者审批。

## Self-Review Result

- 覆盖 PR #2 的全部 9 个后端代码、配置和测试文件。
- 没有扩展到告警、设备、RBAC 或数据库新功能。
- 没有修改已应用迁移、依赖版本、接口契约或业务行为。
- 所有阶段都有精确文件、注释内容、验证命令、预期结果和独立提交点。
- 注释重点是事务与安全设计理由，不重复显而易见的语句。
