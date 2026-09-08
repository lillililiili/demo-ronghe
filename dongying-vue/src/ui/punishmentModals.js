/* 处罚案件的表单（阶段 14 契约 v1.0）：立案 / 指派 / 线索 / 裁量 / 复核 / 结案 / 撤案 / 作废文书。
   共用 openFormModal 与同一套幂等键、错误翻译，避免每个动作各写一套。
   处罚是有法律后果的行政行为：金额、案件号、文书编号一律以服务端为准；
   确定性 409 不说成“结果未知”——那会让人以为可能已经生效了。 */
import { openFormModal } from './formModal.js';
import { closeModal } from './modal.js';
import { toast } from './nv.js';
import { isPunishmentUnavailable, newPunishmentIdempotencyKey, punishmentApi, PUNISHMENT_UNAVAILABLE_TEXT } from '@/services/punishmentApi.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import { LEAD_KIND_LABEL, PENALTY_TYPE_LABEL, PUNISHMENT_BLOCKED_LABEL, REVIEW_CONCLUSION_LABEL, VIOLATION_CODE_LABEL, labelOf } from '@/ui/labels.js';

/* 这些 409/400 是服务端给出的确定结论：请求一定没被受理，不能按“可能已落库”处理。 */
const DEFINITE_CODES = new Set([
  'CASE_ALREADY_EXISTS', 'INVALID_TRANSITION', 'DISCRETION_NOT_CONFIRMED',
  'REVIEW_SELF_NOT_ALLOWED', 'DECISION_DOCUMENT_REQUIRED', 'FINE_OUT_OF_RANGE', 'PENALTY_TYPE_NOT_ALLOWED',
  'VALIDATION_ERROR', 'UNKNOWN_FIELD'
]);

const pendingKeys = new Map();
const keyOf = (scope, action) => {
  const id = `${action}:${scope}`;
  if (!pendingKeys.has(id)) pendingKeys.set(id, newPunishmentIdempotencyKey(action));
  return { id, key: pendingKeys.get(id) };
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
export function yuan(cents) {
  if (cents == null || cents === '') return '';
  return (Number(cents) / 100).toFixed(2);
}
function messageOf(error, fallback) {
  if (!error) return fallback;
  if (isPunishmentUnavailable(error)) return `${PUNISHMENT_UNAVAILABLE_TEXT}，无法提交。`;
  if (error.status === 401) return '登录已失效，请重新登录。';
  if (error.status === 403) return '当前账号没有执行该操作的权限。';
  // INVALID_TRANSITION 在处罚域走服务端原话：服务端会说"未指派承办人不能复核""已作废的文书不能再作废"
  // 这类带补救办法的话，套一句通用的"当前状态不允许"反而把有用信息丢了。
  if (error.code === 'INVALID_TRANSITION') return error.message || PUNISHMENT_BLOCKED_LABEL.INVALID_TRANSITION;
  const mapped = PUNISHMENT_BLOCKED_LABEL[error.code];
  if (mapped) return `${mapped}。`;
  return error.message || fallback;
}

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
    if (DEFINITE_CODES.has(error?.code)) {
      // 确定失败：换新键（下次是新请求），仍回读一次让页面显示服务端的最新状态。
      pendingKeys.delete(id);
      if (refresh) { try { await refresh(null); } catch { /* 回读失败不掩盖原始错误 */ } }
      throw new Error(messageOf(error, '提交失败'));
    }
    if (isUncertainOutcome(error)) {
      // 超时 / 断网 / 乐观锁冲突：服务端可能已落库。保留原键，回读核对，不提示成功。
      pendingKeys.delete(id);
      if (refresh) { try { await refresh(null); } catch { /* 同上 */ } }
      throw new Error(`提交结果未确认，请刷新核对：${messageOf(error, '没有收到明确结果')}`);
    }
    pendingKeys.delete(id);
    throw new Error(messageOf(error, '提交失败'));
  }
}

function introOf(rows) {
  const body = rows.filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
  return body ? `<dl class="kv">${body}</dl>` : '';
}

