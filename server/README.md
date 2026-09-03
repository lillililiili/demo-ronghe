# low-altitude-server

监管侧值班平台后端工程，当前处于骨架阶段。沿用 Java 17、Spring Boot 3.4.5、MyBatis Starter 3.0.4、Flyway、Maven Wrapper（Maven 3.9.9），开发数据库示例为 PostgreSQL 16/PostGIS 3.5。

- [后端开发基线](../docs/后端开发基线.md)：业务范围、能力状态、资料缺口与开发顺序。
- [数据库设计文档](../docs/数据库设计文档.md)：现有表、拟建字段与关系、约束索引和分期迁移设计，尚未执行建表。
- [后端项目规则](AGENTS.md)：分层、接口、安全、事务、测试及交付要求。
- [仓库目录约定](../docs/目录结构.md)：前后端与部署位置。

已有登录/退出/当前用户、数据库 Bearer 会话、审计写入、本地存储和迁移代码；告警与设备接口固定返回空列表，Adapter 和 Worker 尚未形成真实接入闭环。前端仍是 Mock 登录和业务数据。本次文档更新只做静态核查，不表示构建、测试或设备联调已通过。

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

数据库连接按 [application-local.yml](src/main/resources/application-local.yml)与 [Compose](../deploy/compose.yml)保持一致；修改了数据库凭据后须同步本地连接配置，不要提交或输出真实凭据。Flyway 会对所配置的数据库执行迁移。

当前空用户表会初始化开发账号 `duty1` / `changeme`（另有 admin1、judge1、auth1、auth2、ops1、audit1）。**Seeder 尚未限制运行环境**，不能因名字含 Local 就认为生产安全；默认账号门禁和失败登录留痕仍待加固，见开发基线 G1/G2。本骨架不是可直接上线的生产配置。

启动后可检查 `GET /actuator/health`；无 Bearer 请求 `GET /api/v1/alarms`、`GET /api/v1/devices` 应为 401。登录返回 `session_id` 后，以 `Authorization: Bearer <session_id>` 请求 `/api/v1/auth/me`；两个业务列表当前返回空分页。这些是验证步骤与预期，不是本轮实测结果。

## 测试

以下命令都在 `server/` 执行。`AuthApiIT` 显式启用 `test` profile，使用 H2 PostgreSQL 兼容模式；不会依据 Docker 是否启动自动切换数据库。

Windows PowerShell：

```powershell
.\mvnw.cmd "-Dtest=AuthApiIT" test
.\mvnw.cmd test
.\mvnw.cmd package
```

Linux/macOS：

```bash
./mvnw -Dtest=AuthApiIT test
./mvnw test
./mvnw package
```

当前 POM 没有显式绑定 IT 生命周期，普通 `test/package` 不能被当作已执行 `AuthApiIT` 的证据。显式运行后核对 `target/surefire-reports` 中的实际用例数、失败及跳过；当前该类有 8 个测试方法。本次文档更新没有执行这些命令。

H2 测试不替代 PostgreSQL/PostGIS 的 SQL、空间查询、锁、约束和迁移验证；新增相关功能时，在隔离真实数据库中补充验证，不连接生产库。

## 约定

- 服务端执行动作与数据范围授权；目前“已登录”与角色码不代表完整权限已实现。
- 成功状态及审计保持一致，失败尝试也须可靠留痕。当前审计 Mapper 只有 INSERT，不代表完整防篡改方案已完成。
- 生产禁止公网依赖；真实部署网络按确认资料配置。`APP_SOURCE_MODE=live` 不得自动降级为 mock；当前尚无 live/replay 适配器，不应将模式名当作已接入能力。
- 当前本地证据目录适配只用于开发测试；真实文件、元数据、哈希、下载授权和保管策略随业务切片建设。
- 启动配置、默认账号、消息投递与测试发现等差距见[开发基线](../docs/后端开发基线.md)，本轮不修复业务或安全代码。
