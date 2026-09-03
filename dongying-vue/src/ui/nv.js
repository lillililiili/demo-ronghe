/* =============================================================================
 * nv.js —— Naive UI 命令式 API 单一出口（createDiscreteApi）。
 *
 * message 对应旧 U.toast、dialog 备用（P4 个别确认框可用）。
 * z-index 显式对齐旧层级（ui.js/全局样式：mask 100 / drawer 150 / toast 200 /
 * carousel 300）—— 并存期内新旧同类控件层序完全一致，P4 结束后再评估恢复默认。
 * message 容器位置对齐旧 .toast（top:70px 居中）。
 * 主题与 App.vue 的 n-config-provider 共用 theme.js 这一份配置。
 * ========================================================================== */
import { h } from 'vue';
import { createDiscreteApi } from 'naive-ui';
import { theme, themeOverrides } from './theme.js';

const { message, dialog } = createDiscreteApi(['message', 'dialog'], {
  configProviderProps: { theme, themeOverrides },
  messageProviderProps: {
    placement: 'top',
    containerStyle: { top: '70px', zIndex: 200 },
    duration: 2600,                      // 对齐旧 toast 的 2600ms 自毁
    keepAliveOnHover: true
  },
  dialogProviderProps: {}
});

export { message, dialog };

/* toast —— U.toast 的等价分发器（P1 全量替换走它，行对行、文案不改）：
   type 'ok'→success / 'err'→error / 其它→info；type 允许是运行期表达式
   （旧代码存在 `cond ? 'ok' : 'err'` 动态写法，逐调用点静态映射会漏）。
   旧 U.toast 用 innerHTML 渲染，部分文案带 <b>/图标片段 —— 这里检测到
   HTML 即走渲染函数保持原样（文案均为本站模板字面量，信任级不变）。 */
export function toast(msg, type) {
  const fn = type === 'ok' ? message.success : type === 'err' ? message.error : message.info;
  if (typeof msg === 'string' && /<[a-z!/]/i.test(msg)) fn(() => h('span', { innerHTML: msg }));
  else fn(msg);
}
