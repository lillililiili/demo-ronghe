# low-altitude-server

监管侧值班平台后端工程。沿用 Java 17、Spring Boot 3.4.5、MyBatis Starter 3.0.4、Flyway、Maven Wrapper（Maven 3.9.9），开发数据库示例为 PostgreSQL 16/PostGIS 3.5。身份权限和设备运维切片已形成可运行接口；其余业务域仍按开发基线渐进建设。

- [后端开发基线](../docs/后端开发基线.md)：业务范围、能力状态、资料缺口与开发顺序。
- [数据库设计文档](../docs/数据库设计文档.md)：现有表、拟建字段与关系、约束索引和分期迁移设计，尚未执行建表。
- [设备运维接口契约](../docs/设备运维接口契约.md)：设备台账、实时监测、重启与接入调测的 REST 契约和联调边界。
- [系统管理接口](../docs/系统管理接口.md)：登录、菜单、用户、组织区域、自定义角色和审计接口。
- [后端项目规则](AGENTS.md)：分层、接口、安全、事务、测试及交付要求。
- [仓库目录约定](../docs/目录结构.md)：前后端与部署位置。

已有登录/退出/当前用户、数据库 Bearer 会话、角色权限、审计写入，以及设备台账、状态历史、事件、告警、重启命令与调测任务接口。设备动作由持久化 Outbox Worker 推进；开发模拟结果均显式标记。设备适配层已按 `source_mode + protocol_code` 路由，并实现 T02/兼容机扫雷达 TCP v3.0.0 与固定式四通道网络控制器 v2.0 的只读 live 接入。真实射频发射、雷达启停和正式验收阈值仍关闭。

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

`local` profile 启用 `spring-boot-devtools`：`target/classes` 变化后会快速重启应用，不必关掉 `spring-boot:run`。保存 Java 或 `src/main/resources` 后需要先编译（IDE 自动构建，或在 `server/` 执行 `.\mvnw.cmd compile -DskipTests` / `./mvnw compile -DskipTests`）。这不是前端那种方法体热替换；改方法签名、配置类或 Flyway 迁移仍可能需要重新执行 `spring-boot:run`。可执行包默认不包含 DevTools。前端静态页由 Vite 热更新，与此后端重启相互独立。

数据库连接按 [application-local.yml](src/main/resources/application-local.yml)与 [Compose](../deploy/compose.yml)保持一致；修改了数据库凭据后须同步本地连接配置，不要提交或输出真实凭据。Flyway 会对所配置的数据库执行迁移。

`local` profile 幂等补齐唯一合成超级管理员 `admin1`，不再预置运维模拟设备台账；默认密码为 `changeme`，可通过 `APP_DEV_SEED_PASSWORD` 覆盖。其他角色和账号由 `admin1` 在系统管理中按需创建。账号 Seeder 受 `app.dev-seed.enabled` 显式控制，默认环境和 `integration` profile 默认关闭，`test` profile 显式启用。设备模拟夹具仅在 `test` profile 注入，不能当作现场设备。本工程不是可直接上线的生产配置。

两位开发者的个人数据库、共享联调库与迁移协作流程见[协作开发环境](../docs/协作开发环境.md)。

启动后可检查 `GET /actuator/health`；无 Bearer 请求 `GET /api/v1/devices` 应为 401。登录返回 `session_id` 后，以 `Authorization: Bearer <session_id>` 请求 `/api/v1/auth/me`。所有系统管理写接口还必须带 8–128 位 `Idempotency-Key`，更新已有资源须提交 `expected_version`。运行仓库根目录的 `.\scripts\verify-dev.ps1` 会检查健康状态、登录、`/auth/me` 和 Vite API 代理。

## 测试

以下命令都在 `server/` 执行。`AuthApiTest`、`SystemManagementApiTest` 和 `DeviceOperationsApiTest` 启用 `test` profile，使用 H2 PostgreSQL 兼容模式；不会依据 Docker 是否启动自动切换数据库。普通 `./mvnw test` 会发现这些测试。

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

## 约定

- 服务端执行设备动作授权；业务数据访问仍按账号已有范围过滤。用户管理不再维护或展示数据范围，新建用户内部固定为 `ALL`，调整角色时不改写已有范围。
- 成功状态及审计保持一致，失败尝试也须可靠留痕。当前审计 Mapper 只有 INSERT，不代表完整防篡改方案已完成。
- 生产禁止公网依赖；真实部署网络按确认资料配置。live 来源默认停用，显式启用前逐台校验 TCP 配置、协议配置、凭据引用与 CIDR 白名单；任何连接失败都不得自动降级为 mock。`APP_LIVE_DEVICE_ENABLED=false` 可整体关闭 live 连接监督器，但不能把 live 数据改标为模拟成功。
- 当前本地证据目录适配只用于开发测试；真实文件、元数据、哈希、下载授权和保管策略随业务切片建设。
- 启动配置、默认账号、消息投递与测试发现等差距见[开发基线](../docs/后端开发基线.md)。
