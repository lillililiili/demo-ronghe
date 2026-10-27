<script setup>
/* 融合感知指挥台：页面结构保持不变，全部业务状态来自后端领域接口。 */
import { punishmentHandoffProgress } from '@/ui/punishmentHandoffProgress.js';
import { displayBusinessNo, displayTargetNo, displayNumberReferences } from '@/ui/deviceNumber.js';
import { computed, h, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { NSelect } from 'naive-ui';
import { riskCaseOf, riskCaseKey, riskStageLabel, RISK_STAGE_LABEL, riskCaseVisible, riskCaseVerificationLabel, riskSummaryMatches } from '@/services/riskCaseView.js';
import { useRoute } from 'vue-router';
import { ChevronUpOutline, GitCompareOutline, LocateOutline } from '@vicons/ionicons5';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { createSituationApiSource } from '@/pages/situation/situationApiSource.js';
import { serverNow } from '@/services/serverClock.js';
import { alarmReasonView, uavNowHtml, uavNowPillHtml, uavNowStatus } from '@/components/disposal/uavNowStatus.js';
import { uavAdvisoryApi } from '@/services/uavAdvisoryApi.js';
import { toAlarms, clockLagText, currentMapSnapshot, deviceGroupState, riskMatchesPlan, SITUATION_DEVICE_TYPE_ORDER, targetClassCounts, targetIsCurrent } from '@/services/situationData.js';
import {
  disposalStage, situationAlarmNeedsAttention, situationRouteRiskIsCurrent,
  uavProcessActions, uavProcessStatus
} from '@/pages/situation/situationFlow.js';
import { closeModal, openFormModal } from '@/ui/formModal.js';
import { openModal } from '@/ui/modal.js';
import { getUavRiskCase, getUavEvent } from '@/services/alarmApi.js';
import { openUavVerification } from '@/ui/uavVerificationModal.js';
import {
  CORRIDOR_RELATION_LABEL, PLAN_STATUS_LABEL, RISK_STATE_LABEL, SEVERITY_LABEL, SOURCE_MODE_LABEL, labelOf
} from '@/ui/labels.js';
import { toast } from '@/ui/nv.js';
import { getAlarm } from '@/services/alarmApi.js';
import SituationAdvisoryCard from './situation/SituationAdvisoryCard.vue';
import SituationNextStep from './situation/SituationNextStep.vue';
import SituationTargetCard from './situation/SituationTargetCard.vue';
import SituationDeviceReport from './situation/SituationDeviceReport.vue';
import SituationAlarmPopup from './situation/SituationAlarmPopup.vue';
import { PILOT_LOCATION_IN_ALARM_DETAIL, pilotLocationText } from '@/services/pilotLocation.js';
import { pilotDistanceNote } from '@/ui/pilotDistanceNote.js';
import { ruleReasonText } from '@/ui/legalityReviewModal.js';
import WeatherRiskMarkers from '@/components/WeatherRiskMarkers.vue';
import FlightTrafficLayer from './situation/FlightTrafficLayer.vue';
import { weatherAnchor } from '@/services/weatherRiskGeometry.js';
import SituationRiskGroupPopup from './situation/SituationRiskGroupPopup.vue';
import SituationRiskProcess from './situation/SituationRiskProcess.vue';
import SituationRiskMarkers from './situation/SituationRiskMarkers.vue';
import { riskSnapshotMarkers } from './situation/riskSnapshotMarkers.js';
import { groupRouteRisks } from './situation/routeRiskGroups.js';
import { selectionLayout } from './situation/selectionLayout.js';
import { createSituationMarkerLayout } from './situation/markerLayout.js';
import { sourceContributionCards } from './situation/sourceContributions.js';
import TargetLiveVideo from '@/components/video/TargetLiveVideo.vue';
import { autoSmsView } from '@/components/disposal/autoSmsView.js';
import { autoVoiceView } from '@/components/disposal/autoVoiceView.js';
import PredictionPanel from './situation/PredictionPanel.vue';
import { PREDICTION_ORIGIN, PREDICTION_STATES, currentPredictionViews, predictionMapData, predictionWarningRows, isPredictionAlarm, predictionVerificationState } from '@/services/predictionView.js';

import { predictionAlarmStatusHtml } from '@/ui/predictionDetails.js';
import DeviceVideoWorkspace from '@/components/video/DeviceVideoWorkspace.vue';
import EoMapSelection from './situation/EoMapSelection.vue';
import { MAX_EO_SELECTION, reconcileSelected, toggleSelected } from './situation/eoSelection.js';
import { drawEoCoverageMask, eoCoverageView } from './situation/eoCoverage.js';
import { authSession } from '@/services/auth.js';

const U = window.UI;
usePageChrome('situation');

const VIEWED_STORAGE_KEY = 'situation.viewed.v1';
const mapHost = ref(null);
const weatherLayer = ref(null);
const riskSnapshotLayer = ref(null);
const flightLayer = ref(null);
const snapshot = ref({ generatedAt: 0, sourceMode: 'unknown', simulated: false, devices: [], targets: [], alarms: [], flightPlans: [], risks: [], airspaces: [], handoffs: [] });
const selection = ref(null);
const advisorySummaries = ref({});
// 列表里各条已核实告警的「通知后位置判断」：没选中的行也用和卡片同样的依据，列表标签与卡片一致。
const departureByEvent = ref({});
const expandedType = ref('');
const devicesExpanded = ref(true);
const alertTab = ref('target');
const riskStageFilter = ref('');
const riskStageOptions = [{ label: '全部阶段', value: '' }, ...['PREDICTED', 'ENTERED'].map(value => ({ value, label: RISK_STAGE_LABEL[value] }))];
const alertsExpanded = ref(true);
// 同一风险周期只提醒一次；重算、暂时失效后恢复不抢回用户手动切换的页签。
const announcedRiskKeys = new Set();
const fuseOpen = ref(false);
const showTargetVideo = ref(false);
const eoDevice = ref(null), eoExpanded = ref(false), eoMode = ref('point'), eoSelected = ref([]), eoFocusedId = ref('');
const source = createSituationApiSource();
const layers = ref({ prediction: true, coverage: true, device: true, track: true, flightPlan: true, airspace: true, flights: true });
const statusAnnouncement = ref('正在连接融合感知服务');
let viewedKeys = loadViewedKeys();
watch(authSession, () => announcedRiskKeys.clear());
let rawSnapshot = null;
let map = null;
let stopSource = null;
let situationPageActive = true, selectedReadSequence = 0;
const reportedSourceFailures = new Set();
const SEGMENT_LABEL = { predictions: '未来预测', targets: '目标', 'target-sources': '目标融合来源', alarms: '告警', risks: '航线风险', handoffs: '移送', devices: '设备',
  'device-events': '设备事件', 'flight-plans': '飞行任务', airspaces: '空域', 'fusion-status': '融合状态' };
const sourceFailureLabels = computed(() => (snapshot.value.failedSegments || []).map(segment => SEGMENT_LABEL[segment] || segment).join('、'));
let selectionResizeObserver = null;
let expiryTimer = null;
let mainMapView = null;

const devices = computed(() => snapshot.value.devices || []);
const locatedDevices = computed(() => devices.value.filter(device => device.posValid !== false
  && Number.isFinite(device.lon) && Math.abs(device.lon) <= 180
  && Number.isFinite(device.lat) && Math.abs(device.lat) <= 85.051129));
const hasSimulatedCoverage = computed(() => devices.value.some(device => device.displayCoverage?.displayOnly));
const targets = computed(() => snapshot.value.targets || []);
const currentEoDevice = computed(() => devices.value.find(d => d.deviceId === eoDevice.value?.deviceId));
const eoMapView = computed(() => eoCoverageView(
  snapshot.value.failedSegments?.includes('devices') ? null : currentEoDevice.value, targets.value));
const eoMapCandidates = computed(() => {
  const ids = new Set(eoMapView.value.targets.map(t => t.targetId));
  return eoCandidates.value.filter(row => ids.has(row.targetId));
});
const eoCoverageKey = computed(() => JSON.stringify([currentEoDevice.value?.deviceId, eoMapView.value.coordinates]));
const eoCandidates = computed(() => targets.value.filter(target => target.objectTypeCode === 'UAV').flatMap(target => {
  const alarm = [...(target.relatedAlarms || [])].filter(a => a.eventId && a.eventState !== 'FALSE_POSITIVE').sort((a,b) => b.ts-a.ts || String(a.alarmId).localeCompare(String(b.alarmId)))[0];
  return alarm ? [{ targetId: target.targetId, mapId: target.id, eventId: alarm.eventId, alarmId: alarm.alarmId,
    label: displayTargetNo(target.id), eventState: alarm.eventState, lon: target.lon, lat: target.lat,
    reasonText: (alarm.violationReasons || []).map(ruleReasonText).filter(Boolean).join('、') || alarm.type || '告警原因未提供' }] : [];
}));
watch(eoCandidates, candidates => { eoSelected.value = reconcileSelected(eoSelected.value,candidates); });
watch(authSession, () => { closeEoVideo(); eoSelected.value=[];eoFocusedId.value=''; });
function openEoVideo(device) {
  if (!device || device.typeCode !== 'EO') return;
  showTargetVideo.value=false;eoDevice.value=device;eoMode.value='point';clearSelection();
}
function focusEoCoverage() {
  if (eoExpanded.value && eoMapView.value.coordinates.length) map?.fitTo(eoMapView.value.coordinates, .17);
}
async function setEoExpanded(value) {
  if (value && !eoExpanded.value && map) mainMapView = { center: map.unpx(map.w / 2, map.h / 2), scale: map.zoom };
  eoExpanded.value = value;
  await nextTick();
  syncMapData();
  if (value) focusEoCoverage();
  else if (mainMapView && map) map.centerAt(...mainMapView.center, { scale: mainMapView.scale });
}
watch(eoCoverageKey, () => { if (eoExpanded.value) { syncMapData(); focusEoCoverage(); } }, { flush: 'post' });
async function closeEoVideo() {await setEoExpanded(false);eoDevice.value=null;eoMode.value='point';}
function selectEoTargets(rows) {
  const current=rows.filter(row=>row?.eventId && eoCandidates.value.some(c=>c.eventId===row.eventId && c.targetId===row.targetId));
  if(!current.length){toast('此处没有可关联告警的当前无人机，可在地图或告警列表选择。','warn');return;}
  if(current.length===1 && eoMode.value==='point') {
    if(eoSelected.value.length>=MAX_EO_SELECTION && !eoSelected.value.some(row=>row.eventId===current[0].eventId)){toast('每批最多选择20架，请先取消部分选择。','warn');return;}
    eoSelected.value=toggleSelected(eoSelected.value,current[0]);
  }
  else {
    const added=current.filter(row=>!eoSelected.value.some(old=>old.eventId===row.eventId));
    if(eoSelected.value.length+added.length>MAX_EO_SELECTION){toast('每批最多选择20架，请缩小框选范围。','warn');return;}
    eoSelected.value=[...eoSelected.value,...added];
  }
  eoFocusedId.value=current[0].eventId;
}
function removeEoTarget(eventId){eoSelected.value=eoSelected.value.filter(row=>row.eventId!==eventId);if(eoFocusedId.value===eventId)eoFocusedId.value=eoSelected.value[0]?.eventId||'';}
function clearEoTargets(){eoSelected.value=[];eoFocusedId.value='';}
function locateEoTarget(row){
  const target=targets.value.find(t=>t.targetId===row.targetId);
  if(!target || target.posValid===false || !Number.isFinite(target.lon) || !Number.isFinite(target.lat)){toast('当前没有可定位的有效位置','warn');return;}
  if(eoExpanded.value){
    if(eoMapView.value.reason){toast(eoMapView.value.reason,'warn');return;}
    if(!eoMapView.value.targets.some(t=>t.targetId===row.targetId)){toast('目标不在本机已配置覆盖范围内，可缩小视频后在主地图查看','warn');return;}
    focusEoCoverage();map?.pinHit('target',target.id);return;
  }
  map?.centerAt(target.lon,target.lat,{scale:Math.max(map.zoom,32)});
}
const currentTargetIds = computed(() => new Set(targets.value.map(target => target.targetId).filter(Boolean)));
const alarms = computed(() => (snapshot.value.alarms || [])
  .filter(alarm => currentTargetIds.value.has(alarm.targetInternalId) && riskCaseVisible(alarm) && situationAlarmNeedsAttention(alarm)
    && (isPredictionAlarm(alarm) ? predictionRows.value.some(row => row.warning.event_id === alarm.eventId || row.warning.alarm_id === alarm.alarmId || (row.warning.risk_case_id && row.warning.risk_case_id === riskCaseOf(alarm)?.risk_case_id)) : !alarmDeparted(alarm)))
  .slice()
  .sort((a, b) => b.ts - a.ts));
const visibleUavRisks = computed(() => alarms.value.filter(alarm => !riskStageFilter.value || riskCaseOf(alarm)?.stage === riskStageFilter.value));
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
const riskGroups = computed(() => groupRouteRisks(risks.value.filter(risk => risk.active)));
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
const newRiskCount = computed(() => riskGroups.value.filter(risk => risk.isNew).length);
const activeRiskCount = computed(() => alarms.value.length + riskGroups.value.length);
const selectedTarget = computed(() => {
  const value = selection.value;
  if (!value || !['target', 'alarm'].includes(value.kind)) return null;
  return targets.value.find(target => (value.targetId ? target.targetId === value.targetId : value.kind === 'target' && target.id === value.id)
    && (!value.sourceMode || target.sourceMode === value.sourceMode)) || null;
});
const predictions = computed(() => snapshot.value.predictions || []);
const predictionUnavailable = computed(() => (snapshot.value.failedSegments || []).includes('predictions'));
const predictionDenied = computed(() => (snapshot.value.deniedSegments || []).includes('predictions'));
const currentPredictions = computed(() => currentPredictionViews(predictions.value, nowTick.value,
  predictionUnavailable.value || predictionDenied.value));
const predictionRows = computed(() => predictionWarningRows(currentPredictions.value, nowTick.value));
const predictionClusterIds = ref([]);
const visiblePredictionRows = computed(() => predictionClusterIds.value.length
  ? predictionRows.value.filter(row => predictionClusterIds.value.includes(row.key)) : predictionRows.value);
const selectedPrediction = computed(() => currentPredictions.value.find(row => row.target_id ===
  (selectedTarget.value?.targetId || (selection.value?.kind === 'prediction' ? selection.value.id : null))) || null);
const mapPredictions = computed(() => predictionMapData(currentPredictions.value, nowTick.value,
  selectedPrediction.value?.target_id, predictionUnavailable.value));
const selectedDevice = computed(() => selection.value?.kind === 'device'
  ? devices.value.find(device => device.id === selection.value.id) : null);
// 民航航班图层按反制设备的位置判断远近；点开某台反制设备时在它周围画范围圈。
const counterDevices = computed(() => locatedDevices.value.filter(device => device.typeCode === 'COUNTERMEASURE'));
const selectedCounterId = computed(() => selectedDevice.value?.typeCode === 'COUNTERMEASURE' ? selectedDevice.value.id : '');
const flightSummary = computed(() => flightLayer.value?.summary || { receivers: 0 });
const selectedPlan = computed(() => selection.value?.kind === 'plan'
  ? flightPlans.value.find(plan => plan.id === selection.value.id) : null);
const selectedRisk = computed(() => {
  if (selectedRiskGroup.value) return selectedRiskGroup.value;
  const id = selection.value?.riskId || (selection.value?.kind === 'risk' ? selection.value.id : null);
  return id ? risks.value.find(risk => risk.riskId === id) : null;
});
const riskSnapshots = computed(() => riskSnapshotMarkers(riskGroups.value, {
  pendingRiskIds: riskGroups.value.flatMap(group => group.members.map(risk => risk.riskId)),
  selectedPlan: selectedPlan.value || selectedRisk.value,
  selectedGroupId: selectedRiskGroup.value?.groupId
}));
const selectedSnapshotId = computed(() => riskSnapshots.value.find(row =>
  row.group.members.some(risk => risk.riskId === selectedRisk.value?.riskId))?.id);
watch([riskSnapshots, selectedSnapshotId, () => layers.value.flightPlan], () => map?.draw(), { flush: 'post' });
const showSelectionPopup = computed(() => !!selectedDevice.value || !!selectedTarget.value || showAlarmPopup.value
  || !!selectedPlan.value || !!selectedRisk.value || !!selectedPrediction.value);
const selectedPredictionAlarmDetail = ref(null);
let predictionAlarmDetailSeq = 0;
const selectedRiskContext = ref(null);
let selectedRiskRead = 0;
const listedSelectedUavAlarm = computed(() => {
  if (selection.value?.kind === 'alarm' || selection.value?.alarmId) {
    const alarmId = selection.value.alarmId || selection.value.id;
    return alarms.value.find(item => riskCaseKey(item) === (selection.value.riskCaseId || alarmId) || item.alarmId === alarmId) || null;
  }
  return selectedTarget.value?.objectTypeCode === 'UAV' ? targetAlarm(selectedTarget.value) : null;
});
const selectedUavAlarm = computed(() => {
  const listed = listedSelectedUavAlarm.value, held = selectedRiskContext.value;
  if (!held || held.selectionKey !== selectedRiskSelectionKey()) return listed;
  if (listed && riskCaseKey(listed) === held.caseId && Number(riskCaseOf(listed)?.version || 0) >= Number(riskCaseOf(held.alarm)?.version || 0)) return listed;
  return { ...held.alarm, _riskUnavailable: held.unavailable, _riskReadReason: held.reason || '' };
});
const selectedAdvisorySummary = computed(() => {
  const alarm = selectedUavAlarm.value, risk = riskCaseOf(alarm);
  const summary = advisorySummaries.value[risk?.risk_case_id || alarm?.eventId];
  return !alarm?._riskUnavailable && riskSummaryMatches(summary, alarm?.eventId, risk?.risk_case_id, risk) ? summary : null;
});
function selectedRiskSelectionKey() {
  const value = selection.value;
  return value && ['target', 'alarm'].includes(value.kind)
    ? `${value.kind}:${value.id}:${value.riskCaseId || ''}:${value.targetId || ''}:${value.sourceMode || ''}:${authSession.value || ''}` : '';
}

// 仅保留已选中风险卡片的最后观测资料，不把过期目标放回地图或作为动作依据。
const heldCardTarget = ref(null);
watch(() => [selectedRiskSelectionKey(), selectedTarget.value], ([key, target]) => {
  if (target?.objectTypeCode === 'UAV') heldCardTarget.value = { key, target: { ...target } };
  else if (heldCardTarget.value?.key !== key) heldCardTarget.value = null;
}, { immediate: true, flush: 'sync' });
const selectedCardTarget = computed(() => selectedTarget.value || (
  heldCardTarget.value?.key === selectedRiskSelectionKey() && selectedUavAlarm.value
    && heldCardTarget.value.target.targetId === selectedUavAlarm.value.targetInternalId
    ? { ...heldCardTarget.value.target, _lastObservationOnly: true } : null));
const selectedCardAlarm = computed(() => selectedCardTarget.value?._lastObservationOnly && selectedUavAlarm.value
  ? { ...selectedUavAlarm.value, _riskUnavailable: true, _riskReadReason: '当前未取得有效实测位置，以下保留最后观测与核实记录，暂停新操作。' }
  : selectedUavAlarm.value);

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
    key: `${selection.value?.kind}:${selection.value?.id}:${risk?.riskId || riskCaseKey(alarm)}:${targetId}`,
    targetId,
    // 取证关联的告警事件：只取与视频同一目标的无人机告警。
    eventId: !risk && alarm?.eventId && alarm.targetInternalId === targetId ? alarm.eventId : '',
    label: displayBusinessNo(linked?.id || risk?.targetId || alarm?.targetId || risk?.id) || '当前事项',
    subtype: linked?.objectTypeCode === 'UAV' || (!risk && alarm) ? 'UAV' : linked?.subtypeCode || risk?.spaceFact?.subtypeCode || 'UNKNOWN',
    unavailableReason: !targetId ? (risk ? '此风险未关联可读取的目标，暂无可关联的视频。' : '此告警未提供可读取的关联目标，暂无可关联的视频。') : ''
  };
});
watch(() => videoContext.value?.key, () => { showTargetVideo.value = false; }, { flush: 'sync' });
watch(() => selectedTarget.value?.targetId, targetId => source.setSourceTarget(targetId || null), { flush: 'sync' });
const fusionSources = computed(() => sourceContributionCards(selectedTarget.value, devices.value));
const fusionConfidence = computed(() => selectedTarget.value?.fusedConf ?? null);
const targetRefreshAt = computed(() => snapshot.value.targetUpdatedAt || snapshot.value.startedAt || snapshot.value.generatedAt);
const clockText = computed(() => formatClock(targetRefreshAt.value));
/* 数据刷新慢（CDX-P01）：地图上的目标只在有效期（十几秒）内显示，目标请求在途超过 10 秒仍未完成或目标读取失败，
   才提示刷新慢。SSE 正常空闲没有新观测时，不用距上次读回的时间假定故障。 */