/** 立案：把一条处罚交接变成案件。一个事件只能有一个案件（服务端 409 兜底）。 */
export function openCaseFile({ handoff, refresh, onDone } = {}) {
  if (!handoff?.handoff_id) { toast('缺少处罚交接，无法立案', 'err'); return false; }
  openFormModal({
    title: '立案',
    width: '600px',
    warning: '立案后案件号由服务端按日生成；当事人信息不确定时选「暂不确定」，不要先填一个占位值。',
    introHtml: introOf([['处罚交接', esc(handoff.handoff_no || handoff.handoff_id)], ['来源事件', esc(handoff.source_id || '')]]),
    fields: [
      { key: 'party_type', label: '当事人类型', type: 'radio', required: true, options: [
        { value: 'PERSON', label: '个人' }, { value: 'ORG', label: '单位' }, { value: 'UNKNOWN', label: '暂不确定' }
      ] },
      { key: 'party_name', label: '当事人名称', placeholder: '选填：确定时填写，未确定请留空' },
      { key: 'note', label: '立案说明', type: 'textarea', minRows: 3, placeholder: '选填：立案理由与已掌握的情况' }
    ],
    initial: { party_type: 'UNKNOWN', party_name: '', note: '' },
    confirmText: '立案',
    validate: m => (m.party_type !== 'UNKNOWN' && !String(m.party_name || '').trim() ? '选择个人或单位时必须填写当事人名称' : null),
    onSubmit: ({ party_type: partyType, party_name: partyName, note }) => submit({
      scope: handoff.handoff_id,
      action: 'file',
      call: key => punishmentApi.fileCase({
        handoff_id: handoff.handoff_id, party_type: partyType,
        party_name: String(partyName || '').trim() || undefined, note: String(note || '').trim() || undefined
      }, key),
      refresh,
      onDone,
      okText: result => `已立案：${result?.case_no || ''}`
    })
  });
  return true;
}

/** 指派承办人：officer 必须是可见的启用用户，服务端校验。 */
export function openCaseAssign({ punishmentCase, officers = [], refresh, onDone } = {}) {
  const c = punishmentCase;
  if (!c?.case_id) { toast('缺少案件', 'err'); return false; }
  openFormModal({
    title: `指派承办人 · ${c.case_no || ''}`,
    width: '560px',
    introHtml: introOf([['案件', esc(c.case_no || '')], ['当前承办人', esc(c.officer_name || '尚未指派')]]),
    fields: [{ key: 'officer_id', label: '承办人', type: 'select', required: true,
      options: officers.map(u => ({ value: u.user_id, label: u.name || u.account })) }],
    initial: { officer_id: c.officer_id || '' },
    confirmText: '指派',
    validate: m => (m.officer_id ? null : '请选择承办人'),
    onSubmit: ({ officer_id: officerId }) => submit({
      scope: c.case_id, action: 'assign',
      call: key => punishmentApi.assign(c.case_id, { officer_id: officerId, expected_version: Number(c.version) }, key),
      refresh, onDone,
      okText: () => '已指派承办人'
    })
  });
  return true;
}

/** 新增待补线索。 */
export function openLeadAdd({ punishmentCase, refresh, onDone } = {}) {
  const c = punishmentCase;
  if (!c?.case_id) { toast('缺少案件', 'err'); return false; }
  openFormModal({
    title: `新增待补线索 · ${c.case_no || ''}`,
    width: '600px',
    fields: [
      { key: 'kind', label: '线索类别', type: 'select', required: true,
        options: Object.keys(LEAD_KIND_LABEL).map(k => ({ value: k, label: LEAD_KIND_LABEL[k] })) },
      { key: 'description', label: '需要补什么', type: 'textarea', required: true, minRows: 3, placeholder: '必填：具体要补的材料或事实' }
    ],
    initial: { kind: 'EVIDENCE', description: '' },
    confirmText: '新增',
    validate: m => (String(m.description || '').trim() ? null : '请写明需要补充的内容'),
    onSubmit: ({ kind, description }) => submit({
      scope: c.case_id, action: 'lead-add',
      call: key => punishmentApi.addLead(c.case_id, { kind, description: String(description).trim(), expected_version: Number(c.version) }, key),
      refresh, onDone,
      okText: () => '已记录待补线索'
    })
  });
  return true;
}

