# Naive UI 替换映射速查表（上游 diff 重放用）

上游（dongying-demo）改到下列旧调用时，按本表映射到 dongying-vue 的对应写法再重放。
展示串（U.tag/icon/kv/sect/detailHero/metricStrip 等 ~280 处）**未替换**，原样照搬即可。

## toast（P1）

| 上游写法 | 本仓写法 | 备注 |
| --- | --- | --- |
| `U.toast(m, 'ok')` | `toast(m, 'ok')` | `import { toast } from '../ui/nv.js'` |
| `U.toast(m, 'err')` | `toast(m, 'err')` | 内部映射 message.success/error/info |
| `U.toast(m)` | `toast(m)` | msg 含 HTML 时 toast() 自动走渲染函数 |

## 弹窗（P4a 桥接层）

| 上游写法 | 本仓写法 | 备注 |
| --- | --- | --- |
| `U.modal({...})` | `openModal({...})` | 同签名：title/width/body/footer/on/mounted；`import { openModal, closeModal } from '../ui/modal.js'` |
| `U.closeModal()` | `closeModal()` | 会连带收掉 legacy U.modal |
| footer 内联 `onclick="UI.toast(...)"` | `data-act="xx"` + `on:{xx}` | 内联 onclick 会走 legacy toast，须改造（样例：PunishPage docModal） |
| —— | `openModal({ render: () => h(Comp), footer: false })` | P4b 受控表单扩展口（样板：ui/modals/CarouselModal.vue） |

桥接层行为契约（modal.js 头注释为准）：单例、掩层关、data-close/data-act 委托、
mounted(卡片根) nextTick 触发、同一事件内连开两次只落最后一个（微任务合并，防孤儿容器）。

## 分页（P2，仅 Alarms/Evidence/Devices/Legality 四页已替换）

| 上游写法 | 本仓写法 |
| --- | --- |
| `${U.pager(total, st.page, st.size)}` 串 | 模板层 `<n-pagination :page :page-size :item-count show-size-picker>` + `totalCount.value = all.length`（list() 内） |
| `[data-pg]` / `[data-size]` 委托 | `@update:page="onPage"` / `@update:page-size="onPageSize"` |

Punish/Flights/Archive/Commission 四页 pager 未替换（列表区命令式 innerHTML，P5 项），上游 pager 改动原样重放。

## drawer / tabs（P3）

| 上游写法 | 本仓写法 |
| --- | --- |
| situation techDrawer 手搓 mask+drawer | `<n-drawer v-model:show :width="600" :z-index="150">`（SituationPage） |
| Users/Archive 外层模板 tabs | `<n-tabs type="line" size="small">` + `<n-tab :name>` |
| paint() 串内的 tabs | 未替换，原样重放 |

## z-index 层级（nv.js/modal.js 已对齐旧值）

mask/modal 100 · drawer 150 · toast/message 200 · carousel 300

## 主题

token 单一真源 = public/assets/css/app.css 第二套 `:root`（~601 行起）。
src/ui/theme.js 运行时 getComputedStyle 读取生成 themeOverrides，**不要手抄色值**；
上游改 token 时 Vue 侧自动跟随，无需重放。
