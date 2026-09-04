# AGENTS.md

本文件适用于整个仓库。前端遵守 [dongying-vue/AGENTS.md](dongying-vue/AGENTS.md)，后端遵守 [server/AGENTS.md](server/AGENTS.md)；各子目录规则不自动套用于另一端。

## Git 分支与提交

- 所有对话只允许在 `main` 分支修改和提交代码。
- 不得新建或使用其他分支，也不得新建 Git worktree；包括但不限于 `codex/*`、`feature/*` 分支。
- 开始修改前必须确认当前分支为 `main`。如果当前不在 `main`，或 `main` 被其他 worktree 占用、无法安全切换，停止修改和提交并告知用户，不得自行创建替代分支。
- 不得把其他分支上的提交合并、变基或拣选到 `main`，除非用户针对该操作另行明确授权。

## 目录

| 路径 | 内容 |
| --- | --- |
| `dongying-vue/` | 前端 Demo。npm 命令只在该目录运行。 |
| `server/` | 独立后端工程，当前为骨架。Maven 命令只在该目录运行。 |
| `docs/` | 项目文档。见[目录结构](docs/目录结构.md)与[后端开发基线](docs/后端开发基线.md)。 |
| `deploy/` | Compose、Nginx 等部署示例。 |

不要把前端文件放回仓库根目录，也不要把后端 Java 源码写进 `dongying-vue/`。

## 命令

以下每条从仓库根目录独立执行；后端完整命令见 [server/README.md](server/README.md)。

```bash
cd dongying-vue && npm install && npm run dev
cd dongying-vue && npm run build
cd server && ./mvnw test
cd server && ./mvnw package
cd server && ./mvnw spring-boot:run -Dspring-boot.run.profiles=local
```

Windows PowerShell 进入对应目录后使用 `.\mvnw.cmd`，`-D` 参数建议整体加引号。认证测试类为 `AuthApiTest`，普通 `test` 会执行；交付时核对 `target/surefire-reports` 的实际用例数。

前端技术栈与编码约定以 `dongying-vue/AGENTS.md` 为准：保持 JavaScript、原生 CSS、Naive UI 与渐进式 legacy 迁移。

后端沿用 Java 17、Spring Boot 3.4.5、MyBatis、Maven Wrapper、Flyway、PostgreSQL 16/PostGIS；新增依赖或调整基线须单独确认。

## 前后端协作与验收

- 后端范围及已实现/待开发/演示/待确认能力见[后端开发基线](docs/后端开发基线.md)。源码描述当前事实，业务确认约束目标；遇到冲突须记录并确认，不按路线图虚构能力。
- 纯后端改动按后端规则验证，不无条件执行前端构建；公共接口变更检查所有受影响消费者，涉及前端代码时同时遵守前端规则。
- 后端正式测试允许放入 `server/src/test/`；前端目录对临时过程文件的限制不应阻止后端新增正式回归测试。
- 纯文档变更检查内容、引用和差异即可，不声称构建或联调通过。所有交付检查 `git diff --check`，如实说明未执行项。
- 保留用户未提交改动及删除状态，不恢复旧方案、不顺手清理无关文件；业务代码、数据库、依赖等变更须在当前任务授权范围内。
