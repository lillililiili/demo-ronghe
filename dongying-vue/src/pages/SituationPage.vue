<script setup>
/* 融合感知指挥台：页面结构保持不变，全部业务状态来自后端领域接口。 */
import { computed, h, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ChevronUpOutline, GitCompareOutline, LocateOutline } from '@vicons/ionicons5';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { createSituationApiSource } from '@/pages/situation/situationApiSource.js';
import { serverNow } from '@/services/serverClock.js';
import { clockLagText, currentMapSnapshot, deviceGroupState, riskMatchesPlan, routeRiskIsActive, SITUATION_DEVICE_TYPE_ORDER, targetClassCounts } from '@/services/situationData.js';
import {
  disposalStage, situationAlarmNeedsAttention, situationRouteRiskVisible,
  uavProcessActions, uavProcessStatus
} from '@/pages/situation/situationFlow.js';
import { closeModal, openFormModal } from '@/ui/formModal.js';
import { getUavEvent } from '@/services/alarmApi.js';
import { openUavVerification } from '@/ui/uavVerificationModal.js';
import { riskApi, newRiskIdempotencyKey } from '@/services/riskApi.js';
import { handoffApi, newHandoffIdempotencyKey } from '@/services/handoffApi.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import {
  CORRIDOR_RELATION_LABEL, PLAN_STATUS_LABEL, RISK_STATE_LABEL, SEVERITY_LABEL, labelOf
} from '@/ui/labels.js';
import { toast } from '@/ui/nv.js';
import { getAlarm } from '@/services/alarmApi.js';
import SituationAdvisoryCard from './situation/SituationAdvisoryCard.vue';
import SituationAlarmPopup from './situation/SituationAlarmPopup.vue';
import { PILOT_LOCATION_IN_ALARM_DETAIL, pilotLocationText } from '@/services/pilotLocation.js';
import WeatherRiskMarkers from '@/components/WeatherRiskMarkers.vue';
import { weatherAnchor } from '@/services/weatherRiskGeometry.js';
import SituationRiskGroupPopup from './situation/SituationRiskGroupPopup.vue';
import { groupRouteRisks } from './situation/routeRiskGroups.js';
import { selectionLayout } from './situation/selectionLayout.js';
import { createSituationMarkerLayout } from './situation/markerLayout.js';
import TargetLiveVideo from '@/components/video/TargetLiveVideo.vue';
import { autoSmsView } from '@/components/disposal/autoSmsView.js';
import { autoVoiceView } from '@/components/disposal/autoVoiceView.js';

const U = window.UI;
usePageChrome('situation');

const VIEWED_STORAGE_KEY = 'situation.viewed.v1';
const mapHost = ref(null);
const weatherLayer = ref(null);
const snapshot = ref({ generatedAt: 0, sourceMode: 'unknown', simulated: false, devices: [], targets: [], alarms: [], flightPlans: [], risks: [], airspaces: [], handoffs: [] });
const selection = ref(null);
const advisorySummaries = ref({});
const expandedType = ref('');
const devicesExpanded = ref(true);
const alertTab = ref('target');
const alertsExpanded = ref(true);
const fuseOpen = ref(false);
const showTargetVideo = ref(false);
const source = createSituationApiSource();
const layers = ref({ coverage: true, device: true, track: true, flightPlan: true, airspace: true });
const statusAnnouncement = ref('正在连接融合感知服务');
let viewedKeys = loadViewedKeys();
let rawSnapshot = null;
let map = null;
let stopSource = null;
let lastSourceErrorAt = 0;
let selectionResizeObserver = null;
let expiryTimer = null;

const devices = computed(() => snapshot.value.devices || []);
const hasSimulatedCoverage = computed(() => devices.value.some(device => device.displayCoverage?.displayOnly));
const targets = computed(() => snapshot.value.targets || []);
const currentTargetIds = computed(() => new Set(targets.value.map(target => target.targetId).filter(Boolean)));
const alarms = computed(() => (snapshot.value.alarms || [])
  .filter(alarm => currentTargetIds.value.has(alarm.targetInternalId) && situationAlarmNeedsAttention(alarm))
  .slice()
  .sort((a, b) => b.ts - a.ts));
const evidenceRoute = useRoute();
let evidenceTargetHandled = '';
watch(() => [evidenceRoute.query.target, snapshot.value.generatedAt], ([id, generatedAt]) => {
  if (typeof id !== 'string' || !id) { evidenceTargetHandled = ''; return; }
  if (!generatedAt || id === evidenceTargetHandled) return;
  const target = targets.value.find(item => item.targetId === id);
  evidenceTargetHandled = id;
  if (target) selectTarget(target);
  else { clearSelection(); toast('指定目标没有当前有效观测，可返回证据管理查看该目标的历史材料。', 'warn'); }
}, { flush: 'post' });
const flightPlans = computed(() => snapshot.value.flightPlans || []);
const risks = computed(() => snapshot.value.risks || []);
const riskGroups = computed(() => groupRouteRisks(risks.value.filter(situationRouteRiskVisible)));
const selectedRiskGroup = computed(() => selection.value?.kind === 'risk-group'
  ? riskGroups.value.find(group => group.groupId === selection.value.id) : null);
const airspaces = computed(() => snapshot.value.airspaces || []);
const deviceStatusCounts = computed(() => devices.value.reduce((counts, device) => {
  counts[device.statusCode] = (counts[device.statusCode] || 0) + 1;
  return counts;
}, { ONLINE: 0, ABNORMAL: 0, OFFLINE: 0, UNKNOWN: 0 }));
const targetCounts = computed(() => targetClassCounts(targets.value));
const deviceGroups = computed(() => {
  const presentTypes = [...new Set(devices.value.map(device => device.typeCode).filter(Boolean))];
  const orderedTypes = [
    ...SITUATION_DEVICE_TYPE_ORDER.filter(typeCode => presentTypes.includes(typeCode)),
    ...presentTypes.filter(typeCode => !SITUATION_DEVICE_TYPE_ORDER.includes(typeCode))
  ];
  return orderedTypes.map(typeCode => {
  const items = devices.value.filter(device => device.typeCode === typeCode);
  const sample = items[0] || {};
  const meters = items.map(device => device.displayCoverage || device.coverage)
    .map(coverage => coverage?.kind === 'sector' ? coverage.rangeM : coverage?.radiusM)
    .filter(Number.isFinite);
  const min = meters.length ? Math.min(...meters) : null;
  const max = meters.length ? Math.max(...meters) : null;
  const range = min == null ? '参数未知' : min === max ? `${min / 1000} km` : `${min / 1000}–${max / 1000} km`;
  return {
    typeCode, label: sample.type || typeCode, icon: sample.icon, color: sample.color,
    items, total: items.length, online: items.filter(device => device.statusCode === 'ONLINE').length,
    abnormal: items.filter(device => device.statusCode === 'ABNORMAL').length,
    offline: items.filter(device => device.statusCode === 'OFFLINE').length,
    unknown: items.filter(device => device.statusCode === 'UNKNOWN').length,
    hasNew: items.some(device => device.newAlert),
    rangeText: `${typeCode === 'EO' ? `单站 ${range} 定向视场` : `单站 ${range} 覆盖范围`}${items.some(device => device.displayCoverage?.displayOnly) ? ' · 含模拟参数' : ''}`
  };
  });
});
const newAlarmCount = computed(() => alarms.value.filter(alarm => alarm.isNew).length);
const newRiskCount = computed(() => riskGroups.value.filter(risk => risk.active && risk.isNew).length);
const activeRiskCount = computed(() => riskGroups.value.filter(risk => risk.active).length);
const selectedTarget = computed(() => {
  if (selection.value?.kind !== 'target') return null;
  return targets.value.find(target => target.id === selection.value.id) || null;
});
const selectedDevice = computed(() => selection.value?.kind === 'device'
  ? devices.value.find(device => device.id === selection.value.id) : null);