/** 线索补齐。 */
export function openLeadResolve({ punishmentCase, lead, refresh, onDone } = {}) {
  const c = punishmentCase;
  if (!c?.case_id || !lead?.lead_id) { toast('缺少线索', 'err'); return false; }
  openFormModal({
    title: '标记线索已补齐',
    width: '560px',
    introHtml: introOf([['线索类别', esc(labelOf(LEAD_KIND_LABEL, lead.kind))], ['原始要求', esc(lead.description || '')]]),
    fields: [{ key: 'note', label: '补齐说明', type: 'textarea', required: true, minRows: 3, placeholder: '必填：补到了什么' }],
    initial: { note: '' },
    confirmText: '标记已补齐',
    validate: m => (String(m.note || '').trim() ? null : '补齐说明为必填项'),
    onSubmit: ({ note }) => submit({
      scope: `${c.case_id}:${lead.lead_id}`, action: 'lead-resolve',
      call: key => punishmentApi.resolveLead(c.case_id, lead.lead_id, { note: String(note).trim(), expected_version: Number(c.version) }, key),
      refresh, onDone,
      okText: () => '线索已标记为补齐'
    })
  });
  return true;
}

/**
 * 裁量：选档位 → 定处罚种类与金额。
 * 界面单位是元、接口单位是分，换算只在提交前做一次；金额区间来自所选档位，超区间的提示要带上区间本身。
 */
export function openDiscretionDraft({ punishmentCase, rules = [], refresh, onDone } = {}) {
  const c = punishmentCase;
  if (!c?.case_id) { toast('缺少案件', 'err'); return false; }
  if (!rules.length) { toast('没有可用的罚则档位，无法拟定裁量', 'err'); return false; }
  const ruleOptions = rules.map(r => ({
    value: r.rule_code,
    label: Number(r.fine_max) > 0
      ? `${r.title || labelOf(VIOLATION_CODE_LABEL, r.violation_code)} · ${yuan(r.fine_min)}–${yuan(r.fine_max)} 元（演示档位）`
      : `${r.title || labelOf(VIOLATION_CODE_LABEL, r.violation_code)} · 不涉及罚款（演示档位）`
  }));
  /* 找不到就返回 null：拿另一档罚则顶替，会让人按错误的区间填金额却看不出来。 */
  const ruleOf = code => rules.find(r => r.rule_code === code) || null;
  openFormModal({
    title: `拟定裁量 · ${c.case_no || ''}`,
    width: '640px',
    warning: '罚则档位与金额区间是演示值，未经业务方确认；确认裁量后案件进入复核，复核人必须是另一个人。',
    introHtml: introOf([['案件', esc(c.case_no || '')], ['当事人', esc(c.party_name || '暂不确定')]]),
    fields: [
      { key: 'rule_code', label: '违法事由与档位', type: 'select', required: true, options: ruleOptions },
      /* 处罚种类列全集，由 validate 按所选档位的 penalty_types 拦（契约 v1.2 该字段是数组）。
         表单是静态的：按"第一条规则"裁剪选项，换成别的违法事由后就会列错——宁可列全再拦，
         也不能给出一份与所选事由对不上的选项。每条档位允许哪些处罚，页面的档位表里逐条写着。 */
      { key: 'penalty_type', label: '处罚种类', type: 'radio', required: true,
        options: Object.keys(PENALTY_TYPE_LABEL).map(k => ({ value: k, label: PENALTY_TYPE_LABEL[k] })) },
      { key: 'fine_yuan', label: '罚款金额（元）', placeholder: '仅警告时填 0' },
      /* 法律依据由所选档位决定（档位表里逐条写着），接口也不接受单独传：这里不再给可编辑框，
         免得填了却没被采纳。 */
      { key: 'factors', label: '裁量因素', type: 'textarea', required: true, minRows: 3, placeholder: '必填：从重/从轻的具体情节，一行一条' }
    ],
    initial: { rule_code: rules[0].rule_code, penalty_type: 'FINE', fine_yuan: '', factors: '' },
    confirmText: '保存裁量草稿',
    validate: m => {
      if (!String(m.factors || '').trim()) return '裁量因素为必填项';
      const rule = ruleOf(m.rule_code);
      if (!rule) return '请重新选择违法事由与档位';
      const amount = Number(String(m.fine_yuan || '').trim() || '0');
      if (!Number.isFinite(amount) || amount < 0) return '罚款金额必须是不小于 0 的数字';
      if (rule.penalty_types?.length && !rule.penalty_types.includes(m.penalty_type)) {
        return `该违法事由只允许：${rule.penalty_types.map(t => labelOf(PENALTY_TYPE_LABEL, t)).join(' / ')}`;
      }
      if (m.penalty_type === 'WARNING' && amount !== 0) return '处罚种类为警告时罚款金额必须为 0';
      if (Number(rule.fine_max) === 0 && amount !== 0) return '该违法事由不涉及罚款，金额必须为 0';
      if (m.penalty_type !== 'WARNING') {
        const cents = Math.round(amount * 100);
        if (cents < Number(rule.fine_min) || cents > Number(rule.fine_max)) {
          return `罚款金额需在 ${yuan(rule.fine_min)}–${yuan(rule.fine_max)} 元之间（所选档位）`;
        }
      }
      return null;
    },
    onSubmit: ({ rule_code: ruleCode, penalty_type: penaltyType, fine_yuan: fineYuan, factors }) => {
      const rule = ruleOf(ruleCode);
      if (!rule) return Promise.reject(new Error('请重新选择违法事由与档位'));
      return submit({
        scope: c.case_id, action: 'discretion',
        /* 请求体只认这五个字段（联调实测：violation_code 与 legal_basis 都会被 UNKNOWN_FIELD 打回，
           违法事由与依据由 rule_code 决定）。 */
        call: key => punishmentApi.draftDiscretion(c.case_id, {
          rule_code: ruleCode,
          penalty_type: penaltyType,
          fine_amount: Math.round(Number(String(fineYuan || '').trim() || '0') * 100),   // 元 → 分
          factors: String(factors).trim(),
          expected_version: Number(c.version)
        }, key),
        refresh, onDone,
        okText: () => '裁量草稿已保存，确认后进入复核'
      });
    }
  });
  return true;
}

