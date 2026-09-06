/* “我的工作台”统一事件适配层：把后端工作台摘要映射成页面视图模型，并提供导航与源对象读取。
 * 这里只统一入口、分类和待办提示，不改写三类业务各自的状态机，也不再写任何内存状态：
 * 队列、计数、详情全部来自 GET /workbench/items；核实委托 alarmApi/riskApi，通知委托 handoffApi（待领导接线）。 */
import { RISK_STATE_LABEL, SEVERITY_LABEL, SEVERITY_TAG, SOURCE_MODE_LABEL, labelOf } from '@/ui/labels.js';
import { getWorkbenchItem, listWorkbenchItems } from '@/services/workbenchApi.js';
import { getAlarm, getUavEvent } from '@/services/alarmApi.js';
import { riskApi } from '@/services/riskApi.js';

export const KINDS = ['UAV_EVENT', 'RISK', 'DEVICE_INCIDENT'];
export const kindLabel = { UAV_EVENT: '无人机告警', RISK: '飞行计划风险', DEVICE_INCIDENT: '设备告警' };
export const kindIcon = { UAV_EVENT: 'plane', RISK: 'plan', DEVICE_INCIDENT: 'device' };
export const kindModule = { UAV_EVENT: '异常告警中心', RISK: '飞行活动管理 · 全部风险事件', DEVICE_INCIDENT: '设备实时监测' };

/* 等级/风险状态字典已上提到 ui/labels.js 与处罚交接页共用；这里保留导出名。 */
export { SEVERITY_LABEL, SEVERITY_TAG };
export const STATE_LABEL = {
  UAV_EVENT: { PENDING_VERIFICATION: '待核实', EVIDENCE_REQUIRED: '证据待补充', CONFIRMED: '已核实，待处置', FALSE_POSITIVE: '误报' },
  RISK: RISK_STATE_LABEL,
  DEVICE_INCIDENT: { PENDING: '待处理', PROCESSING: '处理中', PENDING_VERIFICATION: '待验证', RECOVERED: '已恢复' }
};
/* 旧设备阶段词表：保留导出名，供仍按中文阶段渲染的消费者使用。 */
export const DEVICE_STAGES = ['待处理', '处理中', '待验证', '已恢复'];
export const CLOSED_STATES = new Set(['FALSE_POSITIVE', 'NOTIFIED', 'EXCLUDED', 'RECOVERED']);

export const BLOCKED_REASON_LABEL = {
  COUNTERMEASURE_NOT_CONNECTED: '联动反制与信号干扰尚未接入：属实后停留在“已核实，待处置”，不表示反制或处罚交接已执行',
  RECIPIENT_NOT_CONFIGURED: '交接接收方未配置，无法通知上级；不会以默认部门补值',
  DEVICE_RECOVERY_NOT_CONNECTED: '设备重启、恢复校验与关闭命令尚未接入工作台；只读展示，处置请到设备实时监测页'
};
export const AVAILABILITY_LABEL = { AVAILABLE: '已接入', FORBIDDEN: '无读取权限', UNCONFIGURED: '设备归属映射未配置' };
export const HANDOFF_NOT_WIRED = '通知上级待提交交接';

export function severityLabel(code) { return SEVERITY_LABEL[code] || (code ? String(code) : '未知'); }
export function severityTag(code) { return SEVERITY_TAG[code] || 't-gray'; }
export function stateLabel(kind, code) { return (STATE_LABEL[kind] || {})[code] || (code ? String(code) : '未知'); }
export function blockedLabel(code) { return code ? (BLOCKED_REASON_LABEL[code] || `阻断：${code}`) : ''; }
export function keyOf(item) { return `${item.kind}:${item.source_id}`; }
export function splitKey(key) {
  const idx = String(key || '').indexOf(':');
  return idx < 0 ? null : { kind: key.slice(0, idx), sourceId: key.slice(idx + 1) };
}