const SLOW_REFRESH_SECONDS = 10;
const nowTick = ref(serverNow());
watch(() => [selectedRiskSelectionKey(), snapshot.value.alarms, snapshot.value.targets, snapshot.value.predictions, nowTick.value], async () => {
  const key = selectedRiskSelectionKey(), listed = listedSelectedUavAlarm.value;
  const previous = selectedRiskContext.value;
  if (!key || (previous && previous.selectionKey !== key)) { selectedRiskRead++; selectedRiskContext.value = null; }
  const held = selectedRiskContext.value;
  const caseId = held?.caseId || riskCaseOf(listed)?.risk_case_id || selection.value?.riskCaseId;
  if (!key || !caseId) return;
  if (listed && riskCaseKey(listed) === caseId) {
    if (!held || Number(riskCaseOf(listed)?.version || 0) >= Number(riskCaseOf(held.alarm)?.version || 0)) {
      selectedRiskRead++;
      selectedRiskContext.value = { selectionKey: key, caseId, alarm: listed, unavailable: false, missing: false };
      return;
    }
  }
  if (!held || held.reading || ['CLEARED', 'ENDED'].includes(riskCaseOf(held.alarm)?.stage)
    || (held.checkedAt && Date.now() - held.checkedAt < 2000)) return;
  const request = ++selectedRiskRead;
  selectedRiskContext.value = { ...held, missing: true, reading: true, checkedAt: Date.now(), unavailable: held.missing ? held.unavailable : true };
  try {
    const detail = await getUavRiskCase(caseId, { purpose: 'verification' });
    if (request !== selectedRiskRead || key !== selectedRiskSelectionKey()) return;
    if (detail?.risk_case?.risk_case_id !== caseId) throw new Error('风险详情与所选记录不一致');
    const latest = toAlarms([{ ...detail.alarm,
      risk_case: detail.risk_case, prediction: detail.event?.prediction || detail.alarm?.prediction }], { includeClosed: true })[0];
    if (!latest || latest.targetInternalId !== held.alarm.targetInternalId
      || (held.alarm.sourceMode && latest.sourceMode !== held.alarm.sourceMode)
      || riskCaseOf(latest)?.airspace_id !== riskCaseOf(held.alarm)?.airspace_id) throw new Error('风险目标、来源或区域关联已变化，请重新选择');
    if (Number(detail.risk_case.version || 0) < Number(riskCaseOf(held.alarm)?.version || 0)) throw new Error('风险状态尚在更新，请稍候重读');
    selectedRiskContext.value = { selectionKey: key, caseId, alarm: latest, missing: true, unavailable: false, reading: false, checkedAt: Date.now() };
  } catch (error) {
    if (request === selectedRiskRead && key === selectedRiskSelectionKey()) selectedRiskContext.value = {
      ...held, missing: true, reading: false, unavailable: true, checkedAt: Date.now(), reason: error.message || '风险状态读取失败，暂不能办理' };
  }
}, { immediate: true });
onUnmounted(() => { selectedRiskRead++; });
watch(mapPredictions, () => syncMapData(), { flush: 'post' });
watch([alarms, predictionRows], ([alarmRows, forecasts]) => {
  // 新风险只展开右上角风险列表，不弹顶部提示；同周期更新不反复抢页签。
  const candidates = [
    ...alarmRows.map(row => ({ keys: [eventKey(row), ...(row.prediction?.warnings || [row.prediction?.warning]).filter(warning => warning?.episode_id && (!riskCaseOf(row)?.airspace_id || !warning.airspace_id || warning.airspace_id === riskCaseOf(row).airspace_id)).map(warning => `episode:${warning.episode_id}`)], target: row.targetId || row.id,
      phase: riskStageLabel(row) || (isPredictionAlarm(row) ? '预计入区' : row.type), area: riskCaseOf(row)?.airspace_name })),
    ...forecasts.map(row => ({ keys: [row.warning.risk_case_id, row.warning.episode_id ? `episode:${row.warning.episode_id}` : `prediction:${row.key}`].filter(Boolean), target: row.targetNo || row.targetId,
      phase: '预计入区', area: row.name }))
  ];
  const fresh = candidates.filter(row => {
    const announced = row.keys.some(key => announcedRiskKeys.has(key));
    row.keys.forEach(key => announcedRiskKeys.add(key));
    return !announced;
  });
  if (!fresh.length) return;
  alertTab.value = 'target'; alertsExpanded.value = true; predictionClusterIds.value = [];
}, { flush: 'post' });

