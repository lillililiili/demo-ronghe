/* 处置授权弹窗（阶段 13 契约 v1.0，决策 13-7）：申请 / 审批 / 执行 / 停止·人工结果四种形态共用一个实现，
   避免出现第二套表单和第二套幂等键逻辑。所有按钮可用性以服务端 allowed_actions 为准，前端不自算。
   反制与干扰有法律后果：授权编号、审批人、时限、执行结果一律来自服务端，页面绝不伪造，也绝不把
   “结果未知”说成成功。 */
import { openFormModal } from './formModal.js';
import { closeModal } from './modal.js';
import { toast } from './nv.js';
import { displayDeviceNo } from './deviceNumber.js';
import { disposalApi, isDisposalUnavailable, newDisposalIdempotencyKey } from '@/services/disposalApi.js';
import { deviceApi } from '@/services/deviceApi.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import { DISPOSAL_ACTION_LABEL, DISPOSAL_BLOCK_REASON_LABEL, DISPOSAL_CHANNEL_LABEL, DISPOSAL_STATUS_LABEL, disposalStatusText, labelOf } from '@/ui/labels.js';

export const DISPOSAL_UNAVAILABLE_TEXT = '处置授权功能暂不可用';

/* 这些 409 是服务端给出的**确定**结论（不是"可能已落库"的乐观锁冲突）：请求一定没被受理。
   把它们当"结果未知"会让人以为可能已经执行了，比报错更糟。 */
