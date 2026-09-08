/* 处置授权弹窗（阶段 13 契约 v1.0，决策 13-7）：申请 / 审批 / 执行 / 停止·人工结果四种形态共用一个实现，
   避免出现第二套表单和第二套幂等键逻辑。所有按钮可用性以服务端 allowed_actions 为准，前端不自算。
   反制与干扰有法律后果：授权编号、审批人、时限、执行结果一律来自服务端，页面绝不伪造，也绝不把
   “结果未知”说成成功。 */
import { openFormModal } from './formModal.js';
import { closeModal } from './modal.js';
import { toast } from './nv.js';
import { disposalApi, isDisposalUnavailable, newDisposalIdempotencyKey } from '@/services/disposalApi.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import { DISPOSAL_ACTION_LABEL, DISPOSAL_BLOCK_REASON_LABEL, DISPOSAL_CHANNEL_LABEL, DISPOSAL_STATUS_LABEL, disposalStatusText, labelOf } from '@/ui/labels.js';

export const DISPOSAL_UNAVAILABLE_TEXT = '处置授权服务尚未接入';

/* 这些 409 是服务端给出的**确定**结论（不是"可能已落库"的乐观锁冲突）：请求一定没被受理。
   把它们当"结果未知"会让人以为可能已经执行了，比报错更糟。 */
const DEFINITE_CONFLICT_CODES = new Set([
  'TWO_PERSON_RULE', 'INVALID_TRANSITION', 'AUTHORIZATION_EXPIRED',
  'DEVICE_CONTROL_UNAVAILABLE', 'DEVICE_NOT_BOUND', 'DEVICE_OFFLINE',
  'ACTIVE_AUTHORIZATION_EXISTS', 'SUBJECT_KIND_NOT_SUPPORTED',
  'TARGET_NOT_ACTIVE', 'POLICY_REQUIRES_CONFIRMED_EVENT'
]);

