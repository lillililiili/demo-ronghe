# 协作者 B：多对话并行，做到 21:00

> 今天 2026-09-03，本地约 07:23，目标 21:00（约 13.5 小时）。  
> 你是协作者 B。A 的安全基线已合进 `main`（PR #2）。  
> 本文件是调度单：开几个对话、各干什么、几点合流、禁止碰什么。

**Goal:** 今晚 21:00 前，B 侧交出「真实登录贯通 + 前端公共请求层 + 页面空/错/分页规范 + 当期契约」；不要假装做完告警/设备后端。

**原则:** 并行靠「文件不打架」，不靠人多。同时写代码的对话最多 **2 个**，再加 **1 个只读审查**。第三个写代码的对话只允许在审查或文档上。

---

## 0. 今晚编制（固定）

| 对话 | 角色 | 分支 | 主要文件（独占） |
| --- | --- | --- | --- |
| 对话 0 本窗口 | B 侧调度 | 不写业务代码 | 本计划、收口、写下一刀 |
| 对话 1 | B 实现甲 | `feature/b-auth-client` | `apiClient.js` `auth.js` `LoginPage.vue` `router/index.js` `vite.config.js` |
| 对话 2 | B 实现乙 | `feature/b-page-chrome` | 新建 `src/components/` 或 `src/hooks/` 里空态/错态/分页，**不改** auth/login/router |
| 对话 3 | B 只读 | 无分支或只读 worktree | 盘点 MOCK 依赖、契约草稿、审查对话 1 的 diff |

不要开对话 4、5 去改 `AlarmsPage` / `FlightsPage` / Java。那些会和 1、2 抢状态，晚上合不回去。

**共同禁区（所有对话第一句都要写上）**

- 不改 `server/src/main/java`、`db/migration`、`MockAdapter`、`AuthService`
- 不在 `feature/stage1-security-baseline` 上继续提交
- 从最新 `main` 拉分支
- 接口失败不准回退成 Mock 成功
- 不新增 npm 生产依赖

---

## 1. 为什么不能五路同时写页面

B 第 1–2 周任务里，真正能并行的只有两块：

1. **认证请求层**（必须先做完）：没它，登录页、路由守卫、401 都假的。
2. **页面壳规范**（可并行）：加载中 / 空数据 / 接口错 / 分页组件，先不接业务 API。

这些 **不能** 今晚并行：

| 事项 | 原因 |
| --- | --- |
| 用户/角色管理接 API | 等 A 的 RBAC 接口 |
| 告警/设备列表接 API | 后端仍是空分页占位 |
| 工作台事件池 | 没有领域表 |
| 两个人同时改 `auth.js` | 必冲突 |

用户管理页今晚只允许改文案或加上「接口未就绪」空态，不准假 CRUD。

---

## 2. 时间表（不间断，按波次合流）

### 波次 1　07:30–11:00　先打地基（只开对话 1）

对话 1 执行已有计划：

`docs/superpowers/plans/2026-09-03-stage-b1-auth-client.md`

做到：

- `apiClient` + Bearer + 解析 `ok/data/error`
- 登录/退出/`/me` 接 `http://127.0.0.1:8080`
- Vite `/api` 代理
- `bootstrap-dev.ps1` 改 `npm ci`
- 登录页账号改为 `duty1` / `changeme`
- `npm run build` 通过

**11:00 合流：** 对话 1 停，调度把 `feature/b-auth-client` 合进本地 `main` 或至少 rebase 干净。对话 2、3 在这之前不要改 `auth.js`。

对话 1 开场白（整段复制）：

```text
我是协作者 B。从最新 main 建分支 feature/b-auth-client。
只执行 docs/superpowers/plans/2026-09-03-stage-b1-auth-client.md。
不要改 server/ 下 Java 和 Flyway。
做完跑 cd dongying-vue && npm run build，把结果写进报告。
接口失败不准回退成 Mock 登录。
```

---

### 波次 2　11:00–15:00　两路并行

对话 1 若已合，改做 **契约清单落地**（仍在 `feature/b-auth-client` 或新分支 `feature/b-api-contract`，只加文档）：

- 写 `dongying-vue/docs/api-contract-current.md`
- 列清 login/logout/me/alarms/devices 现状
- 标明用户 CRUD、告警写入「A 未提供，B 不虚构」

对话 2 同时开 `feature/b-page-chrome`：

