/* 无人机事件人工核实弹窗：告警页与工作台共用同一实现，避免出现第二套表单和第二套幂等键逻辑。
   只调用 alarmApi.verifyUavEvent；结果以服务端为准，不写 window.MOCK/window.EVT。 */
import { openFormModal } from './formModal.js';
import { closeModal } from './modal.js';
import { toast } from './nv.js';
import { verifyUavEvent } from '@/services/alarmApi.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import { ALARM_TYPE_LABEL, labelOf } from '@/ui/labels.js';

export const UAV_STATE_TEXT = {
  PENDING_VERIFICATION: '待人工核实',
  EVIDENCE_REQUIRED: '证据待补充',
  CONFIRMED: '已核实，待处置',
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
  if (!pendingKeys.has(eventId)) pendingKeys.set(eventId, newKey());
  const intro = [
    ['核实事件', `当前版本 v${expectedVersion}`],
    ['当前状态', esc(uavStateText(event.state))],
    alarm ? ['告警', `<span class="mono" title="${esc(alarm.alarm_id)}">${esc(alarm.alarm_no || alarm.alarm_id)}</span> ${esc(labelOf(ALARM_TYPE_LABEL, alarm.alarm_type, ''))}`] : null,
    alarm ? ['关联目标', alarm.target_id ? `<span class="mono" title="${esc(alarm.target_id)}">${esc(alarm.target_no || alarm.target_id)}</span>` : '无关联目标或无目标读取权限'] : null
  ].filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');

  openFormModal({
    title: '人工核实 · ' + esc(alarm?.alarm_no || alarm?.alarm_id || '核实事件'),
    width: '600px',
    warning: '「属实」表示已核实、待处置，不代表反制、干扰或处罚交接已执行（阶段 4 未接入）；「误报」为终态；「证据待补充」记录本次核实后可再次核实。',
    introHtml: `<dl class="kv">${intro}</dl>`,
    fields: [
      { key: 'conclusion', label: '核实结论', type: 'radio', required: true, options: [
        { value: 'CONFIRMED', label: '属实（置为“已核实，待处置”）' },
        { value: 'FALSE_POSITIVE', label: '误报（终态）' },
        { value: 'EVIDENCE_REQUIRED', label: '证据待补充（可再次核实）' }
      ] },
      { key: 'note', label: '核实说明', type: 'textarea', required: true, minRows: 4, placeholder: '必填，1–1000 字：现场确认、轨迹复核、飞手联系结果等依据' }
    ],
    initial: { conclusion: 'CONFIRMED', note: '' },
    confirmText: '提交核实结论',
    validate: m => { const n = String(m.note || '').trim(); return !n ? '核实说明为必填项' : n.length > 1000 ? `核实说明不能超过 1000 字（当前 ${n.length} 字）` : ''; },
    onSubmit: async ({ conclusion, note }) => {
      const key = pendingKeys.get(eventId);
      try {
        const result = await verifyUavEvent(eventId, { conclusion, note: String(note || '').trim(), expected_version: expectedVersion }, key);
        pendingKeys.delete(eventId);
        closeModal();
        toast(`核实完成：${uavStateText(result?.state)}（v${Number(result?.version)}）`, 'ok');
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
              ? `提交结果未确认，已刷新服务端状态：事件已更新为 v${Number(latest.version)}（${uavStateText(latest.state)}），请核对历史后重新打开核实表单。`
              : `提交结果未确认，已刷新服务端状态：当前事件为「${uavStateText(latest.state)}」，不能再次核实。`, 'err');
            return;
          }
          throw new Error(`提交结果未确认，请刷新核对：${messageOf(error, '服务端未返回明确结果')}`);
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
