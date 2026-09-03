# AGENTS.md

本文件适用于 `dongying-vue/` 前端目录。仓库级说明见根目录 `AGENTS.md`。

目录组织与编码约定参考了同类 Vue 工程的分层方式，但**不要**把那套技术栈原样搬进来：本仓库保持 JavaScript、原生 CSS、Naive UI 与渐进式 legacy 迁移。禁止借「对标」引入 TypeScript、Less、Ant Design、pnpm/yarn 或新的生产依赖。

## 项目定位

- 这是“东营无人机融合感知与低空安全管理平台”演示工程的 Vue 3 迁移版。
- 当前工程采用渐进式迁移：Vue 外壳与已迁移页面和 legacy 经典脚本并存。首要目标是保持现有业务语义、状态流、数据口径和交互兼容，再逐步减少 legacy。
- 产品长期方向见 `../docs/整体改造方案.md` 和 `../docs/事件驱动业务流程梳理.md`：从功能驾驶舱转向角色化工作台与事件闭环。这两份文档是路线图，不代表所有事件、任务、SLA、责任人或后端能力已经实现；未收到明确需求时，不要凭路线图虚构字段、流程或数据。

## 技术基线与常用命令

- 技术栈：Vue 3、Vite 6、Vue Router 4（hash 路由）、Pinia 3、Naive UI、ECharts。
- 使用 npm；`package-lock.json` 是依赖锁文件。不要改用 pnpm 或 yarn。
- 路径别名：`@/` → `src/`。跨目录引用一律用 `@/`，同目录组件可用相对路径。
- 常用命令：
  - `npm install`
  - `npm run dev`
  - `npm run build`
  - `npm run preview`
- 项目当前没有 `test` 或 `lint` npm script。不要声称运行过不存在的命令。
- 未经用户明确同意，不新增生产依赖，不更换构建工具，不做与当前任务无关的依赖升级。

## 目录结构

当前真源见 `../docs/目录结构.md`。分层约定（路径相对本目录）：

| 目录 | 放什么 | 不放什么 |
| --- | --- | --- |
| `src/assets/css/` | 全局样式切片与入口 `index.css` | 页面私有、只服务单个 SFC 的样式 |
| `src/components/` | 跨页面复用的 Vue 组件 | 某一页专用的业务块 |
| `src/config/` | 导航、路由、页面主题等静态配置 | 运行时状态 |
| `src/hooks/` | 跨模块 composable（`use` 前缀） | 某一页专用的逻辑 |
| `src/layout/` | 壳层：顶栏、侧栏、面包屑、页面宿主 | 业务页 |
| `src/pages/` | 路由页面 | 通用组件 |
| `src/ui/` | Naive 适配层（toast/modal/theme/表单桥） | 展示型 Vue 组件 |
| `src/services/` | 工作台入口、权限、天气等共享服务 | 页面私有渲染 |
| `src/stores/` | Pinia 全局状态 | 页面局部 ref |
| `public/assets/js/` | legacy IIFE 与演示数据 | 新的 Vue 代码 |
| `public/assets/img/` | 运行时静态图 | 样式文件 |

新增文件先判断该不该公共复用：只有跨页面使用的才进 `src/components/`、`src/hooks/`、`src/services/`。

## 样式规范

- 全局样式在 `src/assets/css/`，由 `src/main.js` 首先 `import '@/assets/css/index.css'`。不要再往 `public/assets/css/` 加样式，也不要在 `index.html` 用 `<link>` 加载业务 CSS。
- `src/assets/css/index.css` 的 `@import` **顺序即层叠顺序**，后写覆盖先写。不要为了「好看」重排 import。
- `src/assets/css/tokens.css` 是主题颜色与间距 token 的唯一真源。`src/ui/theme.js` 必须运行时 `getComputedStyle` 映射 Naive UI，禁止在主题配置里手抄色值。
- 分层：
  - `tokens.css` / `reset.css`：变量与基线
  - `layout/`：壳层（顶栏、导航、面包屑、大屏模式）
  - `mixins/`：通用布局工具类（`.row` `.col` `.grid` 等）
  - `components/`：跨页组件类（面板、KPI、表格、按钮、地图、弹窗等）
  - `visual-2026.css`：覆盖层，改顶栏/导航/面板时必须同时看这里和 `layout/`、`components/`
  - `themes.css`：`body[data-theme]` 模块插画
  - `pages/`：只作用于某页的选择器