- 新建统一：`PageLoading` `PageEmpty` `PageError` `PagePager`（或等价 hooks）
- 先接到 **B 名下、且今晚不接 API 的一两个壳**（建议 `StatsPage` 或 `ArchivePage` 的空/错展示），不要改登录
- 规范：列表继续 `page/size/items/total`，页码从 1，默认 20，最大 100
- `npm run build`

对话 3 只读：

- 列出 `dongying-vue/src/pages` 里 B 名下页面的 `window.MOCK` 读写点
- 输出 `docs/superpowers/plans/2026-09-03-b-mock-inventory.md`
- 不改业务代码
- 若对话 1 已有 diff：按 AGENTS 做只读审查（越权、假成功、静默 Mock）

对话 2 开场白：

```text
我是协作者 B。从最新 main 建 feature/b-page-chrome。
只做前端空态/错态/加载/分页公共组件，不要改 auth.js、LoginPage、router、server/。
列表分页字段必须是 page/size/items/total。
做完 npm run build。
```

对话 3 开场白：

```text
我是协作者 B 的只读审查。不要改代码。
1）盘点 dongying-vue 里工作台/态势/飞行计划/合法性/告警/处罚/统计/大屏对 window.MOCK 的读写。
2）若存在 feature/b-auth-client，只读审查登录是否仍会 Mock 成功。
结果写到 docs/superpowers/plans/2026-09-03-b-mock-inventory.md。
```

**15:00 合流：** 对话 2 的组件能单独演示；对话 3 的清单成为晚上选页的依据。

---

### 波次 3　15:00–18:30　把壳铺到 B 的页面（仍不接假后端）

对话 1 或对话 2 二选一继续写代码（不要两个一起改同一页）：

按对话 3 的清单，把空/错/加载接到：

1. 工作台
2. 态势
3. 飞行计划
4. 合法性
5. 告警
6. 处罚交接
7. 统计
8. 大屏（只读查询壳，不改地图引擎）

规则：数据仍可来自 Mock，但 **出错路径必须走 PageError，禁止 toast 成功却没副作用**。  
用户/角色页只加「管理接口未就绪」，不要接不存在的 API。

同时对话 3 继续只读：`node tools/scan.cjs`（若改了 legacy/Mock）是否该跑；列出今晚必须跑的验证命令。

---

### 波次 4　18:30–21:00　收口，不开新功能

调度（对话 0）做：

1. `git fetch`，确认 A 有没有新的契约 PR；有则只记依赖，今晚不跟车大改。
2. 对话 1、2 停写功能，只修 build / 明显冲突。
3. 跑：
   - `cd dongying-vue && npm run build`
   - 若动过 mock/legacy：`node tools/scan.cjs`、`node tools/falsify.cjs`
   - `git diff --check`
4. 写今晚验收记录（命令、是否真跑、失败项）。
5. 写 **B 第 2 刀计划**（明天）：等 A 的用户/角色 API；B 准备告警只读查询适配，但仍等空列表契约冻结。

**21:00 硬停止。** 不在 21:00 后新开告警状态机。

---

## 3. 今晚完成才算完成（不要多报）

必须同时满足：

1. 后端 `local` 起来后，`duty1` / `changeme` 能从 Vue 登录进工作台。
2. 错密码走后端错误，不会 Mock 登录成功。
3. 刷新后 `/me` 能恢复会话；退出后进业务路由会回登录页。
4. 有统一 `apiClient`，401 清 token。
5. 有空/错/分页规范，并至少挂上 1 个非登录页面。
6. 有当期 API 契约清单，未提供的接口标「不做」。
7. `npm run build` 实际跑过。

**今晚不算完成：** 告警闭环、设备台账、RBAC 管理页、真实轨迹、大屏生产数据。

---

## 4. 调度怎么盯（对话 0 每 90 分钟看一次）

每次只问三件事：

1. 分支是否还只碰自己的文件？
2. 有没有把 Mock 失败改成假成功？
3. build 过了没有？

冲突了就停对话 2，先合对话 1。不要让两个对话「各修各的 router」。

---

## 5. 和协作者 A 的接口

今晚你不阻塞 A。你只消费已合并的：

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`

若 A 今天并行做 RBAC：你 **18:30 前不要接用户管理 API**，避免契约改三次。明天 B 第 2 刀再接。

---

## 6. 效率真正来自哪里

- 同时最多两个写代码对话。
- 每刀计划写在 `docs/superpowers/plans/`，新对话只读那一份。
- 先合认证，再铺页面壳，最后才接业务 API。
- 21:00 停笔写「下一刀计划」，比再赶一个告警页更值。
