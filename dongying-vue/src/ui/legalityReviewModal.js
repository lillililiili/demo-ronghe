/* 合法性研判动作弹窗：人工复核（确认/驳回/改判）、重新研判（确认框）、转告警（说明框）。
   与 uavVerificationModal 同一范式：幂等键在“结果未知”期间保留，只有服务端给出明确结果后才丢弃；
   只调用 legalityApi，不写 window.MOCK/window.EVT，结论以服务端回读为准。 */
import { openFormModal } from './formModal.js';
import { openConfirm } from './confirm.js';
import { closeModal, openModal } from './modal.js';
import { toast } from './nv.js';
import { legalityApi } from '@/services/legalityApi.js';
import { isUncertainOutcome } from '@/services/apiClient.js';

export const LEGAL_STATUS_TEXT = {
  LEGAL: '合法', ABNORMAL: '异常', ILLEGAL: '非法', UNDETERMINED: '不可判定', NOT_APPLICABLE: '不适用'
};
export const REVIEW_STATE_TEXT = {
  PENDING_REVIEW: '待人工复核', CONFIRMED: '已确认', REJECTED: '已驳回', OVERRIDDEN: '已改判', SUPERSEDED: '已被重算取代'
};
export const PLAN_MATCH_TEXT = { FULL: '完全匹配', PARTIAL: '部分匹配', NONE: '无匹配计划', UNDETERMINED: '不可判定', NOT_APPLICABLE: '不适用' };
export const GRADE_TEXT = { HIGH: '高', MEDIUM: '中', LOW: '低' };
export const RULE_CODE_TEXT = {
  C01: '计划匹配', 'C02-1': '禁飞空域', 'C02-2': '空域限高', 'C02-3': '航线偏离', 'C02-4': '时间窗', 'C02-5': '夜航',
  'C02-6': '超视距', 'C02-7': '计划高度', 'C02-8': '临时限制', C03: '四态判定', C06: '告警生成'
};
export const RULE_RESULT_TEXT = { PASS: '通过', FAIL: '不通过', UNDETERMINED: '不可判定', NOT_APPLICABLE: '不适用' };
export const RULE_REASON_TEXT = {
  INSIDE_RESTRICTED_AIRSPACE: '进入禁飞/限制空域', AIRSPACE_ALTITUDE_EXCEEDED: '超过空域限高', ROUTE_DEVIATION: '偏离报备航线',
  TIME_WINDOW_OVERRUN: '超出计划时间窗', NIGHT_FLIGHT: '夜间飞行', PLAN_ALTITUDE_EXCEEDED: '超出计划高度带', TEMPORARY_RESTRICTION_ACTIVE: '临时管制生效中',
  NO_AUTHORIZATION: '无飞行授权', BOUNDARY_POLICY_UNKNOWN: '边界接触政策未定', POSITION_UNKNOWN: '位置未知',
  ALTITUDE_DATUM_OR_RANGE_UNKNOWN: '高度基准或范围未知', VERSION_AMBIGUOUS: '空域版本歧义', CORRIDOR_WIDTH_UNKNOWN: '航线走廊宽度未知',
  ROUTE_GEOMETRY_UNKNOWN: '航线几何未知', PLAN_TIME_UNKNOWN: '计划时间未知', PILOT_POSITION_UNAVAILABLE: '飞手位置尚未接入', NO_PLAN: '无计划',
  STATE_STALE: '状态已过期', NO_STATE: '无目标状态', LOW_CONFIDENCE: '置信度不足', CONFIDENCE_UNKNOWN: '置信度未知', TRACK_DEGRADED: '轨迹点不足',
  TRACK_BRIDGED: '轨迹存在断点', PLAN_MATCH_UNDETERMINED: '计划匹配不可判定', PLAN_MATCHER_UNAVAILABLE: '计划匹配不可用',
  NO_PLAN_CANDIDATE: '没有候选计划', PLAN_AMBIGUOUS: '多个计划同优', IDENTITY_CLUE_MISSING: '身份线索缺失', PLAN_IDENTITY_UNKNOWN: '计划未登记机身序列号',
  IDENTITY_MISMATCH: '身份不匹配', TIME_WINDOW_MISMATCH: '时间窗不匹配', CORRIDOR_MISMATCH: '不在航线走廊内',
  TAKEOFF_POINT_UNAVAILABLE: '起降点尚未接入', PILOT_UNIT_UNAVAILABLE: '飞手/单位尚未接入'
};
export const MERGE_KIND_TEXT = { CREATED: '已生成告警', MERGED: '并入既有告警', UPGRADED: '升级生成告警', DOWNGRADED: '降级并入', MANUAL_ESCALATION: '人工转告警', BLOCKED: '告警被阻断', SUPPRESSED_SHADOW: '影子运行不告警' };
export const CONCLUSION_TEXT = { CONFIRM: '确认', REJECT: '驳回', OVERRIDE: '改判', RECOMPUTE: '重新研判', ESCALATE: '转告警' };
export const legalStatusText = code => LEGAL_STATUS_TEXT[code] || (code ? String(code) : '—');
export const reviewStateText = code => REVIEW_STATE_TEXT[code] || (code ? String(code) : '—');
export const planMatchText = code => PLAN_MATCH_TEXT[code] || (code ? String(code) : '—');
export const ruleReasonText = code => RULE_REASON_TEXT[code] || (code ? String(code) : '');