- 改样式先找已有全局类组合；不够再补对应切片。新增选择器尽量限定在页面根类下（如 `.workbench-page`），避免污染其他页。
- 已有 class 名（`.hdr` `.nav` `.tb` `.kpi` 等）是视觉与 DOM 指纹的一部分，禁止为了 BEM 或「规范化」重命名。
- 图片走 `public/assets/img/`，CSS 里用根路径 `url('/assets/img/...')`，不要用相对 `../img/`。
- Vue 单文件若需要局部样式，写在该组件的 `<style scoped>`。不允许为了把 SFC 行数做小，把组件局部样式抽成单独 CSS 文件；行数超标时按业务块拆子组件。
- 不引入 Less/Sass，除非用户明确要求并接受新增依赖。

## 功能页面模块组织

1. 新增功能页使用独立文件夹，相关代码收敛在该文件夹内：

   ```
   src/pages/<feature>/
     XxxPage.vue
     components/     # 仅本页使用
     hooks/          # 仅本页使用
   ```

2. 只有跨页面复用的组件、hooks 才分别放入 `src/components/`、`src/hooks/`。
3. 已迁移的扁平页面（`src/pages/*Page.vue`）不要为了目录整齐再搬一次；后续若拆子组件，再就地改成功能文件夹。
4. 开发前先搜索并复用 `src/components/`、`src/hooks/`、`src/ui/`、`src/services/`、`src/assets/css/` 中的已有能力。
5. 弹窗组件命名 `xxxModal`，抽屉 `xxxDrawer`，页面 `xxxPage`，hooks 以 `use` 开头。
6. 新组件目标不超过约 500 行、函数不超过约 100 行。已迁移页受 DOM 指纹约束，禁止只为行数拆分而改 DOM 结构。

## 当前架构契约

- `index.html` 中 `public/assets/js/**` 以经典 `<script>` 按固定顺序加载，随后才加载 `src/main.js`。这些 IIFE 依赖经典脚本语义和 `window.*` 全局对象；不要随意改成 ESM、调整加载顺序或异步加载。
- 关键全局契约包括 `MOCK`、`UI`、`CH`、`MapView`、`EVT`、`PAGES`、`ROUTES` 和 `APP`。修改共享层前先搜索全部消费者。
- `src/config/navModel.js` 是导航、路由、页面主题和重定向表的当前真源；新增或改名页面时同步检查侧栏、标题、面包屑、重定向和别名。
- `src/pages/registry.js` 是 Vue 页面迁移开关。只有页面行为和 DOM 验收通过后才能登记；未登记页面继续由 `LegacyHost` 承载。
- `monitor` 暂不迁移：它在模块加载期消耗共享确定性随机序列。只有先把对应数据副作用移入统一数据层并证明口径不漂移，才可改为 SFC。
- `public/assets/js/mock.js` 是当前演示数据、领域关系和大量推导规则的主要真源。不要在 Vue 页面再造一份同类数据或状态机。
- `src/services/workbenchEvents.js` 只统一工作台入口、分类和待办提示，不重写无人机、飞行风险和设备三类流程各自的状态机。

## Legacy 与 Vue 迁移规则

- 开始迁移页面前重新读取对应 `public/assets/js/pages/<page>.js`；不要依赖旧会话或旧截图中的代码记忆。
- 需要与同级 `dongying-demo` 母本同步时，先运行 `bash tools/parity-diff.sh`。若母本目录不存在，明确说明无法做字节级对照，不要猜测差异。
- 未迁移页面、共享 legacy JS 和 `public/assets/img` 可按母本同步。**CSS 已由本仓 `src/assets/css/` 维护，不再与母本逐字节同步**；上游样式 diff 必须人工重放到对应切片。
- 已迁移页面必须把上游 JS 差异人工重放到对应 Vue 页面，不能用旧脚本直接覆盖 SFC。
- 保留 legacy 的状态生命周期：需要跨导航保留的模块级状态放在 SFC 普通 `<script>` 模块作用域；仅当旧 `mount()` 本就完全重置时，才放在 `setup` 生命周期中。
- 模块加载期的数据注入、注册或随机数消耗只保留一处。不要在 SFC 中重复 `U.regParams`、Mock 注入或其他副作用。
- 页面卸载必须清理图表、地图、动画帧、计时器、事件监听和弹窗。Vue 页面优先调用 `usePageChrome()`，并保持与 legacy 兼容的清理顺序。
- `v-html` 只用于仓库内受信任的 legacy 渲染串和图标输出。禁止把外部输入、用户输入或未清洗数据直接传入 `v-html`；还要避免为了包裹 HTML 额外增加会破坏 DOM 指纹的节点。
- 保持 hash 地址与旧书签兼容，例如 `#/situation`、`#/alarms`、`#/risk`、`#/monitor` 和 `#/bigscreen`。

