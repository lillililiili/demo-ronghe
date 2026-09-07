# 第 1 部分：安全基线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修好登录失败计数/审计会被事务回滚的问题，让普通 `./mvnw test` 跑到认证测试，并堵住 integration 环境静默落到 Mock。

**Architecture:** 失败登录写入放到独立事务（`REQUIRES_NEW`），与登录成功事务分开。数据源模式由显式配置 + `SourceModeGuard` 校验，没有对应 Adapter 时拒绝启动。认证测试改名为 Surefire 默认可发现的 `*Test`。

**Tech Stack:** Java 17、Spring Boot 3.4.5、MyBatis、H2 测试、Maven Wrapper。

## Global Constraints

- 不新增生产依赖；不引入 JWT、Redis、MQ、Lombok、JPA。
- 保留 `/api/v1`、Bearer `session_id`、`ApiResponse` 的 `ok/data/error`、snake_case。
- 不修改已应用的 `V1__init.sql`、`V2__outbox_inbox.sql`。
- 本阶段不做 RBAC、数据范围、前端登录贯通、设备/告警业务表。
- 命令只在 `server/` 跑 Maven；不提交 `设备资料/`、凭据、`target/`。

## 本阶段不包含（下一阶段）

- 组织/角色/权限表与用户管理接口。
- 前端 `apiClient`、路由守卫、登录页接真实 API。
- Inbox/Outbox Worker、设备闭环。

## File Structure

- Modify: `server/src/main/java/com/uav/lowaltitude/modules/identity/application/AuthService.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/identity/application/LoginFailureRecorder.java`
- Create: `server/src/main/java/com/uav/lowaltitude/integration/SourceModeGuard.java`
- Modify: `server/src/main/java/com/uav/lowaltitude/integration/MockAdapter.java`
- Rename: `AuthApiIT.java` → `AuthApiTest.java`
- Create: `server/src/test/java/com/uav/lowaltitude/modules/identity/api/LoginFailurePersistenceTest.java`
- Create: `server/src/test/java/com/uav/lowaltitude/integration/SourceModeGuardTest.java`
- Modify: `server/src/main/resources/application-integration.yml`
- Modify: `server/pom.xml`（显式 `release=17`）
- Modify: `.github/workflows/ci.yml`、`.github/pull_request_template.md`
- Modify: `server/README.md`、`server/AGENTS.md`、`AGENTS.md`、`docs/后端开发基线.md`

---

### Task 1: 认证测试可被 `./mvnw test` 发现

**Files:**
- Create: `server/src/test/java/com/uav/lowaltitude/modules/identity/api/AuthApiTest.java`（内容同现 `AuthApiIT`，类名改为 `AuthApiTest`）
- Delete: `server/src/test/java/com/uav/lowaltitude/modules/identity/api/AuthApiIT.java`
- Modify: `.github/workflows/ci.yml`（backend 只跑 `./mvnw -B test`，去掉 `-Dtest=AuthApiIT`）
- Modify: `.github/pull_request_template.md`、`server/README.md`、`server/AGENTS.md`、`AGENTS.md`、`docs/后端开发基线.md`

**Interfaces:**
- Consumes: 现有 8 个认证用例行为不变
- Produces: Surefire 默认包含 `*Test` 类

- [ ] **Step 1: 复制测试类并改名**

类名 `AuthApiTest`，包路径不变，测试方法与断言原样保留。

- [ ] **Step 2: 删除 `AuthApiIT.java`**

- [ ] **Step 3: 改 CI / 文档 / 基线中的类名与命令**

CI `backend` job 只保留：

```yaml
- run: ./mvnw -B test
- run: ./mvnw -B package
```

文档命令改为 `./mvnw test`，说明认证测试类现为 `AuthApiTest`，普通 test 会执行。

- [ ] **Step 4: 运行**

```bash
cd server && ./mvnw -q -Dtest=AuthApiTest test
```

Expected: BUILD SUCCESS，8 tests。

---

### Task 2: 失败登录计数与审计必须落库（先红后绿）

**Files:**
- Create: `server/src/test/java/com/uav/lowaltitude/modules/identity/api/LoginFailurePersistenceTest.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/identity/application/LoginFailureRecorder.java`
- Modify: `server/src/main/java/com/uav/lowaltitude/modules/identity/application/AuthService.java`

**Interfaces:**
- Consumes: `UserMapper.updateLock`、`AuditService.record`（`MANDATORY`）
- Produces: `LoginFailureRecorder` 上 `@Transactional(REQUIRES_NEW)` 方法；`AuthService.login` 失败路径先记再抛

当前问题：`login()` 整段 `@Transactional`，错误密码时 `updateLock` + `auditService.record` 后抛 `ApiException`，同一事务回滚，HTTP 401 有了但库里没有失败次数和审计。

- [ ] **Step 1: 写失败测试（此时应红）**