watch([selectedPrediction, predictionRows, targets], ([_prediction, rows]) => {
  reconcilePredictionSelection();
  predictionClusterIds.value = predictionClusterIds.value.filter(id => rows.some(row => row.key === id));
});
watch(() => isPredictionAlarm(selectedUavAlarm.value) ? selectedUavAlarm.value.alarmId : null, async alarmId => {
  const sequence = ++predictionAlarmDetailSeq;
  selectedPredictionAlarmDetail.value = null;
  if (!alarmId) return;
  try {
    const detail = await getAlarm(alarmId);
    if (sequence === predictionAlarmDetailSeq && detail?.alarm_id === alarmId && isPredictionAlarm(detail)) selectedPredictionAlarmDetail.value = detail;
  } catch { /* 冻结依据不可读时不以最新结果冒充首次快照。 */ }
}, { immediate: true });
onUnmounted(() => { predictionAlarmDetailSeq++; });
const refreshLagSeconds = computed(() => targetRefreshAt.value ? Math.max(0, Math.floor((nowTick.value - targetRefreshAt.value) / 1000)) : 0);
const refreshSlow = computed(() => {
  if ((snapshot.value.deniedSegments || []).includes('targets')) return false;
  const startedAt = Number(snapshot.value.targetRefreshStartedAt || 0);
  return (startedAt > 0 && nowTick.value - startedAt >= SLOW_REFRESH_SECONDS * 1000)
    || ((snapshot.value.failedSegments || []).includes('targets') && refreshLagSeconds.value >= SLOW_REFRESH_SECONDS);
});
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
  return riskCaseOf(item) ? riskCaseKey(item) : `${item?.id || ''}:${Number(item?.occurredAt ?? item?.ts ?? 0)}`;
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
  return new Date(Number(value)).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
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
    const plan = planForRisk(group);
    map.planSel = plan?.id || null;
    map.clearPinnedHit();
    if (plan?.coordinates?.length >= 2) map.fitTo(plan.coordinates, 0.38);
    focusSelection(false);
  }
}


function toggleDeviceType(typeCode) {
  expandedType.value = expandedType.value === typeCode ? '' : typeCode;
}

function decorate(next) {
  const targetsByInternalId = new Map((next.targets || []).map(target => [target.targetId, target]));
  // 每个事件的处罚移送进度：发出才算已移送，建立未发出是待发送（与告警列表同一口径）。
  const punishmentRows = new Map();
  for (const row of next.handoffs || []) {
    if (row.source_kind !== 'UAV_EVENT') continue;
    punishmentRows.set(row.source_id, [...(punishmentRows.get(row.source_id) || []), row]);
  }
  const nextAlarms = (next.alarms || []).map(alarm => {
    const target = targetsByInternalId.get(alarm.targetInternalId);
    return {
      ...alarm,
      isNew: isNewEvent(alarm),
      disposalStage: riskCaseOf(alarm) ? disposalStage(riskCaseOf(alarm).counter) : disposalStage(target?.disposalSummary),
      handoff: riskCaseOf(alarm)?.manual_counter_only ? '' : punishmentHandoffProgress(punishmentRows.get(alarm.eventId)) || ''
    };
  });
  const now = serverNow();
  const nextRisks = (next.risks || []).map(risk => {
    const plan = (next.flightPlans || []).find(plan => riskMatchesPlan(risk, plan));
    const active = situationRouteRiskIsCurrent(risk, plan, targetsByInternalId.get(risk.targetInternalId), now);
    return { ...risk, active, mapVisible: active, isNew: active && isNewEvent(risk) };
  });
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
  const previousSelectedTargetId = selection.value?.targetId || selectedTarget.value?.targetId;
  const previousCaseId = selection.value?.riskCaseId || riskCaseOf(selectedUavAlarm.value)?.risk_case_id;
  rawSnapshot = next;
  for (const segment of reportedSourceFailures) if (!(next.failedSegments || []).includes(segment)) reportedSourceFailures.delete(segment);
  const decorated = decorate(currentMapSnapshot(next));
  snapshot.value = decorated;
  if (selection.value?.kind === 'target' && !selectedTarget.value && !previousCaseId) {
    const forecast = currentPredictions.value.find(row => row.target_id === previousSelectedTargetId);
    if (forecast) selection.value = { kind: 'prediction', id: forecast.target_id, targetId: forecast.target_id, sourceMode: selection.value.sourceMode }; else clearSelection();
  }
  // 已选区域风险独立于地图位置时效。地图目标/预测可退出，办理上下文不能被改成纯预测再清掉。
  reconcilePredictionSelection();
  predictionClusterIds.value = predictionClusterIds.value.filter(id => predictionRows.value.some(row => row.key === id));
  if (selection.value?.kind === 'risk-group' && !selectedRiskGroup.value) clearSelection();
  if (selection.value?.riskId && !decorated.risks.some(risk => risk.riskId === selection.value.riskId && risk.active)) clearSelection();
  const count = newAlarmCount.value + newRiskCount.value;
  const failed = (next.failedSegments || []).map(segment => ({
    predictions: '未来预测', targets: '目标', alarms: '告警', risks: '风险', handoffs: '移送', devices: '设备',
    'device-events': '设备事件', 'flight-plans': '飞行任务', airspaces: '空域', 'fusion-status': '融合状态'
  }[segment] || segment));
  statusAnnouncement.value = failed.length
    ? `${failed.join('、')}数据刷新失败，已保留上次结果；恢复后自动重试`
    : count
    ? `融合感知数据已更新，${count} 条新风险`
    : '融合感知数据已更新，当前无未查看异常';
  syncMapData();
  if (!map) return;
  if (selection.value && ['device', 'target', 'plan'].includes(selection.value.kind)) map.pinHit(selection.value.kind, selection.value.id);
}

function syncMapData() {
  if (!map) return;
  const mini = eoExpanded.value, data = snapshot.value;
  map.layers = { ...map.layers, coverage: mini || layers.value.coverage, device: mini || layers.value.device,
    track: mini || layers.value.track, flightPlan: !mini && layers.value.flightPlan,
    nofly: !mini && layers.value.airspace, limit: !mini && layers.value.airspace, suit: !mini && layers.value.airspace };
  map.setData({
    airspaces: mini ? [] : data.airspaces,
    devices: mini ? (eoMapView.value.coordinates.length ? [currentEoDevice.value] : []) : locatedDevices.value,
    targets: mini ? eoMapView.value.targets.map(target => ({ ...target, track: [] })) : data.targets,
    predictions: mini ? [] : mapPredictions.value,
    flightPlans: mini ? [] : data.flightPlans,
    risks: mini ? [] : data.risks.filter(risk => risk.mapVisible !== false), alarms: []
  });
}

