import { closeModal } from './modal.js';
import { openFormModal } from './formModal.js';

export function openDeviceRebootForm(d, { onConfirm } = {}) {
  const U = window.UI;
  return openFormModal({
    title: '远程重启设备 · ' + d.name,
    width: '600px',
    warning: `注意：远程重启是<b>控制类指令</b>，作用于在网感知设备。重启期间该设备停止上报，
      融合结果在此期间可能降级。依纪要 §8.1，控制类指令须具备<b>幂等、回执与急停</b>，
      本次下发与回执全程记入操作审计。`,
    introHtml: U.kv([
      ['设备', `${d.name}　<span class="mono">${d.id}</span>`],
      ['类型 / 通道', d.type + ' / ' + d.channel],
      ['当前状态', U.tag(d.status) + (d.alarm ? ' ' + U.tag('告警中', 't-amber') : '')],
      ['最后心跳', d.hb],
      ['上次重启', d.lastReboot ? `${d.lastReboot.at} · ${d.lastReboot.by} · ${d.lastReboot.ack}` : '无记录'],
      ['下发接口', '<span class="mono">POST /api/v1/device/control</span>　【指令码待设备方确认】']
    ]),
    fields: [
      { key: 'why', label: '重启原因', required: true, placeholder: '必填，例如：心跳异常、指标持续超阈值' },
      { key: 'ack', type: 'checkbox', label: '我已确认该设备可以重启，知悉重启期间数据中断且本次操作全程记入审计' }
    ],
    initial: { why: '', ack: false },
    confirmText: '确认下发',
    danger: true,
    submitEnabled: m => !!m.ack,
    validate: m => !(m.why || '').trim() ? '重启原因为必填 —— 设备控制操作必须能回答"为什么重启"' : '',
    onSubmit: ({ why }) => {
      closeModal();
      if (onConfirm) onConfirm((why || '').trim());
    }
  });
}