/* 同一授权的幂等键在“结果未知”期间保留；服务端给出明确结果后才丢弃，避免超时重试重复写授权。 */
const pendingKeys = new Map();
const keyOf = (scope, action) => {
  const id = `${action}:${scope}`;
  if (!pendingKeys.has(id)) pendingKeys.set(id, newDisposalIdempotencyKey(action));
  return { id, key: pendingKeys.get(id) };
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function time(value) {
  if (!value) return '';
  const at = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(at.getTime()) ? String(value) : at.toLocaleString('zh-CN', { hour12: false });
}
/* 错误码不上屏：每一条都译成处置人员能据以行动的话。 */
function messageOf(error, fallback) {
  if (!error) return fallback;
  if (isDisposalUnavailable(error)) return `${DISPOSAL_UNAVAILABLE_TEXT}，无法提交。`;
  if (error.status === 401) return '登录已失效，请重新登录。';
  if (error.status === 403) return '当前账号没有执行该操作的权限。';
  if (error.code === 'TWO_PERSON_RULE') return '审批人不能是申请人，请由另一位有审批权限的人处理。';
  if (error.code === 'AUTHORIZATION_EXPIRED') return '授权已超过时限，不能再执行；如仍需处置请重新申请。';
  if (error.code === 'INVALID_TRANSITION') return '该授权的当前状态不允许这一步操作，请刷新后按最新状态处理。';
  // 联调实测到的两个码：策略限制每个主体同时只能有一条未了结授权；本期主体只支持无人机事件与目标。
  if (error.code === 'ACTIVE_AUTHORIZATION_EXISTS') return '该对象已有一条未了结的同类处置授权，请先撤销或等它结束再申请。';
  if (error.code === 'SUBJECT_KIND_NOT_SUPPORTED') return '本期只能对已核实的无人机事件或目标发起处置授权。';
  if (error.code === 'DEVICE_CONTROL_UNAVAILABLE') return '该设备不支持自动执行，未下发指令；可改为登记人工执行结果。';
  // 未登记连接是可补救的配置问题，与“设备根本不支持自动执行”不是一回事，两句必须分开说。
  if (error.code === 'DEVICE_NOT_BOUND') return '设备未登记凌云连接，未下发指令；请运维补登记后重试。';
  // 离线是现场问题，与"未登记"（运维）和"不支持"（换通道）的补救方都不同（13-14）。
  if (error.code === 'DEVICE_OFFLINE') return '设备未启用或不在线，未下发指令；请现场处理后重试。';
  if (error.code === 'TARGET_NOT_ACTIVE') return '该目标最近没有观测记录，无法确认它仍在活动，不能对它派发处置。';
  if (error.code === 'POLICY_REQUIRES_CONFIRMED_EVENT') return '该动作要求事件先经人工核实，请先完成核实再申请。';
  return error.message || fallback;
}

/** 授权摘要：业务编号上屏，内部 ID 只进 title；空值整行不渲染。 */
function summaryHtml(auth, extra = []) {
  const rows = [
    ['授权编号', auth?.authorization_no ? `<span class="mono" title="${esc(auth.authorization_id)}">${esc(auth.authorization_no)}</span>` : ''],
    ['动作类型', auth?.action_type ? esc(labelOf(DISPOSAL_ACTION_LABEL, auth.action_type)) : ''],
    ['当前状态', auth?.status ? esc(disposalStatusText(auth)) : ''],
    ['执行受阻', auth?.execution_block_reason ? esc(labelOf(DISPOSAL_BLOCK_REASON_LABEL, auth.execution_block_reason)) : ''],
    ['执行通道', auth?.channel ? esc(labelOf(DISPOSAL_CHANNEL_LABEL, auth.channel)) : ''],
    ['申请人', esc(auth?.requested_by_name || auth?.requested_by || '')],
    ['审批人', esc(auth?.approved_by_name || auth?.approved_by || '')],
    ['有效至', time(auth?.valid_until)],
    ...extra
  ].filter(([, v]) => v);
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

/** 提交包装：统一处理“结果未知”——保留幂等键、回读服务端、绝不提示成功。 */
async function submit({ scope, action, call, refresh, onDone, okText }) {
  const { id, key } = keyOf(scope, action);
  try {
    const result = await call(key);
    pendingKeys.delete(id);
    closeModal();
    toast(okText(result), 'ok');
    if (refresh) await refresh(result);
    if (onDone) onDone(result);
  } catch (error) {
    if (DEFINITE_CONFLICT_CODES.has(error?.code)) {
      // 确定失败：换新键（下次是新请求），但仍回读一次详情——执行被阻的具体原因在 DTO 的
      // execution_block_reason 上，错误码只说"不支持自动执行"，两者合起来才是完整事实。
      pendingKeys.delete(id);
      if (refresh) { try { await refresh(null); } catch { /* 回读失败不掩盖原始错误 */ } }
      throw new Error(messageOf(error, '提交失败'));
    }
    if (isUncertainOutcome(error)) {
      // 409 / 超时 / 断网：服务端可能已经落库。保留原键，先回读核对，不换键重试、不提示成功。
      const latest = refresh ? await refresh(null) : null;
      if (latest?.status) {
        pendingKeys.delete(id);
        closeModal();
        toast(`提交结果未确认，已重新读取：当前为「${disposalStatusText(latest)}」，请核对处置经过后再决定下一步。`, 'err');
        return;
      }
      throw new Error(`提交结果未确认，请刷新核对：${messageOf(error, '没有收到明确结果')}`);
    }
    pendingKeys.delete(id);
    throw new Error(messageOf(error, '提交失败'));
  }
}

/**
 * 申请授权。
 * @param {object} o
 * @param {'COUNTERMEASURE'|'JAMMING'|'DISPERSAL'|'DECOY'} o.actionType 默认动作类型
 * @param {string[]} [o.actionOptions] 可选动作类型；给两个及以上时弹窗内选（决策 13-19：干扰与反制共用入口）
 * @param {'UAV_EVENT'|'RISK'|'TARGET'} o.subjectKind
 * @param {string} o.subjectId
 * @param {string} [o.subjectText] 主体的可读说明（编号/名称），只读展示
 * @param {object} [o.policy] GET /disposal-policies 的结果，用于显示时限与 DEMO 标注
 */
export function openDisposalRequest({ actionType, actionOptions, subjectKind, subjectId, subjectText, policy, refresh, onDone } = {}) {
  if (!actionType || !subjectKind || !subjectId) { toast('缺少处置对象，无法发起申请', 'err'); return false; }
  const choices = (actionOptions || []).filter(Boolean);
  const pickable = choices.length > 1;
  /* GET /disposal-policies 实际返回的是策略数组，参数在 params 下、DEMO 标记是 schema_status；
     这里一并兼容扁平形状，避免接口小改动就把时限提示悄悄变没。 */
  const current = Array.isArray(policy) ? policy[0] : policy;
  const params = current?.params || current || {};
  const demo = (current?.schema_status || current?.param_status) === 'DEMO' || current?.policy_code === 'demo-v1' || current?.policy_version === 'demo-v1';
  const limits = params.time_limit_min || {};
  // 可选动作时把各自时限并列写出：表单是静态的，选哪个就临时改一行提示会让人误以为它随选择实时变化。
  const limitText = pickable
    ? choices.map(a => (limits[a] ? `${labelOf(DISPOSAL_ACTION_LABEL, a)} ${limits[a]} 分钟` : null)).filter(Boolean).join(' · ')
    : (limits[actionType] ? `${limits[actionType]} 分钟` : '');
  const intro = [
    pickable ? null : ['动作类型', esc(labelOf(DISPOSAL_ACTION_LABEL, actionType))],
    ['处置对象', esc(subjectText || subjectId)],
    limitText ? ['批准后有效时长', esc(limitText)] : null
  ].filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');

  openFormModal({
    title: pickable ? '发起处置申请' : `发起${labelOf(DISPOSAL_ACTION_LABEL, actionType)}申请`,
    width: '600px',
    warning: '提交后进入待审批：审批人必须是另一个人，批准后才可执行。'
      + (demo ? '当前为演示策略，时限与条件待业务确认。' : ''),
    introHtml: `<dl class="kv">${intro}</dl>`,
    fields: [
      ...(pickable ? [{ key: 'action_type', label: '动作类型', type: 'radio', required: true,
        options: choices.map(a => ({ value: a, label: labelOf(DISPOSAL_ACTION_LABEL, a) })) }] : []),
      { key: 'channel', label: '执行通道', type: 'radio', required: true, options: [
        { value: 'LINGYUN_B', label: '凌云协议 B 设备（批准后可自动执行）' },
        { value: 'COUNTERMEASURE_4CH', label: '四通道反制设备（本期不支持自动执行，只能登记人工结果）' },
        { value: 'MANUAL', label: '人工执行（现场处置后登记结果）' }
      ] },
      { key: 'device_id', label: '执行设备', placeholder: '经设备执行时必填：设备编号；人工执行可留空' },
      { key: 'reason', label: '申请事由', type: 'textarea', required: true, minRows: 3, placeholder: '必填：为什么需要这次处置（现场情况、已采取的措施、影响范围）' }
    ],
    initial: { action_type: actionType, channel: 'LINGYUN_B', device_id: '', reason: '' },
    confirmText: '提交申请',
    danger: true,
    validate: m => {
      if (!String(m.reason || '').trim()) return '申请事由为必填项';
      // 服务端要求：经设备执行的处置必须指定设备。这里先拦，免得填完事由才被打回。
      if (m.channel !== 'MANUAL' && !String(m.device_id || '').trim()) return '经设备执行的处置必须指定执行设备';
      return null;
    },
    onSubmit: ({ action_type: chosen, channel, device_id: deviceId, reason }) => submit({
      scope: `${subjectKind}:${subjectId}:${chosen || actionType}`,
      action: 'request',
      call: key => disposalApi.create({
        action_type: chosen || actionType, subject_kind: subjectKind, subject_id: subjectId,
        channel, device_id: String(deviceId || '').trim() || undefined, reason: String(reason).trim()
      }, key),
      refresh,
      onDone,
      okText: result => `申请已提交：${result?.authorization_no || ''} 待审批`
    })
  });
  return true;
}

/** 审批（批准 / 驳回）。 */
export function openDisposalApproval({ authorization, refresh, onDone } = {}) {
  const auth = authorization;
  if (!auth?.authorization_id) { toast('缺少授权记录', 'err'); return false; }
  const allowed = auth.allowed_actions || [];
  if (!allowed.includes('APPROVE') && !allowed.includes('REJECT')) { toast('当前授权不可审批或缺少审批权限', 'err'); return false; }
  openFormModal({
    title: `审批 · ${auth.authorization_no || '处置授权'}`,
    width: '600px',
    warning: '批准后授权在时限内有效，超时需要重新申请；审批人不能是申请人。',
    introHtml: summaryHtml(auth, [['申请事由', esc(auth.reason || '')]]),
    fields: [
      { key: 'decision', label: '审批结论', type: 'radio', required: true, options: [
        { value: 'APPROVE', label: '批准' }, { value: 'REJECT', label: '驳回' }
      ] },
      { key: 'note', label: '审批意见', type: 'textarea', minRows: 3, placeholder: '驳回时必填；批准时可写明限制条件' }
    ],
    initial: { decision: 'APPROVE', note: '' },
    confirmText: '提交审批',
    validate: m => (m.decision === 'REJECT' && !String(m.note || '').trim() ? '驳回时必须填写审批意见' : null),
    onSubmit: ({ decision, note }) => submit({
      scope: auth.authorization_id,
      action: decision === 'APPROVE' ? 'approve' : 'reject',
      call: key => {
        const body = { expected_version: Number(auth.version), note: String(note || '').trim() || undefined };
        return decision === 'APPROVE' ? disposalApi.approve(auth.authorization_id, body, key) : disposalApi.reject(auth.authorization_id, body, key);
      },
      refresh,
      onDone,
      okText: result => `审批完成：${disposalStatusText(result)}`
    })
  });
  return true;
}

/** 执行：凌云 B 下发指令；四通道设备本期没有执行能力，只能登记人工结果。 */
export function openDisposalExecution({ authorization, refresh, onDone } = {}) {
  const auth = authorization;
  if (!auth?.authorization_id) { toast('缺少授权记录', 'err'); return false; }
  const manualOnly = auth.channel !== 'LINGYUN_B';
  if (manualOnly) return openDisposalManualResult({ authorization: auth, refresh, onDone });
  openFormModal({
    title: `执行 · ${auth.authorization_no || '处置授权'}`,
    width: '560px',
    warning: '下发后以设备回执为准：回执成功才算完成，超时或失败会如实标为执行失败。',
    introHtml: summaryHtml(auth),
    fields: [{ key: 'note', label: '执行备注', placeholder: '选填：下发参数说明' }],
    initial: { note: '' },
    confirmText: '下发执行',
    danger: true,
    onSubmit: ({ note }) => submit({
      scope: auth.authorization_id,
      action: 'execute',
      call: key => disposalApi.execute(auth.authorization_id, {
        expected_version: Number(auth.version),
        operation_params: String(note || '').trim() ? { note: String(note).trim() } : undefined
      }, key),
      refresh,
      onDone,
      /* 执行被阻（本期凌云四种处置码都还没开放）既不是成功也不是失败：如实说明并指向人工结果。 */
      okText: result => (result?.execution_block_reason
        ? `未下发：${labelOf(DISPOSAL_BLOCK_REASON_LABEL, result.execution_block_reason)}`
        : `已下发，等待设备回执：${disposalStatusText(result)}`)
    })
  });
  return true;
}

/** 人工结果：仅人工/无自动执行能力的通道。 */
export function openDisposalManualResult({ authorization, refresh, onDone } = {}) {
  const auth = authorization;
  if (!auth?.authorization_id) { toast('缺少授权记录', 'err'); return false; }
  openFormModal({
    title: `登记执行结果 · ${auth.authorization_no || '处置授权'}`,
    width: '600px',
    warning: auth.channel === 'COUNTERMEASURE_4CH'
      ? '四通道反制设备本期不支持自动执行，请在现场处置后如实登记结果。'
      : '人工执行：请在现场处置后如实登记结果。',
    introHtml: summaryHtml(auth),
    fields: [
      { key: 'result', label: '执行结果', type: 'radio', required: true, options: [
        { value: 'SUCCEEDED', label: '执行成功' }, { value: 'FAILED', label: '执行失败' }
      ] },
      { key: 'detail', label: '结果说明', type: 'textarea', required: true, minRows: 3, placeholder: '必填：现场处置经过与结果' }
    ],
    initial: { result: 'SUCCEEDED', detail: '' },
    confirmText: '登记结果',
    validate: m => (String(m.detail || '').trim() ? null : '结果说明为必填项'),
    onSubmit: ({ result, detail }) => submit({
      scope: auth.authorization_id,
      action: 'manual-result',
      call: key => disposalApi.manualResult(auth.authorization_id, {
        expected_version: Number(auth.version), result, detail: String(detail).trim()
      }, key),
      refresh,
      onDone,
      okText: r => `已登记：${disposalStatusText(r)}`
    })
  });
  return true;
}

/** 停止：撤销授权并尝试设备急停；急停不可用不阻塞撤销（决策 13-4）。 */
export function openDisposalStop({ authorization, refresh, onDone } = {}) {
  const auth = authorization;
  if (!auth?.authorization_id) { toast('缺少授权记录', 'err'); return false; }
  openFormModal({
    title: `停止 · ${auth.authorization_no || '处置授权'}`,
    width: '560px',
    warning: '停止会立即撤销授权，并尝试让设备急停；设备不支持急停时授权仍然停止，事件流会记下这一点。',
    introHtml: summaryHtml(auth),
    fields: [{ key: 'note', label: '停止原因', type: 'textarea', required: true, minRows: 3, placeholder: '必填：为什么现在停止' }],
    initial: { note: '' },
    confirmText: '停止处置',
    danger: true,
    validate: m => (String(m.note || '').trim() ? null : '停止原因为必填项'),
    onSubmit: ({ note }) => submit({
      scope: auth.authorization_id,
      action: 'stop',
      call: key => disposalApi.stop(auth.authorization_id, { expected_version: Number(auth.version), note: String(note).trim() }, key),
      refresh,
      onDone,
      okText: result => `${disposalStatusText(result)}`
    })
  });
  return true;
}
