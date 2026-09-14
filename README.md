# 无人机融合感知与低空安全管理平台业务前台

本仓库现仅维护 Vue 3 业务前台。统一后端、若依风格后台管理端、数据库/API 文档和部署编排已迁移到同级 `../houtaiguanli` 仓库。

运维管理与系统管理的六个页面已从业务前台移除；访问旧地址 `#/devices`、`#/monitor`、`#/commission`、`#/users`、`#/roles`、`#/archive` 会显示迁移说明，不会自动跨系统跳转。设备查询、光电联动和业务动作权限仍保留给融合感知、告警处置等业务页面使用。

## 本地启动

先在后台仓库启动数据库与统一后端，再启动业务前台：

```powershell
cd ..\houtaiguanli
.\scripts\bootstrap-dev.ps1

cd ..\demo-ronghe\dongying-vue
npm install
npm run dev
```

- 业务前台：http://127.0.0.1:5173
- 后台管理端：http://127.0.0.1:5175
- 统一 API：http://127.0.0.1:8080

前端说明见 [`dongying-vue/README.md`](dongying-vue/README.md)，后台与后端说明见 [`../houtaiguanli/README.md`](../houtaiguanli/README.md)。

## 验证

```powershell
cd dongying-vue
npm run build
node tools/scan.cjs
npx playwright test e2e/admin-migration.spec.js
```
