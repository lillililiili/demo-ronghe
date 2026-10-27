<script setup>
/* 融合感知指挥台：页面结构保持不变，全部业务状态来自后端领域接口。 */
import { punishmentHandoffProgress } from '@/ui/punishmentHandoffProgress.js';
import { displayBusinessNo, displayTargetNo, displayNumberReferences } from '@/ui/deviceNumber.js';
import { computed, h, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { NSelect } from 'naive-ui';
import { riskCaseOf, riskCaseKey, riskStageLabel, RISK_STAGE_LABEL, riskCaseVisible, riskCaseVerificationLabel } from '@/services/riskCaseView.js';
import { useRoute } from 'vue-router';
import { ChevronUpOutline, GitCompareOutline, LocateOutline, VideocamOutline } from '@vicons/ionicons5';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { createSituationApiSource } from '@/pages/situation/situationApiSource.js';
import { serverNow } from '@/services/serverClock.js';
import { alarmReasonView, uavNowHtml, uavNowPillHtml, uavNowStatus } from '@/components/disposal/uavNowStatus.js';
import { uavAdvisoryApi } from '@/services/uavAdvisoryApi.js';
import { clockLagText, currentMapSnapshot, coverageContainsPoint, deviceGroupState, riskMatchesPlan, SITUATION_DEVICE_TYPE_ORDER, targetClassCounts, targetIsCurrent } from '@/services/situationData.js';
import {
  disposalStage, situationAlarmNeedsAttention, situationRouteRiskIsCurrent,
  uavProcessActions, uavProcessStatus
} from '@/pages/situation/situationFlow.js';
import { closeModal, openFormModal } from '@/ui/formModal.js';
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
import { MAX_EO_SELECTION, reconcileSelected, selectionKey } from './situation/eoSelection.js';
import { useSituationRiskItems } from './situation/useSituationRiskItems.js';
import { candidateFromRisk, riskFromAlarm } from './situation/situationRiskItems.js';
import SituationRiskEvidence from './situation/SituationRiskEvidence.vue';
import { drawRiskEvidenceGeometry, riskContextCoordinates } from './situation/riskEvidenceGeometry.js';
import { drawEoCoverageMask, eoCoveragePresentation, eoCoverageView, eoMapFraming } from './situation/eoCoverage.js';
import { eoCameraText } from './situation/eoCameraState.js';
import { authSession } from '@/services/auth.js';

const U = window.UI;
usePageChrome('situation');

const VIEWED_STORAGE_KEY = 'situation.viewed.v1';
const mapHost = ref(null);
const weatherLayer = ref(null);
const riskSnapshotLayer = ref(null);
const snapshot = ref({ generatedAt: 0, sourceMode: 'unknown', simulated: false, devices: [], targets: [], alarms: [], flightPlans: [], risks: [], airspaces: [], handoffs: [] });
const selection = ref(null);
const advisorySummaries = ref({});
// 列表里各条已核实告警的「通知后位置判断」：没选中的行也用和卡片同样的依据，列表标签与卡片一致。
const departureByEvent = ref({});
const expandedType = ref('');
const devicesExpanded = ref(true);
const alertTab = ref('target');
const riskStageFilter = ref('');
const riskStageOptions = [{ label: '全部阶段', value: '' }, ...['PREDICTED', 'ENTERED', 'OBSERVED'].map(value => ({ value, label: RISK_STAGE_LABEL[value] }))];
const alertsExpanded = ref(true);
// 同一风险周期只提醒一次；重算、暂时失效后恢复不抢回用户手动切换的页签。
const announcedRiskKeys = new Set();
const fuseOpen = ref(false);
const showTargetVideo = ref(false);
const eoDevice = ref(null), eoExpanded = ref(false), eoMode = ref('point'), eoSelected = ref([]), eoFocusedId = ref('');
const eoRiskFocus = ref(null), riskMapContext = ref(null);
const riskItems = useSituationRiskItems(computed(() => !!eoDevice.value));
const riskListState = computed(() => ({ rows:riskItems.rows.value, counts:riskItems.counts.value,
  availability:riskItems.availability.value,
  total:riskItems.total.value, kind:riskItems.kind.value, page:riskItems.page.value, view:riskItems.view.value,
  error:riskItems.error.value, loading:riskItems.loading.value }));
const source = createSituationApiSource();
const layers = ref({ prediction: true, coverage: true, device: true, track: true, flightPlan: true, airspace: true });
const statusAnnouncement = ref('正在连接融合感知服务');
let viewedKeys = loadViewedKeys();
watch(authSession, () => announcedRiskKeys.clear());
let rawSnapshot = null;
let map = null;
let stopSource = null;
let situationPageActive = true, selectedReadSequence = 0;
const reportedSourceFailures = new Set();
const SEGMENT_LABEL = { predictions: '未来预测', targets: '目标', 'target-sources': '目标融合来源', alarms: '告警', risks: '航线风险', handoffs: '移送', devices: '设备',
  'eo-status': '光电朝向',
  'device-events': '设备事件', 'flight-plans': '飞行任务', airspaces: '空域', 'fusion-status': '融合状态' };
const sourceFailureLabels = computed(() => (snapshot.value.failedSegments || []).map(segment => SEGMENT_LABEL[segment] || segment).join('、'));
let selectionResizeObserver = null;
let expiryTimer = null;
let mainMapView = null;
let eoMapAutoFit = true;

const devices = computed(() => snapshot.value.devices || []);
const locatedDevices = computed(() => devices.value.filter(device => device.posValid !== false
  && Number.isFinite(device.lon) && Math.abs(device.lon) <= 180
  && Number.isFinite(device.lat) && Math.abs(device.lat) <= 85.051129));
const hasSimulatedCoverage = computed(() => devices.value.some(device => device.displayCoverage?.displayOnly));
const targets = computed(() => snapshot.value.targets || []);
const currentEoDevice = computed(() => devices.value.find(d => d.deviceId === eoDevice.value?.deviceId));
const eoMapView = computed(() => eoCoverageView(
  snapshot.value.failedSegments?.includes('devices') ? null : currentEoDevice.value, targets.value, serverNow()));
const eoMapFrame = computed(() => eoMapFraming(currentEoDevice.value, eoMapView.value));
const eoMapTargetKey = computed(() => JSON.stringify(eoMapView.value.targets.map(target => target.targetId).sort()));
const eoMapCandidates = computed(() => {
  const ids = new Set(eoMapView.value.targets.map(t => t.targetId));
  return eoCandidates.value.filter(row => ids.has(row.targetId));
});
const eoMapPresentation = computed(() => eoCoveragePresentation({
  device: currentEoDevice.value,
  view: eoMapView.value,
  devicesUnavailable: snapshot.value.failedSegments?.includes('devices'),
  targetsUnavailable: snapshot.value.failedSegments?.includes('targets'),
  selectedCount: eoSelected.value.length
}));
const eoWorkspaceMapView = computed(() => ({ ...eoMapView.value, ...eoMapPresentation.value,
  airspaceNotice: riskMapContext.value?.notice || (riskMapContext.value?.airspaces?.length ? '当前选中告警：显示报警时的区域边界' : snapshot.value.failedSegments?.includes('airspaces') ? '空域读取失败，区域边界暂不可用' : '') }));
const eoCoverageKey = computed(() => JSON.stringify([currentEoDevice.value?.deviceId, eoMapView.value.coordinates]));
const eoCandidates = computed(() => {
  const rows = new Map();
  for (const target of targets.value.filter(t=>t.objectTypeCode==='UAV')) {
    for (const alarm of target.relatedAlarms || []) {
      if (!alarm.eventId || alarm.eventState==='FALSE_POSITIVE' || !riskCaseVisible(alarm)) continue;
      const candidate = candidateFromRisk(riskFromAlarm(alarm,target),targets.value);
      if (candidate) rows.set(candidate.key,candidate);
    }
  }
  if (!riskItems.error.value && riskItems.view.value==='ACTIVE') for (const item of riskItems.rows.value) {
    const candidate = candidateFromRisk(item,targets.value);
    if (candidate) rows.set(candidate.key,candidate);
  }
  return [...rows.values()];
});
const eoRangeTargets = computed(()=>targets.value.filter(target=>target.posValid!==false && Number.isFinite(target.lon) && Number.isFinite(target.lat)
  && currentEoDevice.value && coverageContainsPoint({...currentEoDevice.value,coverage:{...currentEoDevice.value.coverage,status:'available'}},target)));
watch(eoCandidates, candidates => { eoSelected.value = reconcileSelected(eoSelected.value,candidates); });
watch(()=>eoRiskFocus.value?.key,()=>{riskMapContext.value=null;syncMapData();});
watch(authSession, () => { closeEoVideo(); eoSelected.value=[];eoFocusedId.value=''; });
function openEoVideo(device) {
  if (!device || device.typeCode !== 'EO') return;
  showTargetVideo.value=false;eoDevice.value=device;eoMode.value='point';eoRiskFocus.value=null;riskMapContext.value=null;clearSelection();
}
function focusEoCoverage() {
  const frame = eoMapFrame.value;
  if (eoExpanded.value && frame.coordinates.length) map?.fitTo(frame.coordinates, frame.padding);
}
async function setEoExpanded(value) {
  if (value && !eoExpanded.value && map) mainMapView = { center: map.unpx(map.w / 2, map.h / 2), scale: map.zoom };
  eoMapAutoFit = value;
  eoExpanded.value = value;
  await nextTick();
  syncMapData();
  if (value) focusEoCoverage();
  else if (mainMapView && map) map.centerAt(...mainMapView.center, { scale: mainMapView.scale });
}
watch(eoCoverageKey, () => { if (eoExpanded.value) { eoMapAutoFit=true;syncMapData();focusEoCoverage(); } }, { flush: 'post' });
watch(eoMapTargetKey, () => { if (eoExpanded.value && eoMapAutoFit) focusEoCoverage(); }, { flush: 'post' });
function preserveEoMapView() { if (eoExpanded.value) eoMapAutoFit=false; }
function currentEoMapFocus() {
  if (!eoExpanded.value) return null;
  eoMapAutoFit=true;
  return { kind: 'fit', ...eoMapFrame.value };
}
async function closeEoVideo() {await setEoExpanded(false);eoDevice.value=null;eoMode.value='point';eoRiskFocus.value=null;riskMapContext.value=null;syncMapData();}
function selectEoTargets(rows) {
  const current=[...new Map(rows.filter(row=>row?.eventId && eoCandidates.value.some(c=>selectionKey(c)===selectionKey(row) && c.targetId===row.targetId)).map(row=>[selectionKey(row),row])).values()];
  if(!current.length){toast('此处没有可关联告警的当前无人机，可在地图或告警列表选择。','warn');return;}
  const keys = new Set(current.map(selectionKey));
  if(eoMode.value==='point' && current.every(row=>eoSelected.value.some(old=>selectionKey(old)===selectionKey(row)))) {
    eoSelected.value=eoSelected.value.filter(row=>!keys.has(selectionKey(row)));
  } else {
    const added=current.filter(row=>!eoSelected.value.some(old=>selectionKey(old)===selectionKey(row)));
    if(eoSelected.value.length+added.length>MAX_EO_SELECTION){toast('每批最多选择20项风险，请缩小选择范围。','warn');return;}
    eoSelected.value=[...eoSelected.value,...added];
  }
  focusEoRisk(current[0].riskItem);
  eoFocusedId.value=selectionKey(current[0]);
}
function removeEoTarget(key){eoSelected.value=eoSelected.value.filter(row=>selectionKey(row)!==key);if(eoFocusedId.value===key)eoFocusedId.value=eoSelected.value[0]?.key||'';}
function clearEoTargets(){eoSelected.value=[];eoFocusedId.value='';}
function focusEoRisk(item){if(!item)return;eoRiskFocus.value=item;if(item.kind==='UAV')eoFocusedId.value=item.key;}
function focusEoSelected(key){eoFocusedId.value=key;focusEoRisk(eoSelected.value.find(row=>selectionKey(row)===key)?.riskItem);}
function checkEoRisk(item){
  const row=candidateFromRisk(item,targets.value);if(!row)return;
  if(eoSelected.value.some(value=>selectionKey(value)===row.key))removeEoTarget(row.key);
  else if(eoSelected.value.length>=MAX_EO_SELECTION)toast('每批最多选择20项风险','warn');
  else eoSelected.value=[...eoSelected.value,row];
  focusEoRisk(item);
}
function receiveRiskContext(context){riskMapContext.value=context;syncMapData();}
function receiveRiskStatus(item){
  if(eoRiskFocus.value?.key!==item?.key)return;
  eoRiskFocus.value=item;
  const candidate=candidateFromRisk(item,targets.value);
  eoSelected.value=eoSelected.value.map(row=>selectionKey(row)!==item.key ? row
    : candidate ? {...row,...candidate} : {...row,unavailable:true,riskItem:item});
}
async function locateRiskEvidence(){
  const coordinates=riskContextCoordinates(riskMapContext.value);
  const targetId=eoDevice.value ? eoRiskFocus.value?.target_id : mainRiskItem.value?.target_id;
  const target=targets.value.find(row=>row.targetId===targetId && row.posValid!==false);
  if(target && Number.isFinite(target.lon) && Number.isFinite(target.lat))coordinates.push([target.lon,target.lat]);
  if(!coordinates.length){toast('该风险缺少可定位的位置或范围','warn');return;}
  if(eoExpanded.value)await setEoExpanded(false);
  map?.fitTo(coordinates,.22);
}
function refreshRiskWorkspace(){source.refresh();riskItems.refresh();}
function normalizedMapRisk(row){
  if(!row)return null;
  const id=row.risk_id || row.riskId,kind=(row.risk_type || row.riskType)==='WEATHER'?'WEATHER':'SPACE_OBJECT';
  if(!id)return null;
  return {key:`${kind==='WEATHER'?'weather':'space'}:${id}`,kind,risk_id:id,target_id:row.targetInternalId || row.target_id,
    target_no:row.target_no || row.targetId,plan_id:row.plan_id || row.planId,plan_no:row.plan_no || row.planNo,
    route_version_id:row.route_version_id || row.routeVersionId,state:row.state,reason_text:row.reason_text || row.reasonText,
    reason_code:row.reason_code || row.reasonCode,occurred_at:row.occurred_at || row.ts,updated_at:row.updated_at || row.version,
    current_status:row.current_status || row.currentStatus,presence_reason:row.current_reason || row.currentReason,
    source_mode:row.source_mode || row.sourceMode,simulated:row.simulated};
}
function focusEoMapRisk(row){
  const value=row?.members?.[0] || row;
  const item=riskItems.rows.value.find(item=>item.risk_id===(value?.risk_id || value?.riskId)) || normalizedMapRisk(value);
  if(item)focusEoRisk(item);else toast('当前目标没有可读取的关联风险事项','warn');
}
function pickWeatherRisk(row){if(eoDevice.value)focusEoMapRisk(row);else selectWeatherRisk(row);}
function pickRiskGroup(row){if(eoDevice.value)focusEoMapRisk(row);else selectRiskGroup(row);}
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
    rangeText: `单站 ${range} 配置覆盖${items.some(device => device.displayCoverage?.displayOnly) ? ' · 含模拟参数' : ''}`
  };
  });
});
const newAlarmCount = computed(() => alarms.value.filter(alarm => alarm.isNew).length);
const newRiskCount = computed(() => riskGroups.value.filter(risk => risk.isNew).length);
const activeRiskCount = computed(() => alarms.value.length + riskGroups.value.length);
const selectedTarget = computed(() => {
  if (selection.value?.kind !== 'target') return null;
  return targets.value.find(target => target.id === selection.value.id) || null;
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
  eoDevice.value ? eoRiskFocus.value?.target_id : selectedPrediction.value?.target_id, predictionUnavailable.value));