const selectedPlan = computed(() => selection.value?.kind === 'plan'
  ? flightPlans.value.find(plan => plan.id === selection.value.id) : null);
const selectedRisk = computed(() => {
  if (selectedRiskGroup.value) return selectedRiskGroup.value;
  const id = selection.value?.riskId || (selection.value?.kind === 'risk' ? selection.value.id : null);
  return id ? risks.value.find(risk => risk.riskId === id) : null;
});
const showSelectionPopup = computed(() => !!selectedDevice.value || !!selectedTarget.value || showAlarmPopup.value
  || !!selectedPlan.value || !!selectedRisk.value);
const selectedUavAlarm = computed(() => {
  if (selection.value?.kind === 'alarm' || selection.value?.alarmId) {
    const alarmId = selection.value.alarmId || selection.value.id;
    return alarms.value.find(item => item.alarmId === alarmId) || null;
  }
  return selectedTarget.value?.objectTypeCode === 'UAV' ? targetAlarm(selectedTarget.value) : null;
});
const showAlarmPopup = computed(() => alertTab.value === 'target' && !!selectedUavAlarm.value);
const showAlarmAdvisoryCard = computed(() => showAlarmPopup.value && !!selectedUavAlarm.value?.eventId);
const videoContext = computed(() => {
  const risk = selectedRisk.value;
  const target = selectedTarget.value;
  const alarm = selectedUavAlarm.value;
  if (!risk && !target && !alarm) return null;
  // 风险只读取该记录的明确目标关联；计划登记无人机不是风险目标。
  const targetId = risk ? risk.targetInternalId || '' : target?.targetId || alarm?.targetInternalId || '';
  const linked = target || targets.value.find(item => item.targetId === targetId);
  return {
    key: `${selection.value?.kind}:${selection.value?.id}:${risk?.riskId || alarm?.alarmId || ''}:${targetId}`,
    targetId,
    // 取证关联的告警事件：只取与视频同一目标的无人机告警。
    eventId: !risk && alarm?.eventId && alarm.targetInternalId === targetId ? alarm.eventId : '',
    label: linked?.id || risk?.targetId || alarm?.targetId || risk?.id || '当前事项',
    subtype: linked?.objectTypeCode === 'UAV' || (!risk && alarm) ? 'UAV' : linked?.subtypeCode || risk?.spaceFact?.subtypeCode || 'UNKNOWN',
    unavailableReason: !targetId ? (risk ? '此风险未关联可读取的目标，暂无可关联的视频。' : '此告警未提供可读取的关联目标，暂无可关联的视频。') : ''
  };
});
watch(() => videoContext.value?.key, key => { showTargetVideo.value = !!key; }, { flush: 'sync' });
const fusionDevices = computed(() => {
  const ids = new Set(selectedTarget.value?.sourceDeviceIds || []);
  return devices.value.filter(device => ids.has(device.fusionDeviceId || device.deviceId));
});
const fusionConfidence = computed(() => selectedTarget.value?.fusedConf ?? null);
const clockText = computed(() => formatClock(snapshot.value.generatedAt));
/* 数据刷新慢（CDX-P01）：地图上的目标只在有效期（十几秒）内显示，最近一轮数据超过 10 秒还没更新，
   目标会陆续按期退出地图，看起来像"没有目标"。这时明确提示是刷新慢，不让值班员误以为空中没有东西。 */
const SLOW_REFRESH_SECONDS = 10;
const nowTick = ref(serverNow());
const refreshLagSeconds = computed(() => snapshot.value.generatedAt ? Math.max(0, Math.floor((nowTick.value - snapshot.value.generatedAt) / 1000)) : 0);
const refreshSlow = computed(() => refreshLagSeconds.value >= SLOW_REFRESH_SECONDS);
const sourceModeText = computed(() => snapshot.value.simulated ? '含模拟数据'
  : snapshot.value.sourceMode === 'replay' ? '回放数据'
  : snapshot.value.sourceMode === 'live' ? '实时数据'
    : snapshot.value.sourceMode === 'mixed' ? '混合数据' : '来源待确认');
const sourceModeDetail = computed(() => snapshot.value.simulated ? '当前视图包含模拟记录，不能作为现场验收依据'
  : snapshot.value.sourceMode === 'replay' ? 'MQTT 测试回放来源'
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
  if (value == null || (typeof value === 'string' && !value.trim())) return '未提供';
  return Number.isFinite(Number(value)) ? `${Number(value)}${unit}` : '未提供';
}

function planForRisk(risk) {
  return flightPlans.value.find(plan => riskMatchesPlan(risk, plan)) || null;
}

function riskFactText(risk) {
  const fact = risk?.spaceFact;
  if (!fact) return '空间事实未提供';
  const relation = labelOf(CORRIDOR_RELATION_LABEL, fact.corridorRelation);
  return fact.distanceToRouteM != null && Number.isFinite(Number(fact.distanceToRouteM)) ? `${relation} · ${Math.round(fact.distanceToRouteM)} m` : relation;
}

function riskGroupStateText(group) {
  const presence = group.currentStatus === 'UNKNOWN' ? '位置未知／待确认 · '
    : group.currentStatus === 'CLEARED' ? '已解除 · ' : '';
  return presence + Object.entries(group.stateCounts).map(([state, count]) =>
    `${group.members.length > 1 ? `${count} 条` : ''}${labelOf(RISK_STATE_LABEL, state)}`).join(' · ');
}

function selectRiskGroup(group) {
  markViewed(group.members);
  alertTab.value = 'route';
  selection.value = { kind: 'risk-group', id: group.groupId };
  fuseOpen.value = false;
  if (map) {
    map.sel = null;
    map.planSel = planForRisk(group)?.id || null;
    map.clearPinnedHit();
    focusSelection(false);
  }
}