## 表单控件（Naive UI 强制）

- **产品表单只使用公共表单件**（内部才是 Naive UI）：`src/components/form/` 的 `UField`、`UFieldGrid`、`UFormFooter`、`UControl`。Vue 模板禁止出现原生 `<input>`、`<select>`、`<textarea>`，也不要在页面里直接铺 `NInput`/`NSelect`（权限矩阵等无对应公共件的除外）。
- **新弹窗表单**走 `openFormModal()`（`src/ui/formModal.js`）或 `openModal({ render: () => h(Comp), footer: false })` 后在 Comp 里用 `UField`。样板：`ControlledFormModal.vue`、`CarouselModal.vue`。
- **禁止**为了“看起来像组件”而用 CSS 给原生控件描边；也禁止在 Vue 页面继续拼 `U.field` + `` `<input class="ip">` `` / `U.select` 作为新表单。
- 仍由 `innerHTML` 绘制的旧工具条 / 调测参数 / monitor 字符串，必须带 `.ip` / `.sel` / `type="checkbox|radio"`，由 `src/ui/legacyControls.js` 升级为真 Naive 组件。新代码不要再扩大这条兼容路径。
- `tools/scan.cjs` 对 Vue 模板中的原生表单控件判红。扫描、修复和生成新代码均遵守本条。

## UI 与交互规则

- 交互控件优先使用现有 Naive UI 适配：toast 走 `src/ui/nv.js`，弹窗走 `src/ui/modal.js`，确认框走 `src/ui/confirm.js`。具体 legacy → Naive 映射见 `tools/NAIVE-MAP.md`。
- 弹窗保持单例、遮罩关闭、`data-close`/`data-act` 委托和既有 z-index 契约；Vue 页面不要绕回 legacy toast 或另造第二套弹窗系统。
- 展示型 legacy helpers（如 tag、kv、sect、metricStrip）可以继续复用。不要仅为“组件化”改变已有 DOM 数量、文案、数据口径或视觉签名。
- 优先复用现有图标、品牌资源、`MapView`、图表和组件；不要用 emoji、占位图、临时手绘 SVG 或虚构数据代替真实界面资产。
- UI 文案使用简体中文，并沿用现有业务术语。首屏优先表达结论、依据、风险、下一动作和阻断原因，技术细节按需展开。
- 所有新增交互要有明确的空态、无权限态、阻断态、处理中态、失败态和完成态。可点击元素优先使用语义化 `button`/`a`，并支持键盘与可见焦点。
- 页面不得产生 document 级横向滚动。与任务相关时至少检查 1280×720、1366×768、1440×900/1024；大屏页面还应检查目标大屏尺寸。表格或长内容应在局部容器内滚动。

## 业务与数据一致性

- 不得虚构事件 ID、责任人、SLA、协作关系、授权记录、证据、回执或统计趋势。界面只展示当前数据模型真实存在或由既有规则可确定推导的内容。
- 权限同时影响导航/可见性、数据范围、操作按钮和敏感字段。前端权限仅改善体验；不要把它描述为生产级后端授权。
- 任何状态动作必须复用共享状态机并同步审计、证据、关联记录和回执；不要只改按钮文案或页面局部状态。
- 当前已确认的无人机演示主线为：告警触发 → 人工核实 → 联动反制 → 自动信号干扰 → 通知处罚部门。联动反制是一次人工动作，告警页、工作台和处罚页必须调用同一共享动作并显示一致进度。
- 无人机事件完成“通知处罚部门”表示完成交接，不等于行政处罚案件已经办结；不要添加手工归档步骤来混淆实时处置与案件办理。
- 飞行计划风险遵循既有 `M.RISK_FLOW`/`RISK_IMPL`；设备异常遵循“原因与确认 → 下发重启 → 等待真实延迟回执 → 平台恢复校验 → 关闭”的独立流程。不要把三类事件强行套入一条状态链。
- 地图、图表和列表必须读取同一份状态。切换事件、路由或重挂页面后，不得遗留多个活动 `MapView`、overlay canvas、定时器或全局监听器。