const DEFINITE_CONFLICT_CODES = new Set([
  'TWO_PERSON_RULE', 'INVALID_TRANSITION', 'AUTHORIZATION_EXPIRED',
  'EMERGENCY_STOP_UNCONFIRMED', 'ADVISORY_COUNTER_BLOCKED',
  'DEVICE_CONTROL_UNAVAILABLE', 'DEVICE_NOT_BOUND', 'DEVICE_OFFLINE', 'DEVICE_NOT_OPERABLE', 'DEVICE_BUSY',
  'ACTIVE_AUTHORIZATION_EXISTS', 'SUBJECT_KIND_NOT_SUPPORTED',
  'TARGET_NOT_ACTIVE', 'POLICY_REQUIRES_CONFIRMED_EVENT', 'DEVICE_UNAVAILABLE'
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
  // 401 在受理前就被拒绝：这次没有保存，弹窗和已选内容保留，重新登录后再提交（ZT-29）。
  if (error.status === 401) return '登录已过期，这次提交没有保存。重新登录后请再提交一次。';
  if (error.status === 403) return '当前账号没有执行该操作的权限。';
  if (error.code === 'TWO_PERSON_RULE') return '审批人不能是申请人，请由另一位有审批权限的人处理。';
  if (error.code === 'AUTHORIZATION_EXPIRED') return '授权已超过时限，不能再执行；如仍需处置请重新申请。';
  if (error.code === 'INVALID_TRANSITION') return '该授权的当前状态不允许这一步操作，请刷新后按最新状态处理。';
  // 联调实测到的两个码：策略限制每个主体同时只能有一条未了结授权；本期主体只支持无人机事件与目标。
  if (error.code === 'ACTIVE_AUTHORIZATION_EXISTS') return '这个对象已有一条还没了结的同类处置授权（待审批、已批准还没执行，或正在执行）。如果那条已经用不上，请到「反制办理」里撤回或撤销它，再重新申请。';
  if (error.code === 'SUBJECT_KIND_NOT_SUPPORTED') return '本期只能对已核实的无人机事件或目标发起处置授权。';
  if (error.code === 'DEVICE_CONTROL_UNAVAILABLE') return '该设备不支持所需反制动作，未下发指令；请检查设备能力与接入配置。';
  // 未登记连接是可补救的配置问题，与“设备根本不支持自动执行”不是一回事，两句必须分开说。
  if (error.code === 'DEVICE_NOT_BOUND') return '设备未登记凌云连接，未下发指令；请运维补登记后重试。';
  // 申请时就挡下的坏设备：服务端的话已经写明是停用、离线、异常、状态不明还是故障。
  if (error.code === 'DEVICE_UNAVAILABLE') return error.message || '所选设备现在不能用（停用、离线、故障或状态不明），请换一台设备再申请。';
  // 离线是现场问题，与"未登记"（运维）和"不支持"（换通道）的补救方都不同（13-14）。
  if (error.code === 'DEVICE_OFFLINE') return '本次没有下发。设备未启用，或当前不在线。没有心跳的设备不能执行，请改选正在上报的设备后重新申请。';
  if (error.code === 'DEVICE_BUSY') return '本次没有下发。设备仍有未完成的指令或调测任务，请等待任务结束后重试。';
  if (error.code === 'DEVICE_NOT_OPERABLE') return `本次没有下发。${error.message || '设备当前不可执行，请检查启用、在线和故障状态。'}`;
  // 急停没核查完时拦的是这起事件（或这台设备上那次急停），换设备没用（新-20 / 确认书 3-9）。
  if (error.code === 'EMERGENCY_STOP_UNCONFIRMED') return '本次没有下发。上次急停还没确认设备已停，请先确认：在急停记录里“登记现场停机核查”后，再申请或执行反制。';
  if (error.code === 'ADVISORY_COUNTER_BLOCKED') return `本次没有下发。${error.message || '当前观测或违规研判已失效。'}`;
  if (error.code === 'TARGET_NOT_ACTIVE') return '最近没有监测到这个目标，无法确认它还在现场，暂时不能下发处置指令。';
  // 服务端会说清真实原因（证据不足、类别不是无人机、告警还没核实……），不再一律说成“先核实”。
  if (error.code === 'POLICY_REQUIRES_CONFIRMED_EVENT') return error.message || '该动作要求事件先经人工核实，请先完成核实再申请。';
  return error.message || fallback;
}

/** 授权摘要：业务编号上屏，内部 ID 只进 title；空值整行不渲染。 */
function summaryHtml(auth, extra = []) {
  const direct = auth?.authorization_mode === 'DIRECT';
  const status = auth?.status ? disposalStatusText(auth) : '';
  const rows = [
    ['授权编号', auth?.authorization_no ? `<span class="mono" title="${esc(auth.authorization_id)}">${esc(auth.authorization_no)}</span>` : ''],
    ['动作类型', auth?.action_type ? esc(labelOf(DISPOSAL_ACTION_LABEL, auth.action_type)) : ''],
    ['授权方式', direct ? '免逐次审批' : auth?.authorization_mode === 'REVIEW' ? '申请审批' : ''],
    ['当前状态', esc(status)],
    ['执行受阻', auth?.execution_block_reason ? esc(labelOf(DISPOSAL_BLOCK_REASON_LABEL, auth.execution_block_reason)) : ''],
    ['执行通道', auth?.channel ? esc(labelOf(DISPOSAL_CHANNEL_LABEL, auth.channel)) : ''],
    [direct ? '直接操作人' : '申请人', esc(auth?.requested_by_name || auth?.requested_by || '')],
    ['审批人', direct ? '不适用（免逐次审批）' : esc(auth?.approved_by_name || auth?.approved_by || '')],
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
      let latest = null;
      if (refresh) { try { latest = await refresh(null); } catch { /* 回读失败不掩盖原始错误 */ } }
      // 资格检查可能先于状态检查失败，不能从错误码推断授权仍然有效。
      if (action === 'execute' && latest?.status && latest.status !== 'APPROVED') {
        closeModal();
        toast(`本次没有下发。已重新读取授权：当前为「${disposalStatusText(latest)}」，请按最新状态处理。`, 'err');
        return;
      }
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
 * 设备为什么现在不能拿来申请处置；能用时返回空串（BUG-03 / ZT-18）。
 * 与服务端申请时的 DEVICE_UNAVAILABLE 同一口径：停用、离线、上报工作异常、状态不明、上报故障。
 * 设备忙不算：那是一时的，批准后执行时服务端还会再查。
 */
export function deviceUnavailableReason(device) {
  if (!device) return '找不到这台设备';
  if (device.enabled === false) return '设备已停用';
  if (device.connectivity === 'OFFLINE') return '设备离线';
  if (device.connectivity === 'ABNORMAL') return '设备上报工作异常（故障）';
  if (device.connectivity !== 'ONLINE') return '设备状态不明（没有上报状态）';
  if (device.health_code === 'BAD') return '设备上报故障';
  return '';
}

function deviceOptionLabel(device) {
  const title = [displayDeviceNo(device.device_no), device.name].filter(Boolean).join(' · ') || '未命名设备';
  const why = deviceUnavailableReason(device);
  const bits = [device.device_type_name, why ? `不能选：${why}` : ''].filter(Boolean);
  return bits.length ? `${title}（${bits.join(' · ')}）` : title;
}

/** 执行设备下拉：能用的在前；不能用的置灰、写明原因，不能选。 */
export function deviceOptions(devices, channel) {
  return devicesForChannel(devices, channel)
    .map(device => ({ value: device.device_id, label: deviceOptionLabel(device), disabled: !!deviceUnavailableReason(device) }))
    .sort((a, b) => Number(a.disabled) - Number(b.disabled));
}

const CHANNEL_DEVICE_TYPE = {
  LINGYUN_B: 'ifr',
  COUNTERMEASURE_4CH: 'countermeasure'
};

function devicesForChannel(devices, channel) {
  const type = CHANNEL_DEVICE_TYPE[channel];
  return (devices || []).filter(device => device.device_id && device.device_type_code === type);
}

async function loadEnabledDevices() {
  const page = await deviceApi.list({ page: 1, size: 200, enabled: true, sort: 'device_no_asc' });
  return (page?.items || []).filter(device => device.device_id);
}

/**
 * 申请授权。
 * @param {object} o
 * @param {'COUNTERMEASURE'|'JAMMING'|'DISPERSAL'|'DECOY'} o.actionType 默认动作类型
 * @param {string[]} [o.actionOptions] 可选动作类型；给两个及以上时弹窗内选（决策 13-19：干扰与反制共用入口）
 * @param {'UAV_EVENT'|'RISK'|'TARGET'} o.subjectKind
 * @param {string} o.subjectId
 * @param {string} [o.subjectText] 主体的可读说明（编号/名称），只读展示
 * @param {string} [o.initialReason] 申请事由草稿，提交前由用户核对
 * @param {() => boolean} [o.isCurrent] 所属事件及页面是否仍有效，阻止迟到表单串到其他事件
 * @param {object} [o.policy] GET /disposal-policies 的结果，用于显示时限与 DEMO 标注
 * @param {(body: object, key: string) => Promise<object>} [o.submit] 自定义提交；融合感知模拟源用来复用同一弹窗但不打真实授权接口
 * @param {(result: object) => string} [o.okText] 成功提示；缺省为“申请已提交，待审批”
 */
export function openDisposalRequest({ actionType, actionOptions, subjectKind, subjectId, subjectText, initialReason = '', isCurrent = () => true, policy, refresh, onDone, submit: customSubmit, okText } = {}) {
  if (!actionType || !subjectKind || !subjectId) { toast('缺少处置对象，无法发起申请', 'err'); return false; }
  return showDisposalRequestForm({ actionType, actionOptions, subjectKind, subjectId, subjectText, initialReason, isCurrent, policy, refresh, onDone, customSubmit, okText, direct: false });
}

/** 免逐次审批直接处置。资格与业务前置条件仍由 direct-execute 在服务端重新校验。 */
export function openDisposalDirect({ actionType, subjectKind, subjectId, subjectText, initialReason = '', isCurrent = () => true, policy, refresh, onDone } = {}) {
  if (!actionType || !subjectKind || !subjectId) { toast('缺少处置对象，无法直接反制', 'err'); return false; }
  return showDisposalRequestForm({ actionType, subjectKind, subjectId, subjectText, initialReason, isCurrent, policy, refresh, onDone, direct: true });
}

async function showDisposalRequestForm({ actionType, actionOptions, subjectKind, subjectId, subjectText, initialReason, isCurrent, policy, refresh, onDone, customSubmit, okText, direct = false }) {
  const choices = (actionOptions || []).filter(Boolean);
  const pickable = choices.length > 1;
  let devices = [];
  let deviceHelp = '只显示当前执行通道可以下发的设备；停用、离线、故障或状态不明的设备置灰不能选，括号里写明原因。';
  try {
    devices = await loadEnabledDevices();
    if (!devices.length) deviceHelp = '没有启用中的设备，请联系运维接入设备后再申请。';
  } catch (error) {
    deviceHelp = error?.status === 403
      ? '当前账号没有设备台账读取权限，无法选择执行设备。'
      : (error?.message || '读取执行设备失败，请稍后重试。');
  }
  if (!isCurrent()) return false;
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
    limitText ? [direct ? '授权有效时长' : '批准后有效时长', esc(limitText)] : null
  ].filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');

  openFormModal({
    title: direct ? `直接${labelOf(DISPOSAL_ACTION_LABEL, actionType)}` : pickable ? '发起处置申请' : `发起${labelOf(DISPOSAL_ACTION_LABEL, actionType)}申请`,
    width: '600px',
    warning: (direct
      ? '本次使用免逐次审批权限。服务端仍会核对目标、范围、时效、设备操作权限和急停状态；提交后以设备回执为准。'
      : '提交后进入待审批：审批人必须是另一个人，批准后才可执行。')
      + ((pickable && choices.includes('COUNTERMEASURE')) || actionType === 'COUNTERMEASURE'
        ? '选择联动反制时，执行完成后会自动接着发起信号干扰：沿用这次授权，不再二次审批，有效期不超过这次授权。' : '')
      + (demo ? '当前为演示策略，时限与条件待业务确认。' : ''),
    introHtml: `<dl class="kv">${intro}</dl>`,
    notice: initialReason ? '已带入申请事由草稿，请依据当前观测与研判核对。' : '',
    fields: [
      ...(pickable ? [{ key: 'action_type', label: '动作类型', type: 'radio', required: true,
        options: choices.map(a => ({ value: a, label: labelOf(DISPOSAL_ACTION_LABEL, a) })) }] : []),
      { key: 'channel', label: '执行通道', type: 'radio', required: true, options: [
        { value: 'LINGYUN_B', label: direct ? '凌云协议 B 设备（提交后由服务端直接下发）' : '凌云协议 B 设备（批准后可自动执行）' },
        { value: 'COUNTERMEASURE_4CH', label: '四通道反制设备（经网络控制器下发，回执以设备为准）' }
      ] },
      { key: 'device_id', label: '执行设备', type: 'select', clearable: true, filterable: true,
        placeholder: '请选择执行设备',
        options: model => deviceOptions(devices, model.channel),
        help: deviceHelp, required: true },
      { key: 'reason', label: direct ? '直接反制事由' : '申请事由', type: 'textarea', required: true, minRows: 3, placeholder: '2–500 字：依据当前观测与研判，说明本次处置事由' }
    ],
    initial: { action_type: actionType, channel: 'LINGYUN_B', device_id: null, reason: initialReason },
    confirmText: direct ? '确认直接反制' : '提交申请',
    danger: true,
    validate: m => {
      if (!isCurrent()) return '事件已切换，请关闭后从当前事件重新申请';
      const reason = String(m.reason || '').trim();
      if (reason.length < 2 || reason.length > 500) return `申请事由需为 2–500 字，当前 ${reason.length} 字；请核对并调整。`;
      // 服务端要求：经设备执行的处置必须指定设备。这里先拦，免得填完事由才被打回。
      if (!['LINGYUN_B', 'COUNTERMEASURE_4CH'].includes(m.channel)) return '仅支持设备执行';
      const matched = devicesForChannel(devices, m.channel);
      if (!matched.length) return '当前执行通道没有可下发的设备';
      if (matched.every(device => deviceUnavailableReason(device))) return '这个执行通道的设备现在都不能用（停用、离线、故障或状态不明），请换一个执行通道，或等设备恢复后再申请。';
      const chosen = matched.find(device => device.device_id === m.device_id);
      if (!chosen) return '执行设备与所选通道不一致，请重新选择';
      const why = deviceUnavailableReason(chosen);
      if (why) return `所选设备不能用：${why}。请换一台设备。`;
      return null;
    },
    onSubmit: ({ action_type: chosen, channel, device_id: deviceId, reason }) => submit({
      scope: `${subjectKind}:${subjectId}:${chosen || actionType}`,
      action: direct ? 'direct' : 'request',
      call: key => {
        if (!isCurrent()) throw new Error('事件已切换，请关闭后从当前事件重新申请');
        const body = {
          action_type: chosen || actionType, subject_kind: subjectKind, subject_id: subjectId,
          channel, device_id: String(deviceId || '').trim(),
          reason: String(reason).trim()
        };
        return customSubmit ? customSubmit(body, key) : direct ? disposalApi.directExecute(body, key) : disposalApi.create(body, key);
      },
      refresh,
      onDone,
      okText: okText || (result => direct
        ? result?.execution_block_reason
            ? `免逐次审批授权已创建：${result?.authorization_no || ''}，执行受阻，请查看授权记录。`
            : `直接反制已受理：${result?.authorization_no || ''}，正在等待设备回执。`
        : `申请已提交：${result?.authorization_no || ''} 待审批`)
    })
  });
  return true;
}

/** 审批（批准 / 驳回）。 */
export function openDisposalApproval({ authorization, refresh, onDone } = {}) {
  const auth = authorization;
  if (!auth?.authorization_id) { toast('缺少授权记录', 'err'); return false; }
  if (!['LINGYUN_B', 'COUNTERMEASURE_4CH'].includes(auth.channel)) { toast('仅支持设备反制；旧人工执行记录只供查阅', 'err'); return false; }
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

/** 执行：仅凌云 B 或四通道网络控制器下发，结果来自设备回执。 */
export function openDisposalExecution({ authorization, refresh, onDone } = {}) {
  const auth = authorization;
  if (!auth?.authorization_id) { toast('缺少授权记录', 'err'); return false; }
  const autoDevice = auth.channel === 'LINGYUN_B' || auth.channel === 'COUNTERMEASURE_4CH';
  if (!autoDevice) { toast('仅支持设备执行；旧人工执行记录只供查阅', 'err'); return false; }
  openFormModal({
    title: `执行 · ${auth.authorization_no || '处置授权'}`,
    width: '560px',
    warning: auth.channel === 'COUNTERMEASURE_4CH'
      ? '经四通道网络控制器下发，回执以设备为准。停止时下发全关，不是急停。'
      : '下发后以设备回执为准：回执成功才算完成，超时或失败会如实标为执行失败。',
    introHtml: summaryHtml(auth),
    fields: [],
    initial: {},
    confirmText: '下发执行',
    danger: true,
    onSubmit: () => submit({
      scope: auth.authorization_id,
      action: 'execute',
      call: key => disposalApi.execute(auth.authorization_id, {
        expected_version: Number(auth.version)
      }, key),
      refresh,
      onDone,
      /* 执行被阻（本期凌云四种处置码都还没开放）既不是成功也不是失败：如实说明设备受阻原因。 */
      okText: result => (result?.execution_block_reason
        ? `未下发：${labelOf(DISPOSAL_BLOCK_REASON_LABEL, result.execution_block_reason)}`
        : `已下发，等待设备回执：${disposalStatusText(result)}`)
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

/** 撤回待审批的申请，或撤销已批准还没执行的授权（BUG-03）：撤销后同一对象可以重新申请。 */
export function openDisposalCancel({ authorization, refresh, onDone } = {}) {
  const auth = authorization;
  if (!auth?.authorization_id) { toast('缺少授权记录', 'err'); return false; }
  if (!['REQUESTED', 'APPROVED'].includes(auth.status) || !(auth.allowed_actions || []).includes('CANCEL')) {
    toast('这条授权现在不能撤销，或当前账号没有撤销权限', 'err');
    return false;
  }
  const approved = auth.status === 'APPROVED';
  openFormModal({
    title: `${approved ? '撤销授权' : '撤回申请'} · ${auth.authorization_no || '处置授权'}`,
    width: '560px',
    warning: approved
      ? '这条授权已批准，但还没有下发到设备。撤销后它就作废，不能再执行；同一对象可以马上重新申请。'
      : '撤回后这条申请作废，不再等待审批；需要时可以重新申请。',
    introHtml: summaryHtml(auth),
    fields: [{ key: 'note', label: approved ? '撤销原因' : '撤回原因', type: 'textarea', minRows: 3, placeholder: '选填：例如设备离线，改用其他设备重新申请' }],
    initial: { note: '' },
    confirmText: approved ? '撤销授权' : '撤回申请',
    danger: true,
    validate: m => (String(m.note || '').trim().length > 500 ? '原因不超过 500 字' : null),
    onSubmit: ({ note }) => submit({
      scope: auth.authorization_id,
      action: 'cancel',
      call: key => disposalApi.cancel(auth.authorization_id, {
        expected_version: Number(auth.version),
        note: String(note || '').trim() || undefined
      }, key),
      refresh,
      onDone,
      okText: result => `${approved ? '授权已撤销' : '申请已撤回'}，当前为「${disposalStatusText(result)}」。`
    })
  });
  return true;
}