/* 每个事项只给出一个明确的下一步；未接入或缺前置条件的动作显式禁用并说明原因，不伪装成可执行。 */
function nextStep(item) {
  const actions = item.allowed_actions || [];
  const blocked = blockedLabel(item.blocked_reason);
  if (item.kind === 'UAV_EVENT') {
    if (actions.includes('VERIFY')) return { action: '人工核实', kind: 'verify', allowed: true, blocker: null, hint: '核实结论进入无人机事件核实历史；属实只表示已核实、待处置。' };
    if (item.state === 'PENDING_VERIFICATION' || item.state === 'EVIDENCE_REQUIRED') return { action: '人工核实', kind: 'verify', allowed: false, blocker: '需要 alarm:verify 核实权限', hint: '当前账号只能查看，不能提交核实结论。' };
    if (item.state === 'CONFIRMED') return { action: '联动反制', kind: 'countermeasure', allowed: false, blocker: blocked || BLOCKED_REASON_LABEL.COUNTERMEASURE_NOT_CONNECTED, hint: '已核实，待处置。' };
    return null;
  }
  if (item.kind === 'RISK') {
    if (actions.includes('VERIFY')) return { action: '人工核验', kind: 'verify', allowed: true, blocker: null, hint: '核验通过只进入“待通知”，不表示已通知上级。' };
    if (item.state === 'PENDING_VERIFICATION') return { action: '人工核验', kind: 'verify', allowed: false, blocker: '需要 risk:verify 核验权限', hint: '当前账号只能查看，不能提交核验结论。' };
    if (item.state === 'PENDING_NOTIFICATION') {
      if (actions.includes('NOTIFY')) return { action: '通知上级', kind: 'notify', allowed: true, blocker: null, hint: '提交交接材料后风险仍保持“待通知”；提交成功只表示材料入库，不等于已发送或已送达。' };
      return { action: '通知上级', kind: 'notify', allowed: false, blocker: blocked || '需要 handoff:create 交接权限', hint: '风险已核验通过，等待通知上级。' };
    }
    return null;
  }
  if (item.state === 'RECOVERED') return null;
  const label = item.state === 'PENDING_VERIFICATION' ? '恢复校验' : item.state === 'PROCESSING' ? '等待指令回执' : '远程重启';
  return { action: label, kind: 'device', allowed: false, blocker: blocked || BLOCKED_REASON_LABEL.DEVICE_RECOVERY_NOT_CONNECTED, hint: '工作台只读展示设备异常事实。' };
}

/* 后端事项 → 页面摘要（只做字段映射与文案，不推导任何服务端未给出的事实）。 */
export function summarize(item) {
  return {
    key: keyOf(item), kind: item.kind, kindLabel: kindLabel[item.kind] || item.kind, sourceId: item.source_id, sourceNo: item.source_no || '',
    title: item.title || '', summary: item.summary || '',
    severity: item.severity, level: severityLabel(item.severity), levelTag: severityTag(item.severity),
    state: item.state, sourceStatus: stateLabel(item.kind, item.state),
    statusBucket: CLOSED_STATES.has(item.state) ? 'completed' : 'pending',
    receivedAt: item.received_at, occurredAt: item.occurred_at ?? null, updatedAt: item.updated_at ?? null,
    version: item.version ?? null, allowedActions: item.allowed_actions || [], blockedReason: item.blocked_reason || null,
    blockedLabel: blockedLabel(item.blocked_reason), sourceMode: item.source_mode, sourceModeLabel: labelOf(SOURCE_MODE_LABEL, item.source_mode, ''), links: item.links || {},
    module: kindModule[item.kind], todo: nextStep(item)
  };
}

/** 无人机事件流程条：反制与通知处罚部门本期未接入，只能显示为“未接入”，不能显示为已完成。 */
export function uavSteps(state) {
  const verified = ['CONFIRMED', 'FALSE_POSITIVE'].includes(state);
  return [
    { n: '告警接收', done: true },
    { n: '人工核实', done: verified, act: !verified, t: state === 'EVIDENCE_REQUIRED' ? '证据待补充' : null },
    { n: '联动反制', done: false, act: false, t: state === 'FALSE_POSITIVE' ? '误报终止' : '未接入' },
    { n: '通知处罚部门', done: false, act: false, t: '未接入' }
  ];
}

/** 飞行风险流程条：按后端状态推导，排除是核验后的终态分支。 */
export function riskSteps(state) {
  if (state === 'EXCLUDED') return [
    { n: '风险发现', done: true }, { n: '人工核验', done: true }, { n: '已排除', done: true, t: '核验后判定无需通报' }
  ];
  const idx = state === 'NOTIFIED' ? 3 : state === 'PENDING_NOTIFICATION' ? 2 : 1;
  return [
    { n: '风险发现', done: true },
    { n: '人工核验', done: idx >= 2, act: idx === 1 },
    { n: '通知上级', done: idx >= 3, act: idx === 2, t: idx === 2 ? HANDOFF_NOT_WIRED : null }
  ];
}

export function deviceSteps(state) {
  const order = ['PENDING', 'PROCESSING', 'PENDING_VERIFICATION', 'RECOVERED'];
  const idx = Math.max(0, order.indexOf(state));
  return ['原因与确认', '下发重启', '等待回执', '恢复校验与关闭'].map((n, i) => ({ n, done: i < idx || state === 'RECOVERED', act: i === idx && state !== 'RECOVERED', t: i === idx && state !== 'RECOVERED' ? '未接入工作台' : null }));
}

