<script setup>
/* 融合感知指挥台：页面结构保持不变，全部业务状态来自后端领域接口。 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { createSituationApiSource } from '@/pages/situation/situationApiSource.js';
import { riskMatchesPlan, routeRiskIsActive } from '@/services/situationData.js';
import {
  disposalStage, showEoVideo, uavProcessActions, uavProcessStatus
} from '@/pages/situation/situationFlow.js';
import { closeModal, openFormModal } from '@/ui/formModal.js';
import { getUavEvent, verifyUavEvent } from '@/services/alarmApi.js';
import { riskApi, newRiskIdempotencyKey } from '@/services/riskApi.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import {
  CORRIDOR_RELATION_LABEL, PLAN_STATUS_LABEL, RISK_STATE_LABEL, SEVERITY_LABEL, labelOf
} from '@/ui/labels.js';
import { toast } from '@/ui/nv.js';
import { getAlarm } from '@/services/alarmApi.js';
import SituationAdvisoryCard from './situation/SituationAdvisoryCard.vue';
import SituationAlarmPopup from './situation/SituationAlarmPopup.vue';
import { autoSmsView } from '@/components/disposal/autoSmsView.js';

const U = window.UI;
usePageChrome('situation');

const VIEWED_STORAGE_KEY = 'situation.viewed.v1';
const mapHost = ref(null);
const snapshot = ref({ generatedAt: 0, sourceMode: 'unknown', simulated: false, devices: [], targets: [], alarms: [], flightPlans: [], risks: [], airspaces: [], handoffs: [] });
const selection = ref(null);
const advisorySummaries = ref({});
const expandedType = ref('');
const alertTab = ref('target');
const fuseOpen = ref(false);
const source = createSituationApiSource();
const layers = ref({ coverage: true, device: true, track: true, flightPlan: true, airspace: true });
const statusAnnouncement = ref('正在连接融合感知服务');
let viewedKeys = loadViewedKeys();
let rawSnapshot = null;
let map = null;
let stopSource = null;
let lastSourceErrorAt = 0;

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
const selectedUavAlarm = computed(() => {
  if (selection.value?.kind === 'alarm' || selection.value?.alarmId) {
    const alarmId = selection.value.alarmId || selection.value.id;
    return alarms.value.find(item => item.alarmId === alarmId) || null;
  }
  return selectedTarget.value?.objectTypeCode === 'UAV' ? targetAlarm(selectedTarget.value) : null;
});
const showAlarmPopup = computed(() => alertTab.value === 'target' && !!selectedUavAlarm.value);
const fusionDevices = computed(() => {
  const ids = new Set(selectedTarget.value?.sourceDeviceIds || []);
  return devices.value.filter(device => ids.has(device.fusionDeviceId || device.deviceId));
});
const fusionConfidence = computed(() => selectedTarget.value?.fusedConf ?? null);
const clockText = computed(() => formatClock(snapshot.value.generatedAt));
const sourceModeText = computed(() => snapshot.value.sourceMode === 'replay' ? '回放数据'
  : snapshot.value.sourceMode === 'live' ? '实时数据'
    : snapshot.value.sourceMode === 'mixed' ? '混合数据' : '来源待确认');
const sourceModeDetail = computed(() => snapshot.value.sourceMode === 'replay' ? 'MQTT 测试回放来源'
  : snapshot.value.sourceMode === 'live' ? '现场实时接入来源'
    : snapshot.value.sourceMode === 'mixed' ? '实时与回放来源并存' : '后端暂未返回来源状态');
const fuseIcon = U.icon('radar');

function loadViewedKeys() {
  try {
    const value = JSON.parse(sessionStorage.getItem(VIEWED_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(value) ? value.map(String) : []);
  } catch {
    return new Set();
  }
}

function eventKey(item) {
  return `${item?.id || ''}:${Number(item?.occurredAt ?? item?.ts ?? 0)}`;
}

function persistViewedKeys() {
  sessionStorage.setItem(VIEWED_STORAGE_KEY, JSON.stringify([...viewedKeys]));
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

function targetIconHtml(target) {
  return U.targetIcon(target);
}

function formatMetric(value, unit = '') {
  return Number.isFinite(Number(value)) ? `${Number(value)}${unit}` : '未提供';
}

function actionIdempotencyKey(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
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
  const targetsByInternalId = new Map((next.targets || []).map(target => [target.targetId, target]));
  const punishmentEvents = new Set((next.handoffs || [])
    .filter(row => row.source_kind === 'UAV_EVENT' && row.handoff_type === 'UAV_PUNISHMENT' && row.delivery_status !== 'FAILED')
    .map(row => row.source_id));
  const nextAlarms = (next.alarms || []).map(alarm => {
    const target = targetsByInternalId.get(alarm.targetInternalId);
    return {
      ...alarm,
      isNew: isNewEvent(alarm),
      disposalStage: disposalStage(target?.disposalSummary),
      handoff: punishmentEvents.has(alarm.eventId)
    };
  });
  const nextRisks = (next.risks || []).map(risk => ({
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
    ? `融合感知数据已更新，${count} 条新风险`
    : '融合感知数据已更新，当前无未查看异常';
  if (!map) return;
  map.setData({
    airspaces: decorated.airspaces,
    devices: decorated.devices,
    targets: decorated.targets,
    flightPlans: decorated.flightPlans,
    risks: decorated.risks,
    alarms: []
  });
  if (selection.value && selection.value.kind !== 'alarm') map.pinHit(selection.value.kind, selection.value.id);
}

function onSourceError(error, segment) {
  statusAnnouncement.value = `${segment}数据刷新失败，已保留上次真实结果`;
  const at = Date.now();
  if (at - lastSourceErrorAt > 15_000) {
    lastSourceErrorAt = at;
    toast(`${segment}刷新失败：${error?.message || '服务异常'}；已保留上次结果`, 'err');
  }
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

function selectTarget(target, alarmId) {
  if (!target) return;
  alertTab.value = 'target';
  markViewed([...(target.relatedAlarms || []), ...(target.relatedRisks || []).filter(risk => risk.active)]);
  selection.value = { kind: 'target', id: target.id, alarmId };
  if (map) {
    map.sel = target.id;
    map.planSel = null;
    map.centerAt(target.lon, target.lat, { scale: map.zoom });
    map.pinHit('target', target.id);
  }
  source.loadTargetDetail(target.targetId).catch(error => onSourceError(error, '目标来源链路'));
}

function selectAlarm(alarm) {
  markViewed(alarm);
  alertTab.value = 'target';
  const target = targets.value.find(target => target.targetId === alarm.targetInternalId);
  if (target) selectTarget(target, alarm.alarmId);
  else {
    // 目标不在当前监测窗口，仍查看被点击的同一事件，不能沿用前一个目标。
    selection.value = { kind: 'alarm', id: alarm.alarmId };
    fuseOpen.value = false;
    if (map) { map.sel = null; map.planSel = null; map.clearPinnedHit(); }
  }
}

function alarmAnchor() {
  const target = selectedTarget.value;
  return map && Number.isFinite(target?.lon) && Number.isFinite(target?.lat)
    ? map.px(target.lon, target.lat) : null;
}

function isSelectedAlarm(alarm) {
  return selection.value?.kind === 'alarm' ? selection.value.id === alarm.alarmId
    : selection.value?.kind === 'target' && selection.value.id === alarm.targetId
      && (!selection.value.alarmId || selection.value.alarmId === alarm.alarmId);
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

async function readRiskAfterUncertain(riskId, acceptedStates) {
  try {
    const latest = await riskApi.getRisk(riskId);
    return acceptedStates.includes(latest?.state) ? latest : null;
  } catch {
    return null;
  }
}

async function verifyRiskState(risk, conclusion, note, acceptedStates) {
  const latest = await riskApi.getRisk(risk.riskId);
  if (acceptedStates.includes(latest.state)) return latest;
  try {
    return await riskApi.verifyRisk(risk.riskId, {
      conclusion, note, expected_version: Number(latest.version)
    }, newRiskIdempotencyKey());
  } catch (error) {
    if (isUncertainOutcome(error)) {
      const readback = await readRiskAfterUncertain(risk.riskId, acceptedStates);
      if (readback) return readback;
    }
    throw error;
  }
}

async function notifyRisk(risk, recipients) {
  let latest = await riskApi.getRisk(risk.riskId);
  if (['NOTIFIED', 'ACKNOWLEDGED'].includes(latest.state)) return latest;
  if (latest.state === 'PENDING_VERIFICATION') {
    latest = await verifyRiskState(risk, 'CONFIRMED', '融合感知页一键通知前复核：轨迹、计划与空间风险事实一致。',
      ['PENDING_NOTIFICATION', 'NOTIFIED', 'ACKNOWLEDGED']);
  }
  if (['NOTIFIED', 'ACKNOWLEDGED'].includes(latest.state)) return latest;
  if (latest.state !== 'PENDING_NOTIFICATION') throw new Error('当前风险状态不允许通知');
  if (recipients.length !== 1) throw new Error(recipients.length ? '存在多个风险接收方，请到风险业务页选择' : '尚未配置风险接收方');
  try {
    return await handoffApi.createHandoff({
      source_kind: 'RISK', source_id: risk.riskId, handoff_type: 'RISK_NOTICE',
      recipient_id: recipients[0].recipient_id, expected_version: Number(latest.version)
    }, newHandoffIdempotencyKey());
  } catch (error) {
    if (isUncertainOutcome(error)) {
      const readback = await readRiskAfterUncertain(risk.riskId, ['NOTIFIED', 'ACKNOWLEDGED']);
      if (readback) return readback;
    }
    throw error;
  }
}

async function submitRiskAction(plan, action) {
  const activeRisks = (plan?.activeRisks || []).filter(risk => routeRiskIsActive(risk));
  if (!activeRisks.length) return toast('当前航线已无可提交的风险', 'err');
  let recipients = [];
  if (action === 'notify') recipients = (await handoffApi.listHandoffRecipients('RISK_NOTICE'))?.items || [];
  const settled = await Promise.allSettled(activeRisks.map(risk => action === 'exclude'
    ? verifyRiskState(risk, 'EXCLUDED', '融合感知页批量排除：当前风险尚未通知，经人工操作确认排除。', ['EXCLUDED'])
    : notifyRisk(risk, recipients)));
  closeModal();
  await source.refresh();
  const succeeded = settled.filter(result => result.status === 'fulfilled').length;
  const failed = settled.length - succeeded;
  if (!failed) return toast(action === 'exclude' ? `已排除 ${succeeded} 条风险` : `已通知 ${succeeded} 条风险`, 'ok');
  const firstError = settled.find(result => result.status === 'rejected')?.reason;
  toast(`已成功 ${succeeded} 条，失败 ${failed} 条：${firstError?.message || '请查看最新状态'}`, 'err');
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
      ? `提交后将把该航线所有尚未通知的当前风险正式标记为“已排除”，并写入核验历史。${countText}`
      : `待核验风险将先以固定审计说明确认，再向唯一风险接收方提交交接；送达和回执状态以后端记录为准。${countText}`,
    fields: [],
    danger: isExclude,
    confirmText: isExclude ? '确认排除' : '提交通知',
    onSubmit: async () => submitRiskAction(plan, action)
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
  const alarm = targetAlarm(target);
  const buttons = [];
  if (showEoVideo(target, devices.value)) {
    buttons.push('<button type="button" data-tip-act="eo-video">光电视频</button>');
  }
  if (target.objectTypeCode === 'UAV' && alarm) {
    const process = uavProcessActions(alarm);
    if (process.includes('false-positive')) buttons.push('<button type="button" data-tip-act="false-positive">误报</button>');
    if (alarm.eventState !== 'FALSE_POSITIVE') buttons.push('<button type="button" data-tip-act="disposal-flow">处置流程</button>');
  }
  return buttons.length ? `<div class="sit-map-pop-actions">${buttons.join('')}</div>` : '';
}

function renderTargetTip(target) {
  const alarm = targetAlarm(target);
  const notification = alarm?.eventId ? advisorySummaries.value[alarm.eventId] : null;
  const sms = notification ? autoSmsView(notification) : null;
  const routeRisk = (target.relatedRisks || []).find(risk => risk.active);
  const sourceNames = devices.value.filter(device => (target.sourceDeviceIds || []).includes(device.fusionDeviceId || device.deviceId))
    .map(device => device.type).join(' / ');
  const summary = alarm?.type || routeRisk?.reasonText || '暂无关联异常';
  const processStatus = alarm ? uavProcessStatus(alarm) : '';
  const stateText = processStatus || (target.activeRisk ? '风险持续' : '跟踪中');
  const stateClass = alarm?.eventState === 'FALSE_POSITIVE' || processStatus === '已移送处罚' || processStatus === '已干扰'
    ? 'is-online' : (target.activeRisk || processStatus === '信号干扰中' || processStatus === '待审批' ? 'is-risk' : 'is-online');
  return `<section class="sit-map-pop sit-map-pop-target${target.newAlert ? ' is-new' : ''}" style="--sensor:${target.objectTypeCode === 'UAV' ? '#2fd06e' : '#72d6ff'}">
    <header><span class="sit-map-pop-icon">${targetIconHtml(target)}</span><span><b>${esc(target.id)}</b><small>${esc(target.typeLabel)}</small></span>
      <button type="button" data-tip-act="close" aria-label="关闭目标详情">${U.icon('close')}</button></header>
    <div class="sit-map-pop-status"><span class="sit-state ${stateClass}">${esc(stateText)}</span><span>${esc(summary)}</span></div>
    <div class="sit-target-metrics"><span><small>高度</small><b>${esc(formatMetric(target.alt, ' m'))}</b></span><span><small>速度</small><b>${esc(formatMetric(target.speed, ' m/s'))}</b></span><span><small>融合置信</small><b>${esc(formatMetric(target.fusedConf, '%'))}</b></span></div>
    <p>感知来源：${esc(sourceNames || '未提供')}</p>
    ${alarm?.eventId ? `<p class="sit-map-pop-note">短信通知：${esc(sms?.title || '正在读取通知状态')}${sms?.updatedAt ? ` · ${esc(formatClock(sms.updatedAt))}` : ''}</p>` : ''}
    ${target.objectTypeCode === 'UAV' ? '<p class="sit-eo-track">光电跟踪中</p>' : ''}
    ${target.activeRisk || alarm ? '' : '<div class="sit-map-pop-note">目标处于持续跟踪中。</div>'}
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
  const related = target?.relatedAlarms || [];
  if (selection.value?.kind === 'target' && selection.value.id === target?.id && selection.value.alarmId) {
    return related.find(row => row.alarmId === selection.value.alarmId) || null;
  }
  return related.find(row => row.eventState !== 'FALSE_POSITIVE') || null;
}

function updateNotification(value) {
  if (value.event_id !== selectedUavAlarm.value?.eventId) return;
  advisorySummaries.value = { [value.event_id]: value };
  if (map && selection.value?.kind === 'target') map.pinHit('target', selection.value.id);
}

function openFalsePositive(target) {
  const alarm = targetAlarm(target);
  if (!alarm?.eventId) return toast('没有关联无人机事件，无法核实', 'err');
  openFormModal({
    title: `人工核实 · ${esc(alarm.targetId)}`,
    width: '600px',
    introHtml: `<dl class="kv"><dt>当前状态</dt><dd>${esc(uavProcessStatus(alarm))}</dd><dt>告警</dt><dd>${esc(alarm.type)}</dd><dt>关联目标</dt><dd class="mono">${esc(target.id)}</dd></dl>`,
    fields: [{ key: 'note', label: '核实说明', type: 'textarea', required: true, minRows: 4,
      placeholder: '必填，1–1000 字：现场确认、轨迹复核、飞手联系结果等依据' }],
    initial: { note: '' },
    confirmText: '提交误报结论',
    validate: model => {
      const note = String(model.note || '').trim();
      return !note ? '核实说明为必填项' : note.length > 1000 ? `核实说明不能超过 1000 字（当前 ${note.length} 字）` : '';
    },
    onSubmit: async ({ note }) => {
      const latest = await getUavEvent(alarm.eventId);
      if (latest.state === 'FALSE_POSITIVE') { closeModal(); await source.refresh(); return; }
      try {
        await verifyUavEvent(alarm.eventId, {
          conclusion: 'FALSE_POSITIVE', note: String(note).trim(), expected_version: Number(latest.version)
        }, actionIdempotencyKey('situation-false-positive'));
      } catch (error) {
        if (!isUncertainOutcome(error)) throw error;
        const readback = await getUavEvent(alarm.eventId).catch(() => null);
        if (readback?.state !== 'FALSE_POSITIVE') throw error;
      }
      closeModal();
      await source.refresh();
      toast('核实完成：误报', 'ok');
    }
  });
}

async function openLinkedDisposal(target) {
  const alarm = targetAlarm(target);
  return openAlarmDisposal(alarm);
}

async function openAlarmDisposal(alarm) {
  // 只有数据源明确提供业务告警 ID 才深链；页面私有模拟 ID 不冒充服务端事件。
  if (alarm?.alarmId) {
    try {
      const linked = await getAlarm(alarm.alarmId);
      if (!linked?.event_id) return toast('这条告警尚未建立可办理的无人机事件', 'err');
      sessionStorage.setItem('alarm.sel', linked.alarm_id);
      window.location.hash = '/alarms';
    } catch (error) { toast(error.message || '无法读取关联告警，请稍后重试', 'err'); }
    return;
  }
  openFormModal({
    title: '进入告警处置流程',
    notice: '该目标尚未关联可办理的告警记录。请在告警事件中查看已关联的事件及其处置进度。',
    fields: [], confirmText: '打开告警事件',
    onSubmit: () => { closeModal(); window.location.hash = '/alarms'; }
  });
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
  if (action === 'disposal-flow') openLinkedDisposal(target);
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
    sensorIconScale: 1,
    maxDpr: 2,
    layers: { alarm: false, coverage: true },
    interactiveTip: true,
    renderTip: renderMapTip,
    onTipAction,
    onPick: onMapPick,
    onEmptyPick: clearSelection
  });
  stopSource = source.start(applySnapshot, onSourceError);
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
  <div id="view" class="view situation-page" :class="{ 'has-alarm-popup': showAlarmPopup }" @keydown.esc="clearSelection">
    <main class="sit-stage" aria-label="融合感知实时地图">
      <div id="stMap" ref="mapHost" class="sit-map"></div>

      <div class="sit-live-pill" :aria-label="`当前数据来源：${sourceModeText}`">
        <span class="sit-live-dot" aria-hidden="true"></span>
        <b>{{ sourceModeText }}</b>
        <span>{{ sourceModeDetail }}</span>
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
                <span><span class="sit-node-icon" v-html="iconHtml(device)"></span><b>{{ device.name }}</b><small class="mono">{{ device.id }}</small></span>
                <em>{{ device.status }} · {{ reportAge(device.lastReportAt) }}</em>
              </button>
            </div>
          </section>
        </div>
        <footer>共 {{ devices.length }} 台感知设备；覆盖范围以设备台账配置为准，未知或不可用范围不会绘制。</footer>
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
            :class="[{ 'is-new': alarm.isNew, 'is-selected': isSelectedAlarm(alarm) }, `level-${alarm.level}`]"
            :aria-pressed="isSelectedAlarm(alarm)"
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
      </aside>

      <SituationAlarmPopup v-if="showAlarmPopup" :key="selectedUavAlarm.alarmId" :get-anchor="alarmAnchor">
        <div v-if="selectedTarget" @click="onTipAction($event.target.closest('[data-tip-act]')?.dataset.tipAct, { kind: 'target', data: selectedTarget })"
          v-html="renderTargetTip(selectedTarget)"></div>
        <section v-else class="sit-map-pop">
          <header><span class="sit-map-pop-icon" v-html="U.businessIcon('uav')"></span><span><b>{{ selectedUavAlarm.targetId }}</b><small>无人机告警</small></span>
            <button type="button" aria-label="关闭告警详情" @click="clearSelection" v-html="U.icon('close')"></button></header>
          <div class="sit-map-pop-status"><span class="sit-state is-risk">{{ selectedUavAlarm.level }}风险</span><span>{{ selectedUavAlarm.type }}</span></div>
          <p>{{ selectedUavAlarm.district }} · 告警时间 {{ formatClock(selectedUavAlarm.ts) }}</p>
        </section>
        <p v-if="!alarmAnchor()" class="sit-alarm-position-note">当前未取得该目标的有效位置，无法定位无人机；以下保留此事件的信息。</p>
        <SituationAdvisoryCard v-if="selectedUavAlarm.eventId" :event-id="selectedUavAlarm.eventId" :alarm-label="selectedUavAlarm.id"
          @updated="updateNotification" @open="openAlarmDisposal(selectedUavAlarm)" />
        <p v-else class="sit-alarm-position-note">此告警未关联无人机事件，暂无可读取的通知记录。</p>
      </SituationAlarmPopup>

      <nav class="sit-layerbar" aria-label="地图图层">
        <button type="button" :aria-pressed="layers.coverage" @click="toggleLayer('coverage')">覆盖范围</button>
        <button type="button" :aria-pressed="layers.device" @click="toggleLayer('device')">设备点位</button>
        <button type="button" :aria-pressed="layers.track" @click="toggleLayer('track')">目标轨迹</button>
        <button type="button" :aria-pressed="layers.flightPlan" @click="toggleLayer('flightPlan')">计划航线</button>
        <button type="button" :aria-pressed="layers.airspace" :aria-label="`防控空域，共${airspaces.length}个区域`" @click="toggleLayer('airspace')">防控空域 {{ airspaces.length }}</button>
        <span class="sit-plan-key" aria-label="航线与轨迹图例"><span><i class="is-within"></i>符合航线</span><span><i class="is-outside"></i>偏离航线</span><span><i class="is-plan"></i>未飞计划线</span><span><i class="is-unknown"></i>关系未知</span></span>
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
              <span class="sit-node-icon" v-html="iconHtml(device)"></span><b>{{ device.type }}</b><em>{{ device.status }}</em>
            </span>
          </div>
          <p>来源链路及在线状态均由后端融合服务返回。</p>
        </section>
      </aside>
    </main>
  </div>
</template>

<style scoped>
.situation-page.has-alarm-popup :deep(.maptip.is-track){display:none!important}
.sit-alarm-position-note{margin:0;padding:10px 12px;color:var(--muted);font-size:12px;line-height:1.5}
.situation-page .sit-alert-copy>b,.situation-page .sit-alert-copy>em,.situation-page :deep(.sit-map-pop header b){white-space:normal;overflow:visible;overflow-wrap:anywhere;text-overflow:initial}
.situation-page .sit-alert-row{flex-shrink:0;grid-template-columns:34px minmax(0,1fr)}
.situation-page .sit-alert-meta{grid-column:2;flex-direction:row;justify-content:space-between;flex-wrap:wrap;white-space:normal}
</style>
