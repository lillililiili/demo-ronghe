栈：Java17 Spring Boot 3.4 + PG16/PostGIS + Vue3，依据 docs/13 与 docs/17。

# low-altitude-server

监管侧值班平台后端骨架。本轮已具备：登录/登出/当前用户、Bearer 会话、审计只增、空告警列表、Mock Adapter、本地证据目录。

## 本地启动

1. JDK 17（本机若是 21，Maven 仍按 `release=17` 编译）。
2. 启动数据库：

```bash
cd ../deploy
docker compose up -d db
```

3. 启动 API：

```bash
cd ../server
mvn spring-boot:run -Dspring-boot.run.profiles=local
```

4. 默认本地口令仅开发用：`duty1` / `changeme`（另有 admin1、judge1、auth1、auth2、ops1、audit1）。
5. 验证：

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"account":"duty1","password":"changeme"}'
curl -s http://127.0.0.1:8080/api/v1/alarms
# 期望 401
```

## 测试

本机 Docker 未启动时，集成测试走 H2（PostgreSQL 兼容模式）：

```bash
./mvnw test
```

真实库用 `deploy/compose.yml` 的 `db` 服务（PostGIS 16）。

## 约定

- 写接口走服务端鉴权 + 审计。
- 生产禁止公网依赖；`APP_SOURCE_MODE=live` 时不得自动降级到 mock。
- 审计表 Mapper 只有 INSERT。
