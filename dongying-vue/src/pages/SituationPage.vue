<script setup>
/* 融合感知指挥台：本期显式使用页面私有模拟源。
   模拟数据不会在接口失败时被当作真实数据，也不会发起任何真实设备指令。 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { createSituationMockSource } from '@/pages/situation/situationMock.js';
import { riskMatchesPlan, routeRiskIsActive } from '@/services/situationData.js';
import {
  UAV_FLOW_STORAGE_KEY, applyUavFlow, showEoVideo, skipCountermeasureApproval,
  uavProcessActions, uavProcessStatus
} from '@/pages/situation/situationUavFlow.js';
import { closeModal, openFormModal } from '@/ui/formModal.js';
import { openConfirm } from '@/ui/confirm.js';
import { openDisposalRequest } from '@/ui/disposalAuthModal.js';
import { disposalApi } from '@/services/disposalApi.js';
import {
  CORRIDOR_RELATION_LABEL, PLAN_STATUS_LABEL, RISK_STATE_LABEL, SEVERITY_LABEL, labelOf
} from '@/ui/labels.js';
import { toast } from '@/ui/nv.js';

const U = window.UI;
usePageChrome('situation');

const VIEWED_STORAGE_KEY = 'situation.mock.viewed.v1';
const SCENARIO_STORAGE_KEY = 'situation.mock.started-at.v1';
const RISK_ACTION_STORAGE_KEY = 'situation.mock.risk-actions.v1';
const mapHost = ref(null);
const snapshot = ref({ generatedAt: 0, simulated: true, devices: [], targets: [], alarms: [], flightPlans: [], risks: [], airspaces: [] });
const selection = ref(null);
const expandedType = ref('');
const alertTab = ref('target');
const fuseOpen = ref(false);
const source = createSituationMockSource({ startedAt: loadScenarioStartedAt() });
const layers = ref({ coverage: true, device: true, track: true, flightPlan: true, airspace: true });
const statusAnnouncement = ref('模拟场景准备中');
let viewedKeys = loadViewedKeys();
let riskActions = loadRiskActions();
let uavFlow = loadUavFlow();
let rawSnapshot = null;
let map = null;
let stopSource = null;

function loadScenarioStartedAt() {
  try {
    const stored = Number(sessionStorage.getItem(SCENARIO_STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) return stored;
    const startedAt = Date.now();
    sessionStorage.setItem(SCENARIO_STORAGE_KEY, String(startedAt));
    return startedAt;
  } catch {
    return Date.now();
  }
}

const devices = computed(() => snapshot.value.devices || []);
const alarms = computed(() => (snapshot.value.alarms || [])
  .filter(alarm => alarm.eventState !== 'FALSE_POSITIVE')
  .slice()
  .sort((a, b) => b.ts - a.ts));
const targets = computed(() => snapshot.value.targets || []);
const flightPlans = computed(() => snapshot.value.flightPlans || []);
const risks = computed(() => snapshot.value.risks || []);
const airspaces = computed(() => snapshot.value.airspaces || []);
const deviceStatusCounts = computed(() => devices.value.reduce((counts, device) => {
  counts[device.statusCode] = (counts[device.statusCode] || 0) + 1;
  return counts;
}, { ONLINE: 0, ABNORMAL: 0, OFFLINE: 0, UNKNOWN: 0 }));
const uavCount = computed(() => targets.value.filter(target => target.objectTypeCode === 'UAV').length);
const foreignObjectCount = computed(() => targets.value.length - uavCount.value);
const deviceGroups = computed(() => ['RADAR', 'EO', 'FIVE_G_A', 'TDOA'].map(typeCode => {
  const items = devices.value.filter(device => device.typeCode === typeCode);
  const sample = items[0] || {};
  const meters = items.map(device => device.coverage?.kind === 'sector' ? device.coverage.rangeM : device.coverage?.radiusM)
    .filter(Number.isFinite);
  const min = meters.length ? Math.min(...meters) : null;
  const max = meters.length ? Math.max(...meters) : null;
  const range = min == null ? '参数未知' : min === max ? `${min / 1000} km` : `${min / 1000}–${max / 1000} km`;
  return {
    typeCode, label: sample.type || typeCode, icon: sample.icon, color: sample.color,
    items, total: items.length, online: items.filter(device => device.statusCode === 'ONLINE').length,
    abnormal: items.filter(device => device.statusCode === 'ABNORMAL').length,
    offline: items.filter(device => device.statusCode === 'OFFLINE').length,
    hasNew: items.some(device => device.newAlert),
    rangeText: typeCode === 'EO' ? `单站 ${range} 定向视场` : `单站 ${range} 有效范围`
  };
}));
const newAlarmCount = computed(() => alarms.value.filter(alarm => alarm.isNew).length);
const newRiskCount = computed(() => risks.value.filter(risk => risk.active && risk.isNew).length);
const activeRiskCount = computed(() => risks.value.filter(risk => risk.active).length);
const selectedTarget = computed(() => {
  if (selection.value?.kind !== 'target') return null;
  return targets.value.find(target => target.id === selection.value.id) || null;
});
const fusionDevices = computed(() => {
  const ids = new Set(selectedTarget.value?.sourceDeviceIds || []);
  return devices.value.filter(device => ids.has(device.id));
});
const fusionConfidence = computed(() => selectedTarget.value?.fusedConf ?? null);
const clockText = computed(() => formatClock(snapshot.value.generatedAt));
const fuseIcon = U.icon('radar');

function loadViewedKeys() {
  try {
    const value = JSON.parse(sessionStorage.getItem(VIEWED_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(value) ? value.map(String) : []);
  } catch {
    return new Set();
  }
}

function loadRiskActions() {
  try {
    const value = JSON.parse(sessionStorage.getItem(RISK_ACTION_STORAGE_KEY) || '{}');
    return new Map(value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : []);
  } catch {
    return new Map();
  }
}

function eventKey(item) {
  return `${item?.id || ''}:${Number(item?.occurredAt ?? item?.ts ?? 0)}`;
}

function persistViewedKeys() {
  sessionStorage.setItem(VIEWED_STORAGE_KEY, JSON.stringify([...viewedKeys]));
}

function persistRiskActions() {
  sessionStorage.setItem(RISK_ACTION_STORAGE_KEY, JSON.stringify(Object.fromEntries(riskActions)));
}

function loadUavFlow() {
  try {
    const value = JSON.parse(sessionStorage.getItem(UAV_FLOW_STORAGE_KEY) || '{}');
    return new Map(value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : []);
  } catch {
    return new Map();
  }
}

function persistUavFlow() {
  sessionStorage.setItem(UAV_FLOW_STORAGE_KEY, JSON.stringify(Object.fromEntries(uavFlow)));
}

function saveUavFlow(alarmId, patch) {
  const current = uavFlow.get(alarmId) || {};
  uavFlow.set(alarmId, { ...current, ...patch });
  persistUavFlow();
  if (rawSnapshot) applySnapshot(rawSnapshot);
}

function isNewEvent(item) {
  return !viewedKeys.has(eventKey(item));
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function formatClock(value) {
  if (!Number(value)) return '—';
  return new Date(Number(value)).toLocaleTimeString('zh-CN', { hour12: false });
}

function reportAge(value) {
  if (!Number(value) || !snapshot.value.generatedAt) return '未上报';
  const seconds = Math.max(0, Math.round((snapshot.value.generatedAt - Number(value)) / 1000));
  if (seconds < 5) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  return `${Math.floor(seconds / 60)} 分钟前`;
}

function iconHtml(device) {
  return U.deviceIcon(device);
}

function statusClass(status) {
  return status === '在线' ? 'is-online' : status === '离线' ? 'is-offline' : 'is-warning';
}

function targetIconName(target) {
  return target?.iconKind === 'uav' ? 'plane' : target?.iconKind === 'bird' ? 'bird'
    : target?.iconKind === 'unknown' ? 'alert' : 'zone';
}

function formatMetric(value, unit = '') {
  return Number.isFinite(Number(value)) ? `${Number(value)}${unit}` : '未提供';
}

function planForRisk(risk) {
  return flightPlans.value.find(plan => riskMatchesPlan(risk, plan)) || null;
}

function riskFactText(risk) {
  const fact = risk?.spaceFact;
  if (!fact) return '空间事实未提供';
  const relation = labelOf(CORRIDOR_RELATION_LABEL, fact.corridorRelation);
  return Number.isFinite(Number(fact.distanceToRouteM)) ? `${relation} · ${Math.round(fact.distanceToRouteM)} m` : relation;
}

function toggleDeviceType(typeCode) {
  expandedType.value = expandedType.value === typeCode ? '' : typeCode;
}

function decorate(next) {
  const nextAlarms = (next.alarms || []).map(alarm => applyUavFlow({ ...alarm, isNew: isNewEvent(alarm) }, uavFlow));
  const nextRisks = (next.risks || []).filter(risk => !riskActions.has(eventKey(risk))).map(risk => ({
    ...risk,
    active: routeRiskIsActive(risk),
    isNew: routeRiskIsActive(risk) && isNewEvent(risk)
  }));
  const targetAlarms = new Map();
  const targetRisks = new Map();
  const planRisks = new Map();
  const candidatePlans = next.flightPlans || [];
  nextAlarms.forEach(alarm => {
    const rows = targetAlarms.get(alarm.targetId) || [];
    rows.push(alarm);
    targetAlarms.set(alarm.targetId, rows);
  });
  nextRisks.forEach(risk => {
    const byTarget = targetRisks.get(risk.targetId) || [];
    byTarget.push(risk);
    targetRisks.set(risk.targetId, byTarget);
    const matchingPlan = candidatePlans.find(plan => riskMatchesPlan(risk, plan));
    if (matchingPlan) {
      const byPlan = planRisks.get(matchingPlan.id) || [];
      byPlan.push(risk);
      planRisks.set(matchingPlan.id, byPlan);
    }
  });
  const nextDevices = (next.devices || []).map(device => {
    const relatedAlerts = (device.relatedAlerts || []).map(alarm => ({ ...alarm, isNew: isNewEvent(alarm) }));
    return { ...device, relatedAlerts, newAlert: relatedAlerts.some(alarm => alarm.isNew) };
  });
  const nextTargets = (next.targets || []).map(target => {
    const relatedAlarms = targetAlarms.get(target.id) || [];
    const openAlarms = relatedAlarms.filter(alarm => alarm.eventState !== 'FALSE_POSITIVE');
    const relatedRisks = targetRisks.get(target.id) || [];
    const activeRisks = relatedRisks.filter(risk => risk.active);
    return {
      ...target,
      activeRisk: openAlarms.length > 0 || activeRisks.length > 0,
      newAlert: openAlarms.some(alarm => alarm.isNew) || activeRisks.some(risk => risk.isNew),
      relatedAlarms,
      relatedRisks
    };
  });
  const severityRank = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
  const nextPlans = (next.flightPlans || []).map(plan => {
    const relatedRisks = planRisks.get(plan.id) || [];
    const activeRisks = relatedRisks.filter(risk => risk.active);
    const highest = activeRisks.slice().sort((left, right) => (severityRank[right.severity] || 0) - (severityRank[left.severity] || 0))[0];
    return {
      ...plan,
      statusLabel: labelOf(PLAN_STATUS_LABEL, plan.statusCode),
      relatedRisks,
      activeRisks,
      activeRiskCount: activeRisks.length,
      activeRiskLevel: highest?.severity || null,
      highestRisk: highest || null,
      newRisk: activeRisks.some(risk => risk.isNew)
    };
  });
  return { ...next, alarms: nextAlarms, risks: nextRisks, devices: nextDevices, targets: nextTargets, flightPlans: nextPlans };
}

function applySnapshot(next) {
  rawSnapshot = next;
  const decorated = decorate(next);
  snapshot.value = decorated;
  const count = decorated.alarms.filter(alarm => alarm.isNew).length + decorated.risks.filter(risk => risk.isNew).length;
  statusAnnouncement.value = count
    ? `模拟数据已更新，${count} 条新风险`
    : '模拟数据已更新，当前无未查看异常';
  if (!map) return;
  map.setData({
    airspaces: decorated.airspaces,
    devices: decorated.devices,
    targets: decorated.targets,
    flightPlans: decorated.flightPlans,
    risks: decorated.risks,
    alarms: []
  });
  if (selection.value) map.pinHit(selection.value.kind, selection.value.id);
}

function markViewed(rows) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  if (!list.length) return;
  let changed = false;
  list.forEach(alarm => {
    const key = eventKey(alarm);
    if (!viewedKeys.has(key)) {
      viewedKeys.add(key);
      changed = true;
    }
  });
  if (!changed) return;
  persistViewedKeys();
  if (rawSnapshot) applySnapshot(rawSnapshot);
}

function selectDevice(device) {
  if (!device) return;
  markViewed(device.relatedAlerts || []);
  selection.value = { kind: 'device', id: device.id };
  fuseOpen.value = false;
  if (map) {
    map.sel = null;
    map.planSel = null;
    map.centerAt(device.lon, device.lat, { scale: map.zoom });
    map.pinHit('device', device.id);
  }
}

function selectTarget(target) {
  if (!target) return;
  markViewed([...(target.relatedAlarms || []), ...(target.relatedRisks || []).filter(risk => risk.active)]);
  selection.value = { kind: 'target', id: target.id };
  if (map) {
    map.sel = target.id;
    map.planSel = null;
    map.centerAt(target.lon, target.lat, { scale: map.zoom });
    map.pinHit('target', target.id);
  }
}

function selectAlarm(alarm) {
  markViewed(alarm);
  alertTab.value = 'target';
  selectTarget(targets.value.find(target => target.id === alarm.targetId));
}

function selectPlan(plan, markRisks = true) {
  if (!plan) return;
  if (markRisks) markViewed((plan.activeRisks || []));
  selection.value = { kind: 'plan', id: plan.id };
  fuseOpen.value = false;
  if (map) {
    map.sel = null;
    map.planSel = plan.id;
    const point = plan.coordinates?.[Math.floor((plan.coordinates?.length || 1) / 2)];
    if (point) map.centerAt(point[0], point[1], { scale: map.zoom });
    map.pinHit('plan', plan.id);
  }
}

function selectRisk(risk) {
  if (!risk) return;
  markViewed(risk);
  alertTab.value = 'route';
  selectPlan(planForRisk(risk), false);
}

function submitMockRiskAction(plan, action) {
  const activeRisks = (plan?.activeRisks || []).filter(risk => routeRiskIsActive(risk));
  if (!activeRisks.length) return toast('当前航线已无可提交的风险', 'err');
  const state = action === 'exclude' ? 'EXCLUDED' : 'NOTIFIED';
  activeRisks.forEach(risk => riskActions.set(eventKey(risk), { state, submittedAt: Date.now() }));
  persistRiskActions();
  closeModal();
  if (rawSnapshot) applySnapshot(rawSnapshot);
  toast(action === 'exclude' ? '已提交（前端模拟）：风险已排除' : '已提交（前端模拟）：已通知上级', 'ok');
}

function openRiskActionModal(plan, action) {
  const activeRisks = (plan?.activeRisks || []).filter(risk => routeRiskIsActive(risk));
  if (!activeRisks.length) return toast('当前航线已无可提交的风险', 'err');
  const countText = activeRisks.length > 1 ? `本次将处理 ${activeRisks.length} 条当前风险。` : '';
  const isExclude = action === 'exclude';
  openFormModal({
    title: isExclude ? '排除风险' : '通知上级',
    width: '560px',
    warning: isExclude
      ? `提交后将把该航线当前风险标记为“已排除”，取消红色高亮，并从右上航线风险列表移除。${countText}本期仅记录前端模拟结果，不调用真实接口。`
      : `提交后通知渠道投递；送达后进入接收方确认，等待回执。回执“已驱离”即闭环，风险不进入处置。${countText}本期仅记录前端模拟结果，不调用真实接口。`,
    fields: [],
    danger: isExclude,
    confirmText: isExclude ? '确认排除' : '提交通知',
    onSubmit: async () => submitMockRiskAction(plan, action)
  });
}

function clearSelection() {
  selection.value = null;
  fuseOpen.value = false;
  if (!map) return;
  map.sel = null;
  map.planSel = null;
  map.clearPinnedHit();
}

function renderDeviceTip(device) {
  const coverage = device.coverage || { status: 'unknown' };
  const unavailable = coverage.status === 'unavailable';
  const coverageState = coverage.status === 'unknown' ? '覆盖参数未知'
    : unavailable ? `${device.coverageText}（当前不可用）` : device.coverageText;
  const related = (device.relatedAlerts || []).slice(0, 2);
  return `<section class="sit-map-pop sit-map-pop-device" style="--sensor:${esc(device.color)}">
    <header><span class="sit-map-pop-icon">${iconHtml(device)}</span><span><b>${esc(device.name)}</b><small class="mono">${esc(device.id)}</small></span>
      <button type="button" data-tip-act="close" aria-label="关闭设备详情">${U.icon('close')}</button></header>
    <div class="sit-map-pop-status"><span class="sit-state ${statusClass(device.status)}">${esc(device.status)}</span><span>最新上报 ${esc(reportAge(device.lastReportAt))}</span></div>
    <dl><dt>覆盖参数</dt><dd class="${unavailable ? 'is-unavailable' : ''}">${esc(coverageState)}</dd>
      ${coverage.availabilityReason ? `<dt>可用性</dt><dd class="is-unavailable">${esc(coverage.availabilityReason)}</dd>` : ''}
      <dt>参数来源</dt><dd>${esc(coverage.sourceLabel || '未提供')}</dd>
      <dt>更新时间</dt><dd class="mono">${formatClock(coverage.updatedAt)}</dd></dl>
    <div class="sit-map-pop-alerts"><b>相关设备告警</b>${related.length
      ? related.map(alarm => `<span class="${alarm.isNew ? 'is-new' : ''}">${esc(alarm.title)} · ${alarm.isNew ? '新异常' : '已查看，风险持续'}</span>`).join('')
      : '<span>当前无关联告警</span>'}</div>
  </section>`;
}

function renderTargetActions(target) {
  const alarm = (target.relatedAlarms || [])[0];
  const buttons = [];
  if (showEoVideo(target, devices.value)) {
    buttons.push('<button type="button" data-tip-act="eo-video">光电视频</button>');
  }
  if (target.objectTypeCode === 'UAV' && alarm) {
    const process = uavProcessActions(alarm);
    if (process.includes('false-positive')) buttons.push('<button type="button" data-tip-act="false-positive">误报</button>');
    if (process.includes('counter')) buttons.push('<button type="button" class="is-danger" data-tip-act="counter">反制</button>');
    if (process.includes('punish')) buttons.push('<button type="button" data-tip-act="punish">通知处罚部门</button>');
  }
  return buttons.length ? `<div class="sit-map-pop-actions">${buttons.join('')}</div>` : '';
}

function renderTargetTip(target) {
  const alarm = (target.relatedAlarms || [])[0];
  const routeRisk = (target.relatedRisks || []).find(risk => risk.active);
  const sourceNames = devices.value.filter(device => (target.sourceDeviceIds || []).includes(device.id)).map(device => device.type).join(' / ');
  const summary = alarm?.type || routeRisk?.reasonText || '暂无关联异常';
  const processStatus = alarm ? uavProcessStatus(alarm) : '';
  const stateText = processStatus || (target.activeRisk ? '风险持续' : '跟踪中');
  const stateClass = alarm?.eventState === 'FALSE_POSITIVE' || processStatus === '已移送处罚' || processStatus === '已干扰'
    ? 'is-online' : (target.activeRisk || processStatus === '信号干扰中' || processStatus === '待审批' ? 'is-risk' : 'is-online');
  return `<section class="sit-map-pop sit-map-pop-target${target.newAlert ? ' is-new' : ''}" style="--sensor:${target.objectTypeCode === 'UAV' ? '#2fd06e' : '#72d6ff'}">
    <header><span class="sit-map-pop-icon">${U.icon(targetIconName(target))}</span><span><b>${esc(target.id)}</b><small>${esc(target.typeLabel)}</small></span>
      <button type="button" data-tip-act="close" aria-label="关闭目标详情">${U.icon('close')}</button></header>
    <div class="sit-map-pop-status"><span class="sit-state ${stateClass}">${esc(stateText)}</span><span>${esc(summary)}</span></div>
    <div class="sit-target-metrics"><span><small>高度</small><b>${esc(formatMetric(target.alt, ' m'))}</b></span><span><small>速度</small><b>${esc(formatMetric(target.speed, ' m/s'))}</b></span><span><small>融合置信</small><b>${esc(formatMetric(target.fusedConf, '%'))}</b></span></div>
    <p>感知来源：${esc(sourceNames || '未提供')}</p>
    ${target.objectTypeCode === 'UAV' ? '<p class="sit-eo-track">光电跟踪中</p>' : ''}
    ${target.activeRisk || alarm ? '' : '<div class="sit-map-pop-note">目标处于模拟实时跟踪中。</div>'}
    ${renderTargetActions(target)}
  </section>`;
}

function renderPlanTip(plan) {
  const risks = plan.relatedRisks || [];
  const active = plan.activeRisks || [];
  const highest = plan.highestRisk;
  return `<section class="sit-map-pop sit-map-pop-plan" style="--sensor:${active.length ? '#ff5b61' : '#22d3ee'}">
    <header><span class="sit-map-pop-icon">${U.icon('plan')}</span><span><b>${esc(plan.planNo)}</b><small class="mono">${esc(plan.routeVersionId)}</small></span>
      <button type="button" data-tip-act="close" aria-label="关闭计划详情">${U.icon('close')}</button></header>
    <div class="sit-map-pop-status"><span class="sit-state ${active.length ? 'is-risk' : 'is-online'}">${esc(plan.statusLabel)}</span><span>${active.length ? `${active.length} 条当前风险` : '无当前风险'}</span></div>
    <dl><dt>计划时段</dt><dd>${esc(formatClock(plan.startAt))} ～ ${esc(formatClock(plan.endAt))}</dd>
      <dt>关联无人机</dt><dd class="mono">${esc(plan.uavId || '未提供')}</dd>
      <dt>历史风险</dt><dd>${risks.length} 条</dd>
      <dt>最高等级</dt><dd>${highest ? esc(labelOf(SEVERITY_LABEL, highest.severity)) : '无'}</dd></dl>
    ${active.length ? `<div class="sit-map-pop-actions"><button type="button" class="is-danger" data-tip-act="exclude-risk">排除风险</button><button type="button" data-tip-act="notify-superior">通知上级</button></div>` : ''}
  </section>`;
}

function renderMapTip(hit) {
  if (hit?.kind === 'device') return renderDeviceTip(hit.data);
  if (hit?.kind === 'target') return renderTargetTip(hit.data);
  if (hit?.kind === 'plan') return renderPlanTip(hit.data);
  return null;
}

function onMapPick(hit) {
  if (hit?.kind === 'device') selectDevice(devices.value.find(device => device.id === hit.data.id));
  if (hit?.kind === 'target') selectTarget(targets.value.find(target => target.id === hit.data.id));
  if (hit?.kind === 'plan') selectPlan(flightPlans.value.find(plan => plan.id === hit.data.id));
}

function targetAlarm(target) {
  return (target?.relatedAlarms || [])[0] || null;
}

function openFalsePositive(target) {
  const alarm = targetAlarm(target);
  if (!alarm) return toast('没有关联告警，无法核实', 'err');
  openFormModal({
    title: `人工核实 · ${esc(alarm.targetId)}`,
    width: '600px',
    introHtml: `<dl class="kv"><dt>当前状态</dt><dd>${esc(uavProcessStatus(alarm))}</dd><dt>告警</dt><dd>${esc(alarm.type)}</dd><dt>关联目标</dt><dd class="mono">${esc(target.id)}</dd></dl>`,
    fields: [
      { key: 'conclusion', label: '核实结论', type: 'radio', required: true, options: [
        { value: 'CONFIRMED', label: '属实（置为“已核实，待处置”）' },
        { value: 'FALSE_POSITIVE', label: '误报（终态）' }
      ] },
      { key: 'note', label: '核实说明', type: 'textarea', required: true, minRows: 4, placeholder: '必填，1–1000 字：现场确认、轨迹复核、飞手联系结果等依据' }
    ],
    initial: { conclusion: 'FALSE_POSITIVE', note: '' },
    confirmText: '提交核实结论',
    validate: m => {
      const n = String(m.note || '').trim();
      return !n ? '核实说明为必填项' : n.length > 1000 ? `核实说明不能超过 1000 字（当前 ${n.length} 字）` : '';
    },
    onSubmit: async ({ conclusion, note }) => {
      saveUavFlow(alarm.id, {
        eventState: conclusion,
        disposalStage: 'none',
        handoff: false,
        note: String(note).trim()
      });
      closeModal();
      toast(conclusion === 'FALSE_POSITIVE' ? '核实完成：误报' : '核实完成：已核实，待处置', 'ok');
    }
  });
}

async function openCountermeasure(target) {
  const alarm = targetAlarm(target);
  if (!alarm) return toast('没有关联告警，无法发起反制', 'err');
  if (alarm.eventState !== 'CONFIRMED') return toast('请先完成核实', 'err');
  let policy = null;
  try { policy = await disposalApi.policies(); } catch { policy = null; }
  const skipApproval = skipCountermeasureApproval(alarm, target);
  openDisposalRequest({
    actionType: 'COUNTERMEASURE',
    actionOptions: ['COUNTERMEASURE', 'JAMMING'],
    subjectKind: 'UAV_EVENT',
    subjectId: alarm.id,
    subjectText: target.id,
    policy,
    okText: result => (skipApproval ? '已进入信号干扰中' : `申请已提交：${result?.authorization_no || ''} 待审批`),
    submit: async body => {
      saveUavFlow(alarm.id, {
        eventState: 'CONFIRMED',
        disposalStage: skipApproval ? 'jamming' : 'requested',
        handoff: false,
        actionType: body.action_type,
        channel: body.channel,
        deviceId: body.device_id,
        reason: body.reason
      });
      return { authorization_no: skipApproval ? '' : `SIM-${alarm.id}`, status: skipApproval ? 'EXECUTING' : 'REQUESTED' };
    }
  });
}

async function openPunish(target) {
  const alarm = targetAlarm(target);
  if (!alarm) return toast('没有关联告警，无法移送处罚', 'err');
  const sourceNo = target.id;
  const recipient = '处罚接收方';
  const ok = await new Promise(resolve => openConfirm({
    title: '通知处罚部门',
    message: `将把 ${sourceNo} 的处罚交接通知「${recipient}」。确认后只记录已提交通知，不表示处罚已立案或办结。是否继续？`,
    confirmText: '确认通知',
    onConfirm: () => { resolve(true); return true; },
    onCancel: () => resolve(false)
  }));
  if (!ok) return;
  saveUavFlow(alarm.id, { eventState: 'CONFIRMED', disposalStage: 'completed', handoff: true });
  toast('已提交', 'ok');
}

function onTipAction(action, hit) {
  if (action === 'close') return clearSelection();
  if (action === 'eo-video') {
    toast('暂未接入', 'err');
    return;
  }
  const plan = hit?.kind === 'plan'
    ? flightPlans.value.find(item => item.id === hit.data.id)
    : (selection.value?.kind === 'plan' ? flightPlans.value.find(item => item.id === selection.value.id) : null);
  if (action === 'exclude-risk') openRiskActionModal(plan, 'exclude');
  if (action === 'notify-superior') openRiskActionModal(plan, 'notify');
  const target = hit?.kind === 'target'
    ? targets.value.find(item => item.id === hit.data.id)
    : (selection.value?.kind === 'target' ? selectedTarget.value : null);
  if (!target) return;
  if (action === 'false-positive') openFalsePositive(target);
  if (action === 'counter') openCountermeasure(target);
  if (action === 'punish') openPunish(target);
}

function toggleLayer(key) {
  layers.value = { ...layers.value, [key]: !layers.value[key] };
  if (!map) return;
  if (key === 'airspace') {
    ['nofly', 'limit', 'suit'].forEach(layer => map.setLayer(layer, layers.value.airspace));
    return;
  }
  map.setLayer(key, layers.value[key]);
}

function toggleFuse() {
  if (selectedTarget.value) fuseOpen.value = !fuseOpen.value;
}

function onVisibilityChange() {
  if (document.hidden) source.pause();
  else source.resume();
  if (map?.setPaused) map.setPaused(document.hidden);
}

onMounted(() => {
  map = new window.MapView(mapHost.value, {
    maxDev: 120,
    maxAlarm: 0,
    zoom: 1,
    legend: false,
    fusionProfile: true,
    sensorIconScale: .82,
    maxDpr: 2,
    layers: { alarm: false, coverage: true },
    interactiveTip: true,
    renderTip: renderMapTip,
    onTipAction,
    onPick: onMapPick,
    onEmptyPick: clearSelection
  });
  stopSource = source.start(applySnapshot);
  document.addEventListener('visibilitychange', onVisibilityChange);
});

onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange);
  if (stopSource) stopSource();
  stopSource = null;
  source.stop();
  if (map) map.destroy();
  map = null;
});
</script>

<template>
  <div id="view" class="view situation-page" @keydown.esc="clearSelection">
    <main class="sit-stage" aria-label="融合感知实时地图">
      <div id="stMap" ref="mapHost" class="sit-map"></div>

      <div class="sit-live-pill" aria-label="当前使用非生产模拟数据">
        <span class="sit-live-dot" aria-hidden="true"></span>
        <b>模拟数据</b>
        <span>非生产实时数据</span>
        <span>监测目标 {{ targets.length }} · 无人机 {{ uavCount }} · 异物 {{ foreignObjectCount }}</span>
        <time class="mono">{{ clockText }}</time>
      </div>
      <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ statusAnnouncement }}</p>

      <aside class="sit-glass sit-device-dock" aria-labelledby="sit-device-title">
        <header class="sit-dock-head">
          <span><small>SENSING FIELD</small><b id="sit-device-title">感知设备</b></span>
          <em class="sit-device-summary"><i></i>{{ deviceStatusCounts.ONLINE }}在线 <span>{{ deviceStatusCounts.ABNORMAL }}异常</span> {{ deviceStatusCounts.OFFLINE }}离线</em>
        </header>
        <div class="sit-device-list">
          <section v-for="group in deviceGroups" :key="group.typeCode" class="sit-device-group" :style="{ '--sensor': group.color }">
            <button type="button" class="sit-device-row"
              :class="{ 'is-selected': group.items.some(device => selection?.kind === 'device' && selection.id === device.id), 'has-new': group.hasNew }"
              :aria-expanded="expandedType === group.typeCode" :aria-controls="`sit-device-${group.typeCode}`"
              :aria-label="`${expandedType === group.typeCode ? '收起' : '展开'}${group.label}设备，共${group.total}台`"
              @click="toggleDeviceType(group.typeCode)">
              <span class="sit-device-icon" v-html="iconHtml(group)"></span>
              <span class="sit-device-copy"><b>{{ group.label }}<small>{{ group.total }} 台</small></b><em>{{ group.rangeText }}</em></span>
              <span class="sit-device-state"><b>{{ group.online }}在线</b><small>{{ group.abnormal }}异常 · {{ group.offline }}离线</small></span>
            </button>
            <div v-show="expandedType === group.typeCode" :id="`sit-device-${group.typeCode}`" class="sit-device-node-list">
              <button v-for="device in group.items" :key="device.id" type="button" class="sit-device-node"
                :class="[{ 'is-selected': selection?.kind === 'device' && selection.id === device.id, 'has-new': device.newAlert }, statusClass(device.status)]"
                :aria-pressed="selection?.kind === 'device' && selection.id === device.id"
                :aria-label="`查看${device.type}设备 ${device.name}，${device.status}${device.hasAlarm ? '，存在告警' : ''}`" @click="selectDevice(device)">
                <span><i></i><b>{{ device.name }}</b><small class="mono">{{ device.id }}</small></span>
                <em>{{ device.status }} · {{ reportAge(device.lastReportAt) }}</em>
              </button>
            </div>
          </section>
        </div>
        <footer>共 {{ devices.length }} 台模拟设备；覆盖参数为公开指标量级，非现场实测。</footer>
      </aside>

      <aside class="sit-glass sit-alert-dock" aria-labelledby="sit-alert-title">
        <header class="sit-dock-head">
          <span><small>TARGET / ROUTE RISK</small><b id="sit-alert-title">实时风险</b></span>
          <em :class="{ 'has-new': newAlarmCount + newRiskCount }">{{ newAlarmCount + newRiskCount ? `${newAlarmCount + newRiskCount} 条未查看` : `${activeRiskCount} 条当前风险` }}</em>
        </header>
        <div class="sit-risk-tabs" role="tablist" aria-label="风险类型">
          <button type="button" role="tab" :aria-selected="alertTab === 'target'" @click="alertTab = 'target'">目标异常 <b>{{ alarms.length }}</b></button>
          <button type="button" role="tab" :aria-selected="alertTab === 'route'" @click="alertTab = 'route'">航线风险 <b>{{ risks.length }}</b></button>
        </div>
        <div v-if="alertTab === 'target'" class="sit-alert-list" role="tabpanel" aria-label="目标异常">
          <button v-for="alarm in alarms" :key="eventKey(alarm)" type="button" class="sit-alert-row"
            :class="[{ 'is-new': alarm.isNew, 'is-selected': selection?.kind === 'target' && selection.id === alarm.targetId }, `level-${alarm.level}`]"
            :aria-pressed="selection?.kind === 'target' && selection.id === alarm.targetId"
            :aria-label="`查看${alarm.targetId}的${alarm.type}，${alarm.isNew ? '新异常' : '已查看，风险持续'}`" @click="selectAlarm(alarm)">
            <span class="sit-alert-level">{{ alarm.level }}</span>
            <span class="sit-alert-copy"><b class="mono">{{ alarm.targetId }}</b><em>{{ alarm.type }} · {{ alarm.district }}</em></span>
            <span class="sit-alert-meta"><time class="mono">{{ formatClock(alarm.ts) }}</time><b>{{ alarm.isNew ? '新异常' : '已查看，风险持续' }}</b></span>
          </button>
        </div>
        <div v-else class="sit-alert-list" role="tabpanel" aria-label="航线风险">
          <button v-for="risk in risks" :key="eventKey(risk)" type="button" class="sit-alert-row sit-route-risk-row"
            :class="[{ 'is-new': risk.isNew, 'is-history': !risk.active, 'is-selected': selection?.kind === 'plan' && selection.id === risk.planId }, `level-${risk.level}`]"
            :aria-pressed="selection?.kind === 'plan' && selection.id === risk.planId"
            :aria-label="`查看${planForRisk(risk)?.planNo || risk.planId}的${risk.spaceFact?.subtypeName || '异物'}风险，${risk.isNew ? '新风险' : labelOf(RISK_STATE_LABEL, risk.state)}`" @click="selectRisk(risk)">
            <span class="sit-alert-level">{{ risk.level }}</span>
            <span class="sit-alert-copy"><b class="mono">{{ planForRisk(risk)?.planNo || risk.planId }}</b><em>{{ risk.spaceFact?.subtypeName || '空中异物' }} · {{ riskFactText(risk) }}</em></span>
            <span class="sit-alert-meta"><time class="mono">{{ formatClock(risk.occurredAt) }}</time><b>{{ risk.isNew ? '新风险' : labelOf(RISK_STATE_LABEL, risk.state) }}</b></span>
          </button>
        </div>
        <footer>查看只停止提示动画；当前风险仍按业务状态保留。</footer>
      </aside>

      <nav class="sit-layerbar" aria-label="地图图层">
        <button type="button" :aria-pressed="layers.coverage" @click="toggleLayer('coverage')">覆盖范围</button>
        <button type="button" :aria-pressed="layers.device" @click="toggleLayer('device')">设备点位</button>
        <button type="button" :aria-pressed="layers.track" @click="toggleLayer('track')">目标轨迹</button>
        <button type="button" :aria-pressed="layers.flightPlan" @click="toggleLayer('flightPlan')">计划航线</button>
        <button type="button" :aria-pressed="layers.airspace" :aria-label="`防控空域，共${airspaces.length}个区域`" @click="toggleLayer('airspace')">防控空域 {{ airspaces.length }}</button>
        <span class="sit-plan-key" aria-label="航线状态图例"><i class="is-pending"></i>待执行<i class="is-executing"></i>执行中<i class="is-completed"></i>已完成<i class="is-risk"></i>当前风险</span>
      </nav>

      <aside v-if="selectedTarget" class="sit-fuse-dock" :class="{ 'is-open': fuseOpen }" aria-label="多源融合结果">
        <button type="button" class="sit-fuse-orb" :aria-expanded="fuseOpen"
          :aria-label="fuseOpen ? '收起多源融合' : '展开多源融合'" @click="toggleFuse">
          <span class="sit-fuse-orb-cap"><small>多源融合</small><b>{{ fusionConfidence ?? '—' }}%</b></span>
          <span class="sit-fuse-orb-ball" aria-hidden="true"><span v-html="fuseIcon"></span></span>
        </button>
        <section class="sit-glass sit-fuse-panel">
          <header class="sit-dock-head"><span><small>FUSION LINKS</small><b>{{ selectedTarget.id }}</b></span><em>{{ fusionConfidence }}% 置信</em></header>
          <div class="sit-fuse-links">
            <span v-for="device in fusionDevices" :key="device.id" :style="{ '--sensor': device.color }">
              <i></i><b>{{ device.type }}</b><em>{{ device.status }}</em>
            </span>
          </div>
          <p>各来源为模拟链路，不代表现场已联调。</p>
        </section>
      </aside>
    </main>
  </div>
</template>