/** 确认裁量：草稿 → 已确认，案件进入复核。 */
export function confirmDiscretion({ punishmentCase, discretion, refresh, onDone } = {}) {
  const c = punishmentCase;
  if (!c?.case_id || !discretion?.discretion_id) { toast('缺少裁量草稿', 'err'); return false; }
  openFormModal({
    title: '确认裁量',
    width: '560px',
    warning: '确认后案件进入复核，复核人必须是另一位有复核权限的人。',
    introHtml: introOf([
      ['处罚种类', esc(labelOf(PENALTY_TYPE_LABEL, discretion.penalty_type))],
      ['罚款金额', discretion.fine_amount != null ? `${esc(yuan(discretion.fine_amount))} 元` : ''],
      ['裁量依据', esc(discretion.basis_text || discretion.factors || '')]
    ]),
    fields: [],
    confirmText: '确认裁量',
    onSubmit: () => submit({
      scope: `${c.case_id}:${discretion.discretion_id}`, action: 'discretion-confirm',
      call: key => punishmentApi.confirmDiscretion(c.case_id, discretion.discretion_id, { expected_version: Number(c.version) }, key),
      refresh, onDone,
      okText: () => '裁量已确认，案件进入复核'
    })
  });
  return true;
}

/** 复核：结论三选一，需修正/证据不足时可一并记下待补线索。 */
export function openCaseReview({ punishmentCase, refresh, onDone } = {}) {
  const c = punishmentCase;
  if (!c?.case_id) { toast('缺少案件', 'err'); return false; }
  openFormModal({
    title: `复核 · ${c.case_no || ''}`,
    width: '640px',
    warning: '复核人不能是承办人。维持则进入决定环节，维持时不能附待补线索；需修正或证据不足会退回调查，并把待补线索记入案件。',
    introHtml: introOf([['案件', esc(c.case_no || '')], ['承办人', esc(c.officer_name || '尚未指派')]]),
    fields: [
      { key: 'conclusion', label: '复核结论', type: 'radio', required: true,
        options: Object.keys(REVIEW_CONCLUSION_LABEL).map(k => ({ value: k, label: REVIEW_CONCLUSION_LABEL[k] })) },
      { key: 'note', label: '复核说明', type: 'textarea', required: true, minRows: 3, placeholder: '必填：复核依据与理由' },
      /* 结论选"维持"时这两项直接隐藏（14-33）：维持原裁量却附待补线索是自相矛盾的，
         与其让人填完再被服务端打回，不如根本不给填。表单支持 visibleWhen 按当前取值实时判断。 */
      { key: 'lead_kind', label: '待补线索类别', type: 'select', visibleWhen: m => m.conclusion !== 'UPHELD',
        options: [{ value: '', label: '不需要补充' }, ...Object.keys(LEAD_KIND_LABEL).map(k => ({ value: k, label: LEAD_KIND_LABEL[k] }))] },
      { key: 'lead_description', label: '待补线索说明', type: 'textarea', minRows: 2, visibleWhen: m => m.conclusion !== 'UPHELD',
        placeholder: '选填：选了类别时填写' }
    ],
    initial: { conclusion: 'UPHELD', note: '', lead_kind: '', lead_description: '' },
    confirmText: '提交复核结论',
    validate: m => {
      if (!String(m.note || '').trim()) return '复核说明为必填项';
      if (m.conclusion === 'UPHELD' && (m.lead_kind || String(m.lead_description || '').trim())) {
        return '维持原裁量时不能附待补线索；如需补充请选“需修正”或“证据不足”';
      }
      if (m.lead_kind && !String(m.lead_description || '').trim()) return '选择了待补线索类别，请填写说明';
      return null;
    },
    onSubmit: ({ conclusion, note, lead_kind: leadKind, lead_description: leadDescription }) => submit({
      scope: c.case_id, action: 'review',
      /* 维持时一律不带线索：切回"维持"之前填的内容留在表单模型里，但不能跟着提交。 */
      call: key => punishmentApi.review(c.case_id, {
        conclusion, note: String(note).trim(),
        missing_leads: conclusion !== 'UPHELD' && leadKind
          ? [{ kind: leadKind, description: String(leadDescription).trim() }]
          : undefined,
        expected_version: Number(c.version)
      }, key),
      refresh, onDone,
      okText: result => `复核完成：${labelOf(REVIEW_CONCLUSION_LABEL, result?.conclusion || conclusion)}`
    })
  });
  return true;
}

