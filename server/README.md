# low-altitude-server

监管侧值班平台后端工程，当前处于骨架阶段。沿用 Java 17、Spring Boot 3.4.5、MyBatis Starter 3.0.4、Flyway、Maven Wrapper（Maven 3.9.9），开发数据库示例为 PostgreSQL 16/PostGIS 3.5。

- [后端开发基线](../docs/后端开发基线.md)：业务范围、能力状态、资料缺口与开发顺序。
- [数据库设计文档](../docs/数据库设计文档.md)：现有表、拟建字段与关系、约束索引和分期迁移设计，尚未执行建表。
- [后端项目规则](AGENTS.md)：分层、接口、安全、事务、测试及交付要求。
- [仓库目录约定](../docs/目录结构.md)：前后端与部署位置。

已有登录/退出/当前用户、数据库 Bearer 会话、审计写入、本地存储和迁移代码。阶段 2 增加了数据库实时读取权限/范围决策、隔离的 local/test 合成授权，以及雷达只读承载结构；现有告警与设备 Controller 仍固定返回空列表，尚未接入这些查询能力。Adapter、回放摄取和 Worker 也未形成真实接入闭环，不能把本阶段结构视为雷达已联调或设备控制已实现。

## 本地启动

准备 JDK 17 和 Docker；用 Wrapper 固定 Maven 版本。开发端口为 API 8080、前端 5173。以下数据库必须是隔离开发实例，不使用生产库或已有业务库作试验。

在仓库根目录启动开发数据库：

```bash
cd deploy
docker compose up -d db
```

从 `deploy/` 进入后端，Windows PowerShell：

```powershell
cd ../server
.\mvnw.cmd spring-boot:run "-Dspring-boot.run.profiles=local"
```

Linux/macOS 在 `server/` 执行：

```bash
./mvnw spring-boot:run -Dspring-boot.run.profiles=local
```

数据库连接按 [application-local.yml](src/main/resources/application-local.yml)与 [Compose](../deploy/compose.yml)保持一致；修改了数据库凭据后须同步本地连接配置，不要提交或输出真实凭据。数据库必须预装 PostGIS 扩展。生产 Flyway 依次执行 `V1__init.sql`、`V2__outbox_inbox.sql`、`V3__access_control.sql`、`V4__radar_read_model.sql`，再执行 `db/postgresql/R__stage2_postgres_constraints_and_indexes.sql` 中可重复的 PostgreSQL/PostGIS 约束、索引和层级防循环触发器。V1/V2 是已应用迁移，不得修改。

`local` profile 在空用户表中初始化合成开发账号 `duty1` / `changeme`（另有 admin1、judge1、auth1、auth2、ops1、audit1）；可通过 `APP_DEV_SEED_PASSWORD` 覆盖密码。Seeder 受 `app.dev-seed.enabled` 显式控制，默认环境和 `integration` profile 默认关闭，`test` profile 显式启用。启用后只为 `duty1` 建立确定性的合成组织/区域精确元组，并显式授予三项读取权限；不会创建设备、目标、轨迹或告警数据，也不会授予 `ALL`。生产 V3 迁移只创建 `device:read`、`target:read`、`alarm:read` 权限目录，不启用兼容角色、不建立角色权限或用户范围。默认账号门禁和失败登录留痕仍待继续加固，见开发基线 G2。本骨架不是可直接上线的生产配置。

两位开发者的个人数据库、共享联调库与迁移协作流程见[协作开发环境](../docs/协作开发环境.md)。

启动后可检查 `GET /actuator/health`；无 Bearer 请求 `GET /api/v1/alarms`、`GET /api/v1/devices` 应为 401。登录返回 `session_id` 后，以 `Authorization: Bearer <session_id>` 请求 `/api/v1/auth/me`；两个业务列表当前返回空分页。这些是验证步骤与预期，不是本轮实测结果。

## 测试

以下命令都在 `server/` 执行。`AuthApiTest` 启用 `test` profile，使用 H2 PostgreSQL 兼容模式；不会依据 Docker 是否启动自动切换数据库。普通 `./mvnw test` 会发现该类。

Windows PowerShell：

```powershell
.\mvnw.cmd test
.\mvnw.cmd package
```

Linux/macOS：

```bash
./mvnw test
./mvnw package
```

核对 `target/surefire-reports` 中的实际用例数、失败及跳过。H2 测试不替代 PostgreSQL/PostGIS 的 SQL、空间查询、锁、约束和迁移验证；新增相关功能时，在隔离真实数据库中补充验证，不连接生产库。

阶段 2 的 H2 测试只加载 `classpath:db/migration`；PostgreSQL 专属 repeatable 不会在 H2 中执行。真实库验收必须指向可丢弃的 PostgreSQL 16/PostGIS 3.5 隔离数据库，并在当前进程中提供以下变量：

```bash
export POSTGRES_TEST_URL='jdbc:postgresql://127.0.0.1:PORT/disposable_database'
export POSTGRES_TEST_USER='test_user'
export POSTGRES_TEST_PASSWORD='set-locally-not-in-git'
./mvnw -Dtest=PostgresStage2SchemaTest test
```

`PostgresStage2SchemaTest` 分别验证空 schema 从 V1 迁移到最新、以及先停在 V2 后升级到最新；测试只创建名称匹配 `stage2_[a-f0-9]{32}` 的随机 schema，并只清理自己创建的 schema。它会实际检查 geometry/GiST、JSONB、timestamptz、部分唯一索引、表达式索引、层级循环触发器、非法样本拒绝和 repeatable 幂等性。三项环境变量缺失时该测试会明确跳过，不能据此声明 PostgreSQL/PostGIS 已验收。

组织和区域的非空 `parent_id` 写入必须使用 PostgreSQL 默认的 `READ COMMITTED` 隔离级别；层级触发器会拒绝其他隔离级别，以确保加锁后的循环检查读取到最新已提交关系。

## 约定

- `AccessControlService` 从当前数据库校验用户、启用角色、显式权限、scope mode 和有效范围存在性；不信任会话中的角色码，也不缓存授权结果。现有业务 Controller 尚未接入该服务，读取接口落地留到后续阶段。
- 成功状态及审计保持一致，失败尝试也须可靠留痕。当前审计 Mapper 只有 INSERT，不代表完整防篡改方案已完成。
- 生产禁止公网依赖；真实部署网络按确认资料配置。`APP_SOURCE_MODE=live` 不得自动降级为 mock；当前尚无 live/replay 适配器，不应将模式名当作已接入能力。
- 当前本地证据目录适配只用于开发测试；真实文件、元数据、哈希、下载授权和保管策略随业务切片建设。
- 启动配置、默认账号、消息投递与测试发现等差距见[开发基线](../docs/后端开发基线.md)。