/* 每个研判 × 动作各保留一把幂等键：超时/409/断网时不换键，明确失败（4xx）后才换新键。 */
const pendingKeys = new Map();
const keyOf = (evaluationId, action) => `${action}:${evaluationId}`;

function newKey(action) {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `legality-${action}-${id}`;
}
function holdKey(evaluationId, action) {
  const slot = keyOf(evaluationId, action);
  if (!pendingKeys.has(slot)) pendingKeys.set(slot, newKey(action));
  return pendingKeys.get(slot);
}
function releaseKey(evaluationId, action) { pendingKeys.delete(keyOf(evaluationId, action)); }
function rotateKey(evaluationId, action) { pendingKeys.set(keyOf(evaluationId, action), newKey(action)); }

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function messageOf(error, fallback) {
  if (!error) return fallback;
  if (error.status === 401) return '登录已失效，请重新登录。';
  if (error.status === 403) return '当前账号没有执行此动作的权限。';
  if (error.status === 404) return '研判不存在或不在可见范围内。';
  return error.message || fallback;
}
function trimNote(value) { return String(value || '').trim(); }
function validateNote(value, label = '说明') {
  const note = trimNote(value);
  if (!note) return `${label}为必填项`;
  if (note.length > 1000) return `${label}不能超过 1000 字（当前 ${note.length} 字）`;
  return '';
}

/**
 * 写动作结果未知时的统一处理：回读服务端，版本或可执行动作变了就视为“可能已提交”，提示核对；否则让表单留在原地。
 * 返回 true 表示已处理完毕（弹窗已关），false 表示应把错误抛回表单。
 */
async function settleUncertain({ error, evaluationId, action, expectedVersion, refresh, actionCode }) {
  const latest = refresh ? await refresh(null) : null;
  const version = Number(latest?.review?.version);
  const stillAllowed = (latest?.allowed_actions || []).includes(actionCode);
  if (latest && (version !== expectedVersion || !stillAllowed)) {
    releaseKey(evaluationId, action);
    closeModal();
    toast(stillAllowed
      ? `提交结果未确认，已刷新当前状态：复核已更新为第${version}次（${reviewStateText(latest.review?.state)}），请核对历史后重新操作。`
      : `提交结果未确认，已刷新当前状态：当前为「${reviewStateText(latest.review?.state)}」，该动作已不可执行。`, 'err');
    return true;
  }
  throw new Error(`提交结果未确认，请刷新核对：${messageOf(error, '未返回明确结果')}`);
}

function intro(evaluation) {
  const rows = [
    ['复核次数', Number(evaluation.review?.version ?? 0) > 0 ? `已第${Number(evaluation.review.version)}次复核` : '尚未复核'],
    ['系统结论', esc(legalStatusText(evaluation.legal_status)) + (evaluation.grade ? `　等级 ${esc(evaluation.grade)}` : '')],
    ['复核状态', esc(reviewStateText(evaluation.review?.state))],
    ['计划匹配', esc(evaluation.plan_match_code || '—')],
    evaluation.violation_reasons?.length ? ['违规原因', esc(evaluation.violation_reasons.join('、'))] : null,
    evaluation.unknown_reasons?.length ? ['未知原因', esc(evaluation.unknown_reasons.join('、'))] : null
  ].filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
  return `<dl class="kv">${rows}</dl>`;
}

