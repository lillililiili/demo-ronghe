# dongying-vue —— 东营无人机融合感知平台 Demo（Vue 3 版）

原纯静态 demo（`../dongying-demo/`，**一个字未动**）的 Vue 3 迁移工程。
路线：**混合起步，逐页 Vue 化** —— Vue 外壳 + legacy 页面逐字节保留起步，
之后按页转成真 Vue 组件，每页以「与 legacy 并排 DOM 指纹一致」为验收门槛。

## 运行

```bash
npm install
npm run dev        # http://localhost:5173（hash 路由与旧版地址完全兼容）
npm run build      # dist/ 约 5MB，瓦片不进产物
npm run preview    # 生产产物预览（瓦片中间件同样生效）
```

旧版对照：项目根 `node serve.js` → http://localhost:8899。两个同时开、同 hash 并排比对，
是所有验收的基本姿势。

## 架构

```
public/assets/js/          ← legacy 层：与 dongying-demo/assets/js 逐字节一致的副本，
│                             以经典 <script> 按原顺序加载（保持经典脚本语义，非 ESM）
├── mock.js                ← 唯一数据源（确定性 LCG，两版所有数字必然逐位相等）
├── ui.js/charts.js/map.js/geo.js/video.js/case.js/search.js/bigscreen.js
└── pages/*.js             ← 13 个 legacy 页面（未转换的仍由它渲染）
public/bigscreen.html      ← 独立大屏页（原样搬运，单独窗口打开）
src/
├── main.js                ← APP/ROUTES 全局 shim + createApp
├── shell/                 ← Vue 外壳：App/HeaderBar/NavSidebar/Breadcrumb
│   ├── PageHost.vue       ← 切换器：VUE_PAGES 注册表 → Vue 页；否则 LegacyHost
│   ├── LegacyHost.vue     ← 命令式宿主，逐字移植旧 route() 挂载/清理次序
│   ├── navModel.js        ← NAV/ROUTES/PAGE_THEME/REDIRECT 四表（逐字对应旧 app.js）
│   └── usePageChrome.js   ← 转换页共用外壳职责（面包屑/导航组/页脚/卸载清理）
├── ui/                    ← UPanel/UKpis（标记逐字复刻 ui.js 输出）+ useChart
└── pages/
    ├── registry.js        ← 已转换页面注册表（唯一开关）
    └── *Page.vue          ← 转换页
```

**转换进度（12 转换 / 1 排除）**：
✅ stats · users · archive · evidence · alarms · commission · devices ·
   flights（含 risk / airspace 别名）· situation · punish · legality
⛔ monitor —— 其 devAlarms 在模块加载期消耗共享 LCG，SFC 重算必然数值漂移；
   待数据层把 devAlarms 挪进 mock.js 后再转（由 LegacyHost 承载，1:1 无损）

## 与 dongying-demo 的同步纪律（多会话并行是常态）

demo 侧随时有并行会话在改。**同步流程**：

```bash
bash tools/parity-diff.sh            # 任何 DIFF 都表示 legacy 副本落后
```

1. **未转换页面 + 共享层 + css/img/bigscreen**：直接重拷（`cp`），零风险。
2. **已转换页面**：`git diff -- dongying-demo/assets/js/pages/<页>.js` 看上游改了什么，
   把 diff 重放进对应 `src/pages/*Page.vue`，然后与新版 legacy 并排指纹比对。
3. **app.js**：属外壳，diff 重放进 shell 组件（HeaderBar/Breadcrumb/navModel/PageHost）。
4. **index.html**（demo 侧）：新增 script 标签 → 本工程 index.html 同步加；
   新增顶栏控件 → HeaderBar.vue。

## 页面转换配方（逐页 Vue 化的固定打法）

1. 读 legacy `pages/<页>.js` **当前版本**（不要凭旧读缓存——上游在动）。
2. 模块级状态 → SFC 非 setup 的 `<script>` 块（跨导航保持，legacy 约定）；
   若 legacy mount 本就重置全部状态（如 commission），直接放 setup。
3. render() 外骨架 → template（UPanel/UKpis；面板体沿用 U.* 字符串走 bodyHtml，
   **禁 v-html 包裹节点**——元素数必须与 legacy 逐一对应）。
4. mount() → onMounted（U.on 委托绑在组件根上，:key 重挂时随节点销毁）；
   destroy() → onUnmounted（usePageChrome 先注册，保证 disposeAll → 页面清理 → closeModal 次序）。
5. **模块加载期副作用（U.regParams / 数据注入）一律留在 legacy script，SFC 不重复。**
6. 验收：双服务并排，`元素数 + 全文哈希`（textContent 去空白）一致才准登记进 registry.js。
   含 rAF 绘制内容的页（地图比例尺/点型计数）先把这些片段正则中和再比。
   ⚠ 测量前确认视口可见（隐藏标签 rAF 暂停、定时器节流，量出来的是环境不是页面）。

## 验证工具（适配副本，规则与母本逐字一致，只改路径）

```bash
bash tools/parity-diff.sh     # legacy 副本字节级等价
node tools/scan.cjs           # 源码合规扫描（含 src/**/*.vue）
node tools/falsify.cjs        # mock.js 断言证伪（183 条 + 注入捕获）
node tools/tilecheck.cjs      # 瓦片完整性（瓦片仍读 dongying-demo 原目录）
# tools/overflow.cjs          # 浏览器探针生成器，用法见文件头
```

## 瓦片与部署

1.5GB / 32 万张离线瓦片**不复制**：dev 与 preview 由 `vite.config.js` 的中间件把
`/assets/tiles/**` 转发到 `../dongying-demo/assets/tiles`。生产部署时用反向代理
或把瓦片目录挂载/复制到站点根的 `assets/tiles/`（勿放进 `public/`，build 会全量复制）。

## 组件库（Naive UI，2026-08-31 引入）

交互件全套替换（P0–P4a 完成 + P4b 样板），展示串（tag/kv/sect 等 ~280 处大屏视觉签名）不替换：

- **P0 主题**：`src/ui/theme.js` 运行时 getComputedStyle 读 app.css token 生成
  themeOverrides（app.css 保持唯一真源，勿手抄色值）；App.vue 包 n-config-provider。
- **P1 toast 96 处**：`src/ui/nv.js` 的 `toast()` → message.success/error/info。
- **P2 分页 4 页**（Alarms/Evidence/Devices/Legality）→ n-pagination 受控；
  其余 4 页列表区命令式 innerHTML，pager 保留（P5 项）。
- **P3**：situation techDrawer → n-drawer；Users/Archive 模板层 tabs → n-tabs。
- **P4a 弹窗桥接**：`src/ui/modal.js` 的 `openModal/closeModal` 与 U.modal 同签名同契约，
  全部 U.modal 调用点换壳 Naive；同一事件连开两次走微任务合并（防孤儿容器）。
- **P4b 受控表单**：`openModal({render, footer:false})` 扩展口；
  样板 `src/ui/modals/CarouselModal.vue`（大屏轮播设置）。
- z-index 对齐旧层级：mask 100 / drawer 150 / toast 200 / carousel 300。
- 上游 diff 重放映射表：`tools/NAIVE-MAP.md`。dev-only 对照页 `#/__ui-lab`。