function openGroupedRiskAction(risk, action) {
  // 详情按钮仅作用于这一计划，不把组内其他计划或航线上的其他风险一起提交。
  openRiskActionModal({ activeRisks: [risk] }, action);
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
      activeRisk: target.activeRisk || openAlarms.length > 0 || activeRisks.length > 0,
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
  const decorated = decorate(currentMapSnapshot(next));
  snapshot.value = decorated;
  if (selection.value?.kind === 'target' && !decorated.targets.some(target => target.id === selection.value.id)) clearSelection();
  const count = decorated.alarms.filter(alarm => alarm.isNew).length + groupRouteRisks(decorated.risks).filter(risk => risk.isNew).length;
  const failed = (next.failedSegments || []).map(segment => ({
    targets: '目标', alarms: '告警', risks: '风险', handoffs: '移送', devices: '设备',
    'device-events': '设备事件', 'flight-plans': '飞行任务', airspaces: '空域', 'fusion-status': '融合状态'
  }[segment] || segment));
  statusAnnouncement.value = failed.length
    ? `${failed.join('、')}数据刷新失败，已保留上次结果；恢复后自动重试`
    : count
    ? `融合感知数据已更新，${count} 条新风险`
    : '融合感知数据已更新，当前无未查看异常';
  if (!map) return;
  map.setData({
    airspaces: decorated.airspaces,
    devices: decorated.devices.filter(device => Number.isFinite(device.lon) && Number.isFinite(device.lat)),
    targets: decorated.targets,
    flightPlans: decorated.flightPlans,
    risks: decorated.risks.filter(risk => risk.mapVisible !== false),
    alarms: []
  });
  if (selection.value && ['device', 'target', 'plan'].includes(selection.value.kind)) map.pinHit(selection.value.kind, selection.value.id);
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
    layers.value = { ...layers.value, device: true };
    map.setLayer('device', true);
    map.pinHit('device', device.id);
    focusSelection();
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
    map.pinHit('target', target.id);
    focusSelection();
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
  const current = selection.value;
  const icon = map && current && map.getHitPoint(current.kind, current.id);
  if (icon) return icon;
  const target = selectionLocation();
  return map && target?.posValid !== false && Number.isFinite(target?.lon) && Number.isFinite(target?.lat)
    ? map.px(target.lon, target.lat) : null;
}

function selectionAvoidRect() {
  if (!map) return null;
  const plan = selectedPlan.value || (selectedRiskGroup.value ? planForRisk(selectedRiskGroup.value) : null);
  const points = (plan?.coordinates || []).map(point => map.px(point[0], point[1]))
    .filter(point => point?.every(Number.isFinite));
  if (points.length >= 2) {
    const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
    return { left: Math.min(...xs) - 12, right: Math.max(...xs) + 12,
      top: Math.min(...ys) - 12, bottom: Math.max(...ys) + 12 };
  }
  const point = alarmAnchor();
  return point ? { left: point[0] - 28, right: point[0] + 28,
    top: point[1] - 28, bottom: point[1] + 28 } : null;
}

function selectionLocation() {
  if (selectedDevice.value || selectedTarget.value) return selectedDevice.value || selectedTarget.value;
  const coordinates = selectedPlan.value?.coordinates;
  const point = coordinates?.[Math.floor(coordinates.length / 2)];
  if (point) return { lon: point[0], lat: point[1] };
  const fact = selectedRisk.value?.spaceFact;
  return Number.isFinite(fact?.longitude) && Number.isFinite(fact?.latitude)
    ? { lon: fact.longitude, lat: fact.latitude } : null;
}

async function focusSelection(enlarge = true) {
  const current = selection.value;
  await nextTick();
  if (!map || current !== selection.value) return;
  const item = selectionLocation();
  if (!item || item.posValid === false || !Number.isFinite(item.lon) || !Number.isFinite(item.lat)) return;
  const { point } = selectionLayout(mapHost.value.parentElement);
  // 放大至便于辨认的级别；切换对象不累乘缩放，也不缩小用户已经放大的地图。
  const scale = enlarge ? Math.max(map.zoom, 32) : map.zoom;
  map.centerAt(item.lon, item.lat, { scale, offset: [point[0] - map.w / 2, point[1] - map.h / 2] });
}

function isSelectedAlarm(alarm) {
  return selection.value?.kind === 'alarm' ? selection.value.id === alarm.alarmId
    : selection.value?.kind === 'target' && selection.value.id === alarm.targetId
      && (!selection.value.alarmId || selection.value.alarmId === alarm.alarmId);
}

function selectPlan(plan, markRisks = true, riskId = null) {
  if (!plan) return;
  if (markRisks) markViewed((plan.activeRisks || []));
  selection.value = { kind: 'plan', id: plan.id, riskId };
  fuseOpen.value = false;
  if (map) {
    map.sel = null;
    map.planSel = plan.id;
    map.pinHit('plan', plan.id);
    const coordinates = Array.isArray(plan.coordinates) ? plan.coordinates : [];
    if (coordinates.length >= 2 && typeof map.fitTo === 'function') {
      // 计划需要完整落在可见区域，且保持足够边距让详情弹窗与航线同时可读。
      map.fitTo(coordinates, 0.38);
    } else {
      const point = coordinates[Math.floor(coordinates.length / 2)];
      if (point) map.centerAt(point[0], point[1], { scale: Math.max(map.zoom, 24) });
      focusSelection(false);
    }
  }
}

function selectWeatherRisk(risk) {
  selectRisk(risk);
  const point = weatherAnchor(risk.weather_fact);
  if (point && map) {
    const layout = selectionLayout(mapHost.value.parentElement).point;
    nextTick(() => {
      if (selectedRisk.value?.riskId !== risk.riskId || !map) return;
      map.centerAt(point[0], point[1], { scale: map.zoom, offset: [layout[0] - map.w / 2, layout[1] - map.h / 2] });
    });
  }
}

