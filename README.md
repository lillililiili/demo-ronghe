# 无人机融合感知与低空安全管理平台业务前台

本仓库现仅维护 Vue 3 业务前台。统一后端、若依风格后台管理端、数据库/API 文档和部署编排已迁移到同级 `../houtaiguanli` 仓库。

运维管理与系统管理的六个页面已从业务前台移除；访问旧地址 `#/devices`、`#/monitor`、`#/commission`、`#/users`、`#/roles`、`#/archive` 会显示迁移说明，不会自动跨系统跳转。设备查询、光电联动和业务动作权限仍保留给融合感知、告警处置等业务页面使用。

## 本地启动

先按[后台启动说明](../houtaiguanli/README.md)启动数据库与统一后端，再启动业务前台。当前本机目录为 `dongyiwurenji`，GitHub 仓库名为 `demo-ronghe`；命令以实际克隆目录为准。

```bash
cd /Users/frank/Desktop/dongyiwurenji/dongying-vue
npm install
npm run dev
```

- 业务前台：http://127.0.0.1:5173
- 后台管理端：http://127.0.0.1:5175
- 统一 API：http://127.0.0.1:8081

前端说明见 [`dongying-vue/README.md`](dongying-vue/README.md)，后台与后端说明见 [`../houtaiguanli/README.md`](../houtaiguanli/README.md)。

## 当前规则与文档入口

- [仓库规范](AGENTS.md)与[前端规范](dongying-vue/AGENTS.md)：稳定的产品、交互、数据及协作要求。
- [项目对话与文档核对](docs/项目对话与文档核对-2026-09-16.md)：已确认要求、旧口径修正和待验证差异。
- [目录结构](docs/目录结构.md)与[业务流程](docs/flow-map.md)：当前仓库边界、页面入口和专题契约。
- [自动研判优化评估](docs/自动研判与快速响应优化评估-2026-09-15.md)：产品方向及阶段记录，不能把建议当成已部署能力。

带日期的阶段报告、旧设计和交付材料保留原始上下文；遇到冲突先核对后续用户决定和当前实现。真实轨迹及红绿灰航线规则已在两级 AGENTS.md 中维护，不在各份文档重复定义。

## 验证

```powershell
cd dongying-vue
npm run build
node tools/scan.cjs
npx playwright test e2e/admin-migration.spec.js
```
