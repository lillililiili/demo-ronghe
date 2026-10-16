/* 飞行任务列表“需要处理的放在最上面”（2026-10-16 用户确认设计二）。
   后台按 order=attention 排好序，并给每个未结束的任务带上 attention：有哪几种问题、匹配结论、待处理风险数、未办结的设备处置单。
   本文件只把这些事实翻成列表上的标签、一句“下一步”、展开后的完整说明和按钮，不在前台自己判断。 */
import { maintenanceStateLabel } from './maintenanceState.js';

export const ATTENTION_CHIPS = [
  { key: 'DEVIATION', label: '任务偏离', tag: 't-red' },
  { key: 'AIRCRAFT', label: '没对上飞机', tag: 't-amber' },
  { key: 'DEVICE', label: '设备异常', tag: 't-orange' },
  { key: 'RISK', label: '风险待处理', tag: 't-amber' }
];
const SUMMARY_FIELD = { DEVIATION: 'deviation', AIRCRAFT: 'aircraft', DEVICE: 'device', RISK: 'risk' };

const MATCH_ISSUE = {
  DEVIATION: { tag: '任务偏离', tagClass: 't-red', next: '确认是不是违规，是就按告警处置',
    detail: '飞机实际飞的位置离开了报备航线。请打开合法性判定，确认是不是违规；是违规就按告警处置。' },
  NONE: { tag: '未找到对应飞机', tagClass: 't-amber', next: '看比对的飞机是不是违规，并联系报备单位',
    detail: '有飞机和这条任务比对过，但位置、时间或高度对不上。请打开合法性判定，看那架飞机是不是违规；同时联系报备单位，问清报备的飞机有没有起飞。' },
  NO_EVALUATION: { tag: '还没对上飞机', tagClass: 't-amber', next: '联系报备单位问是否起飞',
    detail: '系统还没把任何飞机和这条任务对上：可能还没起飞，也可能没被探测到。请联系报备单位，问清是否已经起飞。' },
  PARTIAL: { tag: '部分匹配', tagClass: 't-amber', next: '打开合法性判定，看哪一项不符',
    detail: '找到的飞机和报备内容对不全（比如高度或时间不一致）。请打开合法性判定，看是哪一项不符。' },
  UNDETERMINED: { tag: '不可判定', tagClass: 't-gray', next: '人工核实：看现场画面或联系报备单位',
    detail: '收到的数据不够，系统判断不了。请人工核实：看现场画面，或联系报备单位。' }
};
const LEGALITY_ISSUES = new Set(['DEVIATION', 'NONE', 'PARTIAL']);

export function needsAction(plan) {
  return Array.isArray(plan?.attention?.kinds) && plan.attention.kinds.length > 0;
}

/* 列表分组：需要处理 → 其他执行中 → 待执行 → 已结束/已取消，与后台排序一致。 */
export function planGroupOf(plan) {
  if (needsAction(plan)) return 'needs';
  if (plan?.status_code === 'EXECUTING') return 'executing';
  if (['PENDING', 'APPROVED'].includes(plan?.status_code)) return 'pending';
  return 'ended';
}
export const PLAN_GROUP = {
  needs: { title: '需要处理', note: '任务偏离的在最前' },
  executing: { title: '执行中', note: '开始时间新的在前' },
  pending: { title: '待执行', note: '开始时间近的在前' },
  ended: { title: '已结束 / 已取消', note: '最近的在前' }
};

/* 一个任务的每一种问题：列表标签、一句下一步、展开后的完整说明。 */
export function attentionIssues(plan) {
  const attention = plan?.attention;
  if (!needsAction(plan)) return [];
  const issues = [];
  const match = MATCH_ISSUE[attention.match_issue];
  if (match) issues.push({ kind: attention.match_issue === 'DEVIATION' ? 'DEVIATION' : 'AIRCRAFT', ...match });
  const tasks = Array.isArray(attention.device_tasks) ? attention.device_tasks : [];
  if (tasks.length) {
    const names = tasks.map(task => task.device_name || '未命名设备');
    const facts = tasks.map(task => `${task.device_name || '未命名设备'}，后台处置单“${maintenanceStateLabel(task)}”`).join('；');
    issues.push({ kind: 'DEVICE', tag: `设备异常 ${tasks.length}`, tagClass: 't-orange', next: `跟进${names.join('、')}处置单`,
      detail: `航线附近有 ${tasks.length} 台监测设备异常（${facts}），飞机可能测不到。请跟进处置单进度；设备修好前，靠联系报备单位确认飞行情况。` });
  }
  const verify = Number(attention.pending_verification_risks) || 0, notify = Number(attention.pending_notification_risks) || 0;
  if (verify + notify > 0) {
    const parts = [verify ? `待核验 ${verify}` : '', notify ? `待通知 ${notify}` : ''].filter(Boolean).join('、');
    issues.push({ kind: 'RISK', tag: `风险 ${verify + notify} 条`, tagClass: 't-amber',
      next: verify ? '核验风险，确认后通知上级' : '通知上级',
      detail: `这条任务有 ${verify + notify} 个风险事件还没处理（${parts}）。${verify ? '请去核验，确认后通知上级。' : '请通知上级。'}` });
  }
  return issues;
}

/* 行内按钮：比对类问题去合法性判定；只有风险时去风险事件（只看这条任务的）；其他看右侧详情。 */
export function attentionAction(plan) {
  if (!needsAction(plan)) return null;
  if (LEGALITY_ISSUES.has(plan.attention.match_issue)) return { key: 'legality', label: '合法性判定 →' };
  if (plan.attention.kinds.every(kind => kind === 'RISK')) return { key: 'risks', label: '查看风险事件 →' };
  return { key: 'detail', label: '查看详情' };
}

/* 顶部汇总：需要处理几个任务，按种类各几个（一个任务有几种问题就各算一次）。 */
export function attentionSummaryChips(summary, chosen = '') {
  if (!summary) return null;
  return {
    total: Number(summary.needs_action) || 0,
    chips: ATTENTION_CHIPS.map(chip => ({ ...chip, count: Number(summary[SUMMARY_FIELD[chip.key]]) || 0, active: chosen === chip.key }))
  };
}

export function attentionKindLabel(kind) {
  return ATTENTION_CHIPS.find(chip => chip.key === kind)?.label || '';
}
