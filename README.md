# 无人机融合感知与低空安全管理平台 Demo

前端一个目录，后端一个目录，文档和部署在仓库根：

```
├── dongying-vue/   前端（Vue 3 + Vite + Naive UI）
├── server/         后端工程（Java 17 / Spring Boot 3.4.5）
├── docs/           文档
├── deploy/         Compose 与 Nginx 示例
├── scripts/        本地开发初始化与检查脚本
├── README.md
├── AGENTS.md
└── .gitignore
```

## 首次启动（Windows）

准备 Docker Desktop、JDK 17、Node.js 22 和 npm，在仓库根目录运行：

```powershell
.\scripts\bootstrap-dev.ps1
```

随后分别在两个 PowerShell 窗口启动前后端：

```powershell
cd dongying-vue
npm run dev
```

```powershell
cd server
.\mvnw.cmd spring-boot:run "-Dspring-boot.run.profiles=local"
```

运行 `.\scripts\verify-dev.ps1` 检查前端与后端健康状态。完整的个人数据库、共享联调库、Flyway、脱敏数据和 PR 规则见[协作开发环境](docs/协作开发环境.md)。

本地只创建一个合成超级管理员账号 `admin1 / changeme`；它只用于本地合成数据，首次登录无需改密。其他开发角色由超级管理员在“角色管理”中创建，再通过“用户管理”分配。账号和数据分别存在于每位开发者自己的本地库，两个人使用相同本地账号不会共享会话或数据。

离线地图数据已随仓库放在 `map-data/`，正常克隆后无需额外配置；地图部署和更新规则见[离线地图部署说明](docs/离线地图部署说明.md)。

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

当前登录、后端菜单与按钮权限、强制改密、用户/组织/区域、自定义角色权限和审计日志均已接入后端。系统管理变更由唯一超级管理员操作并立即生效，敏感操作仍要求原因、幂等键并写审计。其他尚未迁移的业务页仍显示明确的合成数据，但身份与权限统一取自后端会话。合成 Seeder 只在显式启用的开发/测试环境运行，不能用于生产。接口见[系统管理接口](docs/系统管理接口.md)，其余能力边界见[后端开发基线](docs/后端开发基线.md)。

## 其他

- 文档：[协作开发环境](docs/协作开发环境.md)、[系统管理接口](docs/系统管理接口.md)、[目录结构](docs/目录结构.md)、[后端开发基线](docs/后端开发基线.md)、[数据库设计文档](docs/数据库设计文档.md)
- 部署示例：`deploy/`（`compose.yml` 假定前端产物在 `dongying-vue/dist`，API 在 `server/`）
- 开发规则：[仓库级](AGENTS.md)、[前端](dongying-vue/AGENTS.md)、[后端](server/AGENTS.md)
