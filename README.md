# 无人机融合感知与低空安全管理平台 Demo

前端一个目录，后端一个目录，文档和部署在仓库根：

```
├── dongying-vue/   前端（Vue 3 + Vite + Naive UI）
├── server/         后端骨架（Java 17 / Spring Boot 3.4）
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

说明见 [`server/README.md`](server/README.md)。本地开发口令 `duty1` / `changeme`。

## 其他

- 文档：`docs/`
- 部署示例：`deploy/`（`compose.yml` 假定前端产物在 `dongying-vue/dist`，API 在 `server/`）
- 前端开发规则：`dongying-vue/AGENTS.md`
