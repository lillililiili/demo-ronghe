# AGENTS.md

本仓库只维护 `dongying-vue/` 业务前台，前端细则见 [dongying-vue/AGENTS.md](dongying-vue/AGENTS.md)。平台唯一后端和后台管理端位于同级 `../houtaiguanli`。

## 目录与边界

- npm 命令只在 `dongying-vue/` 运行。
- 不在本仓库新增 Java 后端、运维管理或系统管理页面。
- 后端公共契约变化必须同时核对后台仓库和本业务前台两个消费者。
- 页面菜单访问权限与设备业务动作权限保持解耦；业务页需要设备动作时使用模块权限，不依赖已迁出的设备菜单。
- 保留六个旧哈希地址的迁移提示，不做自动跳转。

## 验收

```powershell
cd dongying-vue
npm run build
node tools/scan.cjs
npx playwright test e2e/admin-migration.spec.js
```

保留用户未提交改动及删除状态，不恢复旧方案、不顺手清理无关文件。交付前执行 `git diff --check`，并如实说明未执行项。
