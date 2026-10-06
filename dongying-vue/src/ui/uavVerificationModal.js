/* 无人机事件人工核实弹窗：告警页与工作台共用同一实现，避免出现第二套表单和第二套幂等键逻辑。
   只调用 alarmApi.verifyUavEvent；结果以服务端为准，不写 window.MOCK/window.EVT。 */
import { openFormModal } from './formModal.js';
import { closeModal } from './modal.js';
import { toast } from './nv.js';
import { verifyUavEvent } from '@/services/alarmApi.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import { ALARM_TYPE_LABEL, labelOf, readableNo } from '@/ui/labels.js';

export const UAV_STATE_TEXT = {
  PENDING_VERIFICATION: '待人工核实',
  CONFIRMED: '告警已确认',
  FALSE_POSITIVE: '误报'
};
export const uavStateText = code => UAV_STATE_TEXT[code] || (code ? String(code) : '—');

/* 同一事件的幂等键在“结果未知”期间保留；只有服务端给出明确结果后才丢弃，避免超时重试重复写历史。 */
const pendingKeys = new Map();

function newKey() {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `uav-verify-${id}`;
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
/* 服务端按目标、本次告警的研判和目标数据时效现算的核实依据；缺依据时不能选“属实”，误报不受限。
   没有返回依据（旧接口或无核实权限）时按原样处理，最终仍以提交时服务端的检查为准。 */
export function verificationBasisState(event) {
  const basis = event?.verification_basis;
  if (!basis || basis.confirmable !== false) return { blocked: false, message: '' };
  return { blocked: true, message: String(basis.message || '缺少依据，不能核实为属实。确认是误报的，可以核实为误报。') };
}
function messageOf(error, fallback) {
  if (!error) return fallback;
  if (error.status === 401) return '登录已失效，请重新登录。';
  if (error.status === 403) return '当前账号没有核实此事件的权限。';
  return error.message || fallback;
}

/**
 * @param {object} o
 * @param {object} o.event   服务端无人机事件（含 event_id/version/allowed_actions）
 * @param {object} [o.alarm] 关联告警（仅用于展示安全字段）
 * @param {(result:object|null)=>Promise<object|null>} [o.refresh] 成功或结果未知时回读当前事件，返回最新事件对象
 * @param {(result:object)=>void} [o.onDone] 明确成功后的回调
 */
export function openUavVerification({ event, alarm, refresh, onDone } = {}) {
  if (!event) { toast('尚未创建核实事件，无法核实', 'err'); return false; }
  if (!(event.allowed_actions || []).includes('VERIFY')) { toast('当前事件不可核实或缺少核实权限', 'err'); return false; }
  const eventId = event.event_id;
  const expectedVersion = Number(event.version);
  const basis = verificationBasisState(event);
  if (!pendingKeys.has(eventId)) pendingKeys.set(eventId, newKey());
  const intro = [
    ['当前状态', esc(uavStateText(event.state))],
    alarm ? ['告警', `${readableNo(alarm.alarm_no) ? `<span class="mono" title="${esc(alarm.alarm_id)}">${esc(readableNo(alarm.alarm_no))}</span> ` : ''}${esc(labelOf(ALARM_TYPE_LABEL, alarm.alarm_type, ''))}`] : null,
    alarm ? ['关联目标', alarm.target_id ? `<span class="mono" title="${esc(alarm.target_id)}">${esc(alarm.target_no || alarm.target_id)}</span>` : '无关联目标或无目标读取权限'] : null
  ].filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');

  openFormModal({
    title: '人工核实 · ' + esc(readableNo(alarm?.alarm_no) || '核实事件'),
    width: '600px',
    introHtml: `<dl class="kv">${intro}</dl>`,
    warning: basis.blocked ? esc(basis.message) : '',
    fields: [
      { key: 'conclusion', label: '核实结论', type: 'radio', required: true, options: [
        { value: 'CONFIRMED', label: basis.blocked ? '属实（缺少依据，暂不能选）' : '属实（置为“告警已确认”）', disabled: basis.blocked },
        { value: 'FALSE_POSITIVE', label: '误报（终态）' }
      ] }
    ],
    // 缺依据时不预选结论，由核实人明确选择误报。
    initial: basis.blocked ? {} : { conclusion: 'CONFIRMED' },
    validate: ({ conclusion }) => (basis.blocked && conclusion === 'CONFIRMED' ? '缺少依据，不能核实为属实。' : ''),
    confirmText: '提交核实结论',
    onSubmit: async ({ conclusion }) => {
      const key = pendingKeys.get(eventId);
      try {
        const result = await verifyUavEvent(eventId, { conclusion, expected_version: expectedVersion }, key);
        pendingKeys.delete(eventId);
        closeModal();
        toast(`核实完成：${uavStateText(result?.state)}`, 'ok');
        if (refresh) await refresh(result);
        if (onDone) onDone(result);
      } catch (error) {
        if (isUncertainOutcome(error)) {
          // 409 / 超时 / 断网：服务端可能已落库。保留原键，先回读事件核对，不自动换键重试、不提示成功。
          const latest = refresh ? await refresh(null) : null;
          if (latest && (Number(latest.version) !== expectedVersion || !(latest.allowed_actions || []).includes('VERIFY'))) {
            pendingKeys.delete(eventId);
            closeModal();
            // 版本变化与终态要分开说明：前者仍可重新打开表单核实，后者不能再核实。
            const stillVerifiable = (latest.allowed_actions || []).includes('VERIFY');
            toast(stillVerifiable
              ? `提交结果未确认，已刷新当前状态：${uavStateText(latest.state)}，请核对后重新打开核实表单。`
              : `提交结果未确认，已刷新当前状态：当前事件为「${uavStateText(latest.state)}」，不能再次核实。`, 'err');
            return;
          }
          throw new Error(`提交结果未确认，请刷新核对：${messageOf(error, '未返回明确结果')}`);
        }
        // 明确失败（400/403/404 等）：请求未被受理，下次提交换新键。
        pendingKeys.delete(eventId);
        pendingKeys.set(eventId, newKey());
        throw new Error(messageOf(error, '核实提交失败'));
      }
    }
  });
  return true;
}
