/* 受控表单弹窗入口。新表单一律走公共组件，不要再拼 <input>/<select> 字符串。 */
import { h } from 'vue';
import { openModal, closeModal } from './modal.js';
import ControlledFormModal from '@/components/modals/ControlledFormModal.vue';

export { optionsOf } from '@/components/form/options.js';

export function openFormModal(o) {
  return openModal({
    title: o.title,
    width: o.width || '560px',
    footer: false,
    render: () => h(ControlledFormModal, {
      fields: o.fields || [],
      initial: o.initial || {},
      columns: o.columns || 1,
      notice: o.notice || '',
      warning: o.warning || '',
      introHtml: o.introHtml || '',
      confirmText: o.confirmText || '确定',
      danger: !!o.danger,
      hideFooter: !!o.hideFooter,
      submitEnabled: o.submitEnabled || null,
      validate: o.validate || null,
      onCancel: closeModal,
      onSubmit: values => o.onSubmit(values)
    })
  });
}
