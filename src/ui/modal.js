/* =============================================================================
 * modal.js —— U.modal 的 Naive UI 桥接层（P4a：全量换壳，契约不变）。
 *
 * openModal(o) 与 ui.js 的 U.modal(o) 同签名：
 *   { title(可含 HTML), width, body(HTML 串), footer(HTML 串|false|省略→默认「关闭」),
 *     on: { actKey(modalEl, el) }, mounted(modalEl) }
 * 行为对齐点（ui.js:325-342 为基准）：
 *   · 单例：新开自动关上一个（含 legacy 的 U.modal）
 *   · 掩层点击关闭；[data-close] 关闭；[data-act=x] → on.x(卡片根元素, 按钮)
 *   · data-close 与 data-act 同存时两者都执行（先关后调，legacy 同序）
 *   · mounted(卡片根元素) 在 DOM 就绪后调用（nextTick，footer 已渲染）
 *   · 不响应 ESC（legacy 无此行为）；z-index 100 对齐旧 .mask
 * 换壳收益：Naive 卡片外观/动画/主题一致性；body 字符串与全部业务逻辑零改动。
 * P4b 逐个重写为受控表单时，从这里迁出即可（openModal 调用点即清单）。
 * ========================================================================== */
import { h, nextTick } from 'vue';
import { createDiscreteApi } from 'naive-ui';
import { theme, themeOverrides } from './theme.js';
import LegacyFormContent from '@/components/modals/LegacyFormContent.vue';

const { modal } = createDiscreteApi(['modal'], {
  configProviderProps: { theme, themeOverrides }
});

let cur = null;
let pendingOpen = null;

export function closeModal() {
  pendingOpen = null;                       // 同一 tick 里还没真正打开的请求一并取消
  if (cur) { const c = cur; cur = null; try { c.destroy(); } catch (e) { } }
  /* 同时收掉可能开着的 legacy 弹窗（跨模块调用链里两套并存期共用一个「关闭」语义） */
  if (window.UI && window.UI.closeModal) window.UI.closeModal();
}

export function openModal(o) {
  /* legacy 契约允许同一次点击连开两次弹窗（兄弟委托同时命中，legacy 里第二次瞬时顶掉
     第一次）。Naive 的 modal 若在 enter 动画中被 destroy 会留下孤儿容器 —— 这里把打开
     合并到微任务：同一事件 tick 内只有最后一次请求真正创建，第一次根本不进 DOM，
     可见结果与 legacy 完全一致（只看到最后那个弹窗）。 */
  pendingOpen = o;
  queueMicrotask(() => {
    if (pendingOpen !== o) return;
    pendingOpen = null;
    reallyOpen(o);
  });
}

function reallyOpen(o) {
  closeModal();
  const handle = e => {
    const card = e.currentTarget.closest('.n-card') || e.currentTarget;
    if (e.target.closest('[data-close]')) closeModal();
    const a = e.target.closest('[data-act]');
    if (a && o.on && o.on[a.dataset.act]) o.on[a.dataset.act](card, a);
  };
  let mountedDone = false;
  const bodyRef = el => {
    if (!el || mountedDone) return;
    mountedDone = true;
    /* nextTick：等 footer 同批渲染完成 —— mounted 钩子常要接线 footer 里的按钮
       （如 jamModal 的 #jamGo 勾选启用）。legacy 是同步调用，这里晚一个微任务，无感知。 */
    nextTick(() => { if (o.mounted) o.mounted(el.closest('.n-card') || el); });
  };
  cur = modal.create({
    preset: 'card',
    autoFocus: false,
    closeOnEsc: false,
    maskClosable: true,
    zIndex: 100,
    style: { width: o.width || '520px', maxWidth: '94vw' },
    contentStyle: { maxHeight: '72vh', overflow: 'auto' },
    onClose: () => { closeModal(); return false; },
    title: () => h('span', { innerHTML: String(o.title == null ? '' : o.title) }),
    /* P4b：o.render 提供 vnode 工厂时走受控组件（真 Naive 表单），否则沿用 HTML 串桥接 */
    content: o.render ? o.render
      : () => h(LegacyFormContent, { html: o.body || '', onClick: handle, onReady: bodyRef }),
    footer: o.footer === false ? undefined
      : () => h('div', {
        style: 'display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;align-items:center',
        innerHTML: o.footer || '<button class="btn" data-close>关闭</button>',
        onClick: handle
      })
  });
  return cur;
}

/* 未迁移页面继续调用 window.UI.modal；统一接入同一 Naive UI 壳层与表单桥接。 */
if (window.UI) window.UI.modal = openModal;