/**
 * 人工复核。
 * @param {object} o
 * @param {object} o.evaluation 服务端研判（含 evaluation_id/legal_status/review/allowed_actions）
 * @param {(result:object|null)=>Promise<object|null>} [o.refresh] 成功或结果未知时回读研判
 * @param {(result:object)=>void} [o.onDone]
 */
export function openLegalityReview({ evaluation, refresh, onDone } = {}) {
  if (!evaluation) { toast('尚未选择研判，无法复核', 'err'); return false; }
  if (!(evaluation.allowed_actions || []).includes('REVIEW')) { toast('当前研判不可复核或缺少复核权限', 'err'); return false; }
  const evaluationId = evaluation.evaluation_id;
  const expectedVersion = Number(evaluation.review?.version ?? 0);
  const action = 'revise';
  holdKey(evaluationId, action);
  const overrideOptions = ['LEGAL', 'ABNORMAL', 'ILLEGAL', 'UNDETERMINED']
    .filter(code => code !== evaluation.legal_status)
    .map(code => ({ value: code, label: legalStatusText(code) }));

  openFormModal({
    title: '人工复核 · ' + esc(evaluationId),
    width: '620px',
    warning: '复核只记录人工结论：「确认」采纳系统结论；「驳回」表示系统误判（告警与合并组不会删除，统计计误报）；「改判」需选择人工结论。复核不执行反制、不改告警核实状态。',
    introHtml: intro(evaluation),
    fields: [
      { key: 'conclusion', label: '复核结论', type: 'radio', required: true, options: [
        { value: 'CONFIRM', label: `确认（采纳系统结论「${legalStatusText(evaluation.legal_status)}」）` },
        { value: 'REJECT', label: '驳回（系统误判）' },
        { value: 'OVERRIDE', label: '改判（选择人工结论）' }
      ] },
      { key: 'override_status', label: '人工结论', type: 'select', options: overrideOptions, placeholder: '请选择改判结论',
        visibleWhen: model => model.conclusion === 'OVERRIDE' },
      { key: 'note', label: '复核说明', type: 'textarea', required: true, minRows: 4, placeholder: '必填，1–1000 字：现场核对、计划核实、飞手联系等依据' }
    ],
    initial: { conclusion: 'CONFIRM', override_status: null, note: '' },
    confirmText: '提交复核结论',
    validate: m => {
      if (m.conclusion === 'OVERRIDE' && !m.override_status) return '改判必须选择人工结论';
      return validateNote(m.note, '复核说明');
    },
    onSubmit: async ({ conclusion, override_status, note }) => {
      const key = holdKey(evaluationId, action);
      const body = { conclusion, note: trimNote(note), expected_version: expectedVersion };
      if (conclusion === 'OVERRIDE') body.override_status = override_status;
      try {
        const result = await legalityApi.reviseEvaluation(evaluationId, body, key);
        releaseKey(evaluationId, action);
        closeModal();
        toast(`复核完成：${reviewStateText(result?.review?.state)}（第${Number(result?.review?.version)}次复核）`, 'ok');
        if (refresh) await refresh(result);
        if (onDone) onDone(result);
      } catch (error) {
        if (isUncertainOutcome(error)) {
          // 409 / 超时 / 断网：服务端可能已落库。保留原键，回读核对，不自动换键重试、不提示成功。
          await settleUncertain({ error, evaluationId, action, expectedVersion, refresh, actionCode: 'REVIEW' });
          return;
        }
        rotateKey(evaluationId, action);
        throw new Error(messageOf(error, '复核提交失败'));
      }
    }
  });
  return true;
}

