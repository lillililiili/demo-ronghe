/* 飞行任务列表“需要处理的放在最上面”（2026-10-16 用户确认设计二）。
   后台按 order=attention 排好序，并给每个未结束的任务带上 attention：有哪几种问题、匹配结论、待处理风险数、未办结的设备处置单。
   本文件只把这些事实翻成列表上的标签、一句“下一步”、展开后的完整说明和按钮，不在前台自己判断。 */
import { maintenanceState, maintenanceStateLabel } from './maintenanceState.js';
import { REASON_CODE_LABEL, RISK_TYPE_LABEL } from '../../ui/labels.js';

export const ATTENTION_CHIPS = [
  { key: 'DEVICE', label: '设备异常', tag: 't-amber' },
  { key: 'RISK', label: '风险待处理', tag: 't-amber' }
];
const SUMMARY_FIELD = { DEVICE: 'device', RISK: 'risk' };

export function needsAction(plan) {
  return Array.isArray(plan?.attention?.kinds) && plan.attention.kinds.some(kind => ['DEVICE', 'RISK'].includes(kind));
}

/* 列表分组：需要处理 → 其他执行中 → 待执行 → 已结束/已取消，与后台排序一致。 */
export function planGroupOf(plan) {
  if (needsAction(plan)) return 'needs';
  if (plan?.status_code === 'EXECUTING') return 'executing';
  if (['PENDING', 'APPROVED'].includes(plan?.status_code)) return 'pending';
  return 'ended';
}
export const PLAN_GROUP = {
  needs: { title: '需要处理', note: '设备异常或风险待处理' },
  executing: { title: '执行中', note: '' },
  pending: { title: '待执行', note: '开始时间近的在前' },
  ended: { title: '已结束 / 已取消', note: '最近的在前' }
};

/* 一个任务的每一种问题：问题说明、下一步及各自的入口；入口只导航，业务动作仍在原页面办理。 */
export function attentionIssues(plan, access = {}) {
  const attention = plan?.attention;
  if (!needsAction(plan)) return [];
  const issues = [];
  const tasks = Array.isArray(attention.device_tasks) ? attention.device_tasks : [];
  if (tasks.length) issues.push(deviceIssue(tasks));
  const verify = Number(attention.pending_verification_risks) || 0, notify = Number(attention.pending_notification_risks) || 0;
  if (verify + notify > 0) {
    const kinds = riskKindText(attention.pending_risk_kinds);
    const parts = [verify ? `待核验 ${verify}` : '', notify ? `待通知 ${notify}` : ''].filter(Boolean).join('、') + (kinds ? `，${kinds}` : '');
    issues.push({ kind: 'RISK', tag: `风险 ${verify + notify} 条`, tagClass: 't-amber',
      next: verify ? `核验${kinds || '风险'}，确认后通知上级` : `把${kinds || '风险'}通知上级`,
      detail: `这条任务有 ${verify + notify} 个风险事件还没处理（${parts}）。${verify ? '请去核验，确认后通知上级。' : '请通知上级。'}`,
      actions: [{ key: 'risks', label: verify ? '去核验与通知' : '去通知上级', primary: true }] });
  }
  return issues.map(issue => ({ ...issue, actions: issue.actions.map(action => ({ ...action,
    blockedReason: action.key === 'risks' && access.risks === false ? '当前账号无权查看风险事件' : ''
  })) }));
}

/* 处置单还在办（待处理、处理中）的设备算“异常”；系统核验中、待确认办结的说明设备可能已恢复，不再说飞机测不到。 */
const RECOVERING = new Set(['PENDING_VERIFICATION', 'READY_TO_COMPLETE']);
function deviceIssue(tasks) {
  const name = task => task.device_name || '未命名设备';
  const state = task => `后台处置单“${maintenanceStateLabel(task)}”`;
  const broken = tasks.filter(task => !RECOVERING.has(maintenanceState(task)));
  const recovering = tasks.filter(task => RECOVERING.has(maintenanceState(task)));
  const lines = [];
  if (broken.length === 1) lines.push(`航线附近的${name(broken[0])} 异常，${state(broken[0])}，飞机可能测不到。请跟进处置单；修好前靠联系报备单位确认飞行情况。`);
  else if (broken.length > 1) lines.push(`航线附近有 ${broken.length} 台设备异常（${broken.map(task => `${name(task)}，${state(task)}`).join('；')}），飞机可能测不到。请跟进处置单；修好前靠联系报备单位确认飞行情况。`);
  if (recovering.length) lines.push(`${recovering.map(task => `${name(task)}${maintenanceState(task) === 'READY_TO_COMPLETE' ? '已恢复' : '正在核验是否恢复'}，${state(task)}`).join('；')}。请跟进后台确认办结。`);
  return { kind: 'DEVICE', tag: `设备异常 ${tasks.length}`, tagClass: 't-amber',
    next: broken.length ? '由后台人员接手处理，恢复核验通过后确认办结' : '跟进后台核验恢复、确认办结', detail: lines.join(''),
    actions: [{ key: 'devices', label: '查看设备处置进度', primary: true }] };
}

/* 待处理风险的种类：气象写具体预警（如“雷雨预警”），其他写风险类型；同名去重。 */
function riskKindText(kinds) {
  const names = (Array.isArray(kinds) ? kinds : []).map(kind => kind?.risk_type === 'WEATHER'
    ? REASON_CODE_LABEL[kind.reason_code] || '气象预警' : RISK_TYPE_LABEL[kind?.risk_type] || '').filter(Boolean);
  return [...new Set(names)].join('、');
}

/* 顶部汇总：需要处理几个任务，按种类各几个（一个任务有几种问题就各算一次）。 */
export function attentionSummaryChips(summary, chosen = '') {
  if (!summary) return null;
  return {
    total: Number(summary.needs_action) || 0,
    otherExecuting: summary.other_executing == null ? null : Number(summary.other_executing) || 0,
    chips: ATTENTION_CHIPS.map(chip => ({ ...chip, count: Number(summary[SUMMARY_FIELD[chip.key]]) || 0, active: chosen === chip.key }))
  };
}

export function attentionKindLabel(kind) {
  return ATTENTION_CHIPS.find(chip => chip.key === kind)?.label || '';
}

// 按本任务分页读取，并只返回点击时对应的处置单；不能拿同设备的新单替代旧单。
export async function loadAttentionDeviceTasks(planId, taskIds, readPage, isCurrent = () => true) {
  const wanted = new Set(taskIds.filter(Boolean)), found = new Map(), seen = new Set();
  if (!planId || !wanted.size) throw new Error('缺少关联处置单，请关闭后刷新任务。');
  for (let page = 1; ; page++) {
    const result = await readPage(planId, { page, size: 100 });
    if (!isCurrent()) return null;
    if (!Array.isArray(result?.items) || !Number.isSafeInteger(result.total) || result.total < 0)
      throw new Error('处置进度返回不完整，请重新读取。');
    let added = 0;
    for (const task of result.items) {
      if (!task?.task_id) throw new Error('处置单编号缺失，请重新读取。');
      if (!seen.has(task.task_id)) { seen.add(task.task_id); added++; }
      if (wanted.has(task.task_id)) found.set(task.task_id, task);
    }
    if (found.size === wanted.size || seen.size >= result.total) break;
    if (!added) throw new Error('处置单分页读取不完整，请重新读取。');
  }
  return { items: [...wanted].flatMap(id => found.has(id) ? [found.get(id)] : []), missing: wanted.size - found.size };
}