function onSourceError(error, segment) {
  if (!situationPageActive) return;
  const label = SEGMENT_LABEL[segment] || segment;
  statusAnnouncement.value = `${label}更新失败，正在重试；已保留上次真实结果`;
  if (reportedSourceFailures.has(segment)) return;
  reportedSourceFailures.add(segment);
  const reason = error?.code === 'TIMEOUT' ? '服务响应超时' : error?.code === 'NETWORK_ERROR' ? '暂时无法连接服务' : error?.message || '服务暂时不可用';
  toast(`${label}更新失败：${reason}。正在自动重试，当前显示上次结果。`, 'err');
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

function selectTarget(target, alarmId, riskCaseId) {
  if (!situationPageActive || !target) return;
  const request = ++selectedReadSequence;
  alertTab.value = 'target';
  markViewed([...(target.relatedAlarms || []), ...(target.relatedRisks || []).filter(risk => risk.active)]);
  const alarm = riskCaseId ? (target.relatedAlarms || []).find(row => riskCaseKey(row) === riskCaseId)
    : alarmId ? (target.relatedAlarms || []).find(row => row.alarmId === alarmId) : targetAlarm(target);
  const caseId = riskCaseId || riskCaseOf(alarm)?.risk_case_id;
  selection.value = { kind: 'target', id: target.id, targetId: target.targetId, sourceMode: target.sourceMode, alarmId, riskCaseId: caseId };
  rememberSelectedRisk(alarm);
  if (map) {
    map.sel = target.id;
    map.planSel = null;
    map.pinHit('target', target.id);
    focusSelection();
  }
  const current = () => situationPageActive && request === selectedReadSequence && selectedTarget.value?.targetId === target.targetId;
  source.loadTargetDetail(target.targetId).catch(error => { if (current()) onSourceError(error, 'target-sources'); });
  source.loadTargetPrediction(target.targetId).catch(error => { if (current()) onSourceError(error, 'predictions'); });
}

function rememberSelectedRisk(alarm, unavailable = false) {
  const caseId = riskCaseOf(alarm)?.risk_case_id;
  if (!caseId) return;
  selectedRiskRead++;
  selectedRiskContext.value = { selectionKey: selectedRiskSelectionKey(), caseId, alarm, unavailable, missing: false };
}

function reconcilePredictionSelection() {
  const value = selection.value;
  if (value?.kind !== 'prediction') return;
  const target = targets.value.find(item => item.targetId === (value.targetId || value.id)
    && (!value.sourceMode || item.sourceMode === value.sourceMode));
  if (target) selectTarget(target, value.alarmId, value.riskCaseId);
  else if (!selectedPrediction.value && !value.riskCaseId) clearSelection();
}

function selectPrediction(row) {
  const prediction = currentPredictions.value.find(item => item.target_id === (row.prediction || row).target_id);
  if (!prediction) return;
  const warning = row.warning;
  const caseId = warning?.risk_case_id;
  const linked = caseId ? (snapshot.value.alarms || []).find(alarm => riskCaseKey(alarm) === caseId && alarm.targetInternalId === prediction.target_id) : null;
  const target = targets.value.find(item => item.targetId === prediction.target_id);
  if (linked) selectAlarm(linked);
  else if (target) {
    selectTarget(target, warning?.alarm_id, caseId);
    if (caseId && (selectedRiskContext.value?.caseId !== caseId || selectedRiskContext.value?.selectionKey !== selectedRiskSelectionKey())) rememberSelectedRisk({
      alarmId: warning.alarm_id, eventId: warning.event_id, targetInternalId: prediction.target_id, targetId: prediction.target_no,
      sourceMode: target.sourceMode, originKind: PREDICTION_ORIGIN, risk_case: { risk_case_id: caseId, airspace_id: warning.airspace_id }
    }, true);
  } else if (caseId) {
    selection.value = { kind: 'alarm', id: caseId, riskCaseId: caseId, targetId: prediction.target_id, sourceMode: prediction.source_mode };
    rememberSelectedRisk({ alarmId: warning.alarm_id, eventId: warning.event_id, targetInternalId: prediction.target_id,
      targetId: prediction.target_no, sourceMode: prediction.source_mode, originKind: PREDICTION_ORIGIN,
      risk_case: { risk_case_id: caseId, airspace_id: warning.airspace_id } }, true);
    map?.clearPinnedHit();
  } else { selection.value = { kind: 'prediction', id: prediction.target_id, targetId: prediction.target_id, sourceMode: prediction.source_mode }; map?.clearPinnedHit(); }
  alertTab.value = 'target';
  layers.value = { ...layers.value, prediction: true };
  map?.setLayer('prediction', true);
}

function selectAlarm(alarm) {
  if(eoDevice.value){const candidate=eoCandidates.value.find(row=>row.eventId===alarm.eventId);if(candidate)selectEoTargets([candidate]);else toast('该告警没有当前可选择的无人机','warn');return;}
  markViewed(alarm);
  alertTab.value = 'target';
  const target = targets.value.find(target => target.targetId === alarm.targetInternalId);
  if (target) selectTarget(target, alarm.alarmId, riskCaseOf(alarm)?.risk_case_id);
  else {
    // 目标不在当前监测窗口，仍查看被点击的同一事件，不能沿用前一个目标。
    selection.value = { kind: 'alarm', id: riskCaseKey(alarm), riskCaseId: riskCaseOf(alarm)?.risk_case_id, targetId: alarm.targetInternalId, sourceMode: alarm.sourceMode };
    rememberSelectedRisk(alarm);
    fuseOpen.value = false;
    if (map) { map.sel = null; map.planSel = null; map.clearPinnedHit(); }
  }
}

function alarmAnchor() {
  const current = selection.value;
  const icon = map && (selectedSnapshotId.value && map.getHitPoint('risk-snapshot', selectedSnapshotId.value)
    || current && map.getHitPoint(current.kind, current.id));
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
  // 弹窗同时避让同任务的发现时标记，避免避让后的气球被详情遮住。
  for (const row of riskSnapshots.value) {
    if (row.id !== selectedSnapshotId.value && !riskMatchesPlan(row.group, plan)) continue;
    const point = layers.value.flightPlan && map.getHitPoint('risk-snapshot', row.id);
    if (point) points.push([point[0] - 56, point[1] - 29], [point[0] + 56, point[1] + 29]);
  }
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
  if (selection.value?.riskCaseId) return selection.value.riskCaseId === riskCaseOf(alarm)?.risk_case_id;
  return selection.value?.kind === 'alarm' ? selection.value.id === riskCaseKey(alarm)
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
  // 弹窗仅展示明确的连接状态变化，报文、协议状态码和指令日志留在后台。
  const related = (device.relatedAlerts || [])
    .filter(event => ['CONNECTED', 'DISCONNECTED', 'RECOVERED'].includes(event.state))
    .slice(0, 2);
  return `<section class="sit-map-pop sit-map-pop-device" style="--sensor:${esc(device.color)}">
    <header><span class="sit-map-pop-icon">${iconHtml(device)}</span><span><b>${esc(device.name)}</b>${device.simulated ? '<small>模拟设备</small>' : ''}</span>
      <button type="button" data-tip-act="close" aria-label="关闭设备详情">${U.icon('close')}</button></header>
    <div class="sit-map-pop-status"><span class="sit-state ${statusClass(device.status)}">${esc(device.status)}</span><span>最新上报 ${esc(reportAge(device.lastReportAt))}</span></div>
    ${device.posValid === false ? '<p class="sit-map-pop-note">未提供安装坐标，暂不显示地图点位。</p>' : ''}
    ${device.timeUntrusted ? `<p class="sit-map-pop-note">设备数据延迟${esc(clockLagText(device.reportLagMs) || '较多')}，请联系运维检查。</p>` : ''}
    <dl><dt>${esc(coverage.label || '覆盖参数')}</dt><dd class="${unavailable ? 'is-unavailable' : ''}">${esc(coverageState)}${coverage.displayOnly ? ' · 示意范围' : ''}</dd>
      ${coverage.availabilityReason ? `<dt>可用性</dt><dd class="is-unavailable">${esc(coverage.availabilityReason)}</dd>` : ''}
    </dl>
    ${related.length ? `<div class="sit-map-pop-alerts"><b>近期连接情况</b>${related.map(event => `<span>${esc(event.title)}</span>`).join('')}</div>` : ''}
    ${device.typeCode === 'EO' ? '<div class="sit-video-entry"><button type="button" data-tip-act="device-video">实时视频</button></div>' : ''}
  </section>`;
}

function renderTargetActions(target, hasAdvisoryCard = false, hasNextStep = false) {
  const alarm = targetAlarm(target);
  const buttons = [];
  if (target.objectTypeCode === 'UAV' && alarm) {
    const process = uavProcessActions(alarm);
    // 有「下一步」时核实按钮已放在那里。
    const prediction = predictionVerificationState(null, alarm, nowTick.value);
    if (process.includes('verify') && !hasNextStep && !prediction?.terminal) buttons.push(`<button type="button" data-tip-act="verify">核实</button>`);
    if (alarm.eventState !== 'FALSE_POSITIVE' && !hasAdvisoryCard) buttons.push('<button type="button" data-tip-act="disposal-flow">处置流程</button>');
  }
  return buttons.length ? `<div class="sit-map-pop-actions">${buttons.join('')}</div>` : '';
}

/** part：'all' 整张卡；'head' 只到「无人机现在」；'body' 其余部分（中间插「下一步」）。 */
function renderTargetTip(target, hasAdvisoryCard = false, part = 'all') {
  const alarm = targetAlarm(target);
  const notification = alarm?.eventId ? advisorySummaries.value[riskCaseOf(alarm)?.risk_case_id || alarm.eventId] : null;
  const sms = notification ? autoSmsView(notification) : null;
  const voice = notification ? autoVoiceView(notification) : null;
  const routeRisk = (target.relatedRisks || []).find(risk => risk.active);
  const predicted = isPredictionAlarm(alarm);
  const nowStatus = target.objectTypeCode === 'UAV' && alarm && !predicted ? targetNowStatus(target, notification, alarm.eventId) : null;
  const reason = alarm && !predicted ? alarmReasonView({ legalStatus: target.legalitySummary?.legal_status, legalReasons: target.legalitySummary?.violation_reasons,
    alarmReasons: alarm.violationReasons, escalationCount: alarm.escalationCount, reasonText: ruleReasonText }) : null;
  const sourceNames = devices.value.filter(device => (target.sourceDeviceIds || []).includes(device.fusionDeviceId || device.deviceId))
    .map(device => device.type).join(' / ');
  const summary = alarm?.type || displayNumberReferences(routeRisk?.reasonText, [routeRisk?.targetId, routeRisk?.id]) || '暂无关联异常';
  const processStatus = alarm ? uavProcessStatus(alarm) : '';
  // 报文时刻不可信（ZT-20）不能显示成"已观测"：写明数据过期、设备时间不准。
  const stateText = processStatus || (target.activeRisk ? '风险持续'
    : target.timeUntrusted ? '数据过期 · 设备时间不准'
      : target.stale || target.freshness === 'STALE' ? '数据已过期' : '已观测');
  const stateClass = alarm?.eventState === 'FALSE_POSITIVE' || processStatus === '已移送处罚' || processStatus === '已干扰'
    ? 'is-online' : (target.activeRisk || processStatus === '信号干扰中' || processStatus === '待审批' ? 'is-risk'
      : !processStatus && target.timeUntrusted ? 'is-warning' : 'is-online');
  const open = `<section class="sit-map-pop sit-map-pop-target${target.newAlert ? ' is-new' : ''}${part === 'all' ? '' : ` is-${part}`}" style="--sensor:${target.objectTypeCode === 'UAV' ? '#2fd06e' : '#72d6ff'}">`;
  const head = `<header><span class="sit-map-pop-icon">${targetIconHtml(target)}</span><span><b>${esc(displayTargetNo(target.id))}</b><small>${esc(target.typeLabel)}</small></span>
      <button type="button" data-tip-act="close" aria-label="关闭目标详情">${U.icon('close')}</button></header>
    ${predicted ? predictionAlarmStatusHtml(alarm, { now: nowTick.value, currentObservation: targetIsCurrent(target, nowTick.value), legalStatus: target.legalitySummary?.legal_status }) : nowStatus ? uavNowHtml(nowStatus, { process: [processStatus, summary].filter(Boolean).join(' · ') })
      : `<div class="sit-map-pop-status"><span class="sit-state ${stateClass}">${esc(stateText)}</span><span>${esc(summary)}</span></div>`}`;
  const body = `${reason ? `<div class="sit-target-alarm-reason is-${reason.tone}" aria-label="${esc(reason.label)}"><span>${esc(reason.label)}</span><strong>${esc(reason.text)}</strong>${reason.atAlarm ? `<small>${esc(reason.atAlarmLabel)}：${esc(reason.atAlarm)}</small>` : ''}</div>` : ''}
    <div class="sit-target-metrics"><span><small>高度</small><b>${esc(formatMetric(target.alt, ' m'))}</b></span><span><small>速度</small><b>${esc(formatMetric(target.speed, ' m/s'))}</b></span></div>
    <p>最后上报：${esc(formatClock(target.lastSeenAt))} · ${esc(reportAge(target.lastSeenAt))}</p>
    ${target.timeUntrusted ? `<p class="sit-map-pop-note">数据过期：报文时刻比平台收到时早${esc(clockLagText(target.reportLagMs) || '较多')}，设备时间不准或数据积压，图上位置可能不是当前位置；超过新鲜时限的数据不做合法性判定。平台收到：${esc(formatClock(target.receivedAt))}</p>` : ''}
    ${target.objectTypeCode === 'UAV' ? `<p>遥控器位置：${esc(pilotLocationText(target.pilotLocation))}</p>` : ''}
    ${target.objectTypeCode === 'UAV' && pilotDistanceNote(target.legalitySummary) ? `<p class="sit-map-pop-note">${esc(pilotDistanceNote(target.legalitySummary))}</p>` : ''}
    <div class="sit-target-source"><span>感知来源：${esc(sourceNames || '未提供')}</span><button type="button" data-tip-act="eo-video" aria-expanded="${showTargetVideo.value}" aria-controls="situation-video-window">${showTargetVideo.value ? '收起视频' : '实时视频'}</button></div>
    ${alarm?.eventId && !hasAdvisoryCard ? `<p class="sit-map-pop-note">短信通知：${esc(sms?.title || '正在读取通知状态')}${sms?.simulated ? '（模拟）' : ''}${sms?.updatedAt ? ` · ${esc(formatClock(sms.updatedAt))}` : ''}</p>
    <p class="sit-map-pop-note">飞手电话：${esc(voice?.title || '正在读取通知状态')}${voice?.simulated ? '（模拟）' : ''}${!predicted && voice?.departureBasis ? `<br><small>${esc(voice.departureBasis)}；现在的情况以「无人机现在」为准</small>` : ''}</p>` : ''}
    ${renderTargetActions(target, hasAdvisoryCard, part === 'body')}`;
  if (part === 'head') return `${open}${head}</section>`;
  if (part === 'body') return `${open}${body}</section>`;
  return `${open}${head}${body}</section>`;
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
  </section>`;
}

function renderMapTip(hit) {
  if (hit?.kind === 'device') return renderDeviceTip(hit.data);
  // 无人机详情统一由点击后的 Vue 卡片显示，避免悬浮卡与实时选中卡重复。
  if (hit?.kind === 'target') return hit.data?.objectTypeCode === 'UAV' ? '' : renderTargetTip(hit.data);
  if (hit?.kind === 'plan') return renderPlanTip(hit.data);
  if (hit?.kind === 'prediction') return `<div class="sit-map-pop"><b>预测入区 · ${hit.data.rows.length} 项</b><p>点击查看预测预警，预计位置不代表已经入区。</p></div>`;
  return null;
}

function onMapPick(hit) {
  if(eoDevice.value && hit?.kind==='target') {const row=eoCandidates.value.find(candidate=>candidate.mapId===hit.data.id);selectEoTargets(row?[row]:[]);return;}
  if(eoExpanded.value) return;
  if (hit?.kind === 'prediction') {
    const rows = hit.data.rows || [];
    predictionClusterIds.value = rows.length > 1 ? rows.map(row => row.warning.event_id || row.warning.alarm_id || `${row.prediction.targetId}:${row.warning.airspace_version_id}`) : [];
    alertTab.value = 'target'; alertsExpanded.value = true;
    if (rows.length === 1) {
      const current = predictions.value.find(row => row.prediction_id === rows[0].prediction.id);
      if (current) selectPrediction(current); else toast('预测已更新，请从预测清单重新选择。', 'warn');
    }
    return;
  }
  if (hit?.kind === 'device') selectDevice(devices.value.find(device => device.id === hit.data.id));
  if (hit?.kind === 'target') selectTarget(targets.value.find(target => target.id === hit.data.id));
  if (hit?.kind === 'plan') selectPlan(flightPlans.value.find(plan => plan.id === hit.data.id));
  if (hit?.kind === 'weather') selectWeatherRisk(hit.data);
}

/** 无人机现在状态：地图上的目标都在有效时限内；通知后的位置判断只有当前选中的事件才读到。 */
function targetNowStatus(target, notification = null, eventId = '') {
  return uavNowStatus({
    current: targetIsCurrent(target, snapshot.value.generatedAt || serverNow()),
    observedAt: target.observedAt,
    legalStatus: target.legalitySummary?.legal_status,
    legalReasons: target.legalitySummary?.violation_reasons,
    departure: notification ? notification.departure_observation : eventId ? departureByEvent.value[eventId] : null,
    now: snapshot.value.generatedAt || serverNow(),
    reasonText: ruleReasonText
  });
}

function alarmNowPill(alarm) {
  if (riskCaseOf(alarm)) return '';
  const target = targets.value.find(row => row.targetId === alarm.targetInternalId);
  if (!target || target.objectTypeCode !== 'UAV') return '';
  const notification = alarm.eventId ? advisorySummaries.value[riskCaseOf(alarm)?.risk_case_id || alarm.eventId] : null;
  // 通知后的位置判断还没读到时不出标签，免得和点开后的卡片说法不一致。
  if (alarm.eventState === 'CONFIRMED' && alarm.eventId && !notification && !(alarm.eventId in departureByEvent.value)) return '';
  return uavNowPillHtml(targetNowStatus(target, notification, alarm.eventId));
}

/** 有有效位置证明已离开、且最新研判不再违规的告警，不再留在融合感知，只在告警事件页办理。 */
function alarmDeparted(alarm) {
  if (riskCaseOf(alarm)) return ['CLEARED', 'ENDED'].includes(riskCaseOf(alarm).stage);
  if (isPredictionAlarm(alarm)) return false;
  if (!alarm?.eventId || alarm.eventState !== 'CONFIRMED') return false;
  const target = targets.value.find(row => row.targetId === alarm.targetInternalId);
  if (!target || target.objectTypeCode !== 'UAV') return false;
  return targetNowStatus(target, advisorySummaries.value[riskCaseOf(alarm)?.risk_case_id || alarm.eventId] || null, alarm.eventId).departed === true;
}

// 通知后判定已离开是一次性的结论，读到“已离开”后不再重读；其余每 15 秒最多读一次，一次最多 6 条。
const departureReadAt = new Map();
let departureReading = false;
async function refreshDepartures() {
  if (departureReading) return;
  departureReading = true;
  try {
    const now = Date.now();
    const due = (snapshot.value.alarms || []).filter(alarm => !riskCaseOf(alarm) && !isPredictionAlarm(alarm) && alarm.eventId && alarm.eventState === 'CONFIRMED'
      && currentTargetIds.value.has(alarm.targetInternalId) && situationAlarmNeedsAttention(alarm)
      && departureByEvent.value[alarm.eventId]?.presence !== 'LEFT' && now - (departureReadAt.get(alarm.eventId) || 0) >= 15000).slice(0, 6);
    for (const alarm of due) {
      departureReadAt.set(alarm.eventId, now);
      try {
        const value = await uavAdvisoryApi.get(alarm.eventId, riskCaseOf(alarm)?.risk_case_id);
        if (value?.event_id === alarm.eventId) departureByEvent.value = { ...departureByEvent.value, [alarm.eventId]: value.departure_observation || null };
      } catch { /* 读不到时保持原样：不当作已飞离 */ }
    }
  } finally { departureReading = false; }
}
watch(() => snapshot.value.generatedAt, () => { void refreshDepartures(); });
const selectedNowStatus = computed(() => {
  const alarm = selectedUavAlarm.value;
  if (!alarm || riskCaseOf(alarm) || isPredictionAlarm(alarm)) return null;
  const target = selectedTarget.value || targets.value.find(row => row.targetId === alarm.targetInternalId);
  const notification = alarm.eventId ? advisorySummaries.value[riskCaseOf(alarm)?.risk_case_id || alarm.eventId] : null;
  if (target?.objectTypeCode === 'UAV') return targetNowStatus(target, notification, alarm.eventId);
  return uavNowStatus({ current: false, now: snapshot.value.generatedAt || serverNow() });
});

function verifySelectedAlarm(alarm = selectedUavAlarm.value) {
  // 点击使用按钮对应的风险，不因实时列表短暂移除或目标过期而重新选择另一条记录。
  return openTargetVerification(null, alarm);
}

function targetAlarm(target) {
  const related = (target?.relatedAlarms || []).filter(row => riskCaseVisible(row) && (!isPredictionAlarm(row) || predictionRows.value.some(item => item.warning.event_id === row.eventId || item.warning.alarm_id === row.alarmId)));
  const selectedId = selection.value?.kind === 'target' && selection.value.id === target?.id ? selection.value.alarmId : null;
  const selectedCaseId = selection.value?.riskCaseId || (selectedRiskContext.value?.selectionKey === selectedRiskSelectionKey() ? selectedRiskContext.value.caseId : null);
  const alarm = selectedCaseId ? related.find(row => riskCaseKey(row) === selectedCaseId) : selectedId ? related.find(row => row.alarmId === selectedId) : related.find(row => riskCaseVisible(row) && row.eventState !== 'FALSE_POSITIVE');
  if (!alarm || !isPredictionAlarm(alarm)) return alarm || null;
  const latest = predictions.value.find(row => row.target_id === target.targetId);
  const warning = latest?.warnings?.find(row => row.event_id === alarm.eventId)
    || (latest?.warning?.event_id === alarm.eventId ? latest.warning : null);
  const prediction = warning ? { ...latest, warning, warnings: [warning] } : alarm.prediction;
  const detail = selectedPredictionAlarmDetail.value?.alarm_id === alarm.alarmId ? selectedPredictionAlarmDetail.value : null;
  return { ...alarm, prediction: predictionUnavailable.value && prediction ? { ...prediction, status: 'UNKNOWN' } : prediction,
    prediction_snapshot: detail?.prediction_snapshot || alarm.prediction_snapshot };
}

function updateNotification(value) {
  const alarm = selectedUavAlarm.value, risk = riskCaseOf(alarm), incoming = value.risk_case;
  const key = value._riskCaseId || incoming?.risk_case_id || value.risk_case_id || value.event_id;
  if (key !== (risk?.risk_case_id || alarm?.eventId)) return;
  if (risk && incoming?.version != null && Number(incoming.version) < Number(risk.version)) return;
  const newer = risk && incoming?.risk_case_id === risk.risk_case_id
    && Number.isInteger(Number(incoming.version)) && Number(incoming.version) > Number(risk.version)
    && incoming.airspace_id === risk.airspace_id && incoming.source_mode === (risk.source_mode || alarm.sourceMode)
    && incoming.action_event_id === value.event_id && incoming.stage && incoming.verification_status
    && (value.event_id === alarm.eventId || incoming.related_event_ids?.includes(alarm.eventId));
  if (value.event_id !== alarm?.eventId && !newer) return;
  const previous = advisorySummaries.value[key];
  if (previous?.event_id === value.event_id && (previous._fetchedAt > (value._fetchedAt || 0) || previous.event_version > value.event_version)) return;
  if (newer) {
    selectedRiskRead++;
    selectedRiskContext.value = { selectionKey: selectedRiskSelectionKey(), caseId: key, unavailable: false, missing: false, checkedAt: Date.now(),
      alarm: { ...alarm, risk_case: { ...incoming }, eventId: value.event_id, eventState: incoming.verification_status,
        disposalStage: disposalStage(incoming.counter) } };
  }
  advisorySummaries.value = { ...advisorySummaries.value, [key]: value };
  departureByEvent.value = { ...departureByEvent.value, [value.event_id]: value.departure_observation || null };
  if (map && selection.value?.kind === 'target') map.pinHit('target', selection.value.id);
}

// 核实响应的阶段、核实状态和资格来自同一读快照；校验后一次接续选中卡片。
// 地图列表随后刷新，不丢弃已返回的新资格，也不借其他区域或旧版本恢复按钮。
function applySelectedRiskDetail(detail) {
  const alarm = selectedUavAlarm.value, current = riskCaseOf(alarm), risk = detail?.risk_case;
  if (!current?.risk_case_id || risk?.risk_case_id !== current.risk_case_id
    || detail.alarm?.target_id !== alarm.targetInternalId || risk.airspace_id !== current.airspace_id
    || (alarm.sourceMode && detail.alarm.source_mode !== alarm.sourceMode)
    || Number(risk.version) < Number(current.version)
    || !riskSummaryMatches(detail.advisory, risk.action_event_id, risk.risk_case_id, risk)) return false;
  updateNotification({ ...detail.advisory, _riskCaseId: risk.risk_case_id, _fetchedAt: Date.now() });
  return selectedAdvisorySummary.value === advisorySummaries.value[risk.risk_case_id]
    && !!selectedAdvisorySummary.value;
}

function invalidateNotification(eventId, startedAt = Date.now(), caseId = '') {
  const key = caseId || riskCaseOf(selectedUavAlarm.value)?.risk_case_id || eventId;
  if (key !== (riskCaseOf(selectedUavAlarm.value)?.risk_case_id || selectedUavAlarm.value?.eventId)) return;
  if (eventId !== selectedUavAlarm.value?.eventId
    || (advisorySummaries.value[key]?._fetchedAt || 0) > startedAt) return;
  advisorySummaries.value = { ...advisorySummaries.value, [key]: { event_id: eventId, _riskCaseId: caseId, _unavailable: true, _fetchedAt: startedAt } };
}

let verificationOpening = null;
onUnmounted(() => verificationOpening?.modal.close());
async function openTargetVerification(target, alarm = targetAlarm(target)) {
  const caseId = riskCaseOf(alarm)?.risk_case_id;
  const eventId = alarm?.eventId || alarm?.event_id;
  const alarmId = alarm?.alarmId || alarm?.alarm_id;
  if (!caseId && !eventId) return toast('没有关联无人机事件，无法核实', 'err');
  const key = caseId || eventId;
  if (verificationOpening?.key === key && verificationOpening.modal.isCurrent()) return false;
  const modal = openModal({ title: '正在读取核实依据', width: '460px',
    render: () => h('div', { role: 'status', 'aria-live': 'polite' }, [
      h('p', '正在核对当前风险和最新依据，请稍候。'), h('p', '读取期间不会提交核实结论。')
    ]) });
  const opening = { key, modal }; verificationOpening = opening;
  try {
    // 只用点击时的稳定标识定位；阶段、事件、核实资格和预测依据全部读取最新详情。
    const detail = caseId ? await getUavRiskCase(caseId, { purpose: 'verification' }) : null;
    if (caseId && detail?.risk_case?.risk_case_id !== caseId) throw new Error('风险详情与所选记录不一致，请重新读取。');
    const [event, linkedAlarm] = detail ? [detail.event, { ...detail.alarm, risk_case: detail.risk_case }] : await Promise.all([
      getUavEvent(eventId),
      alarmId ? getAlarm(alarmId) : Promise.resolve(null)
    ]);
    if (!modal.isCurrent()) return false;
    const opened = openUavVerification({
      event,
      alarm: linkedAlarm,
      refresh: async result => {
        // 优先消费已提交后返回的一致快照，不能等全地图重读后仍保留核实前的在途资格。
        if (caseId) applySelectedRiskDetail(result);
        await source.refresh();
        return result?.event || (caseId ? (await getUavRiskCase(caseId, { purpose: 'verification' })).event : await getUavEvent(eventId));
      }
    });
    if (!opened) modal.close();
    return opened;
  } catch (error) {
    if (modal.isCurrent()) { modal.close(); toast(error.message || '无法读取核实事件，请稍后重试', 'err'); }
    return false;
  } finally { if (verificationOpening === opening) verificationOpening = null; }
}

async function openLinkedDisposal(target) {
  const alarm = targetAlarm(target);
  return openAlarmDisposal(alarm);
}

function openCounterRecords({ eventId, riskCaseId, authorizationId }) {
  const query = new URLSearchParams({ tab: 'authorizations', event: eventId });
  if (riskCaseId) query.set('risk_case', riskCaseId);
  if (authorizationId) query.set('authorization', authorizationId);
  window.location.hash = `/alarms?${query}`;
}

async function openAlarmDisposal(alarm) {
  // 只有数据源明确提供业务告警 ID 才深链；页面私有模拟 ID 不冒充服务端事件。
  if (riskCaseOf(alarm)?.risk_case_id) { window.location.hash = `/alarms?risk_case=${encodeURIComponent(riskCaseOf(alarm).risk_case_id)}`; return; }
  if (alarm?.alarmId) {
    try {
      const linked = await getAlarm(alarm.alarmId);
      if (!linked?.event_id) return toast('这条告警尚未建立可办理的无人机事件', 'err');
      window.location.hash = `/alarms?event=${encodeURIComponent(linked.event_id)}`;
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
  if(action==='device-video'){openEoVideo(hit?.data || selectedDevice.value);return;}
  if (action === 'close') return clearSelection();
  if (action === 'eo-video') {
    showTargetVideo.value = !showTargetVideo.value;
    focusSelection(false);
    return;
  }
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
    maxDev: Infinity,
    maxAlarm: 0,
    zoom: 1,
    legend: false,
    fusionProfile: true,
    // 固定使用原东营地图范围，不因设备位置扩大底图视野。
    constrainToCoverage: true,
    layoutMarkers: createSituationMarkerLayout(),
    getExternalMarkers: view => eoExpanded.value ? [] : [...(weatherLayer.value?.getMarkers(view) || []), ...(riskSnapshotLayer.value?.getMarkers(view) || [])],
    drawUnderMarkers: view => {
      if (eoExpanded.value) drawEoCoverageMask(view, eoMapView.value.coordinates);
      else { weatherLayer.value?.draw(view); riskSnapshotLayer.value?.draw(view); flightLayer.value?.draw(view); }
    },
    sensorIconScale: 1,
    // 地图装饰动画不需要 60fps；降低 Canvas 像素量和重绘频率，保留数据变化时的即时重画。
    animationFps: 12,
    maxDpr: 1.5,
    layers: { alarm: false, coverage: true, prediction: true },
    // 悬停小卡片不接点击（验收预跑 3-7）：图标挤在一起时，停在设备上弹出的卡片会盖住旁边的无人机，点不开；
    // 卡片上的按钮在点开后的弹窗里都有。
    interactiveTip: false,
    renderTip: hit => eoExpanded.value ? '' : renderMapTip(hit),
    onTipAction,
    onPick: onMapPick,
    onEmptyPick: clearSelection
  });
  stopSource = source.start(applySnapshot, onSourceError);
  // 独立于网络轮询：请求失败或迟迟未返回时，旧点仍按期退出地图。
  expiryTimer = window.setInterval(() => {
    nowTick.value = serverNow();
    if (document.hidden || !rawSnapshot) return;
    const at = nowTick.value;
    const visibleRiskIds = new Set(snapshot.value.risks.filter(risk => risk.active).map(risk => risk.riskId));
    const rawTargets = new Map(rawSnapshot.targets.map(target => [target.targetId, target]));
    const rawPlans = new Map(rawSnapshot.flightPlans.map(plan => [plan.planId, plan]));
    const riskWindowChanged = rawSnapshot.risks.some(risk => visibleRiskIds.has(risk.riskId)
      !== situationRouteRiskIsCurrent(risk, rawPlans.get(risk.planId), rawTargets.get(risk.targetInternalId), at));
    if (riskWindowChanged || snapshot.value.targets.some(target => target.mapExpiresAt <= at)) applySnapshot(rawSnapshot);
  }, 1000);
  selectionResizeObserver = new ResizeObserver(() => {
    if (eoExpanded.value) focusEoCoverage();
    else if (mainMapView) { map?.centerAt(...mainMapView.center, { scale: mainMapView.scale }); mainMapView = null; }
    else focusSelection(false);
  });
  selectionResizeObserver.observe(mapHost.value);
  document.addEventListener('visibilitychange', onVisibilityChange);
});

onUnmounted(() => {
  situationPageActive = false; selectedReadSequence++;
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
      <Teleport :to="eoExpanded ? '#eo-video-mini-map' : 'body'" :disabled="!eoExpanded">
        <div class="eo-map-shell" :class="{'is-mini':eoExpanded}">
          <div id="stMap" ref="mapHost" class="sit-map"></div>
          <EoMapSelection v-if="eoDevice" :get-map="() => map" :candidates="eoExpanded ? eoMapCandidates : eoCandidates" :selected="eoSelected" :mode="eoMode" @select="selectEoTargets" />
          <p v-if="eoExpanded && (eoMapView.reason || !eoMapView.targets.length)" class="eo-map-empty" role="status">{{eoMapView.reason || (snapshot.failedSegments?.includes('targets') ? '目标数据读取失败，暂无法确认范围内无人机' : '覆盖范围内暂无当前无人机')}}</p>
        </div>
      </Teleport>
      <SituationRiskMarkers ref="riskSnapshotLayer" :rows="riskSnapshots" :selected-id="selectedSnapshotId"
        :visible="layers.flightPlan" @select="selectRiskGroup" />
      <FlightTrafficLayer ref="flightLayer" :visible="layers.flights && !eoExpanded" :counter-devices="counterDevices" :selected-counter-id="selectedCounterId" />
      <WeatherRiskMarkers ref="weatherLayer" :risks="risks" :selected-id="selectedRisk?.riskId" shared-layout control-target="#situation-weather-control" @select="selectWeatherRisk" />

      <div class="sit-live-pill" :aria-label="`当前数据来源：${sourceModeText}`">
        <span class="sit-live-dot" aria-hidden="true"></span>
        <b>{{ sourceModeText }}</b>
        <span>{{ sourceModeDetail }}</span>
        <span>当前目标 {{ targets.length }} · 无人机 {{ targetCounts.uav }} · 异物 {{ targetCounts.foreign }} · 未分类 {{ targetCounts.unknown }}<template v-if="targetCounts.other"> · 其他 {{ targetCounts.other }}</template>（北京时间）</span>
        <time class="mono">{{ clockText }}</time>
        <em v-if="sourceFailureLabels || refreshSlow" class="sit-refresh-slow" role="status" :title="sourceFailureLabels ? `${sourceFailureLabels}更新失败，正在自动重试；当前显示上次结果。` : `最近一次数据停在 ${clockText}，已有 ${refreshLagSeconds} 秒没有更新；地图上的目标按期退出，可能不全。恢复后自动更新。`">{{ sourceFailureLabels ? `${sourceFailureLabels}更新失败 · 重试中` : `数据刷新慢 · ${refreshLagSeconds} 秒未更新` }}</em>
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
              <div v-for="device in group.items" :key="device.id" class="sit-device-node-wrapper">
              <button type="button" class="sit-device-node"
                :class="[{ 'is-selected': selection?.kind === 'device' && selection.id === device.id, 'has-new': device.newAlert }, statusClass(device.status)]"
                :aria-pressed="selection?.kind === 'device' && selection.id === device.id"
                :aria-label="`查看${device.type}设备 ${device.name}，${device.status}${device.hasAlarm ? '，存在告警' : ''}`" @click="selectDevice(device)">
                <span><span class="sit-node-icon" v-html="iconHtml(device)"></span><b>{{ device.name }}</b><small class="mono" :title="device.id">{{ device.display_no || device.id }}</small></span>
                <em>{{ device.status }} · {{ reportAge(device.lastReportAt) }}<template v-if="device.timeUntrusted"> · 设备时间不准</template><template v-if="!locatedDevices.includes(device)"> · 位置未知</template></em>
              </button>
              <button v-if="device.typeCode==='EO'" type="button" class="sit-device-video-button" :aria-label="`查看${device.name}实时视频`" @click="openEoVideo(device)">实时视频</button>
              </div>
            </div>
          </section>
          <section v-if="flightSummary.receivers" class="sit-device-group" style="--sensor:#8fb3d9">
            <div class="sit-device-row" :class="{ 'is-offline': !flightSummary.online }" role="group"
              :aria-label="`ADS-B 航班接收机，共${flightSummary.receivers}台，收到${flightSummary.aircraft}架航班`">
              <span class="sit-device-icon sit-device-icon--plane" aria-hidden="true"><svg viewBox="-10 -10 20 20"><path d="M0,-9 L2,-3 L9,1 L9,3 L2,1 L1.5,6 L4,8 L4,9.5 L0,8.5 L-4,9.5 L-4,8 L-1.5,6 L-2,1 L-9,3 L-9,1 L-2,-3Z" fill="currentColor" transform="rotate(90)" /></svg></span>
              <span class="sit-device-copy"><b>ADS-B 航班接收机<small>{{ flightSummary.receivers }} 台</small></b><em>{{ flightSummary.aircraft }} 架航班</em></span>
              <span class="sit-device-state" :class="{ 'is-down': !flightSummary.online }"><b>{{ flightSummary.online ? `${flightSummary.online}在线` : '全部不在线' }}</b><small>0异常 · {{ flightSummary.offline }}离线</small></span>
            </div>
          </section>
        </div>
        <footer v-show="devicesExpanded" id="sit-device-footer">共 {{ devices.length }} 台感知设备；在线设备显示上报脉冲。{{ hasSimulatedCoverage ? '模拟范围仅作地图示意。' : '覆盖范围以设备台账配置为准。' }}</footer>
      </aside>

      <aside class="sit-glass sit-alert-dock" :class="{ 'is-collapsed': !alertsExpanded }" aria-labelledby="sit-alert-title">
        <header class="sit-dock-head">
          <span><b id="sit-alert-title">实时风险</b></span>
          <em>{{ alarms.length }} 项无人机风险 · {{ riskGroups.length }} 项航线风险</em>
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
            <span>无人机风险</span><b :class="{ 'has-risk': alarms.length > 0 }">{{ alarms.length }}</b>
          </button>
          <button type="button" role="tab" :aria-selected="alertTab === 'route'" @click="alertTab = 'route'">
            <GitCompareOutline class="sit-risk-icon" aria-hidden="true" />
            <span>航线风险</span><b :class="{ 'has-risk': riskGroups.length > 0 }">{{ riskGroups.length }}</b>
          </button>
        </div>
        <div v-if="alertTab === 'target'" class="sit-alert-list" role="tabpanel" aria-label="无人机风险">
          <NSelect v-model:value="riskStageFilter" :options="riskStageOptions" size="small" aria-label="风险阶段" />
          <p v-if="!visibleUavRisks.length" class="prediction-list-note">当前没有此阶段的有效风险。</p>
          <button v-for="alarm in visibleUavRisks" :key="eventKey(alarm)" type="button" class="sit-alert-row"
            :class="[{ 'is-new': alarm.isNew, 'is-selected': isSelectedAlarm(alarm) }, `level-${alarm.level}`]"
            :aria-pressed="isSelectedAlarm(alarm)"
            :aria-label="`查看${displayBusinessNo(alarm.targetId || alarm.id) || '未关联目标告警'}的${alarm.type}，${alarm.eventState === 'PENDING_VERIFICATION' ? '待核实' : '待定是否反制'}`" @click="selectAlarm(alarm)">
            <span class="sit-alert-level">{{ alarm.level }}</span>
            <span class="sit-alert-copy"><b class="mono">{{ displayBusinessNo(alarm.targetId || alarm.id) || '未关联目标告警' }}</b><em>{{ riskStageLabel(alarm) || alarm.type }} · {{ riskCaseOf(alarm)?.airspace_name || alarm.district }}</em></span>
            <span class="sit-alert-meta"><time class="mono">{{ formatClock(alarm.ts) }}</time><b>{{ riskCaseVerificationLabel(alarm) }}{{ alarm.isNew ? ' · 新风险' : '' }}</b><span v-if="alarmNowPill(alarm)" v-html="alarmNowPill(alarm)"></span></span>
          </button>
        </div>
        <div v-else-if="alertTab === 'route'" class="sit-alert-list" role="tabpanel" aria-label="航线风险">
          <button v-for="risk in riskGroups" :key="risk.groupId" type="button" class="sit-alert-row sit-route-risk-row"
            :class="[{ 'is-new': risk.isNew, 'is-selected': selectedRiskGroup?.groupId === risk.groupId }, `level-${risk.level}`]"
            :aria-pressed="selectedRiskGroup?.groupId === risk.groupId"
            :aria-label="`查看${risk.targetId && risk.targetId !== risk.targetInternalId ? displayBusinessNo(risk.targetId) : '目标编号未提供'}的${risk.spaceFact?.subtypeName || '航线'}风险，关联${risk.planCount}条任务，${riskGroupStateText(risk)}`" @click="selectRiskGroup(risk)">
            <span class="sit-alert-level">{{ risk.level }}</span>
            <span class="sit-alert-copy">
              <b>{{ risk.spaceFact?.subtypeName || '航线' }}风险 · {{ labelOf(SOURCE_MODE_LABEL, risk.sourceMode, '来源未提供') }}</b>
              <em class="mono">{{ risk.targetId && risk.targetId !== risk.targetInternalId ? displayBusinessNo(risk.targetId) : '目标编号未提供' }} · 关联 {{ risk.planCount }} 条任务</em>
              <em>触发时：{{ riskFactText(risk) }}</em>
            </span>
            <span class="sit-alert-meta"><time class="mono">{{ formatClock(risk.occurredAt) }}{{ risk.isNew ? ' · 未查看' : '' }}</time><b>{{ riskGroupStateText(risk) }}</b></span>
          </button>
        </div>
        </div>
      </aside>

      <SituationAlarmPopup v-if="showSelectionPopup" :key="`${selection.kind}:${selection.id}:${selection.riskId || selection.riskCaseId || selection.alarmId || ''}`" :get-anchor="alarmAnchor"
        :get-avoid-rect="selectionAvoidRect"
        :video-open="showTargetVideo && !!videoContext"
        :label="riskCaseOf(selectedUavAlarm) ? '无人机风险详情' : isPredictionAlarm(selectedUavAlarm) ? '预测入区风险详情' : selectedDevice ? '设备详情' : selectedPlan ? '任务详情' : selectedRisk ? '航线风险详情' : showAlarmPopup ? '无人机告警详情' : '目标详情'">
        <template v-if="selectedDevice">
          <div @click="onTipAction($event.target.closest('[data-tip-act]')?.dataset.tipAct, { kind: 'device', data: selectedDevice })"
            v-html="renderDeviceTip(selectedDevice)"></div>
          <SituationDeviceReport :key="selectedDevice.deviceId" :device-id="selectedDevice.deviceId" />
        </template>
        <SituationTargetCard v-else-if="selectedCardTarget" :key="selectedCardTarget.targetId || selectedCardTarget.id"
          :target="selectedCardTarget" :alarm="selectedCardAlarm" :now-status="selectedNowStatus"
          :summary="selectedAdvisorySummary" :now="nowTick" :video-open="showTargetVideo"
          :source-names="devices.filter(device => (selectedCardTarget.sourceDeviceIds || []).includes(device.fusionDeviceId || device.deviceId)).map(device => device.type).join(' / ')"
          @close="clearSelection" @video="onTipAction('eo-video')" @verify="verifySelectedAlarm" @records="openCounterRecords"
          @updated="updateNotification" @unavailable="invalidateNotification" @open="openAlarmDisposal(selectedUavAlarm)" />
        <SituationRiskGroupPopup v-else-if="selectedRiskGroup" :group="selectedRiskGroup" :plans="flightPlans"
          @close="clearSelection" @view-plan="selectRisk" @updated="source.refresh()" />
        <template v-else-if="selectedPlan">
          <div @click="onTipAction($event.target.closest('[data-tip-act]')?.dataset.tipAct, { kind: 'plan', data: selectedPlan })"
            v-html="renderPlanTip(selectedPlan)"></div>
          <SituationRiskProcess v-for="risk in (selectedRisk ? [selectedRisk] : selectedPlan.activeRisks)"
            :key="risk.riskId" :risk-id="risk.riskId" :revision="risk.version" @updated="source.refresh()" />
        </template>
        <section v-else-if="selectedRisk" class="sit-map-pop">
          <header><span class="sit-map-pop-icon" v-html="U.icon('plan')"></span><span><b>{{ displayBusinessNo(selectedRisk.id) }}</b><small>航线风险</small></span>
            <button type="button" aria-label="关闭风险详情" @click="clearSelection" v-html="U.icon('close')"></button></header>
          <div class="sit-map-pop-status"><span class="sit-state is-risk">{{ labelOf(RISK_STATE_LABEL, selectedRisk.state) }}</span></div>
          <p>{{ displayNumberReferences(selectedRisk.reasonText, [selectedRisk.targetId, selectedRisk.id]) || '风险依据未提供' }}</p><p>当前未取得关联任务，保留此风险的信息。</p>
          <SituationRiskProcess :key="selectedRisk.riskId" :risk-id="selectedRisk.riskId" :revision="selectedRisk.version" @updated="source.refresh()" />
        </section>
        <section v-else-if="selectedUavAlarm" class="sit-map-pop">
          <header><span class="sit-map-pop-icon" v-html="U.businessIcon('uav')"></span><span><b>{{ displayBusinessNo(selectedUavAlarm.targetId || selectedUavAlarm.id) || '未关联目标告警' }}</b><small>{{ isPredictionAlarm(selectedUavAlarm) ? '预测入区预警' : '无人机告警' }}</small></span>
            <button type="button" aria-label="关闭告警详情" @click="clearSelection" v-html="U.icon('close')"></button></header>
          <div v-if="riskCaseOf(selectedUavAlarm)" class="sit-map-pop-status">
            <b>{{ selectedUavAlarm._riskUnavailable ? '风险状态更新中' : riskStageLabel(selectedUavAlarm) }}</b>
            <span>{{ riskCaseVerificationLabel(selectedUavAlarm) }}</span>
            <p>{{ riskCaseOf(selectedUavAlarm).airspace_name || '风险区域读取中' }}</p>
            <p v-if="selectedUavAlarm._riskUnavailable">{{ selectedUavAlarm._riskReadReason || '正在重新读取本次风险，暂停新操作。' }}</p>
          </div>
          <div v-else v-html="isPredictionAlarm(selectedUavAlarm) ? predictionAlarmStatusHtml(selectedUavAlarm, { now: nowTick }) : uavNowHtml(selectedNowStatus, { process: `${selectedUavAlarm.level}风险 · ${selectedUavAlarm.type} · 告警时` })"></div>
          <p>{{ selectedUavAlarm.district }} · 告警时间 {{ formatClock(selectedUavAlarm.ts) }}</p>
          <p>遥控器位置：{{ PILOT_LOCATION_IN_ALARM_DETAIL }}</p>
        </section>
        <SituationNextStep v-if="selectedUavAlarm && !selectedCardTarget && !selectedRisk && !selectedPlan && !selectedDevice" :alarm="selectedUavAlarm"
          :summary="selectedAdvisorySummary" :now-status="selectedNowStatus" :now="nowTick" @verify="verifySelectedAlarm" @records="openCounterRecords"
          @updated="updateNotification" @unavailable="invalidateNotification" />
        <div v-if="videoContext && !selectedCardTarget" class="sit-video-entry">
          <button type="button" :aria-expanded="showTargetVideo" aria-controls="situation-video-window" @click="onTipAction('eo-video')">{{ showTargetVideo ? '收起视频' : '实时视频' }}</button>
        </div>
        <p v-if="showAlarmPopup && !alarmAnchor()" class="sit-alarm-position-note">当前未取得该目标的有效位置，无法定位无人机；以下保留此事件的信息。</p>
        <SituationAdvisoryCard v-if="showAlarmAdvisoryCard && !selectedCardTarget" :key="riskCaseKey(selectedUavAlarm)" :risk-case="riskCaseOf(selectedUavAlarm)"
          :event-id="selectedUavAlarm.eventId" :alarm-label="selectedUavAlarm.id"
          @updated="updateNotification" @unavailable="invalidateNotification" @open="openAlarmDisposal(selectedUavAlarm)" />
        <p v-else-if="showAlarmPopup && !selectedCardTarget" class="sit-alarm-position-note">此告警未关联无人机事件，暂无可读取的通知记录。</p>
        <div v-if="selectedPrediction && !selectedCardTarget" class="prediction-popup-title"><b>目标未来位置</b><button type="button" class="btn" @click="clearSelection">关闭</button></div>
        <details v-if="selectedPrediction && selectedTarget" class="sit-target-prediction-more">
          <summary>未来 10／20／30 秒预测详情</summary>
          <PredictionPanel :prediction="selectedPrediction" :risk-case="riskCaseOf(selectedUavAlarm)" :now="nowTick" :unavailable="predictionUnavailable" />
        </details>
        <PredictionPanel v-else-if="selectedPrediction" :prediction="selectedPrediction" :risk-case="riskCaseOf(selectedUavAlarm)" :now="nowTick" :unavailable="predictionUnavailable" />
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

      <Teleport to="body"><DeviceVideoWorkspace v-if="eoDevice" :device="currentEoDevice||eoDevice" :candidates="eoCandidates" :selected="eoSelected" :focused-id="eoFocusedId" :mode="eoMode" :map-view="eoMapView"
        @expanded="setEoExpanded" @close="closeEoVideo" @select="selectEoTargets" @focus="eoFocusedId=$event" @remove="removeEoTarget" @clear="clearEoTargets" @mode="eoMode=$event" @locate="locateEoTarget" @updated="source.refresh()" />
      </Teleport>

      <nav class="sit-layerbar" aria-label="地图图层">
        <button type="button" :aria-pressed="layers.coverage" @click="toggleLayer('coverage')">覆盖范围</button>
        <span v-if="layers.coverage && hasSimulatedCoverage" class="sit-scan-key">含模拟参数</span>
        <span class="sit-scan-key" aria-label="在线设备上报脉冲"><i aria-hidden="true"></i>上报脉冲</span>
        <button type="button" :aria-pressed="layers.device" @click="toggleLayer('device')">设备点位</button>
        <button type="button" :aria-pressed="layers.prediction" @click="toggleLayer('prediction')">未来预测</button>
        <span v-if="layers.prediction" class="sit-scan-key">虚线 ○ 预测位置 · ◇ 预计入区</span>
        <button type="button" :aria-pressed="layers.track" @click="toggleLayer('track')">目标轨迹</button>
        <button type="button" :aria-pressed="layers.flightPlan" @click="toggleLayer('flightPlan')">任务航线</button>
        <button type="button" :aria-pressed="layers.airspace" :aria-label="`防控空域，共${airspaces.length}个区域`" @click="toggleLayer('airspace')">防控空域 {{ airspaces.length }}</button>
        <button v-if="flightSummary.receivers" type="button" :aria-pressed="layers.flights" @click="toggleLayer('flights')">民航航班</button>
        <span id="situation-weather-control"></span>
        <span v-if="layers.track || layers.flightPlan" class="sit-plan-key" aria-label="航线与轨迹图例">
          <span v-if="layers.track"><i class="is-within"></i>符合航线</span>
          <span v-if="layers.track"><i class="is-outside"></i>偏离航线</span>
          <span v-if="layers.flightPlan"><i class="is-plan"></i>计划航线</span>
          <span v-if="layers.track"><i class="is-unknown"></i>关系未知</span>
          <span v-if="layers.flightPlan"><b class="is-start">起</b>起点<b class="is-end">终</b>终点（选中显示）</span>
        </span>
      </nav>

      <aside v-if="selectedTarget" class="sit-fuse-dock" :class="{ 'is-open': fuseOpen }" aria-label="多源融合结果">
        <button type="button" class="sit-fuse-orb" :aria-expanded="fuseOpen"
          :aria-label="fuseOpen ? '收起多源融合' : '展开多源融合'" @click="toggleFuse">
          <span class="sit-fuse-orb-cap"><small>多源融合</small><b>{{ fusionConfidence ?? '—' }}%</b></span>
          <span class="sit-fuse-orb-ball" aria-hidden="true"><span v-html="fuseIcon"></span></span>
        </button>
        <section class="sit-glass sit-fuse-panel">
          <header class="sit-dock-head"><span><small>FUSION LINKS</small><b>{{ displayTargetNo(selectedTarget.id) }}</b></span></header>
          <div class="sit-fuse-links">
            <span v-for="source in fusionSources" :key="source.key" :style="{ '--sensor': source.color }">
              <span v-if="source.device" class="sit-node-icon" v-html="iconHtml(source.device)"></span><b>{{ source.name }}</b><em>{{ source.status }}</em>
              <em v-if="source.observedAt">观测 {{ formatClock(source.observedAt) }}</em><em v-if="source.reason">{{ source.reason }}</em>
            </span>
          </div>
          <p v-if="!fusionSources.length">暂无可读取的融合来源。</p>
        </section>
      </aside>
    </main>
  </div>
</template>

<style scoped>
.prediction-list-note{padding:8px 12px;margin:0;font-size:12px;line-height:1.5;color:var(--txt-3)}
.sit-target-prediction-more{margin:0 12px 12px;border-top:1px solid var(--line);padding-top:8px;font-size:12px;color:var(--txt-3)}
.sit-target-prediction-more>summary{cursor:pointer}
.prediction-popup-title{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px}

.eo-map-empty{position:absolute;z-index:6;left:60px;right:15px;top:45%;margin:0;text-align:center;padding:8px;background:var(--surface-1);color:var(--txt-2);pointer-events:none}
.eo-map-shell.is-mini :deep(.mapctl){top:44px}
.eo-map-shell.is-mini :deep(.map-refocus){font-size:11px}
.eo-map-shell{position:absolute;inset:0}.eo-map-shell.is-mini{position:relative;width:100%;height:100%;min-height:150px}.sit-device-node-wrapper{position:relative}.sit-device-node-wrapper .sit-device-node{width:100%}.sit-device-video-button{margin:0 10px 7px auto;display:block;padding:4px 9px;min-height:28px;border:1px solid var(--control-line);border-radius:5px;color:var(--cyan);background:var(--surface-2);cursor:pointer;font:inherit;font-size:12px}.sit-device-video-button:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
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
.situation-page .sit-risk-tabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));flex:none;gap:4px;margin:10px 10px 0;padding:4px;border:1px solid var(--control-line);border-radius:9px;background:var(--surface-1)}
.situation-page .sit-risk-tabs button{position:relative;display:flex;align-items:center;justify-content:center;gap:6px;min-width:0;min-height:44px;margin:0;padding:8px 6px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--txt-2);font-family:inherit;font-size:13px;font-weight:500;line-height:1.4;cursor:pointer;transition:background .16s ease,color .16s ease,border-color .16s ease}
.situation-page .sit-risk-tabs button>span{white-space:nowrap}
.situation-page .sit-risk-tabs button:hover{background:var(--button-hover);color:var(--txt)}
.situation-page .sit-risk-tabs button[aria-selected="true"]{border-color:color-mix(in srgb,var(--cyan) 40%,var(--control-line));background:color-mix(in srgb,var(--blue) 18%,var(--surface-1));color:var(--txt);font-weight:600;box-shadow:inset 0 -2px 0 var(--cyan)}
.situation-page .sit-risk-tabs button:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
.situation-page .sit-risk-tabs .sit-risk-icon{display:none}
.situation-page .sit-risk-tabs b{display:inline-flex;flex:none;align-items:center;justify-content:center;box-sizing:border-box;min-width:24px;height:24px;padding:0 5px;border-radius:6px;background:color-mix(in srgb,var(--txt-2) 12%,transparent);color:var(--txt-2);font:600 12px/1 var(--app-font-mono);font-variant-numeric:tabular-nums;white-space:nowrap}
.situation-page .sit-risk-tabs button[aria-selected="true"] b:not(.has-risk){background:color-mix(in srgb,var(--cyan) 15%,transparent);color:var(--cyan)}
.situation-page .sit-risk-tabs b.has-risk{background:color-mix(in srgb,var(--red) 18%,transparent);color:var(--red)}
.situation-page .sit-alert-content>.sit-alert-list{gap:10px;padding:10px}
.situation-page .sit-alert-list>.prediction-list-note{padding:10px 4px;text-align:center}
.situation-page.has-selection-popup :deep(.maptip){display:none!important}
.sit-alarm-position-note{margin:0;padding:10px 12px;color:var(--muted);font-size:12px;line-height:1.5}
.sit-companion-video{margin:0;border:0;background:transparent}
.sit-video-title{display:flex;flex-direction:column;gap:4px;min-width:0;overflow-wrap:anywhere}
.sit-video-title small{color:var(--txt-2);font-size:12px}
.sit-companion-video :deep(header){align-items:flex-start;flex-wrap:wrap}
.sit-companion-video :deep(.video-toolbar){margin-left:auto}
.sit-video-entry{padding:0 12px 12px;display:flex;justify-content:flex-end}
.situation-page :deep(.sit-target-source){display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;color:var(--txt-2);font-size:12px}
.situation-page :deep(.sit-target-alarm-reason){display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-left:3px solid var(--sit-risk);background:var(--surface-2);white-space:normal;overflow-wrap:anywhere}
.situation-page :deep(.sit-target-alarm-reason>span){color:var(--txt-2);font-size:11px}
.situation-page :deep(.sit-target-alarm-reason>strong){color:var(--txt);font-size:13px;line-height:1.5}
.situation-page :deep(.sit-target-alarm-reason.is-ok){border-left-color:#58ddb0}
.situation-page :deep(.sit-target-alarm-reason>small){color:var(--txt-3);font-size:10.5px}
.situation-page :deep(.sit-map-pop-target.is-head){padding-bottom:0}
.situation-page :deep(.sit-map-pop-target.is-body){padding-top:0}
.sit-video-entry button,.situation-page :deep(.sit-target-source button){min-height:32px;padding:4px 8px;border:1px solid var(--sit-line);border-radius:6px;background:var(--surface-2);color:var(--cyan);font:inherit;cursor:pointer}
.sit-video-entry button:focus-visible,.situation-page :deep(.sit-target-source button:focus-visible){outline:2px solid var(--cyan);outline-offset:2px}
.situation-page .sit-alert-copy>b,.situation-page .sit-alert-copy>em,.situation-page :deep(.sit-map-pop header b){white-space:normal;overflow:visible;overflow-wrap:anywhere;text-overflow:initial}
.situation-page .sit-alert-row{flex-shrink:0;grid-template-columns:34px minmax(0,1fr)}
.situation-page .sit-alert-meta{grid-column:2;flex-direction:row;justify-content:space-between;flex-wrap:wrap;white-space:normal}
</style>

<style scoped>
.situation-page .sit-fuse-panel { right: 0; bottom: calc(100% + 12px); width: min(360px, calc(100cqw - 32px)); max-height: min(360px, calc(100cqh - 250px)); overflow-y: auto; }
.sit-fuse-links { flex-wrap: wrap; }
.sit-fuse-links > span { min-width: 130px; max-width: 100%; }
.sit-fuse-links b { grid-column: 2; }
.sit-fuse-links b, .sit-fuse-links em { white-space: normal; overflow-wrap: anywhere; }
</style>
