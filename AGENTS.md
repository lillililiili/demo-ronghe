# AGENTS.md

本文件适用于整个仓库。前端子目录另有更具体的 `dongying-vue/AGENTS.md`。

## 目录

| 路径 | 内容 |
| --- | --- |
| `dongying-vue/` | 前端 Demo。npm 命令只在该目录运行。 |
| `server/` | 后端骨架。Maven 命令只在该目录运行。 |
| `docs/` | 项目文档。目录约定见 `docs/目录结构.md`。 |
| `deploy/` | Compose、Nginx 等部署示例。 |

不要把前端文件放回仓库根目录，也不要把后端 Java 源码写进 `dongying-vue/`。

## 命令

```bash
cd dongying-vue && npm install && npm run dev
cd dongying-vue && npm run build
cd server && ./mvnw test
cd server && ./mvnw spring-boot:run -Dspring-boot.run.profiles=local
```

前端技术栈与编码约定以 `dongying-vue/AGENTS.md` 为准：保持 JavaScript、原生 CSS、Naive UI 与渐进式 legacy 迁移。
