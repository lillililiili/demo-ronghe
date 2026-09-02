/* 通用操作确认弹窗：纯 Naive UI Dialog，供 legacy 与 Vue 业务页共同调用。 */
import { h } from 'vue';
import { createDiscreteApi } from 'naive-ui';
import { closeModal } from './modal.js';
import { theme, themeOverrides } from './theme.js';

const { dialog } = createDiscreteApi(['dialog'], {
  configProviderProps: { theme, themeOverrides }
});

let current = null;

function contentOf(options) {
  if (typeof options.content === 'function') return options.content;
  if (options.content != null) return String(options.content);
  if (options.body) return () => h('div', { innerHTML: options.body });
  return options.message || '确认继续执行此操作吗？';
}

export function openConfirm(options = {}) {
  const confirmText = options.confirmText || '确认';
  const cancelText = options.cancelText || '取消';

  closeModal();
  if (current) current.destroy();

  let submitting = false;
  const handle = dialog.create({
    title: options.title || '操作确认',
    content: contentOf(options),
    positiveText: confirmText,
    negativeText: cancelText,
    positiveButtonProps: { type: options.positiveType || 'primary' },
    showIcon: false,
    autoFocus: true,
    closeOnEsc: true,
    maskClosable: false,
    style: {
      width: options.width || '420px',
      maxWidth: 'calc(100vw - 32px)',
      /* Dialog 原生已在视口居中；用独立 translate 轻微上移，不参与 flex 的 auto margin
         计算，也不会与 Naive UI 的 transform 缩放动画互相覆盖。 */
      translate: `0 ${options.offsetY || '-8vh'}`
    },
    onNegativeClick: () => {
      if (options.onCancel) options.onCancel();
    },
    onPositiveClick: async () => {
      if (submitting) return false;
      submitting = true;
      handle.loading = true;
      try {
        const result = options.onConfirm ? await options.onConfirm() : true;
        if (result === false) {
          submitting = false;
          handle.loading = false;
          return false;
        }
        return true;
      } catch (error) {
        submitting = false;
        handle.loading = false;
        throw error;
      }
    },
    onAfterLeave: () => {
      if (current === handle) current = null;
    }
  });

  current = handle;
  return handle;
}