/** 重新研判：确认弹窗；成功后返回 201 新研判，旧研判置 SUPERSEDED。 */
export function openLegalityRecompute({ evaluation, refresh, onDone } = {}) {
  if (!evaluation) { toast('尚未选择研判，无法重新研判', 'err'); return false; }
  if (!(evaluation.allowed_actions || []).includes('RECOMPUTE')) { toast('当前研判不可重新研判或缺少评估权限', 'err'); return false; }
  const evaluationId = evaluation.evaluation_id;
  const expectedVersion = Number(evaluation.review?.version ?? 0);
  const action = 'recompute';
  holdKey(evaluationId, action);
  // 重算说明由操作人填写并进复核历史（RECOMPUTE），不能用页面写死的文案冒充人工依据。
  openFormModal({
    title: '重新研判 · ' + esc(evaluationId),
    width: '600px',
    warning: '将按当前激活规则集重新评估；旧研判保留并标记为"已被重算取代"，其复核记录不会被覆盖。',
    introHtml: intro(evaluation),
    fields: [
      { key: 'note', label: '重算说明', type: 'textarea', required: true, minRows: 4, placeholder: '必填，1–1000 字：为何需要重新研判（如规则集已更新、输入事实已补充）' }
    ],
    initial: { note: '' },
    confirmText: '重新研判',
    validate: m => validateNote(m.note, '重算说明'),
    onSubmit: async ({ note }) => {
      const key = holdKey(evaluationId, action);
      try {
        const result = await legalityApi.recomputeEvaluation(evaluationId, { note: trimNote(note), expected_version: expectedVersion }, key);
        releaseKey(evaluationId, action);
        closeModal();
        toast(`重新研判完成：新研判 ${result?.evaluation_id || ''}（${legalStatusText(result?.legal_status)}）`, 'ok');
        if (refresh) await refresh(result);
        if (onDone) onDone(result);
      } catch (error) {
        if (isUncertainOutcome(error)) {
          await settleUncertain({ error, evaluationId, action, expectedVersion, refresh, actionCode: 'RECOMPUTE' });
          return;
        }
        rotateKey(evaluationId, action);
        throw new Error(messageOf(error, '重新研判失败'));
      }
    }
  });
  return true;
}

export function openLegalityEscalation({ evaluation, refresh, onDone } = {}) {
  if (!evaluation) { toast('尚未选择研判，无法转告警', 'err'); return false; }
  if (!(evaluation.allowed_actions || []).includes('ESCALATE')) { toast('当前研判不可转告警（已关联告警、结论为合法或缺少权限）', 'err'); return false; }
  const evaluationId = evaluation.evaluation_id;
  const expectedVersion = Number(evaluation.review?.version ?? 0);
  const action = 'escalate';
  holdKey(evaluationId, action);
  openFormModal({
    title: '转告警 · ' + esc(evaluationId),
    width: '600px',
    warning: '转告警会创建一条来源告警与待核实无人机事件；后续核实、反制与处罚交接仍在告警页按既有流程执行。',
    introHtml: intro(evaluation),
    fields: [
      { key: 'note', label: '转告警说明', type: 'textarea', required: true, minRows: 4, placeholder: '必填，1–1000 字：为何需要人工转告警' }
    ],
    initial: { note: '' },
    confirmText: '创建告警',
    danger: true,
    validate: m => validateNote(m.note, '转告警说明'),
    onSubmit: async ({ note }) => {
      const key = holdKey(evaluationId, action);
      try {
        const result = await legalityApi.escalateEvaluation(evaluationId, { note: trimNote(note), expected_version: expectedVersion }, key);
        releaseKey(evaluationId, action);
        closeModal();
        toast(`已创建告警 ${result?.alarm_id || ''}，无人机事件 ${result?.event_id || ''} 待核实`, 'ok');
        if (refresh) await refresh(result);
        if (onDone) onDone(result);
      } catch (error) {
        if (isUncertainOutcome(error)) {
          await settleUncertain({ error, evaluationId, action, expectedVersion, refresh, actionCode: 'ESCALATE' });
          return;
        }
        rotateKey(evaluationId, action);
        throw new Error(messageOf(error, '转告警失败'));
      }
    }
  });
  return true;
}