const selectedDevice = computed(() => selection.value?.kind === 'device'
  ? devices.value.find(device => device.id === selection.value.id) : null);
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
const selectedUavAlarm = computed(() => {
  if (selection.value?.kind === 'alarm' || selection.value?.alarmId) {
    const alarmId = selection.value.alarmId || selection.value.id;
    return alarms.value.find(item => riskCaseKey(item) === (selection.value.riskCaseId || alarmId) || item.alarmId === alarmId) || null;
  }
  return selectedTarget.value?.objectTypeCode === 'UAV' ? targetAlarm(selectedTarget.value) : null;
});
const mainRiskItem=computed(()=>{
  if(eoDevice.value)return null;
  if(selectedUavAlarm.value)return riskFromAlarm(selectedUavAlarm.value,selectedTarget.value);
  return normalizedMapRisk(selectedRisk.value?.members?.[0] || selectedRisk.value);
});
watch(()=>mainRiskItem.value?.key,()=>{if(!eoDevice.value){riskMapContext.value=null;syncMapData();}});
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
watch(mapPredictions, () => syncMapData(), { flush: 'post' });
watch([alarms, predictionRows], ([alarmRows, forecasts]) => {
  // 预测先读回时即可提醒；统一风险列表随后返回、转实测或重算，不重复弹出同一风险。
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
  const first = fresh[0];
  toast(`${fresh.length > 1 ? `发现 ${fresh.length} 项无人机风险；` : ''}${displayBusinessNo(first.target) || '无人机'}：${first.phase}${first.area ? ` · ${first.area}` : ''}`, 'warn');
}, { flush: 'post' });

