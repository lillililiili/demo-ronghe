/* 飞行计划风险人工核验弹窗：飞行计划页“全部风险事件”与工作台共用同一实现。
   只调用 riskApi.verifyRisk；不再读取 window.MOCK，也不产生第二套状态机。 */
import { openFormModal } from './formModal.js';
import { closeModal } from './modal.js';
import { toast } from './nv.js';
import { riskApi, newRiskIdempotencyKey } from '@/services/riskApi.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import { RISK_TYPE_LABEL, labelOf, readableNo } from '@/ui/labels.js';

export const RISK_STATE_TEXT = {
  PENDING_VERIFICATION: '待核验',
  PENDING_NOTIFICATION: '待通知',
  NOTIFIED: '已通知',
  EXCLUDED: '已排除'
};
export const riskStateText = code => RISK_STATE_TEXT[code] || (code ? String(code) : '—');

/* 同一风险的幂等键在“结果未知”期间保留；只有服务端给出明确结果后才丢弃。 */
const pendingKeys = new Map();

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function messageOf(error, fallback) {
  if (!error) return fallback;
  if (error.status === 401) return '登录已失效，请重新登录。';
  if (error.status === 403) return '当前账号没有核验此风险的权限。';
  return error.message || fallback;
}

/**
 * @param {object} o
 * @param {object} o.risk 服务端风险对象（含 risk_id/version/allowed_actions）
 * @param {(result:object|null)=>Promise<object|null>} [o.refresh] 成功或结果未知时回读当前风险，返回最新对象
 * @param {(result:object)=>void} [o.onDone] 明确成功后的回调
 */
export function openRiskVerification({ risk, refresh, onDone } = {}) {
  if (!risk) return false;
  if (!(risk.allowed_actions || []).includes('VERIFY')) { toast('当前风险不可核验或缺少核验权限', 'err'); return false; }
  const riskId = risk.risk_id;
  const expectedVersion = Number(risk.version);
  if (!pendingKeys.has(riskId)) pendingKeys.set(riskId, newRiskIdempotencyKey());

  openFormModal({
    title: '人工核验',
    width: '560px',
    notice: [risk.risk_no || readableNo(risk.source_risk_id) ? `风险 ${risk.risk_no || readableNo(risk.source_risk_id)}` : '风险事件', labelOf(RISK_TYPE_LABEL, risk.risk_type, '')].filter(Boolean).join(' · '),
    fields: [
      { key: 'conclusion', label: '核验结论', type: 'radio', required: true, options: [
        { value: 'CONFIRMED', label: '核验通过（转待通知）' },
        { value: 'EXCLUDED', label: '排除（误检 / 非管控风险）' }
      ] },
      { key: 'note', label: '核验说明', type: 'textarea', required: true, minRows: 4, placeholder: '填写现场确认、航线与高度复核等依据（1–1000 字）' }
    ],
    initial: { conclusion: 'CONFIRMED', note: '' },
    confirmText: '提交核验结论',
    validate: m => { const n = String(m.note || '').trim(); return !n ? '核验说明为必填项' : n.length > 1000 ? `核验说明不能超过 1000 字（当前 ${n.length} 字）` : ''; },
    onSubmit: async ({ conclusion, note }) => {
      const key = pendingKeys.get(riskId);
      try {
        const result = await riskApi.verifyRisk(riskId, { conclusion, note: String(note || '').trim(), expected_version: expectedVersion }, key);
        pendingKeys.delete(riskId);
        closeModal();
        toast(`核验结论已提交：${riskStateText(result?.state)}`, 'ok');
        if (refresh) await refresh(result);
        if (onDone) onDone(result);
      } catch (error) {
        if (isUncertainOutcome(error)) {
          // 409 / 超时 / 断网：服务端可能已落库。保留原键，先回读详情核对，不自动换键重试、不提示成功。
          const latest = refresh ? await refresh(null) : null;
          if (latest && (Number(latest.version) !== expectedVersion || !(latest.allowed_actions || []).includes('VERIFY'))) {
            pendingKeys.delete(riskId);
            closeModal();
            // 版本变化与终态要分开说明：前者仍可重新打开表单核验，后者不能再核验。
            const stillVerifiable = (latest.allowed_actions || []).includes('VERIFY');
            toast(stillVerifiable
              ? `提交结果未确认，已刷新当前状态：${riskStateText(latest.state)}，请核对后重新打开核验表单。`
              : `提交结果未确认，已刷新当前状态：当前风险为「${riskStateText(latest.state)}」，不能再次核验。`, 'err');
            return;
          }
          throw new Error(`提交结果未确认，请刷新核对：${messageOf(error, '未返回明确结果')}`);
        }
        pendingKeys.delete(riskId);
        pendingKeys.set(riskId, newRiskIdempotencyKey());
        throw new Error(messageOf(error, '风险核验失败'));
      }
    }
  });
  return true;
}
