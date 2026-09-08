# 阶段 12：清理杂物（2026-09-07）

## 背景
用户裁定顺序："先清理杂物，再做处置授权 → 处罚案件 → 送达回执/取证/通报/驱鸟 → 小接线"。本阶段只做清理与卫生，不加业务能力；依据《系统未完成项盘点-2026-09-07》§四、§五。

## 事实（只读核对）
- `index.html` 仍加载 `mock.js`(350 KB)、`case.js`、`search.js`、13 个 `pages/*.js`；`registry.js` 每个路由键都有 Vue 页面，`LegacyHost` 永远不会挂载，未知键回落到 `PAGES.situation`（legacy Mock 页）是潜在陷阱。
- 运行期读 `window.MOCK` 的 4 处（`JamAuthModal.vue`、`AlarmNotifyModal.vue`、`ui/counterAuthModal.js`、`services/weather.js`）全部不可达；`map.js` 有 3 处 MOCK（空域图层键回落）、`video.js` 2 处、`case.js` 6 处。
- 死文件：上述 4 个 + `hooks/useChart.js`、`ui/deviceRebootModal.js`、`hooks/useCarousel.js` + `components/modals/CarouselModal.vue`；`main.js` 仍把 `openCounterAuth`/`openDeviceRebootForm` 挂到 `window.UI`；`HeaderBar` 调 `window.SEARCH?.destroy()`。
- `services/airportApi.js` 无消费者但后端机场接口存在（后续阶段用），保留。
- 登录页"忘记密码"弹窗明文显示 `admin1` 与 `DEMO_PASSWORD='changeme'`。
- `apis` 路由键悬空（`navModel.PAGE_THEME`、`accessControl.ROUTE_PERMISSION` 有，`NAV/ROUTES/VUE_PAGES` 无）。
- 后端：已映射路径用错方法（405）落到兜底 500。
- 文档：《系统开发进度说明-2026-09-05》过期；基线 §6 G3/G4 状态未更新；决策 10-17 的部署要求没有部署文档。
- 仓库：`feature/b-integration` 领先 9 提交、8 条 09-03 远端分支、10 个 worktree（含 `.worktrees/feature-b-page-chrome` 旧版融合感知页）。分支/工作树删除属不可逆，由用户裁定。

## 任务与会话
| 任务 | 会话 | 独占文件 | 验证 |
| --- | --- | --- | --- |
| 12.1 前端清理 | Session 1（E1） | `index.html`、`public/assets/js/{mock,case,search,app}.js` 与 `pages/*.js`（删除）、`public/assets/js/map.js`（去 MOCK 分支：图层键读数据 `a.layer`）、`public/assets/js/video.js`（去 MOCK 引用，假视频渲染本身不动）、`src/layout/{LegacyHost,PageHost}.vue`（去 legacy 回落）、`src/main.js`、`src/layout/HeaderBar.vue`、`src/config/navModel.js` 与 `src/services/accessControl.js`（去 `apis`）、删除 8 个死文件、`src/pages/login/LoginPage.vue` 与 `src/services/auth.js`（去密码明文）、`src/services/situationData.js`（图层键与 map.js 新口径对齐并去掉"mock.js 仍被其它页面加载"的过期注释）、`tools/situationData.test.cjs` | `npm run build`、`scan`、`falsify`、`check-ui-text`、node 单测；每个导航页在浏览器打开无控制台错误；`dist` 体积前后对比 |
| 12.2 后端与文档清理 | Session 2（E2） | `platform/api/GlobalExceptionHandler`（405 → `METHOD_NOT_ALLOWED` 包络 + `Allow` 头，鉴权在前不变）+ `UnmappedPathApiTest` 追加用例；`docs/系统开发进度说明-2026-09-05.md` 顶部加"已过期，以《系统未完成项盘点-2026-09-07》为准"横幅；`docs/后端开发基线.md` §6 G3/G4 行状态更新；新建 `docs/部署说明-数据库迁移与升级.md`（决策 10-10/10-14/10-17、061 校验和、local profile 开关、生产从全新库起） | 定向 H2 |
| 12.3 验证与仓库盘点 | Session 3（助手） | 等 12.1/12.2 落地后：H2 全量、PG 回归全套、前端四项检查；新建只读盘点 `docs/仓库分支与工作树盘点-2026-09-07.md`（每条分支/worktree：领先/落后、最后提交、内容摘要、建议 删除/合并/保留，**不执行任何删除**） | 数字 |
| 审查 | Session 4 | `review-log.md` | — |
| 12.9 验收 | 领导 | 浏览器逐页冒烟（含大屏）、提交、决策清单 | — |

## 决策（自动，记 `docs/backend-stage12/decisions.md`）
12-1 `index.html` 只保留 `vendor/echarts`、`ui.js`、`charts.js`、`geo.js`、`map.js`、`video.js`；其余 legacy 脚本删除；12-2 8 个死文件删除，`airportApi.js` 保留；12-3 `map.js` 空域图层键改由数据提供（`a.layer`），不再回落 MOCK；12-4 登录页不再显示任何密码，"忘记密码"改为联系系统管理员的说明；12-5 `apis` 键移除，未注册路由键统一走 AccessDenied，`LegacyHost` 删除；12-6 405 返回 `METHOD_NOT_ALLOWED`；12-7 分支/worktree 删除由用户裁定，B 只出盘点；12-8 `AirspacePage`/`SpaceRiskPage` 保留不删（已完成的真实接线），是否挂回菜单待用户；12-9 过期进度文档加横幅不删。