watch([selectedPrediction, predictionRows], ([prediction, rows]) => {
  if (selection.value?.kind === 'prediction' && !prediction) clearSelection();
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
  const previousSelectedTargetId = selectedTarget.value?.targetId;
  rawSnapshot = next;
  for (const segment of reportedSourceFailures) if (!(next.failedSegments || []).includes(segment)) reportedSourceFailures.delete(segment);
  const decorated = decorate(currentMapSnapshot(next));
  snapshot.value = decorated;
  if (selection.value?.kind === 'target' && !decorated.targets.some(target => target.id === selection.value.id)) {
    const forecast = currentPredictions.value.find(row => row.target_id === previousSelectedTargetId);
    if (forecast) selection.value = { kind: 'prediction', id: forecast.target_id }; else clearSelection();
  }
  if (selection.value?.kind === 'prediction' && !selectedPrediction.value) clearSelection();
  predictionClusterIds.value = predictionClusterIds.value.filter(id => predictionRows.value.some(row => row.key === id));
  if (selection.value?.kind === 'risk-group' && !selectedRiskGroup.value) clearSelection();
  if (selection.value?.riskId && !decorated.risks.some(risk => risk.riskId === selection.value.riskId && risk.active)) clearSelection();
  const count = newAlarmCount.value + newRiskCount.value;
  const failed = (next.failedSegments || []).map(segment => ({
    predictions: '未来预测', targets: '目标', alarms: '告警', risks: '风险', handoffs: '移送', devices: '设备',
    'device-events': '设备事件', 'flight-plans': '飞行任务', airspaces: '空域', 'fusion-status': '融合状态', 'eo-status': '光电朝向'
  }[segment] || segment));
  statusAnnouncement.value = failed.length
    ? `${failed.join('、')}数据刷新失败，正在自动重试；可用性以各项状态为准`
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
  // 光电小地图保留当前空域作位置参照；关联只按告警中的区域 ID，不按落点猜测报警原因。
  const context=riskMapContext.value;
  const historical=(context?.airspaces || []).map(area=>({...area,alarmAssociated:true,name:`报警时 · ${area.name}`}));
  const historicalIds=new Set(historical.map(area=>area.airspaceId));
  const alarmAreaIds = new Set((mini?eoMapCandidates.value:[]).map(row => row.airspaceId).filter(Boolean));
  const currentAreas=(data.failedSegments?.includes('airspaces')?[]:data.airspaces).filter(area=>!historicalIds.has(area.airspaceId));
  const evidencePlans=context?.flightPlans || [];
  map.layers = { ...map.layers, coverage: mini || layers.value.coverage, device: mini || layers.value.device,
    track: mini || layers.value.track, flightPlan: mini ? !!evidencePlans.length : layers.value.flightPlan,
    nofly: mini || layers.value.airspace, limit: mini || layers.value.airspace, suit: mini || layers.value.airspace };
  map.setData({
    airspaces: [...currentAreas.map(area=>({...area,alarmAssociated:alarmAreaIds.has(area.airspaceId)})),...historical],
    devices: mini ? (eoMapView.value.coordinates.length ? [currentEoDevice.value] : []) : locatedDevices.value,
    targets: mini ? eoRangeTargets.value.map(target => ({ ...target, track: target.targetId===eoRiskFocus.value?.target_id ? target.track : [] })) : data.targets,
    predictions: mini ? mapPredictions.value.filter(row=>row.targetId===eoRiskFocus.value?.target_id || row.target_id===eoRiskFocus.value?.target_id) : mapPredictions.value,
    flightPlans: mini ? evidencePlans : [...data.flightPlans.filter(plan=>!evidencePlans.some(e=>e.planId===plan.planId)),...evidencePlans],
    risks: data.risks.filter(risk => risk.mapVisible !== false), alarms: []
  });
}

function onSourceError(error, segment) {
  if (!situationPageActive) return;
  const label = SEGMENT_LABEL[segment] || segment;
  const availability = segment === 'eo-status' ? '镜头朝向已标为未知' : '可用性以各项状态为准';
  statusAnnouncement.value = `${label}更新失败，正在重试；${availability}`;
  if (reportedSourceFailures.has(segment)) return;
  reportedSourceFailures.add(segment);
  const reason = error?.code === 'TIMEOUT' ? '服务响应超时' : error?.code === 'NETWORK_ERROR' ? '暂时无法连接服务' : error?.message || '服务暂时不可用';
  toast(`${label}更新失败：${reason}。正在自动重试，${availability}。`, 'err');
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
  selection.value = { kind: 'target', id: target.id, alarmId, riskCaseId };
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

function selectPrediction(row) {
  const prediction = currentPredictions.value.find(item => item.target_id === (row.prediction || row).target_id);
  if (!prediction) return;
  const target = targets.value.find(item => item.targetId === prediction.target_id);
  if (target) selectTarget(target);
  else { selection.value = { kind: 'prediction', id: prediction.target_id }; map?.clearPinnedHit(); }
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
    selection.value = { kind: 'alarm', id: riskCaseKey(alarm), riskCaseId: riskCaseOf(alarm)?.risk_case_id };
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
    ${device.typeCode === 'EO' ? `<dt>镜头当前状态</dt><dd>${esc(eoCameraText(device.eoView))}</dd><dt>地图标识</dt><dd>青色扇形按镜头实时上报的朝向显示；朝向未知或过期时不绘制。引线连接真实安装点。</dd>` : ''}
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
    if (process.includes('verify') && !hasNextStep && !prediction?.terminal) buttons.push(`<button type="button" data-tip-act="verify">${prediction ? prediction.blocked ? '核实为误报' : '核实预测风险' : '核实'}</button>`);
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
  if (hit?.kind === 'target') return renderTargetTip(hit.data);
  if (hit?.kind === 'plan') return renderPlanTip(hit.data);
  if (hit?.kind === 'prediction') return `<div class="sit-map-pop"><b>预测入区 · ${hit.data.rows.length} 项</b><p>点击查看预测预警，预计位置不代表已经入区。</p></div>`;
  return null;
}

function onMapPick(hit) {
  if(eoDevice.value && hit?.kind==='target' && hit.data.objectTypeCode==='UAV') {selectEoTargets(eoCandidates.value.filter(candidate=>candidate.mapId===hit.data.id));return;}
  if(eoDevice.value && hit?.kind==='target') {focusEoMapRisk(risks.value.find(row=>row.targetInternalId===hit.data.targetId));return;}
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

function verifySelectedAlarm() {
  const target = selectedTarget.value || targets.value.find(row => row.targetId === selectedUavAlarm.value?.targetInternalId);
  if (target) openTargetVerification(target);
}

function targetAlarm(target) {
  const related = (target?.relatedAlarms || []).filter(row => riskCaseVisible(row) && (!isPredictionAlarm(row) || predictionRows.value.some(item => item.warning.event_id === row.eventId || item.warning.alarm_id === row.alarmId)));
  const selectedId = selection.value?.kind === 'target' && selection.value.id === target?.id ? selection.value.alarmId : null;
  const selectedCaseId = selection.value?.riskCaseId;
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
  if (value.event_id !== selectedUavAlarm.value?.eventId) return;
  const key = value._riskCaseId || value.risk_case?.risk_case_id || value.risk_case_id || value.event_id;
  if (key !== (riskCaseOf(selectedUavAlarm.value)?.risk_case_id || selectedUavAlarm.value?.eventId)) return;
  const previous = advisorySummaries.value[key];
  if (previous && (previous._fetchedAt > (value._fetchedAt || 0) || previous.event_version > value.event_version)) return;
  advisorySummaries.value = { ...advisorySummaries.value, [key]: value };
  departureByEvent.value = { ...departureByEvent.value, [value.event_id]: value.departure_observation || null };
  if (map && selection.value?.kind === 'target') map.pinHit('target', selection.value.id);
}
function invalidateNotification(eventId, startedAt = Date.now(), caseId = '') {
  const key = caseId || riskCaseOf(selectedUavAlarm.value)?.risk_case_id || eventId;
  if (key !== (riskCaseOf(selectedUavAlarm.value)?.risk_case_id || selectedUavAlarm.value?.eventId)) return;
  if (eventId !== selectedUavAlarm.value?.eventId
    || (advisorySummaries.value[key]?._fetchedAt || 0) > startedAt) return;
  advisorySummaries.value = { ...advisorySummaries.value, [key]: { event_id: eventId, _riskCaseId: caseId, _unavailable: true, _fetchedAt: startedAt } };
}

async function openTargetVerification(target) {
  const alarm = targetAlarm(target);
  if (!alarm?.eventId) return toast('没有关联无人机事件，无法核实', 'err');
  try {
    const risk = riskCaseOf(alarm);
    const detail = risk ? await getUavRiskCase(risk.risk_case_id) : null;
    const [event, linkedAlarm] = detail ? [detail.event, { ...detail.alarm, risk_case: detail.risk_case }] : await Promise.all([
      getUavEvent(alarm.eventId),
      alarm.alarmId ? getAlarm(alarm.alarmId) : Promise.resolve(null)
    ]);
    openUavVerification({
      event,
      alarm: linkedAlarm,
      refresh: async () => {
        await source.refresh();
        return risk ? (await getUavRiskCase(risk.risk_case_id)).event : getUavEvent(alarm.eventId);
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
    now: serverNow,
    // 固定使用原东营地图范围，不因设备位置扩大底图视野。
    constrainToCoverage: true,
    layoutMarkers: createSituationMarkerLayout(),
    getExternalMarkers: view => [...(weatherLayer.value?.getMarkers(view) || []), ...(riskSnapshotLayer.value?.getMarkers(view) || [])],
    drawUnderMarkers: view => {
      if (eoExpanded.value) drawEoCoverageMask(view, eoMapView.value.viewCoordinates);
      weatherLayer.value?.draw(view); riskSnapshotLayer.value?.draw(view);
      drawRiskEvidenceGeometry(view,riskMapContext.value);
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
    // 重新定位读取最新目标位置，并恢复目标加入/退出时的自动取景。
    getRefocus: currentEoMapFocus,
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
        <div class="eo-map-shell" :class="{'is-mini':eoExpanded}" @pointerdown.capture="preserveEoMapView" @wheel.capture="preserveEoMapView" @keydown.capture="preserveEoMapView">
          <div id="stMap" ref="mapHost" class="sit-map"></div>
          <SituationRiskMarkers ref="riskSnapshotLayer" :rows="riskSnapshots" :selected-id="selectedSnapshotId"
            :visible="eoExpanded || layers.flightPlan" @select="pickRiskGroup" />
          <WeatherRiskMarkers ref="weatherLayer" :risks="risks" :selected-id="eoDevice ? eoRiskFocus?.risk_id : selectedRisk?.riskId" shared-layout :control-target="eoExpanded ? '#eo-weather-control' : '#situation-weather-control'" @select="pickWeatherRisk" />
          <EoMapSelection v-if="eoDevice" :get-map="() => map" :candidates="eoExpanded ? eoMapCandidates : eoCandidates" :selected="eoSelected" :mode="eoMode" @select="selectEoTargets" />
          <p v-if="eoExpanded && eoMapPresentation.emptyMessage" class="eo-map-empty" role="status">{{eoMapPresentation.emptyMessage}}</p>
        </div>
      </Teleport>

      <div class="sit-live-pill" :aria-label="`当前数据来源：${sourceModeText}`">
        <span class="sit-live-dot" aria-hidden="true"></span>
        <b>{{ sourceModeText }}</b>
        <span>{{ sourceModeDetail }}</span>
        <span>当前目标 {{ targets.length }} · 无人机 {{ targetCounts.uav }} · 异物 {{ targetCounts.foreign }} · 未分类 {{ targetCounts.unknown }}<template v-if="targetCounts.other"> · 其他 {{ targetCounts.other }}</template>（北京时间）</span>
        <time class="mono">{{ clockText }}</time>
        <em v-if="sourceFailureLabels || refreshSlow" class="sit-refresh-slow" role="status" :title="sourceFailureLabels ? `${sourceFailureLabels}更新失败，正在自动重试；可用性以各项状态为准。` : `最近一次数据停在 ${clockText}，已有 ${refreshLagSeconds} 秒没有更新；地图上的目标按期退出，可能不全。恢复后自动更新。`">{{ sourceFailureLabels ? `${sourceFailureLabels}更新失败 · 重试中` : `数据刷新慢 · ${refreshLagSeconds} 秒未更新` }}</em>
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
              <div v-for="device in group.items" :key="device.id" class="sit-device-node-wrapper"
                :class="{ 'has-video': device.typeCode === 'EO', 'is-selected': selection?.kind === 'device' && selection.id === device.id }">
              <button type="button" class="sit-device-node"
                :class="[{ 'is-selected': selection?.kind === 'device' && selection.id === device.id, 'has-new': device.newAlert }, statusClass(device.status)]"
                :aria-pressed="selection?.kind === 'device' && selection.id === device.id"
                :aria-label="`查看${device.type}设备 ${device.name}，${device.status}${device.hasAlarm ? '，存在告警' : ''}`" @click="selectDevice(device)">
                <span><span class="sit-node-icon" v-html="iconHtml(device)"></span><b>{{ device.name }}</b><small class="mono" :title="device.id">{{ device.display_no || device.id }}</small></span>
                <em v-if="device.typeCode !== 'EO'">{{ device.status }} · {{ reportAge(device.lastReportAt) }}<template v-if="device.timeUntrusted"> · 设备时间不准</template><template v-if="!locatedDevices.includes(device)"> · 位置未知</template></em>
              </button>
              <div v-if="device.typeCode === 'EO'" class="sit-device-node-actions">
                <em>{{ device.status }} · {{ reportAge(device.lastReportAt) }}<template v-if="device.timeUntrusted"> · 设备时间不准</template><template v-if="!locatedDevices.includes(device)"> · 位置未知</template></em>
                <button type="button" class="sit-device-video-button" :class="{ 'is-open': eoDevice?.deviceId === device.deviceId }"
                  :aria-label="`查看${device.name}实时视频`" :aria-expanded="eoDevice?.deviceId === device.deviceId" @click="openEoVideo(device)">
                  <VideocamOutline aria-hidden="true" /><span>实时视频</span>
                </button>
              </div>
              </div>
            </div>
          </section>
        </div>
        <footer v-show="devicesExpanded" id="sit-device-footer">共 {{ devices.length }} 台感知设备；覆盖范围以台账配置为准，青色视场随光电实际回报变化。</footer>
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
        :label="isPredictionAlarm(selectedUavAlarm) ? '预测入区风险详情' : selectedDevice ? '设备详情' : selectedPlan ? '任务详情' : selectedRisk ? '航线风险详情' : showAlarmPopup ? '无人机告警详情' : '目标详情'">
        <template v-if="selectedDevice">
          <div @click="onTipAction($event.target.closest('[data-tip-act]')?.dataset.tipAct, { kind: 'device', data: selectedDevice })"
            v-html="renderDeviceTip(selectedDevice)"></div>
          <SituationDeviceReport :key="selectedDevice.deviceId" :device-id="selectedDevice.deviceId" />
        </template>
        <SituationTargetCard v-else-if="selectedTarget" :key="selectedTarget.targetId || selectedTarget.id"
          :target="selectedTarget" :alarm="selectedUavAlarm" :now-status="selectedNowStatus"
          :summary="advisorySummaries[riskCaseOf(selectedUavAlarm)?.risk_case_id || selectedUavAlarm?.eventId]" :now="nowTick" :video-open="showTargetVideo"
          :source-names="devices.filter(device => (selectedTarget.sourceDeviceIds || []).includes(device.fusionDeviceId || device.deviceId)).map(device => device.type).join(' / ')"
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
          <div v-html="isPredictionAlarm(selectedUavAlarm) ? predictionAlarmStatusHtml(selectedUavAlarm, { now: nowTick }) : uavNowHtml(selectedNowStatus, { process: `${selectedUavAlarm.level}风险 · ${selectedUavAlarm.type} · 告警时` })"></div>
          <p>{{ selectedUavAlarm.district }} · 告警时间 {{ formatClock(selectedUavAlarm.ts) }}</p>
          <p>遥控器位置：{{ PILOT_LOCATION_IN_ALARM_DETAIL }}</p>
        </section>
        <SituationNextStep v-if="selectedUavAlarm && !selectedTarget && !selectedRisk && !selectedPlan && !selectedDevice" :alarm="selectedUavAlarm"
          :summary="advisorySummaries[riskCaseOf(selectedUavAlarm)?.risk_case_id || selectedUavAlarm.eventId]" :now-status="selectedNowStatus" :now="nowTick" @verify="verifySelectedAlarm" @records="openCounterRecords"
          @updated="updateNotification" @unavailable="invalidateNotification" />
        <div v-if="videoContext && !selectedTarget" class="sit-video-entry">
          <button type="button" :aria-expanded="showTargetVideo" aria-controls="situation-video-window" @click="onTipAction('eo-video')">{{ showTargetVideo ? '收起视频' : '实时视频' }}</button>
        </div>
        <p v-if="showAlarmPopup && !alarmAnchor()" class="sit-alarm-position-note">当前未取得该目标的有效位置，无法定位无人机；以下保留此事件的信息。</p>
        <SituationAdvisoryCard v-if="showAlarmAdvisoryCard && !selectedTarget" :key="riskCaseKey(selectedUavAlarm)" :risk-case="riskCaseOf(selectedUavAlarm)"
          :event-id="selectedUavAlarm.eventId" :alarm-label="selectedUavAlarm.id"
          @updated="updateNotification" @unavailable="invalidateNotification" @open="openAlarmDisposal(selectedUavAlarm)" />
        <p v-else-if="showAlarmPopup && !selectedTarget" class="sit-alarm-position-note">此告警未关联无人机事件，暂无可读取的通知记录。</p>
        <div v-if="selectedPrediction && !selectedTarget" class="prediction-popup-title"><b>目标未来位置</b><button type="button" class="btn" @click="clearSelection">关闭</button></div>
        <details v-if="selectedPrediction && selectedTarget" class="sit-target-prediction-more">
          <summary>未来 10／20／30 秒预测详情</summary>
          <PredictionPanel :prediction="selectedPrediction" :risk-case="riskCaseOf(selectedUavAlarm)" :now="nowTick" :unavailable="predictionUnavailable" />
        </details>
        <PredictionPanel v-else-if="selectedPrediction" :prediction="selectedPrediction" :risk-case="riskCaseOf(selectedUavAlarm)" :now="nowTick" :unavailable="predictionUnavailable" />
        <SituationRiskEvidence v-if="mainRiskItem" :item="mainRiskItem" :targets="targets" :flight-plans="flightPlans" :predictions="currentPredictions"
          @context="receiveRiskContext" @updated="source.refresh()" @locate="locateRiskEvidence" />
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

      <Teleport to="body"><DeviceVideoWorkspace v-if="eoDevice" :expanded="eoExpanded" :device="currentEoDevice||eoDevice" :candidates="eoCandidates" :selected="eoSelected" :focused-id="eoFocusedId" :mode="eoMode" :map-view="eoWorkspaceMapView" :risk-state="riskListState" :risk-focus="eoRiskFocus" :targets="targets"
        @expanded="setEoExpanded" @close="closeEoVideo" @select="selectEoTargets" @focus="focusEoSelected" @remove="removeEoTarget" @clear="clearEoTargets" @mode="eoMode=$event" @locate="locateEoTarget" @updated="refreshRiskWorkspace"
        @risk-kind="riskItems.changeKind" @risk-page="riskItems.page.value=$event" @risk-view="riskItems.changeView" @risk-focus="focusEoRisk" @risk-check="checkEoRisk" @risk-refresh="riskItems.refresh">
        <template #risk-detail><SituationRiskEvidence v-if="eoRiskFocus" :item="eoRiskFocus" :targets="targets" :flight-plans="flightPlans" :predictions="currentPredictions"
          @context="receiveRiskContext" @status="receiveRiskStatus" @updated="refreshRiskWorkspace" @locate="locateRiskEvidence" />
          <p v-else class="eo-risk-placeholder">选择一项风险，查看报警原因、影响范围和办理进度。</p></template>
      </DeviceVideoWorkspace>
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
.eo-map-shell{position:absolute;inset:0}.eo-map-shell.is-mini{position:relative;width:100%;height:100%;min-height:150px}
.sit-device-node-wrapper{position:relative}.sit-device-node-wrapper .sit-device-node{width:100%}
.situation-page .sit-device-node-wrapper.has-video{display:grid;grid-template-columns:minmax(0,1fr) 92px;align-items:stretch;border:1px solid var(--line-2);border-radius:7px;background:var(--panel-2)}
.situation-page .sit-device-node-wrapper.has-video.is-selected{border-color:var(--blue);background:var(--surface-selected);box-shadow:inset 3px 0 var(--cyan)}
.situation-page .has-video .sit-device-node{min-width:0;padding:9px 3px 9px 9px;border:0;background:transparent;box-shadow:none;border-radius:6px 0 0 6px}
.situation-page .has-video .sit-device-node>span{min-width:0;gap:4px 6px}
.situation-page .has-video .sit-device-node b{font-size:12px;line-height:1.5;white-space:normal;overflow:visible;overflow-wrap:anywhere}
.situation-page .has-video .sit-device-node small{font-size:10px;line-height:1.4}
.sit-device-node-actions{display:flex;flex-direction:column;align-items:flex-end;justify-content:center;gap:2px;min-width:0;padding:7px 7px 7px 0}
.sit-device-node-actions>em{max-width:100%;padding-right:6px;color:var(--txt-3);font-size:10px;font-style:normal;line-height:1.5;text-align:right;overflow-wrap:anywhere}
.sit-device-video-button{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:30px;margin:0;padding:4px 6px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--txt-2);font:inherit;font-size:11px;line-height:1.4;white-space:nowrap;cursor:pointer;transition:color .14s ease,background-color .14s ease}
.sit-device-video-button svg{width:15px;height:15px;flex:none;color:var(--cyan)}
.sit-device-video-button.is-open{color:var(--cyan);background:var(--surface-selected)}
.sit-device-video-button:focus-visible{outline:2px solid var(--cyan);outline-offset:-2px}
.sit-device-video-button:active{background:var(--surface-selected);color:var(--cyan)}
@media(hover:hover){.sit-device-video-button:hover{color:var(--cyan);background:var(--surface-hover)}.situation-page .has-video .sit-device-node:hover{background:var(--surface-hover)}}
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
