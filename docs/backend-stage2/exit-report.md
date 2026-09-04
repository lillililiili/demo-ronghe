# T02 雷达只读后端阶段 2 退出报告

- 日期：2026-09-04
- 统一基线：`991518b935fda236600ace03e77ece8072b43635`
- 结论：**READY**
- 未关闭问题：P0 = 0，P1 = 0，P2 = 0

## 交付范围

本阶段在只读边界内完成了访问控制结构、授权服务、本地隔离种子和雷达读模型数据库结构。没有新增雷达 HTTP API、replay/live 摄取、设备控制、前端改动或阶段 3 实现。

实现提交按整合顺序如下：

1. `ae854d747cceacfd9eaed9631fdf31fc3d326eef` `feat(server): add read access schema`
2. `19dbbccb0fe9d7570c322ec7bc2078e025ba370c` `feat(server): enforce read permissions and scopes`
3. `0b52d41d9b8e7c49b463671ebab521158e45ab20` `feat(server): seed isolated read access`
4. `f53201eabe850be71306d1b2da5df7b9ed81319e` `feat(server): add radar read model schema`
5. `8cbf421a3e3d13de5a43fa06d307b2609fab0c39` `test(server): verify stage 2 postgres schema`
6. `ae7e601e779ba2ed619bd14a3b14a443e64cd460` `fix(server): enforce radar spatial and hierarchy constraints`
7. `8f1c35bd4420a767e5862322ec1ce71f11f27f77` `fix(server): enforce development seed password gate`
8. `634c68a1a4bc8e46a8c576128319427638a2a198` `fix(server): harden hierarchy validation`

## 验收结果

| 验收项 | 实际结果 | 结论 |
| --- | --- | --- |
| 受影响测试 | 38 tests，0 failures，0 errors，0 skipped | 通过 |
| PostgreSQL/PostGIS 测试 | 6 tests，0 failures，0 errors，0 skipped | 通过 |
| 全量 `test` | 47 tests，0 failures，0 errors，0 skipped | 通过 |
| 全量 `package` | 47 tests，0 failures，0 errors，0 skipped；JAR 已生成 | 通过 |
| `git diff --check` | 无输出 | 通过 |

全量测试实际分布：`SourceModeGuardTest` 3、`AccessSchemaMigrationTest` 5、`PostgresStage2SchemaTest` 6、`RadarSchemaMigrationTest` 7、`AuthApiTest` 8、`LoginFailurePersistenceTest` 2、`AccessControlServiceTest` 11、`LocalAccessSeederTest` 5，共 47 项。

PostgreSQL 验收使用隔离容器 `codex-stage2-pg-01a06afe`，镜像 `postgis/postgis:16-3.5`，仅绑定 `127.0.0.1:61063`。实际版本为 PostgreSQL 16.9、PostGIS 3.5.2。测试覆盖：空库从 V1 迁移、V2 后迁移、重复迁移、geometry/GiST、JSONB、`timestamptz`、部分唯一索引、表达式索引、外键和 CHECK 约束、越界坐标与 `POINT EMPTY`、顺序及并发层级环、非 READ COMMITTED 隔离拒绝、临时表遮蔽防护。测试结束后未残留 `stage2_%` schema。

构建运行时为 Temurin OpenJDK 21.0.12；本机未安装可用的 Java 17 运行时，因此未单独执行 Java 17 JVM 验收。Maven 编译使用项目既有 `<release>17</release>`。首次 `package` 受全局 Tencent Maven 镜像 TLS 失败影响，随后使用仅作用于该命令的 Maven Central 临时 settings 成功完成；未修改仓库或用户 Maven 配置。最终 JAR SHA-256 为 `5c6299214b0603c2a61c1a7e5660a7b058b44cf1fba3333d37c674b6b127c289`。

## 审查与修正

独立只读审查最终确认 P0/P1/P2 均为 0，并建议 READY。审查期间发现的问题均已以回归测试固化：

- 空几何绕过空间约束与并发层级环问题由 `ae7e601` 修正。
- 开发种子在已有用户时绕过密码门禁的问题由 `8f1c35b` 修正。
- 可重复读快照和临时表遮蔽导致层级校验不可靠的问题由 `634c68a` 修正；层级写入明确要求 READ COMMITTED。

## 基线完整性

阶段 1 文档、阶段 2 计划以及 V1/V2 迁移均未被阶段 2 实现修改。V1/V2 与 `origin/main` 的对应文件逐字节一致：

- `V1__init.sql` SHA-256：`a2889567e5c925814b7b18c0301ef42d0b3022286dcd0d8e64b23f09cd6d632c`
- `V2__outbox_inbox.sql` SHA-256：`4f3ca4794a7a9c7a34cd2fae1396b00b377fcf3e39a334826bff2cfe8e5af87c`

阶段 1 文档与阶段 2 计划的内容哈希复核通过。用户未跟踪资料保持原状，未纳入任何阶段 2 提交。

## 退出判定

阶段 2 的授权结构、雷达结构、隔离种子、数据库实测及独立审查均达到计划退出条件，判定 **READY**。阶段 3 未启动；如需进入阶段 3，应另行授权。
