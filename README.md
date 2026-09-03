# 无人机融合感知与低空安全管理平台 Demo

前端一个目录，后端一个目录，文档和部署在仓库根：

```
├── dongying-vue/   前端（Vue 3 + Vite + Naive UI）
├── server/         后端工程，当前为骨架（Java 17 / Spring Boot 3.4.5）
├── docs/           文档
├── deploy/         Compose 与 Nginx 示例
├── README.md
├── AGENTS.md
└── .gitignore
```

## 前端

```bash
cd dongying-vue
npm install
npm run dev        # http://localhost:5173
```

说明见 [`dongying-vue/README.md`](dongying-vue/README.md)。

## 后端

```bash
cd deploy
docker compose up -d db

cd ../server
./mvnw spring-boot:run -Dspring-boot.run.profiles=local
```

说明见 [后端 README](server/README.md)。Windows PowerShell 进入 `server/` 后使用 `.\mvnw.cmd spring-boot:run "-Dspring-boot.run.profiles=local"`。

当前后端已有认证会话、审计和迁移骨架，告警/设备接口仍返回空列表，前端尚未接入真实认证和业务数据。现有默认账号仅供隔离开发使用，初始化环境门禁仍待加固，不能直接用于生产。具体状态、风险与开发顺序见[后端开发基线](docs/后端开发基线.md)。

## 其他

- 文档：[目录结构](docs/目录结构.md)、[后端开发基线](docs/后端开发基线.md)、[数据库设计文档](docs/数据库设计文档.md)
- 部署示例：`deploy/`（`compose.yml` 假定前端产物在 `dongying-vue/dist`，API 在 `server/`）
- 开发规则：[仓库级](AGENTS.md)、[前端](dongying-vue/AGENTS.md)、[后端](server/AGENTS.md)
