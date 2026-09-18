import { openFormModal } from '@/ui/formModal.js';
import { toast } from '@/ui/nv.js';
import { uavAdvisoryApi } from '@/services/uavAdvisoryApi.js';
import { newDisposalIdempotencyKey } from '@/services/disposalApi.js';
import { isUncertainOutcome, readSessionToken } from '@/services/apiClient.js';
import { OBSERVATION_DANGER, OBSERVATION_OUTCOME } from './advisoryView.js';

// 仅在人主动发起反制且缺依据时补录事实；保存不会申请授权或下发设备指令。
export function openCounterBasis({ data, reload, isCurrent }) {
  const eventId = data.event_id, version = data.event_version, session = readSessionToken();
  const key = newDisposalIdempotencyKey('counter-basis');
  let pendingBody = null;
  const observing = values => values.kind !== 'CONTACT_RECORDED';
  const modal = openFormModal({
    title: '补充反制依据', width: '600px', confirmText: '保存依据',
    notice: data.counter_block_reason || '请按当前现场事实补充反制依据。',
    warning: '保存依据不会启动反制。普通处置需有联系后的现场核查；确属紧急情况时填写紧急事由。目标失联不能当作仍在区域或已飞离。',
    fields: [
      { key: 'kind', label: '补充内容', type: 'radio', required: true, options: [
        { value: 'OBSERVATION', label: '现场核查' }, { value: 'CONTACT_RECORDED', label: '已发生的人工联系' },
        { value: 'URGENT_OBSERVATION', label: '紧急处置依据' }
      ] },
      { key: 'outcome', label: '目标现在的情况', type: 'select', required: true, visibleWhen: observing,
        options: Object.entries(OBSERVATION_OUTCOME).map(([value, label]) => ({ value, label })) },
      { key: 'danger', label: '当前危险度', type: 'select', required: true, visibleWhen: observing,
        options: Object.entries(OBSERVATION_DANGER).map(([value, label]) => ({ value, label })) },
      { key: 'note', label: '现场依据与紧急事由（如适用）', type: 'textarea', required: true, minRows: 3, visibleWhen: observing,
        placeholder: '说明当前轨迹、视频或现场反馈；紧急处置还需说明为何不能等待及适用依据' },
      { key: 'recipient_name', label: '实际联系对象', required: true, visibleWhen: m => !observing(m) },
      { key: 'contact_basis', label: '联系依据', required: true, visibleWhen: m => !observing(m) },
      { key: 'content', label: '已发生的联系内容与结果', type: 'textarea', required: true, minRows: 3,
        help: '仅补录联系事实，不生成短信或电话录音通知的送达回执。', visibleWhen: m => !observing(m) }
    ],
    initial: { kind: 'OBSERVATION', outcome: null, danger: null, note: '', recipient_name: '', contact_basis: '', content: '' },
    validate: values => {
      if (!isCurrent() || readSessionToken() !== session) return '事件或登录状态已变化，请关闭后重新操作。';
      const fields = observing(values) ? ['outcome', 'danger', 'note'] : ['recipient_name', 'contact_basis', 'content'];
      if (fields.some(field => !String(values[field] || '').trim())) return '请填写完整的现场事实。';
      if (values.kind === 'URGENT_OBSERVATION' && (values.outcome !== 'STILL_INSIDE' || values.danger !== 'HIGH' || values.note.trim().length < 20))
        return '紧急处置需确认目标仍在违规区域、危险度高，并填写至少 20 字的紧急事由与适用依据。';
      return null;
    },
    onSubmit: async values => {
      const current = () => isCurrent() && readSessionToken() === session && modal.isCurrent();
      if (!current()) throw new Error('事件或登录状态已变化，请关闭后重新操作。');
      const body = { expected_version: version, kind: observing(values) ? 'OBSERVATION' : 'CONTACT_RECORDED',
        ...(observing(values) ? { outcome: values.outcome, danger: values.danger, note: values.note, urgent: values.kind === 'URGENT_OBSERVATION' }
          : { recipient_name: values.recipient_name, contact_basis: values.contact_basis, content: values.content }) };
      if (pendingBody && JSON.stringify(body) !== pendingBody) throw new Error('上次保存结果未确认，请保留原内容重试，或关闭后更新记录核查。');
      try {
        await uavAdvisoryApi.act(eventId, body, key);
        if (!current()) return;
        modal.close();
        await reload();
        toast('依据已保存，请核对最新反制条件后手动发起。', 'ok');
      } catch (error) {
        if (!current()) return;
        if (error.code === 'VERSION_CONFLICT') {
          await reload();
          throw new Error('事件已有新记录，请关闭弹窗，核对最新记录后重新操作。');
        }
        if (isUncertainOutcome(error)) pendingBody = JSON.stringify(body);
        throw new Error(error.message || '保存结果未确认，请使用原内容重试或更新记录核查。');
      }
    }
  });
  return modal;
}