```java
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class LoginFailurePersistenceTest {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;

    @Test
    void wrongPasswordPersistsFailCountAndAudit() throws Exception {
        mvc.perform(post("/api/v1/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"account\":\"duty1\",\"password\":\"wrong\"}"))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.error.code").value("INVALID_CREDENTIALS"));

        Integer fails = jdbc.queryForObject(
            "select fail_count from app_user where account = ?", Integer.class, "duty1");
        Integer audits = jdbc.queryForObject(
            "select count(*) from audit_log where account = ? and action = ?",
            Integer.class, "duty1", "login_fail");
        assertThat(fails).isEqualTo(1);
        assertThat(audits).isEqualTo(1);
    }

    @Test
    void fifthWrongPasswordLocksAccount() throws Exception {
        for (int i = 0; i < 5; i++) {
            mvc.perform(post("/api/v1/auth/login")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"account\":\"duty1\",\"password\":\"wrong\"}"))
                .andExpect(status().isUnauthorized());
        }
        mvc.perform(post("/api/v1/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"account\":\"duty1\",\"password\":\"changeme\"}"))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.error.code").value("ACCOUNT_LOCKED"));
    }
}
```

- [ ] **Step 2: 运行，确认因回滚而失败**

```bash
cd server && ./mvnw -q -Dtest=LoginFailurePersistenceTest test
```

Expected: FAIL，`fail_count` 为 0 或 audit 为 0。

- [ ] **Step 3: 最小实现**

`LoginFailureRecorder`：

```java
@Service
public class LoginFailureRecorder {
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void badPassword(AppUser user, String account, String ip, long now, int failLimit, int lockMinutes) {
        int fails = user.getFailCount() + 1;
        Long lockedUntil = fails >= failLimit ? now + lockMinutes * 60_000L : null;
        userMapper.updateLock(user.getUserId(), fails, lockedUntil);
        auditService.record(user.getUserId(), account, "login_fail", "user", user.getUserId(), "bad_password", ip);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void unknownAccount(String account, String ip) { ... }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void locked(AppUser user, String account, String ip) { ... }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void disabled(AppUser user, String account, String ip) { ... }
}
```

`AuthService.login` 失败分支改为调用 recorder 再抛异常；成功路径保持原事务。

- [ ] **Step 4: 再跑测试**

```bash
cd server && ./mvnw -q -Dtest=LoginFailurePersistenceTest,AuthApiTest test
```

Expected: BUILD SUCCESS。

---

### Task 3: 数据源模式不得静默落到 Mock

**Files:**
- Create: `server/src/main/java/com/uav/lowaltitude/integration/SourceModeGuard.java`
- Create: `server/src/test/java/com/uav/lowaltitude/integration/SourceModeGuardTest.java`
- Modify: `MockAdapter.java` 去掉 `matchIfMissing = true`
- Modify: `application-integration.yml` 为 `source-mode: ${APP_SOURCE_MODE}`

**Interfaces:**
- Consumes: `AppProperties.getSourceMode()`、`List<AdapterPort>`
- Produces: 启动时若模式为空、未知、或没有同名 Adapter，抛 `IllegalStateException`

- [ ] **Step 1: 先写 Guard 单测（红）**

覆盖：空白模式失败；`live` 且无 Adapter 失败；`mock` 且有 `MockAdapter` 通过。

- [ ] **Step 2: 实现 Guard 并注册为 `@Component`**

- [ ] **Step 3: `MockAdapter` 仅在 `app.source-mode=mock` 时生效**

- [ ] **Step 4: integration profile 取消 Mock 默认值**

- [ ] **Step 5: 跑**

```bash
cd server && ./mvnw -q -Dtest=SourceModeGuardTest,AuthApiTest,LoginFailurePersistenceTest test
```

Expected: BUILD SUCCESS。`test`/`local` profile 已显式 `source-mode: mock`，不受 `matchIfMissing` 删除影响。

---

### Task 4: Java 17 编译门禁与全量验证

**Files:**
- Modify: `server/pom.xml`

- [ ] **Step 1: compiler plugin 显式 `<release>17</release>`**

- [ ] **Step 2:**

```bash
cd server && ./mvnw test && ./mvnw package
```

Expected: 认证测试被默认发现；报告里能看到 `AuthApiTest` 与 `LoginFailurePersistenceTest`；`package` 成功。

- [ ] **Step 3: `git diff --check`**

---

## 验收出口（本部分）

1. `cd server && ./mvnw test` 不指定类名也能跑认证测试。
2. 错误密码后 `fail_count` 和 `audit_log.login_fail` 都在。
3. 连续失败达到上限后正确密码也返回 `ACCOUNT_LOCKED`。
4. `integration` 未设 `APP_SOURCE_MODE` 不能靠默认 Mock 启动。
5. `MockAdapter` 不再 `matchIfMissing`。
6. 不宣称 RBAC、设备联调或前端登录已完成。