export function stepsOf(kind, state) {
  return kind === 'UAV_EVENT' ? uavSteps(state) : kind === 'RISK' ? riskSteps(state) : deviceSteps(state);
}

/** 拉取一页工作台队列；返回摘要与同快照的计数/可用性。 */
export async function listWorkbenchEvents(query = {}) {
  const data = await listWorkbenchItems(query);
  return {
    items: (data.items || []).map(summarize), total: Number(data.total || 0), page: Number(data.page || 1), size: Number(data.size || 0),
    counts: data.counts_by_kind || {}, availability: data.source_availability || {}, asOf: data.as_of ?? null
  };
}

/** 顶部计数：counts_by_kind 为 null 表示无权限/未配置，不能显示成 0。 */
export function workbenchStats(data) {
  const counts = (data && data.counts) || {};
  const availability = (data && data.availability) || {};
  const byKind = {};
  KINDS.forEach(k => { byKind[k] = availability[k] === 'AVAILABLE' ? Number(counts[k] || 0) : null; });
  return { total: data ? Number(data.total || 0) : 0, byKind, availability, asOf: data ? data.asOf : null };
}

export async function getWorkbenchDetail(kind, sourceId) {
  const data = await getWorkbenchItem(kind, sourceId);
  const summary = summarize(data.item);
  return { kind, summary, item: data.item, timeline: data.timeline || [], availability: data.availability || {}, steps: stepsOf(kind, data.item.state) };
}

/** 核实弹窗需要源对象（含 version/allowed_actions）；告警读取失败不阻塞核实，只影响展示。 */
export async function loadUavSource(eventId) {
  const event = await getUavEvent(eventId);
  let alarm = null;
  if (event && event.alarm_id) { try { alarm = await getAlarm(event.alarm_id); } catch { alarm = null; } }
  return { event, alarm };
}
export function loadRiskSource(riskId) { return riskApi.getRisk(riskId); }

/** links 只接受服务端给出的站内 hash 路由；任何非 #/ 前缀的地址都不跳转。 */
export function navigateTo(link) {
  if (typeof link !== 'string' || !/^#\/[a-z][a-z0-9-]*(?:\?[^#]*)?$/.test(link)) return false;
  window.location.hash = link;
  return true;
}

function linkParam(link, name) {
  const idx = String(link || '').indexOf('?');
  if (idx < 0) return null;
  const value = new URLSearchParams(link.slice(idx + 1)).get(name);
  return value ? value : null;
}
function stash(page, ctx) {
  if (window.UI?.goto) { window.UI.goto(page, ctx); return true; }
  try { sessionStorage.setItem('goto.' + page, JSON.stringify(ctx)); } catch { /* 存储不可用时仍跳转，目标页按默认选中 */ }
  return navigateTo('#/' + page);
}

/* 源页面不解析 hash query，跳转沿用各页现有深链约定：告警页读 sessionStorage 的 alarm.sel；
   风险页 UI.consume('risk') 取 {risk}；监测页 UI.consume('monitor') 取 {device}。先写存储再改 hash。 */
export function openSourcePage(summary) {
  const link = summary?.links?.source;
  if (!navigateTo.test(link)) return false;
  if (summary.kind === 'UAV_EVENT') {
    const alarmId = linkParam(link, 'alarm_id');
    if (!alarmId) return false;
    try { sessionStorage.setItem('alarm.sel', alarmId); } catch { /* 同上 */ }
    return navigateTo('#/alarms');
  }
  if (summary.kind === 'RISK') return stash('risk', { risk: summary.sourceId });
  const deviceId = linkParam(link, 'device_id');
  return deviceId ? stash('monitor', { device: deviceId }) : false;
}
navigateTo.test = link => typeof link === 'string' && /^#\/[a-z][a-z0-9-]*(?:\?[^#]*)?$/.test(link);

/* ---- 以下为兼容旧消费者保留的导出名：本流程不再写内存状态，全部返回“未接入/请走源模块”的阻断结果。 ---- */
function notWired(msg) { return { ok: false, msg }; }
export function advanceUav() { return notWired(BLOCKED_REASON_LABEL.COUNTERMEASURE_NOT_CONNECTED); }
export function verifyUav() { return notWired('请使用共享核实弹窗（alarmApi.verifyUavEvent）提交核实结论'); }
export function actRisk() { return notWired('请使用共享核验弹窗（riskApi.verifyRisk）或交接接口，不再本地改写风险状态'); }
export function openDeviceReboot() { return false; }
export function verifyDeviceRecovery() { return notWired(BLOCKED_REASON_LABEL.DEVICE_RECOVERY_NOT_CONNECTED); }