/** 手动评估：对当前研判的目标按生效规则集再评估一次（POST /legality-evaluations），确认框 + 幂等键保留。 */
export function openLegalityManualEvaluate({ targetId, targetNo, refresh, onDone } = {}) {
  if (!targetId) { toast('当前研判没有可见的关联目标，无法手动评估', 'err'); return false; }
  const action = 'evaluate';
  holdKey(targetId, action);
  openConfirm({
    title: '手动评估',
    content: `将按当前生效规则集对目标 ${targetNo || targetId} 立即评估一次，生成新的研判并进入待复核队列（不影响既有研判与复核）。是否继续？`,
    confirmText: '立即评估',
    onConfirm: async () => {
      const key = holdKey(targetId, action);
      try {
        const result = await legalityApi.evaluate({ subject_kind: 'TARGET', subject_id: targetId, mode: 'ACTIVE' }, key);
        releaseKey(targetId, action);
        const evaluation = result?.evaluation || null;
        toast(`评估完成：${legalStatusText(evaluation?.legal_status)}${evaluation?.grade ? `（等级 ${esc(evaluation.grade)}）` : ''}`, 'ok');
        if (refresh) await refresh(evaluation);
        if (onDone) onDone(evaluation);
        return true;
      } catch (error) {
        if (isUncertainOutcome(error)) {
          toast(`评估结果未确认，请刷新队列核对：${messageOf(error, '未返回明确结果')}`, 'err');
          if (refresh) await refresh(null);
          return true;
        }
        rotateKey(targetId, action);
        toast(error?.code === 'NO_ACTIVE_RULE_SET' ? '没有生效的规则集版本，引擎空转，无法评估。' : messageOf(error, '手动评估失败'), 'err');
        return false;
      }
    }
  });
  return true;
}

/** 规则版本只读视图：成员规则与参数（含 DEMO/CONFIRMED 状态）；无 rule:read 时提示无权限，不伪造参数。 */
export async function openRuleVersionView({ ruleSetVersionId, ruleSetCode, versionNo } = {}) {
  if (!ruleSetVersionId) { toast('当前研判没有规则集版本信息', 'err'); return false; }
  let detail;
  try { detail = await legalityApi.getRuleVersion(ruleSetVersionId); }
  catch (error) {
    toast(error?.status === 403 ? '当前账号没有规则读取权限（rule:read），无法查看参数。' : messageOf(error, '读取规则版本失败'), 'err');
    return false;
  }
  const members = (detail?.members || []).map(m => `<tr><td class="mono">${esc(m.rule_code)}</td><td>${esc(RULE_CODE_TEXT[m.rule_code] || '')}</td><td>${esc(m.priority)}</td><td>${m.enabled === false ? '停用' : '启用'}</td></tr>`).join('');
  const params = (detail?.params || []).map(p => `<tr><td class="mono">${esc(p.rule_code)}</td><td class="mono">${esc(p.key)}</td><td>${esc(p.value)}${p.unit ? ` ${esc(p.unit)}` : ''}</td><td>${p.status === 'DEMO' ? '<span class="tag t-amber">DEMO 演示值</span>' : '<span class="tag t-green">已确认</span>'}</td><td>${esc(p.note || '')}</td></tr>`).join('');
  const head = `<dl class="kv"><dt>规则集</dt><dd>${esc(detail?.rule_set_code || ruleSetCode || '—')} v${esc(detail?.version_no ?? versionNo ?? '—')}</dd>`
    + `<dt>状态</dt><dd>${esc(detail?.status_code || '—')}　参数状态 ${detail?.param_status === 'DEMO' ? '<span class="tag t-amber">DEMO</span>' : esc(detail?.param_status || '—')}</dd>`
    + `<dt>生效/影子</dt><dd>${detail?.is_active ? '生效中' : '未生效'}${detail?.is_shadow ? '，影子运行中' : ''}</dd>`
    + (detail?.description ? `<dt>说明</dt><dd>${esc(detail.description)}</dd>` : '') + '</dl>';
  openModal({
    title: '判定规则与参数（只读）',
    width: '760px',
    body: `${head}<p class="lg-muted">参数值来自规则集版本；DEMO 表示演示参数尚未业务确认，激活/回滚/影子设置不在本页操作。</p>`
      + `<h4>成员规则</h4><table class="tb"><thead><tr><th>规则</th><th>名称</th><th>优先级</th><th>状态</th></tr></thead><tbody>${members || '<tr><td colspan="4">未提供成员规则</td></tr>'}</tbody></table>`
      + `<h4>参数</h4><table class="tb"><thead><tr><th>规则</th><th>参数</th><th>值</th><th>状态</th><th>说明</th></tr></thead><tbody>${params || '<tr><td colspan="5">未提供参数</td></tr>'}</tbody></table>`,
    footer: '<button class="btn" data-close>关闭</button>'
  });
  return true;
}
