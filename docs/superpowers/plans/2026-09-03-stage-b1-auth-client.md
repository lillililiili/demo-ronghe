# 协作者 B 第 1 刀：前端登录接真实 API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or subagent-driven-development. 本计划只允许改前端与开发脚本，禁止改 `server/` Java、Flyway、A 的安全基线。

**Goal:** 登录、恢复会话、退出走后端 `/api/v1/auth/*`，接口失败不再假装 Mock 登录成功。

**Architecture:** 新增统一 `apiClient`（Bearer、`ApiResponse`、401 清会话）。`auth.js` 只调这个客户端。Vite 把 `/api` 代理到 `127.0.0.1:8080`。用户/角色管理页本刀仍读 Mock，等 A 交出 RBAC 接口再切。

**Tech Stack:** Vue 3、Vite 6、现有 JavaScript、后端已有 login/logout/me。

## Global Constraints

- 你是协作者 B。不要改 `server/src/main/java`、`db/migration`、`MockAdapter`、`AuthService`。
- 从最新 `main` 开分支 `feature/b-auth-client`，不要在 `feature/stage1-security-baseline` 上继续提交。
- 不新增 npm 生产依赖。安装脚本用 `npm ci`，不用无锁的 `npm install`。
- 保留 hash 路由、`ApiResponse` 的 `ok/data/error`、snake_case。
- 接口失败不得回退成演示登录成功。
- 登录页演示账号改为后端 Seeder：`duty1` / `changeme`（local profile），不要再写死 `admin` / `Demo@2026` 当唯一真源。
- 业务页（告警、态势、设备）本刀仍可用 Mock 数据；只有认证会话必须来自后端。

## 本刀不包含（B 第 2 刀）

- 用户/角色/权限管理接 API（等 A 的 RBAC）
- 告警/设备列表接真实查询
- 工作台事件池

## File Structure

- Create: `dongying-vue/src/services/apiClient.js`
- Create: `dongying-vue/docs/api-contract-current.md`（当期已有接口清单）
- Modify: `dongying-vue/src/services/auth.js`
- Modify: `dongying-vue/src/pages/login/LoginPage.vue`
- Modify: `dongying-vue/src/router/index.js`（restoreSession 改为 async 可等待）
- Modify: `dongying-vue/vite.config.js`（`/api` proxy）
- Modify: `scripts/bootstrap-dev.ps1`（`npm ci`）
- Test: `cd dongying-vue && npm run build`；手工或后续补：后端 local 启动后登录 duty1

---

### Task 1: 统一 apiClient

**Produces:**

```js
// apiClient.js
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function setSessionToken(token) { /* sessionStorage } }
export function getSessionToken() {}
export function clearSessionToken() {}
export async function apiRequest(method, path, body) {
  // Authorization: Bearer <session_id>
  // 解析 { ok, data, error: { code, message } }
  // ok === false 或 HTTP 401 → throw ApiError；401 时清 token
}
```

- [ ] 实现 `apiRequest`
- [ ] 401 清本地 token，不调用 Mock 顶号

---

### Task 2: auth.js 接 login / logout / me

现有后端：

- `POST /api/v1/auth/login` `{ account, password }` → `session_id, role_code, expire_at, ...`
- `POST /api/v1/auth/logout` Bearer
- `GET /api/v1/auth/me` Bearer

- [ ] `login` 改为 `await apiRequest('POST', '/api/v1/auth/login', { account, password })`
- [ ] 成功后 `setSessionToken(data.session_id)`，把 `data` 映到前端当前用户摘要（不要用 `M.switchUser` 当认证真源）
- [ ] `restoreSession` 有 token 则请求 `/me`，失败则清会话
- [ ] `logout` 调后端，无论成败清本地 token
- [ ] 保留「记住账号」只记 account，不记密码

权限矩阵本刀仍可暂读 `window.MOCK` 做菜单隐藏，但 **isAuthenticated 必须以后端会话为准**。

---

### Task 3: 登录页与路由

- [ ] `LoginPage.vue` 的 `login()` 改为 async，去掉 450ms 假忙碌也可保留最短等待，但结果必须来自 API
- [ ] 帮助文案改为：本地开发账号 `duty1`，密码见 `APP_DEV_SEED_PASSWORD`（默认 `changeme`）；正式环境找管理员
- [ ] 接口失败展示 `error.message`，不要再走 Mock 密码 `Demo@2026`
- [ ] `router.beforeEach`：未登录去 `/login`；`/me` 401 与过期同等处理

---

### Task 4: Vite 代理与 npm ci

- [ ] `vite.config.js` `server.proxy['/api'] = 'http://127.0.0.1:8080'`
- [ ] `scripts/bootstrap-dev.ps1` 安装改为 `npm ci`（有 lockfile 时）

---

### Task 5: 当期契约清单

写 `dongying-vue/docs/api-contract-current.md`，只列**已经存在**的接口：

| 方法 | 路径 | 谁用 | 状态 |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/login` | 登录页 | 本刀接通 |
| POST | `/api/v1/auth/logout` | 退出 | 本刀接通 |
| GET | `/api/v1/auth/me` | 恢复会话 | 本刀接通 |
| GET | `/api/v1/alarms` | 尚未切页 | 空分页占位 |
| GET | `/api/v1/devices` | 尚未切页 | 空分页占位 |

写明：用户/角色 CRUD 接口尚未由 A 提供，B 不得虚构。

---

## 验收出口

1. 后端 `local` 起来后，前端用 `duty1` / `changeme` 能登录并进入工作台。
2. 错密码看到后端错误，不会变成 Mock 登录成功。
3. 刷新后仍登录（sessionStorage 里是后端 `session_id`，`/me` 成功）。
4. 退出后再访问业务路由回到登录页。
5. `npm run build` 通过。
6. 不改任何 Java 与 Flyway。

## 给领导 / 协作者 A 的依赖

- 本刀只依赖已合并的 login/logout/me。
- 用户管理、角色权限页：等 A 第 2 刀 RBAC 接口。
- 告警/设备页：等 A 设备查询与 B 后续告警切片。