function selectRisk(risk) {
  if (!risk) return;
  markViewed(risk);
  alertTab.value = 'route';
  const plan = planForRisk(risk);
  if (plan) selectPlan(plan, false, risk.riskId);
  else {
    selection.value = { kind: 'risk', id: risk.riskId };
    fuseOpen.value = false;
    if (map) { map.sel = null; map.planSel = null; map.clearPinnedHit(); focusSelection(false); }
  }
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

async function notifyRisk(risk) {
  let latest = await riskApi.getRisk(risk.riskId);
  if (['NOTIFIED', 'ACKNOWLEDGED'].includes(latest.state)) return latest;
  if (latest.state === 'PENDING_VERIFICATION') {
    if (risk.state !== 'PENDING_VERIFICATION') throw new Error('风险状态已变化，请重新打开弹窗核验后通知');
    if (!latest.allowed_actions?.includes('VERIFY')) throw new Error('当前账号无权核验这条风险');
    latest = await verifyRiskState(risk, 'CONFIRMED', '融合感知页：人工确认风险属实并通知上级。',
      ['PENDING_NOTIFICATION', 'NOTIFIED', 'ACKNOWLEDGED']);
  }
  if (['NOTIFIED', 'ACKNOWLEDGED'].includes(latest.state)) return latest;
  if (latest.state !== 'PENDING_NOTIFICATION') throw new Error('当前风险状态不允许通知');
  try {
    return await handoffApi.createHandoff({
      source_kind: 'RISK', source_id: risk.riskId, handoff_type: 'RISK_NOTICE',
      expected_version: Number(latest.version)
    }, newHandoffIdempotencyKey());
  } catch (error) {
    if (isUncertainOutcome(error)) {
      const readback = await readRiskAfterUncertain(risk.riskId, ['NOTIFIED', 'ACKNOWLEDGED']);
      if (readback) return readback;
    }
    throw error;
  }
}

async function submitRiskAction(activeRisks, action) {
  if (!activeRisks.length) return toast('当前航线已无可提交的风险', 'err');
  const settled = await Promise.allSettled(activeRisks.map(risk => action === 'exclude'
    ? verifyRiskState(risk, 'EXCLUDED', '融合感知页批量排除：当前风险尚未通知，经人工操作确认排除。', ['EXCLUDED'])
    : notifyRisk(risk)));
  const succeeded = settled.filter(result => result.status === 'fulfilled').length;
  const failed = settled.length - succeeded;
  await source.refresh();
  const firstError = settled.find(result => result.status === 'rejected')?.reason;
  if (failed) throw new Error(`已完成 ${succeeded} 条，失败 ${failed} 条：${firstError?.message || '请查看最新状态'}`);
  closeModal();
  toast(action === 'exclude' ? `已排除 ${succeeded} 条风险` : `已提交 ${succeeded} 条风险通知，请在通知与回执中查看发送结果`, 'ok');
}

function openRiskActionModal(plan, action) {
  const activeRisks = (plan?.activeRisks || []).filter(risk => routeRiskIsActive(risk));
  if (!activeRisks.length) return toast('当前航线已无可提交的风险', 'err');
  const countText = activeRisks.length > 1 ? `本次将处理 ${activeRisks.length} 条当前风险。` : '';
  const isExclude = action === 'exclude';
  const needsVerification = !isExclude && activeRisks.some(risk => risk.state === 'PENDING_VERIFICATION');
  openFormModal({
    title: isExclude ? '排除风险' : '通知上级',
    width: '560px',
    warning: isExclude
      ? `提交后将把下列尚未通知的风险正式标记为“已排除”，并写入核验历史。${countText}`
      : `${needsVerification ? '请核对下列风险。确认后将记录核验通过，并继续通知上级。' : '将下列风险通知上级。'}提交后请在通知与回执中查看发送结果。${countText}`,
    introHtml: `<dl class="kv">${activeRisks.map(risk => `<dt>${esc(risk.planNo || risk.id || risk.riskId)}</dt><dd>${esc(risk.reasonText || '风险依据未提供')}<br>${esc(labelOf(RISK_STATE_LABEL, risk.state))}</dd>`).join('')}</dl>`,
    fields: [],
    danger: isExclude,
    confirmText: isExclude ? '确认排除' : needsVerification ? '确认属实并通知' : '提交通知',
    onSubmit: async () => submitRiskAction(activeRisks, action)
  });
}

function clearSelection() {
  selection.value = null;
  fuseOpen.value = false;
  showTargetVideo.value = false;
  if (!map) return;
  map.sel = null;
  map.planSel = null;
  map.clearPinnedHit();
  map.draw();
}

function renderDeviceTip(device) {
  const coverage = device.displayCoverage || device.coverage || { status: 'unknown' };
  const coverageText = device.displayCoverageText || device.coverageText;
  const unavailable = coverage.status === 'unavailable';
  const coverageState = coverage.status === 'unknown' ? '覆盖参数未知'
    : unavailable ? `${coverageText}（当前不可用）` : coverageText;
  const related = (device.relatedAlerts || []).slice(0, 2);
  return `<section class="sit-map-pop sit-map-pop-device" style="--sensor:${esc(device.color)}">
    <header><span class="sit-map-pop-icon">${iconHtml(device)}</span><span><b>${esc(device.name)}</b><small class="mono" title="${esc(device.id)}">${esc(device.display_no || device.id)}</small></span>
      <button type="button" data-tip-act="close" aria-label="关闭设备详情">${U.icon('close')}</button></header>
    <div class="sit-map-pop-status"><span class="sit-state ${statusClass(device.status)}">${esc(device.status)}</span><span>最新上报 ${esc(reportAge(device.lastReportAt))}</span></div>
    ${device.posValid === false ? '<p class="sit-map-pop-note">未提供安装坐标，暂不显示地图点位。</p>' : ''}
    ${device.timeUntrusted ? `<p class="sit-map-pop-note">设备时间不准：最近感知数据的报文时刻比平台收到时早${esc(clockLagText(device.reportLagMs) || '较多')}（设备时钟慢或数据积压），相关目标会标为“数据过期”。请核对设备时间。</p>` : ''}
    ${device.simulated ? '<p class="sit-map-pop-note">模拟设备数据（非现场验收）</p>' : ''}
    <dl><dt>${esc(coverage.label || '覆盖参数')}</dt><dd class="${unavailable ? 'is-unavailable' : ''}">${esc(coverageState)}</dd>
      ${coverage.availabilityReason ? `<dt>可用性</dt><dd class="is-unavailable">${esc(coverage.availabilityReason)}</dd>` : ''}
      <dt>参数来源</dt><dd>${esc(coverage.sourceLabel || '未提供')}</dd>
      ${coverage.displayOnly ? '' : `<dt>更新时间</dt><dd class="mono">${formatClock(coverage.updatedAt)}</dd>`}</dl>
    <div class="sit-map-pop-alerts"><b>近期设备事件（最多2条）</b>${related.length
      ? related.map(event => `<span>${esc(event.title)}</span>`).join('')
      : '<span>本次读取范围内暂无该设备事件</span>'}</div>
  </section>`;
}

function renderTargetActions(target, hasAdvisoryCard = false) {
  const alarm = targetAlarm(target);
  const buttons = [];
  if (target.objectTypeCode === 'UAV' && alarm) {
    const process = uavProcessActions(alarm);
    if (process.includes('verify')) buttons.push('<button type="button" data-tip-act="verify">核实</button>');
    if (alarm.eventState !== 'FALSE_POSITIVE' && !hasAdvisoryCard) buttons.push('<button type="button" data-tip-act="disposal-flow">处置流程</button>');
  }
  return buttons.length ? `<div class="sit-map-pop-actions">${buttons.join('')}</div>` : '';
}

function renderTargetTip(target, hasAdvisoryCard = false) {
  const alarm = targetAlarm(target);
  const notification = alarm?.eventId ? advisorySummaries.value[alarm.eventId] : null;
  const sms = notification ? autoSmsView(notification) : null;
  const voice = notification ? autoVoiceView(notification) : null;
  const routeRisk = (target.relatedRisks || []).find(risk => risk.active);
  const sourceNames = devices.value.filter(device => (target.sourceDeviceIds || []).includes(device.fusionDeviceId || device.deviceId))
    .map(device => device.type).join(' / ');
  const summary = alarm?.type || routeRisk?.reasonText || '暂无关联异常';
  const processStatus = alarm ? uavProcessStatus(alarm) : '';
  // 报文时刻不可信（ZT-20）不能显示成"已观测"：写明数据过期、设备时间不准。
  const stateText = processStatus || (target.activeRisk ? '风险持续'
    : target.timeUntrusted ? '数据过期 · 设备时间不准'
      : target.stale || target.freshness === 'STALE' ? '数据已过期' : '已观测');
  const stateClass = alarm?.eventState === 'FALSE_POSITIVE' || processStatus === '已移送处罚' || processStatus === '已干扰'
    ? 'is-online' : (target.activeRisk || processStatus === '信号干扰中' || processStatus === '待审批' ? 'is-risk'
      : !processStatus && target.timeUntrusted ? 'is-warning' : 'is-online');
  return `<section class="sit-map-pop sit-map-pop-target${target.newAlert ? ' is-new' : ''}" style="--sensor:${target.objectTypeCode === 'UAV' ? '#2fd06e' : '#72d6ff'}">
    <header><span class="sit-map-pop-icon">${targetIconHtml(target)}</span><span><b>${esc(target.id)}</b><small>${esc(target.typeLabel)}</small></span>
      <button type="button" data-tip-act="close" aria-label="关闭目标详情">${U.icon('close')}</button></header>
    <div class="sit-map-pop-status"><span class="sit-state ${stateClass}">${esc(stateText)}</span><span>${esc(summary)}</span></div>
    <div class="sit-target-metrics"><span><small>高度</small><b>${esc(formatMetric(target.alt, ' m'))}</b></span><span><small>速度</small><b>${esc(formatMetric(target.speed, ' m/s'))}</b></span></div>
    <p>最后上报：${esc(formatClock(target.lastSeenAt))} · ${esc(reportAge(target.lastSeenAt))}</p>
    ${target.timeUntrusted ? `<p class="sit-map-pop-note">数据过期：报文时刻比平台收到时早${esc(clockLagText(target.reportLagMs) || '较多')}，设备时间不准或数据积压，图上位置可能不是当前位置；超过新鲜时限的数据不做合法性判定。平台收到：${esc(formatClock(target.receivedAt))}</p>` : ''}
    ${target.objectTypeCode === 'UAV' ? `<p>遥控器位置：${esc(pilotLocationText(target.pilotLocation))}</p>` : ''}
    <div class="sit-target-source"><span>感知来源：${esc(sourceNames || '未提供')}</span><button type="button" data-tip-act="eo-video" aria-expanded="${showTargetVideo.value}" aria-controls="situation-video-window">${showTargetVideo.value ? '收起视频' : '实时视频'}</button></div>
    ${alarm?.eventId && !hasAdvisoryCard ? `<p class="sit-map-pop-note">短信通知：${esc(sms?.title || '正在读取通知状态')}${sms?.simulated ? '（模拟）' : ''}${sms?.updatedAt ? ` · ${esc(formatClock(sms.updatedAt))}` : ''}</p>
    <p class="sit-map-pop-note">飞手电话：${esc(voice?.title || '正在读取通知状态')}${voice?.simulated ? '（模拟）' : ''}</p>` : ''}
    ${renderTargetActions(target, hasAdvisoryCard)}
  </section>`;
}

function renderPlanTip(plan) {
  const risks = plan.relatedRisks || [];
  const active = plan.activeRisks || [];
  const highest = plan.highestRisk;
  const riskId = selection.value?.kind === 'plan' && selection.value.id === plan.id
    ? selection.value.riskId : null;
  const selectedRisk = riskId ? risks.find(risk => risk.riskId === riskId) : null;
  const stateText = riskId
    ? `风险：${selectedRisk ? labelOf(RISK_STATE_LABEL, selectedRisk.state) : '状态待确认'}`
    : `任务：${plan.statusLabel}`;
  const stateClass = (riskId ? selectedRisk?.active : active.length) ? 'is-risk' : 'is-online';
  const routePointCount = Array.isArray(plan.coordinates) ? plan.coordinates.length : 0;
  return `<section class="sit-map-pop sit-map-pop-plan" style="--sensor:${active.length ? '#ff5b61' : '#22d3ee'}">
    <header><span class="sit-map-pop-icon">${U.icon('plan')}</span><span><b>任务详情</b><small class="mono">${esc(plan.planNo)}</small></span>
      <button type="button" data-tip-act="close" aria-label="关闭任务详情">${U.icon('close')}</button></header>
    <div class="sit-map-pop-status"><span class="sit-state ${stateClass}">${esc(stateText)}</span><span>${active.length ? `${active.length} 条当前风险` : '无当前风险'}</span></div>
    <dl><dt>任务编号</dt><dd class="mono">${esc(plan.planNo)}</dd>
      <dt>任务状态</dt><dd>${esc(plan.statusLabel)}</dd>
      <dt>执行时段</dt><dd>${esc(formatClock(plan.startAt))} ～ ${esc(formatClock(plan.endAt))}</dd>
      <dt>关联无人机</dt><dd class="mono">${esc(plan.uavId || '未提供')}</dd>
      <dt>航线版本</dt><dd class="mono">${esc(plan.routeVersionId)}</dd>
      <dt>航线点数</dt><dd>${routePointCount || '未提供'}</dd>
      <dt>风险记录</dt><dd>${risks.length} 条</dd>
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
  if (hit?.kind === 'weather') selectWeatherRisk(hit.data);
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

async function openTargetVerification(target) {
  const alarm = targetAlarm(target);
  if (!alarm?.eventId) return toast('没有关联无人机事件，无法核实', 'err');
  try {
    const [event, linkedAlarm] = await Promise.all([
      getUavEvent(alarm.eventId),
      alarm.alarmId ? getAlarm(alarm.alarmId) : Promise.resolve(null)
    ]);
    openUavVerification({
      event,
      alarm: linkedAlarm,
      refresh: async () => {
        await source.refresh();
        return getUavEvent(alarm.eventId);
      }
    });
  } catch (error) {
    toast(error.message || '无法读取核实事件，请稍后重试', 'err');
  }
}

async function openLinkedDisposal(target) {
  const alarm = targetAlarm(target);
  return openAlarmDisposal(alarm);
}

function openCounterRecords({ eventId, authorizationId }) {
  const query = new URLSearchParams({ tab: 'authorizations', event: eventId });
  if (authorizationId) query.set('authorization', authorizationId);
  window.location.hash = `/alarms?${query}`;
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
    showTargetVideo.value = !showTargetVideo.value;
    focusSelection(false);
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
  if (action === 'verify') openTargetVerification(target);
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
  else { if (rawSnapshot) applySnapshot(rawSnapshot); source.resume(); }
  if (map?.setPaused) map.setPaused(document.hidden);
}

onMounted(() => {
  map = new window.MapView(mapHost.value, {
    maxDev: 120,
    maxAlarm: 0,
    zoom: 1,
    legend: false,
    fusionProfile: true,
    layoutMarkers: createSituationMarkerLayout(),
    getExternalMarkers: view => weatherLayer.value?.getMarkers(view) || [],
    drawUnderMarkers: view => weatherLayer.value?.draw(view),
    sensorIconScale: 1,
    maxDpr: 2,
    layers: { alarm: false, coverage: true },
    // 悬停小卡片不接点击（验收预跑 3-7）：图标挤在一起时，停在设备上弹出的卡片会盖住旁边的无人机，点不开；
    // 卡片上的按钮在点开后的弹窗里都有。
    interactiveTip: false,
    renderTip: renderMapTip,
    onTipAction,
    onPick: onMapPick,
    onEmptyPick: clearSelection
  });
  stopSource = source.start(applySnapshot, onSourceError);
  // 独立于网络轮询：请求失败或迟迟未返回时，旧点仍按期退出地图。
  expiryTimer = window.setInterval(() => {
    nowTick.value = serverNow();
    if (!document.hidden && rawSnapshot && snapshot.value.targets.some(target => target.mapExpiresAt <= nowTick.value)) applySnapshot(rawSnapshot);
  }, 1000);
  selectionResizeObserver = new ResizeObserver(() => focusSelection(false));
  selectionResizeObserver.observe(mapHost.value);
  document.addEventListener('visibilitychange', onVisibilityChange);
});

onUnmounted(() => {
  window.clearInterval(expiryTimer);
  selectionResizeObserver?.disconnect();
  document.removeEventListener('visibilitychange', onVisibilityChange);
  if (stopSource) stopSource();
  stopSource = null;
  source.stop();
  if (map) map.destroy();
  map = null;
});
</script>

<template>
  <div id="view" class="view situation-page" :class="{ 'has-selection-popup': showSelectionPopup }" @keydown.esc="clearSelection">
    <main class="sit-stage" aria-label="融合感知实时地图">
      <div id="stMap" ref="mapHost" class="sit-map"></div>
      <WeatherRiskMarkers ref="weatherLayer" :risks="risks" :selected-id="selectedRisk?.riskId" shared-layout control-target="#situation-weather-control" @select="selectWeatherRisk" />

      <div class="sit-live-pill" :aria-label="`当前数据来源：${sourceModeText}`">
        <span class="sit-live-dot" aria-hidden="true"></span>
        <b>{{ sourceModeText }}</b>
        <span>{{ sourceModeDetail }}</span>
        <span>当前目标 {{ targets.length }} · 无人机 {{ targetCounts.uav }} · 异物 {{ targetCounts.foreign }} · 未分类 {{ targetCounts.unknown }}<template v-if="targetCounts.other"> · 其他 {{ targetCounts.other }}</template>（北京时间）</span>
        <time class="mono">{{ clockText }}</time>
        <em v-if="refreshSlow" class="sit-refresh-slow" role="status" :title="`最近一次数据停在 ${clockText}，已有 ${refreshLagSeconds} 秒没有更新；地图上的目标按期退出，可能不全。恢复后自动更新。`">数据刷新慢 · {{ refreshLagSeconds }} 秒未更新</em>
      </div>
      <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ statusAnnouncement }}</p>

      <aside class="sit-glass sit-device-dock" :class="{ 'is-collapsed': !devicesExpanded }" aria-labelledby="sit-device-title">
        <header class="sit-dock-head">
          <span><small>SENSING FIELD</small><b id="sit-device-title">感知设备</b></span>
          <em class="sit-device-summary"><i></i>{{ deviceStatusCounts.ONLINE }}在线 <span>{{ deviceStatusCounts.ABNORMAL }}异常</span> {{ deviceStatusCounts.OFFLINE }}离线<template v-if="deviceStatusCounts.UNKNOWN"> {{ deviceStatusCounts.UNKNOWN }}状态未知</template></em>
          <button type="button" class="sit-device-toggle" :aria-expanded="devicesExpanded" aria-controls="sit-device-content sit-device-footer"
            :aria-label="devicesExpanded ? '收起感知设备' : '展开感知设备'" @click="devicesExpanded = !devicesExpanded">{{ devicesExpanded ? '收起' : '展开' }}</button>
        </header>
        <div v-show="devicesExpanded" id="sit-device-content" class="sit-device-list">
          <section v-for="group in deviceGroups" :key="group.typeCode" class="sit-device-group" :style="{ '--sensor': group.color }">
            <button type="button" class="sit-device-row"
              :class="{ 'is-selected': group.items.some(device => selection?.kind === 'device' && selection.id === device.id), 'has-new': group.hasNew, 'is-offline': deviceGroupState(group).down }"
              :aria-expanded="expandedType === group.typeCode" :aria-controls="`sit-device-${group.typeCode}`"
              :aria-label="`${expandedType === group.typeCode ? '收起' : '展开'}${group.label}设备，共${group.total}台，${deviceGroupState(group).headline}`"
              @click="toggleDeviceType(group.typeCode)">
              <span class="sit-device-icon" v-html="iconHtml(group)"></span>
              <span class="sit-device-copy"><b>{{ group.label }}<small>{{ group.total }} 台</small></b><em>{{ group.rangeText }}</em></span>
              <span class="sit-device-state" :class="{ 'is-down': deviceGroupState(group).down }"><b>{{ deviceGroupState(group).headline }}</b><small>{{ deviceGroupState(group).detail }}</small></span>
            </button>
            <div v-show="expandedType === group.typeCode" :id="`sit-device-${group.typeCode}`" class="sit-device-node-list">
              <button v-for="device in group.items" :key="device.id" type="button" class="sit-device-node"
                :class="[{ 'is-selected': selection?.kind === 'device' && selection.id === device.id, 'has-new': device.newAlert }, statusClass(device.status)]"
                :aria-pressed="selection?.kind === 'device' && selection.id === device.id"
                :aria-label="`查看${device.type}设备 ${device.name}，${device.status}${device.hasAlarm ? '，存在告警' : ''}`" @click="selectDevice(device)">
                <span><span class="sit-node-icon" v-html="iconHtml(device)"></span><b>{{ device.name }}</b><small class="mono" :title="device.id">{{ device.display_no || device.id }}</small></span>
                <em>{{ device.status }} · {{ reportAge(device.lastReportAt) }}<template v-if="device.timeUntrusted"> · 设备时间不准</template></em>
              </button>
            </div>
          </section>
        </div>
        <footer v-show="devicesExpanded" id="sit-device-footer">共 {{ devices.length }} 台感知设备；在线设备显示上报脉冲。{{ hasSimulatedCoverage ? '模拟范围仅作地图示意，详情标注参数来源。' : '覆盖范围以设备台账配置为准。' }}</footer>
      </aside>

      <aside class="sit-glass sit-alert-dock" :class="{ 'is-collapsed': !alertsExpanded }" aria-labelledby="sit-alert-title">
        <header class="sit-dock-head">
          <span><b id="sit-alert-title">实时风险</b></span>
          <em :class="{ 'has-new': newAlarmCount + newRiskCount }">{{ newAlarmCount + newRiskCount ? `${newAlarmCount + newRiskCount} 条未查看` : `${activeRiskCount} 条当前风险` }}</em>
          <button type="button" class="sit-alert-toggle" :aria-expanded="alertsExpanded" aria-controls="sit-alert-content"
            :aria-label="alertsExpanded ? '收起实时风险' : '展开实时风险'" @click="alertsExpanded = !alertsExpanded">
            {{ alertsExpanded ? '收起' : '展开' }}
            <ChevronUpOutline class="sit-alert-chevron" :class="{ 'is-collapsed': !alertsExpanded }" aria-hidden="true" />
          </button>
        </header>
        <div v-show="alertsExpanded" id="sit-alert-content" class="sit-alert-content">
        <div class="sit-risk-tabs" role="tablist" aria-label="风险类型">
          <button type="button" role="tab" :aria-selected="alertTab === 'target'" @click="alertTab = 'target'">
            <LocateOutline class="sit-risk-icon" aria-hidden="true" />
            <span>目标异常</span><b :class="{ 'has-risk': alarms.length > 0 }">{{ alarms.length }}</b>
          </button>
          <button type="button" role="tab" :aria-selected="alertTab === 'route'" @click="alertTab = 'route'">
            <GitCompareOutline class="sit-risk-icon" aria-hidden="true" />
            <span>航线风险</span><b :class="{ 'has-risk': riskGroups.length > 0 }">{{ riskGroups.length }}</b>
          </button>
        </div>
        <div v-if="alertTab === 'target'" class="sit-alert-list" role="tabpanel" aria-label="目标异常">
          <button v-for="alarm in alarms" :key="eventKey(alarm)" type="button" class="sit-alert-row"
            :class="[{ 'is-new': alarm.isNew, 'is-selected': isSelectedAlarm(alarm) }, `level-${alarm.level}`]"
            :aria-pressed="isSelectedAlarm(alarm)"
            :aria-label="`查看${alarm.targetId || alarm.id || '未关联目标告警'}的${alarm.type}，${alarm.eventState === 'PENDING_VERIFICATION' ? '待核实' : '待反制'}`" @click="selectAlarm(alarm)">
            <span class="sit-alert-level">{{ alarm.level }}</span>
            <span class="sit-alert-copy"><b class="mono">{{ alarm.targetId || alarm.id || '未关联目标告警' }}</b><em>{{ alarm.type }} · {{ alarm.district }}</em></span>
            <span class="sit-alert-meta"><time class="mono">{{ formatClock(alarm.ts) }}</time><b>{{ alarm.eventState === 'PENDING_VERIFICATION' ? '待核实' : '待反制' }}{{ alarm.isNew ? ' · 新异常' : '' }}</b></span>
          </button>
        </div>
        <div v-else class="sit-alert-list" role="tabpanel" aria-label="航线风险">
          <button v-for="risk in riskGroups" :key="risk.groupId" type="button" class="sit-alert-row sit-route-risk-row"
            :class="[{ 'is-new': risk.isNew, 'is-history': !risk.active, 'is-selected': selectedRiskGroup?.groupId === risk.groupId }, `level-${risk.level}`]"
            :aria-pressed="selectedRiskGroup?.groupId === risk.groupId"
            :aria-label="`查看${risk.spaceFact?.subtypeName || '航线'}风险，关联${risk.planCount}条任务，${riskGroupStateText(risk)}`" @click="selectRiskGroup(risk)">
            <span class="sit-alert-level">{{ risk.level }}</span>
            <span class="sit-alert-copy"><b>{{ risk.spaceFact?.subtypeName || '航线' }}风险 · 关联 {{ risk.planCount }} 条任务</b><em>{{ riskFactText(risk) }}</em></span>
            <span class="sit-alert-meta"><time class="mono">{{ formatClock(risk.occurredAt) }}{{ risk.isNew ? ' · 未查看' : '' }}</time><b>{{ riskGroupStateText(risk) }}</b></span>
          </button>
        </div>
        </div>
      </aside>

      <SituationAlarmPopup v-if="showSelectionPopup" :key="`${selection.kind}:${selection.id}:${selection.riskId || selection.alarmId || ''}`" :get-anchor="alarmAnchor"
        :get-avoid-rect="selectionAvoidRect"
        :video-open="showTargetVideo && !!videoContext"
        :label="selectedDevice ? '设备详情' : selectedPlan ? '任务详情' : selectedRisk ? '航线风险详情' : showAlarmPopup ? '无人机告警详情' : '目标详情'">
        <div v-if="selectedDevice" @click="onTipAction($event.target.closest('[data-tip-act]')?.dataset.tipAct, { kind: 'device', data: selectedDevice })"
          v-html="renderDeviceTip(selectedDevice)"></div>
        <div v-else-if="selectedTarget" @click="onTipAction($event.target.closest('[data-tip-act]')?.dataset.tipAct, { kind: 'target', data: selectedTarget })"
          v-html="renderTargetTip(selectedTarget, showAlarmAdvisoryCard)"></div>
        <SituationRiskGroupPopup v-else-if="selectedRiskGroup" :group="selectedRiskGroup" :plans="flightPlans"
          @close="clearSelection" @view-plan="selectRisk" @action="openGroupedRiskAction" />
        <div v-else-if="selectedPlan" @click="onTipAction($event.target.closest('[data-tip-act]')?.dataset.tipAct, { kind: 'plan', data: selectedPlan })"
          v-html="renderPlanTip(selectedPlan)"></div>
        <section v-else-if="selectedRisk" class="sit-map-pop">
          <header><span class="sit-map-pop-icon" v-html="U.icon('plan')"></span><span><b>{{ selectedRisk.id }}</b><small>航线风险</small></span>
            <button type="button" aria-label="关闭风险详情" @click="clearSelection" v-html="U.icon('close')"></button></header>
          <div class="sit-map-pop-status"><span class="sit-state is-risk">{{ labelOf(RISK_STATE_LABEL, selectedRisk.state) }}</span></div>
          <p>{{ selectedRisk.reasonText || '风险依据未提供' }}</p><p>当前未取得关联任务，保留此风险的信息。</p>
        </section>
        <section v-else-if="selectedUavAlarm" class="sit-map-pop">
          <header><span class="sit-map-pop-icon" v-html="U.businessIcon('uav')"></span><span><b>{{ selectedUavAlarm.targetId || selectedUavAlarm.id || '未关联目标告警' }}</b><small>无人机告警</small></span>
            <button type="button" aria-label="关闭告警详情" @click="clearSelection" v-html="U.icon('close')"></button></header>
          <div class="sit-map-pop-status"><span class="sit-state is-risk">{{ selectedUavAlarm.level }}风险</span><span>{{ selectedUavAlarm.type }}</span></div>
          <p>{{ selectedUavAlarm.district }} · 告警时间 {{ formatClock(selectedUavAlarm.ts) }}</p>
          <p>遥控器位置：{{ PILOT_LOCATION_IN_ALARM_DETAIL }}</p>
        </section>
        <div v-if="videoContext && !selectedTarget" class="sit-video-entry">
          <button type="button" :aria-expanded="showTargetVideo" aria-controls="situation-video-window" @click="onTipAction('eo-video')">{{ showTargetVideo ? '收起视频' : '实时视频' }}</button>
        </div>
        <p v-if="showAlarmPopup && !alarmAnchor()" class="sit-alarm-position-note">当前未取得该目标的有效位置，无法定位无人机；以下保留此事件的信息。</p>
        <SituationAdvisoryCard v-if="showAlarmAdvisoryCard" :key="`${selectedUavAlarm.eventId}:${selectedUavAlarm.eventState}`"
          :event-id="selectedUavAlarm.eventId" :alarm-label="selectedUavAlarm.id"
          :can-launch="uavProcessActions(selectedUavAlarm).includes('counter')"
          @updated="updateNotification" @open="openAlarmDisposal(selectedUavAlarm)" @records="openCounterRecords" />
        <p v-else-if="showAlarmPopup" class="sit-alarm-position-note">此告警未关联无人机事件，暂无可读取的通知记录。</p>
        <template #video="{ expanded, toggleExpanded }">
          <TargetLiveVideo v-if="videoContext" :key="videoContext.key" class="sit-companion-video" compact default-expanded
            :target-id="videoContext.targetId" :event-id="videoContext.eventId" :context-label="videoContext.label" :unavailable-reason="videoContext.unavailableReason" :subtype="videoContext.subtype">
            <template #title><div class="sit-video-title"><strong>实时视频</strong><small>{{ videoContext.label }}</small></div></template>
            <template #actions>
              <button type="button" class="btn" :aria-expanded="expanded" @click="toggleExpanded">{{ expanded ? '还原' : '放大' }}</button>
              <button type="button" class="btn" @click="onTipAction('eo-video')">收起视频</button>
            </template>
          </TargetLiveVideo>
        </template>
      </SituationAlarmPopup>

      <nav class="sit-layerbar" aria-label="地图图层">
        <button type="button" :aria-pressed="layers.coverage" @click="toggleLayer('coverage')">覆盖范围</button>
        <span v-if="layers.coverage && hasSimulatedCoverage" class="sit-scan-key">含模拟参数</span>
        <span class="sit-scan-key" aria-label="在线设备上报脉冲"><i aria-hidden="true"></i>上报脉冲</span>
        <button type="button" :aria-pressed="layers.device" @click="toggleLayer('device')">设备点位</button>
        <button type="button" :aria-pressed="layers.track" @click="toggleLayer('track')">目标轨迹</button>
        <button type="button" :aria-pressed="layers.flightPlan" @click="toggleLayer('flightPlan')">任务航线</button>
        <button type="button" :aria-pressed="layers.airspace" :aria-label="`防控空域，共${airspaces.length}个区域`" @click="toggleLayer('airspace')">防控空域 {{ airspaces.length }}</button>
        <span id="situation-weather-control"></span>
        <span class="sit-plan-key" aria-label="航线与轨迹图例"><span><i class="is-within"></i>符合航线</span><span><i class="is-outside"></i>偏离航线</span><span><i class="is-plan"></i>未飞任务线</span><span><i class="is-unknown"></i>关系未知</span><span><b class="is-start">起</b>起点<b class="is-end">终</b>终点</span></span>
      </nav>

      <aside v-if="selectedTarget" class="sit-fuse-dock" :class="{ 'is-open': fuseOpen }" aria-label="多源融合结果">
        <button type="button" class="sit-fuse-orb" :aria-expanded="fuseOpen"
          :aria-label="fuseOpen ? '收起多源融合' : '展开多源融合'" @click="toggleFuse">
          <span class="sit-fuse-orb-cap"><small>多源融合</small><b>{{ fusionConfidence ?? '—' }}%</b></span>
          <span class="sit-fuse-orb-ball" aria-hidden="true"><span v-html="fuseIcon"></span></span>
        </button>
        <section class="sit-glass sit-fuse-panel">
          <header class="sit-dock-head"><span><small>FUSION LINKS</small><b>{{ selectedTarget.id }}</b></span></header>
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
.situation-page .sit-alert-dock>.sit-dock-head,.situation-page .sit-device-dock>.sit-dock-head{flex-wrap:wrap;gap:8px;flex-shrink:0}
.situation-page .sit-device-dock>.sit-dock-head>span{flex-basis:85px}
.situation-page .sit-alert-dock>.sit-dock-head>span{flex-basis:auto}
.situation-page .sit-alert-dock>.sit-dock-head>em{padding:0;border:0;border-radius:0;background:transparent;font-size:11px;white-space:normal;overflow-wrap:anywhere}
.situation-page .sit-alert-dock>.sit-dock-head>em.has-new{color:var(--red)}
.situation-page .sit-alert-dock.is-collapsed>.sit-dock-head,.situation-page .sit-device-dock.is-collapsed>.sit-dock-head{border-bottom:0}
.sit-alert-content{display:flex;flex-direction:column;min-height:0}
.sit-alert-toggle,.sit-device-toggle{flex:none;min-height:32px;padding:4px 8px;border:1px solid var(--sit-line);border-radius:6px;background:var(--surface-2);color:var(--txt);font:inherit;font-size:12px;cursor:pointer}
.sit-alert-toggle:hover,.sit-device-toggle:hover{border-color:var(--cyan);color:var(--cyan)}
.sit-alert-toggle:focus-visible,.sit-device-toggle:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
.situation-page .sit-alert-toggle{display:inline-flex;align-items:center;gap:5px;min-height:26px;padding:2px 0 2px 10px;border:0;border-left:1px solid var(--control-line);border-radius:0;background:transparent;color:var(--txt-2)}
.situation-page .sit-alert-toggle:hover{color:var(--txt)}
.sit-alert-chevron{width:15px;height:15px;flex:none;transition:transform .16s ease}
.sit-alert-chevron.is-collapsed{transform:rotate(180deg)}
.situation-page .sit-risk-tabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));flex:none;gap:0;margin:10px 9px 2px;padding:0;border:1px solid var(--control-line);border-radius:10px;background:var(--button-bg)}
.situation-page .sit-risk-tabs button{position:relative;display:grid;grid-template-columns:22px minmax(0,1fr) auto;align-items:center;gap:6px;min-width:0;min-height:58px;margin:0;padding:10px;border:0;border-radius:9px;background:transparent;color:var(--txt-2);font-family:inherit;font-size:14px;font-weight:500;line-height:1.4;text-align:left;cursor:pointer;transition:background .16s ease,color .16s ease}
.situation-page .sit-risk-tabs button>span{white-space:normal;overflow-wrap:anywhere}
.situation-page .sit-risk-tabs button:hover{background:var(--button-hover);color:var(--txt)}
.situation-page .sit-risk-tabs button[aria-selected="true"]{background:color-mix(in srgb,var(--blue) 22%,var(--panel));color:var(--txt)}
.situation-page .sit-risk-tabs button[aria-selected="true"]::after{position:absolute;bottom:2px;left:38px;width:22px;height:3px;border-radius:2px;background:var(--blue);content:""}
.situation-page .sit-risk-tabs button:focus-visible{outline:2px solid var(--blue);outline-offset:-3px}
.sit-risk-icon{width:22px;height:22px;color:var(--txt-2)}
.situation-page .sit-risk-tabs b{display:flex;align-items:center;justify-content:center;min-width:28px;min-height:28px;padding:2px 6px;border-radius:999px;background:color-mix(in srgb,var(--txt-2) 12%,transparent);color:var(--txt-2);font:600 18px/1.2 'Segoe UI',Arial,sans-serif;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.situation-page .sit-risk-tabs b.has-risk{background:color-mix(in srgb,var(--red) 18%,transparent);color:var(--red)}
@media (max-width:1366px){.situation-page .sit-risk-tabs button{grid-template-columns:20px minmax(0,1fr) auto;gap:5px;padding:9px 8px;font-size:13px}.sit-risk-icon{width:20px;height:20px}.situation-page .sit-risk-tabs button[aria-selected="true"]::after{left:33px}}
.situation-page.has-selection-popup :deep(.maptip){display:none!important}
.sit-alarm-position-note{margin:0;padding:10px 12px;color:var(--muted);font-size:12px;line-height:1.5}
.sit-companion-video{margin:0;border:0;background:transparent}
.sit-video-title{display:flex;flex-direction:column;gap:4px;min-width:0;overflow-wrap:anywhere}
.sit-video-title small{color:var(--txt-2);font-size:12px}
.sit-companion-video :deep(header){align-items:flex-start;flex-wrap:wrap}
.sit-companion-video :deep(.video-toolbar){margin-left:auto}
.sit-video-entry{padding:0 12px 12px;display:flex;justify-content:flex-end}
.situation-page :deep(.sit-target-source){display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;color:var(--txt-2);font-size:12px}
.sit-video-entry button,.situation-page :deep(.sit-target-source button){min-height:32px;padding:4px 8px;border:1px solid var(--sit-line);border-radius:6px;background:var(--surface-2);color:var(--cyan);font:inherit;cursor:pointer}
.sit-video-entry button:focus-visible,.situation-page :deep(.sit-target-source button:focus-visible){outline:2px solid var(--cyan);outline-offset:2px}
.situation-page .sit-alert-copy>b,.situation-page .sit-alert-copy>em,.situation-page :deep(.sit-map-pop header b){white-space:normal;overflow:visible;overflow-wrap:anywhere;text-overflow:initial}
.situation-page .sit-alert-row{flex-shrink:0;grid-template-columns:34px minmax(0,1fr)}
.situation-page .sit-alert-meta{grid-column:2;flex-direction:row;justify-content:space-between;flex-wrap:wrap;white-space:normal}
</style>