/** 作废决定书。 */
export function openDocumentRevoke({ document: doc, refresh, onDone } = {}) {
  if (!doc?.document_id) { toast('缺少决定书', 'err'); return false; }
  openFormModal({
    title: `作废决定书 · ${doc.document_no || ''}`,
    width: '560px',
    warning: '作废是只增记录：原文书仍可查阅，状态标为已作废。',
    fields: [{ key: 'reason', label: '作废理由', type: 'textarea', required: true, minRows: 3, placeholder: '必填：为什么作废' }],
    initial: { reason: '' },
    confirmText: '作废',
    danger: true,
    validate: m => (String(m.reason || '').trim() ? null : '作废理由为必填项'),
    onSubmit: ({ reason }) => submit({
      scope: doc.document_id, action: 'doc-revoke',
      call: key => punishmentApi.revokeDocument(doc.document_id, { reason: String(reason).trim(), expected_version: Number(doc.version) }, key),
      refresh, onDone,
      okText: () => '决定书已作废'
    })
  });
  return true;
}

/** 结案：必须已出具至少一份决定书（服务端兜底）。 */
export function openCaseClose({ punishmentCase, refresh, onDone } = {}) {
  const c = punishmentCase;
  if (!c?.case_id) { toast('缺少案件', 'err'); return false; }
  openFormModal({
    title: `结案 · ${c.case_no || ''}`,
    width: '560px',
    warning: '结案前必须至少出具一份决定书。结案后案件不再接受新的裁量与文书。',
    fields: [{ key: 'note', label: '结案说明', type: 'textarea', minRows: 3, placeholder: '选填：执行情况与归档说明' }],
    initial: { note: '' },
    confirmText: '结案',
    onSubmit: ({ note }) => submit({
      scope: c.case_id, action: 'close',
      call: key => punishmentApi.closeCase(c.case_id, { note: String(note || '').trim() || undefined, expected_version: Number(c.version) }, key),
      refresh, onDone,
      okText: () => '案件已结案'
    })
  });
  return true;
}

/** 撤案：只在已立案/调查中。 */
export function openCaseWithdraw({ punishmentCase, refresh, onDone } = {}) {
  const c = punishmentCase;
  if (!c?.case_id) { toast('缺少案件', 'err'); return false; }
  openFormModal({
    title: `撤案 · ${c.case_no || ''}`,
    width: '560px',
    warning: '撤案是终态：案件不再继续办理，事件仍保留在处罚交接清单里。',
    fields: [{ key: 'reason', label: '撤案理由', type: 'textarea', required: true, minRows: 3, placeholder: '必填：为什么不再办理' }],
    initial: { reason: '' },
    confirmText: '撤案',
    danger: true,
    validate: m => (String(m.reason || '').trim() ? null : '撤案理由为必填项'),
    onSubmit: ({ reason }) => submit({
      scope: c.case_id, action: 'withdraw',
      call: key => punishmentApi.withdrawCase(c.case_id, { reason: String(reason).trim(), expected_version: Number(c.version) }, key),
      refresh, onDone,
      okText: () => '案件已撤案'
    })
  });
  return true;
}