## 地图、环境变量与安全

- 高德地图配置只通过环境变量进入：`VITE_AMAP_KEY`、`VITE_AMAP_SECURITY_CODE`、`VITE_AMAP_SERVICE_HOST`。
- 不读取、输出、提交或在代码中硬编码 `.env.local` 的值。新增配置时同步更新 `.env.example`，只放空值和说明。
- `VITE_AMAP_SECURITY_CODE` 仅用于本地开发；生产构建必须继续剔除它，并通过以 `/_AMapService` 结尾的代理地址提供安全代理。部署参考 `deploy/nginx-amap.conf.example`。
- 历史离线瓦片不参与运行时、文件监听或构建；`tools/tilecheck.cjs` 只用于人工审计保留包，不能把瓦片重新打进产物。
- 地图在线加载失败时保留现有降级行为，不得让地图或天气失败阻塞主页面。

## 验证要求

- 先按改动范围做最小充分验证，不要用未执行的检查填充结论。
- 所有代码改动至少运行 `npm run build`。
- 改到 legacy 共享层、Mock、业务状态或页面迁移时，运行：
  - `node tools/scan.cjs`
  - `node tools/falsify.cjs`
- 改到历史瓦片审计逻辑时运行 `node tools/tilecheck.cjs`；它不是普通 UI 改动的必跑项。
- 改到经典 JS/CJS 时对相关文件运行 `node --check <file>`。
- 改到全局 CSS 时，至少抽查壳层、一张业务页、工作台和大屏，确认层叠未被打乱、图片能加载。
- UI 改动需在真实浏览器验证受影响路由、关键交互链、控制台错误、目标视口和卸载清理；涉及地图时确认只剩一个活动地图宿主和 overlay canvas。
- 页面迁移的验收门槛是与当前 legacy 页面并排比较：DOM 元素数和规范化 `textContent` 指纹一致。含 `requestAnimationFrame` 内容时先中和环境相关片段，并保证页面可见后再测量。
- 视觉改造只有在确实捕获了对应截图、视口、状态和测试证据后才能更新 `design-qa.md`；不要引用缺失或过期图片作为通过依据。
- 交付前运行 `git diff --check`，并报告实际通过、失败或未运行的检查。

## 修改与协作纪律

- 开始前检查 `git status`。仓库可能有其他会话或用户的未提交改动；保留它们，不回滚、不覆盖、不顺手整理无关文件。
- 只做与当前任务直接相关的最小改动。不要提交 `node_modules/`、`dist/`、`.env.local`、日志、浏览器会话目录或临时 QA 输出。
- 在生成和验证过程中，不要在项目目录内添加过程文件、测试文件或临时验证产物；确需临时文件时使用项目外的系统临时目录，并在完成后清理。
- 不使用 `git reset --hard`、`git checkout --` 或其他会丢失工作区内容的命令，除非用户明确要求并确认精确目标。
- 行为或公共约定变化时同步更新最接近的文档；不要让 README、流程文档、映射表和代码互相矛盾。
- 发现实现与文档冲突时，以可运行代码和已验证业务行为描述“当前状态”，以仓库根目录 `docs/` 描述“目标方向”，并在交付中明确差异，不要静默选择一边。

## Code Review Rules

- 阻止会破坏经典脚本加载顺序、全局 shim、hash 路由兼容、页面清理顺序或确定性 Mock 数据的改动。
- 阻止把 CSS 重新堆回单文件、打乱 `index.css` 的 import 顺序，或在 Vue 主题里手抄 token 的改动。
- 阻止页面私自复制状态机、跳过权限/审计/证据/回执，或让不同入口对同一事件显示不同阶段的改动。
- 阻止把密钥写入源码、生产包或日志，以及把开发安全码带入生产配置的改动。
- 阻止只靠 toast 模拟成功、虚构业务记录或把路线图能力伪装成已落地能力的改动。
- 阻止在 Vue 模板或新弹窗里新增原生 `<input>` / `<select>` / `<textarea>` 表单控件，或仅靠 CSS 仿写组件库外观；新表单必须使用 Naive UI。
- 阻止无验证证据却声称构建、流程、视觉或兼容性已通过的改动。
