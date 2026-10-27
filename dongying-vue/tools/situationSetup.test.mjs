import { toAlarms, currentMapSnapshot } from '../src/services/situationData.js';
import { randomUUID } from 'node:crypto';
import * as riskHelpers from '../src/services/riskCaseView.js';
import * as riskFlow from '../src/pages/situation/situationFlow.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { computed, ref, watch, effectScope, nextTick } from 'vue';
import * as prediction from '../src/services/predictionView.js';
import * as eoCoverage from '../src/pages/situation/eoCoverage.js';
import * as eoSelection from '../src/pages/situation/eoSelection.js';

function createPage(now = Date.now(), sourceOverrides = {}, apiOverrides = {}) {
  const file = readFileSync(new URL('../src/pages/SituationPage.vue', import.meta.url), 'utf8');
  let script = file.match(/<script setup>([\s\S]*?)<\/script>/)[1];
  const bindings = {};
  script = script.replace(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"];?/g, (_, names) => {
    for (const name of names.replace(/[{}]/g, '').split(',').map(name => name.trim()).filter(Boolean)) {
      bindings[name.split(/\s+as\s+/).at(-1)] = () => undefined;
    }
    return '';
  });
  const unmounts = [];
  const stats = { watchCount: 0, mapCreated: 0, notices: [] };
  const context = vm.createContext({ ...bindings, ...riskHelpers, ...riskFlow, ...prediction, ...eoCoverage, ...eoSelection,
    authSession: ref('test-session'), toast: (message, tone) => stats.notices.push({ message, tone }), displayBusinessNo: value => value,
    computed, ref, nextTick, watch: (...args) => { stats.watchCount++; return watch(...args); },
    onMounted() {}, onUnmounted: callback => unmounts.push(callback), serverNow: () => now,
    useRoute: () => ({ query: {} }), createSituationApiSource: () => ({ setSourceTarget() {},
      loadTargetDetail: async () => null, loadTargetPrediction: async () => null, stop() {}, ...sourceOverrides }),
    groupRouteRisks: () => [], riskSnapshotMarkers: () => [],
    document: { removeEventListener() {} }, window: { clearInterval() {}, UI: { icon: () => '', businessIcon: () => '' }, MapView: function () { stats.mapCreated++; } },
    sessionStorage: { getItem: () => null, setItem() {} }, console, toAlarms, currentMapSnapshot: value => currentMapSnapshot(value, now), ...apiOverrides
  });
  const scope = effectScope();
  try {
    scope.run(() => vm.runInContext(`${script}\n globalThis.page = {
      snapshot, selection, nowTick, refreshSlow, predictionRows, alertTab, alertsExpanded, predictionClusterIds, visiblePredictionRows,
      selectedPrediction, selectedTarget, selectedCardTarget, selectedCardAlarm, selectedUavAlarm, alarms, videoContext, showTargetVideo, mapPredictions, showSelectionPopup, selectPrediction, selectAlarm, selectTarget, clearSelection,
      selectedRiskContext, updateNotification, applySelectedRiskDetail, openTargetVerification, advisorySummaries, selectedAdvisorySummary, applySnapshot, eoDevice, eoSelected, setEoExpanded, onMapPick, attachMap: value => { map = value; syncMapData(); }
    };`, context));
    return { ...context.page, stats, leave: () => unmounts.forEach(fn => fn()), stop: () => scope.stop() };
  } catch (error) { scope.stop(); throw error; }
}

function forecast(id, now, shift = 0) {
  return { prediction_id: `prediction-${id}`, target_id: `target-${id}`, target_no: `UAV-${id}`, status: 'READY',
    based_on_observed_at: now - 200, generated_at: now, valid_until: now + 6000,
    anchor: { location: { longitude: 118.3 + shift, latitude: 37.4 } },
    points: [10, 20, 30].map(horizon => ({ horizon_seconds: horizon, predicted_at: now + horizon * 1000,
      location: { longitude: 118.3 + shift + horizon / 100000, latitude: 37.4 }, altitude_m: 90 })),
    warnings: [{ event_id: `event-${id}`, state: 'ACTIVE', airspace_name: `${id}禁飞区`,
      entry_at: now + 20000, entry_location: { longitude: 118.31 + shift, latitude: 37.4 } }] };
}

test('融合感知真实响应式初始化：预测watch在平台时钟初始化后注册，空态不创建地图或动作', () => {
  const page = createPage();
  try {
    assert.ok(page.stats.watchCount > 0); assert.equal(page.stats.mapCreated, 0);
  } finally { page.stop(); }
});

test('仅时钟跨过到期边界也收起独立预测详情并清理聚合选择，其他有效预警仍可见', async () => {
  for (const [id, shift] of [['north', 0], ['south', .3]]) {
    const now = Date.now(), page = createPage(now);
    try {
      const raw = forecast(id, now, shift), other = { ...forecast(`${id}-other`, now, shift + .1), valid_until: now + 12000 };
      page.snapshot.value = { ...page.snapshot.value, predictions: [raw, other] };
      await nextTick();
      const staleRow = page.predictionRows.value.find(row => row.targetId === raw.target_id);
      page.selectPrediction(staleRow);
      page.predictionClusterIds.value = [staleRow.key];
      await nextTick();
      assert.equal(page.selection.value.kind, 'prediction');
      assert.equal(page.selectedPrediction.value.prediction_id, raw.prediction_id);
      assert.equal(page.showSelectionPopup.value, true);
      page.nowTick.value = raw.valid_until - 1;
      await nextTick();
      assert.equal(page.selectedPrediction.value.prediction_id, raw.prediction_id);
      page.nowTick.value = raw.valid_until;
      await nextTick();
      assert.equal(page.selection.value, null);
      assert.equal(page.selectedPrediction.value, null);
      assert.equal(page.showSelectionPopup.value, false);
      assert.equal(page.predictionClusterIds.value.length, 0);
      assert.deepEqual(Array.from(page.visiblePredictionRows.value, row => row.targetId), [other.target_id]);
      assert.equal(page.mapPredictions.value.some(row => row.targetId === raw.target_id), false);
      page.selectPrediction(staleRow);
      await nextTick();
      assert.equal(page.selection.value, null, '旧列表点击不得重新打开已失效详情');
      assert.equal(raw.warnings[0].state, 'ACTIVE', '页面到期不写成后端撤销');
    } finally { page.stop(); }
  }
});

test('预测失效只隐藏未来面板，保留当前实测目标选择；新有效结果恢复面板', async () => {
  const now = Date.now(), page = createPage(now);
  try {
    const raw = forecast('still-observed', now);
    const target = { id: 'display-still-observed', targetId: raw.target_id, objectTypeCode: 'UAV', relatedAlarms: [] };
    page.snapshot.value = { ...page.snapshot.value, targets: [target], predictions: [raw] };
    page.selectPrediction(page.predictionRows.value[0]);
    await nextTick();
    assert.equal(page.selection.value.kind, 'target');
    assert.equal(page.selectedPrediction.value.prediction_id, raw.prediction_id);
    assert.equal(page.mapPredictions.value[0].points.length, 3);
    page.nowTick.value = raw.valid_until;
    await nextTick();
    assert.equal(page.selection.value.kind, 'target');
    assert.equal(page.selectedTarget.value.targetId, raw.target_id);
    assert.equal(page.selectedPrediction.value, null);
    assert.equal(page.showSelectionPopup.value, true);
    assert.equal(page.predictionRows.value.length, 0);
    assert.equal(page.mapPredictions.value.length, 0);
    const renewed = { ...forecast('still-observed', page.nowTick.value), prediction_id: 'renewed-current' };
    page.snapshot.value = { ...page.snapshot.value, predictions: [renewed] };
    await nextTick();
    assert.equal(page.selectedPrediction.value.prediction_id, 'renewed-current');
    assert.equal(page.mapPredictions.value[0].points.length, 3);
  } finally { page.stop(); }
});

test('未知、读取失败或无权限均收起缓存预测，恢复后须重新选择且不复活失效记录', async () => {
  for (const failure of ['UNKNOWN', 'failedSegments', 'deniedSegments']) {
    const now = Date.now(), page = createPage(now);
    try {
      const raw = forecast(`failure-${failure}`, now);
      page.snapshot.value = { ...page.snapshot.value, predictions: [raw] };
      page.selectPrediction(page.predictionRows.value[0]);
      await nextTick();
      if (failure === 'UNKNOWN') page.snapshot.value = { ...page.snapshot.value, predictions: [{ ...raw, status: 'UNKNOWN' }] };
      else page.snapshot.value = { ...page.snapshot.value, [failure]: ['predictions'] };
      await nextTick();
      assert.equal(page.selection.value, null, failure);
      assert.equal(page.selectedPrediction.value, null, failure);
      assert.equal(page.predictionRows.value.length, 0, failure);
      assert.equal(page.mapPredictions.value.length, 0, failure);
      page.snapshot.value = { ...page.snapshot.value, predictions: [raw], failedSegments: [], deniedSegments: [] };
      await nextTick();
      assert.equal(page.predictionRows.value.length, 1);
      assert.equal(page.selection.value, null, '恢复不自动抢回用户已关闭的详情');
      page.selectPrediction(page.predictionRows.value[0]);
      await nextTick();
      assert.equal(page.selectedPrediction.value.prediction_id, raw.prediction_id);
      assert.equal(raw.warnings[0].state, 'ACTIVE');
    } finally { page.stop(); }
  }
});


test('预测刷新与光电小地图共存：小地图只显示本机覆盖目标，收起后恢复当前预测且过期仍退出', async () => {
  for (const shift of [0, .3]) {
    const now = Date.now(), page = createPage(now), frames = [];
    const raw = forecast(`map-switch-${shift}`, now, shift);
    const device = { id: `eo-${shift}`, deviceId: `device-${shift}`, typeCode: 'EO', lon: 118.3 + shift, lat: 37.4,
      coverage: { kind: 'circle', status: 'available', radiusM: 1000 } };
    const inside = { id: `inside-${shift}`, targetId: `inside-target-${shift}`, objectTypeCode: 'UAV',
      lon: device.lon + .001, lat: device.lat, track: [[device.lon, device.lat], [device.lon + .001, device.lat]],
      relatedAlarms: [{ eventId: `event-inside-${shift}`, alarmId: `alarm-${shift}`, eventState: 'CONFIRMED', ts: now }] };
    const outside = { ...inside, id: `outside-${shift}`, targetId: `outside-target-${shift}`, lon: device.lon + 1,
      relatedAlarms: [{ ...inside.relatedAlarms[0], eventId: `event-outside-${shift}` }] };
    const map = { layers: {}, w: 100, h: 100, zoom: 12, unpx: () => [device.lon, device.lat],
      setData: data => frames.push(data), fitTo() {}, centerAt() {}, draw() {}, clearPinnedHit() {}, setLayer() {} };
    try {
      page.snapshot.value = { ...page.snapshot.value, devices: [device, { ...device, id: 'other-device', deviceId: 'other-device' }],
        targets: [inside, outside], predictions: [raw], risks: [{ riskId: 'shown-risk', mapVisible: true }],
        flightPlans: [{ id: 'plan' }] };
      await nextTick();
      page.attachMap(map);
      assert.equal(frames.at(-1).predictions.length, 1);
      assert.equal(frames.at(-1).devices.length, 2);
      page.eoDevice.value = device;
      await page.setEoExpanded(true);
      assert.deepEqual(Array.from(frames.at(-1).devices, row => row.deviceId), [device.deviceId]);
      assert.deepEqual(Array.from(frames.at(-1).targets, row => row.targetId), [inside.targetId]);
      assert.equal(frames.at(-1).targets[0].track.length, 0);
      assert.equal(frames.at(-1).predictions.length, 0);
      assert.equal(frames.at(-1).flightPlans.length, 0);
      const renewed = { ...raw, prediction_id: `renewed-${shift}`, valid_until: now + 12000 };
      page.snapshot.value = { ...page.snapshot.value, predictions: [renewed] };
      await nextTick();
      assert.equal(frames.at(-1).predictions.length, 0, '预测watch不能把主地图数据覆盖回光电小地图');
      assert.deepEqual(Array.from(frames.at(-1).targets, row => row.targetId), [inside.targetId]);
      const hit = { kind: 'prediction', data: { rows: [{ prediction: { id: renewed.prediction_id }, warning: renewed.warnings[0] }] } };
      page.onMapPick(hit);
      assert.equal(page.selection.value, null, '小地图不能打开主地图预测详情');
      page.onMapPick({ kind: 'target', data: inside });
      assert.deepEqual(Array.from(page.eoSelected.value, row => row.eventId), [inside.relatedAlarms[0].eventId]);
      assert.equal(page.selection.value, null, '光电选目标不改变主地图详情选择');
      await page.setEoExpanded(false);
      assert.equal(frames.at(-1).predictions.length, 1);
      assert.equal(frames.at(-1).targets.length, 2);
      assert.equal(frames.at(-1).targets[0].track.length, 2);
      assert.equal(frames.at(-1).risks.length, 1);
      page.onMapPick(hit);
      await nextTick();
      assert.equal(page.selectedPrediction.value.prediction_id, renewed.prediction_id);
      page.nowTick.value = renewed.valid_until;
      await nextTick();
      assert.equal(page.selection.value, null);
      assert.equal(frames.at(-1).predictions.length, 0);
      assert.equal(frames.at(-1).targets.length, 2, '预测过期不移除实测目标');
    } finally { page.stop(); }
  }
});

test('有效新预测预警展开右上角页签，同周期重算和恢复不反复抢页签', async () => {
  for (const prefix of ['north-alert', 'south-alert']) {
    const now = Date.now(), page = createPage(now);
    try {
      const first = forecast(prefix, now);
      page.alertsExpanded.value = false;
      page.snapshot.value = { ...page.snapshot.value, predictions: [first] };
      await nextTick();
      assert.equal(page.alertTab.value, 'target');
      assert.equal(page.alertsExpanded.value, true);
      assert.equal(page.selection.value, null); // 提醒不改变地图选择或办理对象。
      page.alertTab.value = 'route'; page.alertsExpanded.value = false;
      for (const prediction of [{ ...first, prediction_id: 'recomputed' },
        { ...first, status: 'UNKNOWN' }, first]) {
        page.snapshot.value = { ...page.snapshot.value, predictions: [prediction] };
        await nextTick();
        assert.equal(page.alertTab.value, 'route');
        assert.equal(page.alertsExpanded.value, false);
      }
      page.snapshot.value = { ...page.snapshot.value, predictions: [forecast(prefix + '-new-cycle', now)] };
      await nextTick();
      assert.equal(page.alertTab.value, 'target');
      assert.equal(page.alertsExpanded.value, true);
    } finally { page.stop(); }
  }
});

test('未知、已撤销、已入区及过期预测不弹出新预警', async () => {
  const now = Date.now(), page = createPage(now);
  try {
    const first = forecast('not-current', now);
    for (const prediction of [{ ...first, status: 'UNKNOWN' }, { ...first, valid_until: now },
      ...['WITHDRAWN', 'ENTERED'].map(state => ({ ...first, warnings: first.warnings.map(row => ({ ...row, state })) }))]) {
      page.snapshot.value = { ...page.snapshot.value, predictions: [prediction] };
      await nextTick();
      assert.equal(page.alertTab.value, 'target');
      assert.equal(page.predictionRows.value.length, 0);
    }
  } finally { page.stop(); }
});

test('统一风险从预计入区转实际入区保留所选区域、卡片及视频上下文', async () => {
  for (const sourceMode of ['live', 'replay']) {
    const now = Date.now(), page = createPage(now), predicted = forecast(sourceMode, now);
    const risk_case_id = `case-${sourceMode}`;
    const first = { id: 'first', alarmId: 'first-alarm', eventId: predicted.warnings[0].event_id,
      targetInternalId: predicted.target_id, targetId: predicted.target_no, eventState: 'CONFIRMED', sourceMode,
      originKind: 'PREDICTED_AIRSPACE_ENTRY', risk_case: { risk_case_id, version: 3, stage: 'PREDICTED', verification_status: 'CONFIRMED', airspace_id: 'area-one' } };
    const target = { id: predicted.target_no, targetId: predicted.target_id, objectTypeCode: 'UAV', relatedAlarms: [first] };
    try {
      page.snapshot.value = { ...page.snapshot.value, predictions: [predicted], targets: [target], alarms: [first] };
      await nextTick(); page.selectAlarm(first); await nextTick();
      page.showTargetVideo.value = true; const videoKey = page.videoContext.value.key, selection = page.selection.value;
      const entered = { ...first, id: 'observed', alarmId: 'observed-alarm', eventId: 'observed-event',
        risk_case: { ...first.risk_case, version: 4, stage: 'ENTERED' } };
      const another = { ...entered, alarmId: 'other-area', risk_case: { ...entered.risk_case, risk_case_id: 'another-case', airspace_id: 'area-two', verification_status: 'PENDING_VERIFICATION' } };
      page.snapshot.value = { ...page.snapshot.value, predictions: [], alarms: [entered, another], targets: [{ ...target, relatedAlarms: [another, entered] }] };
      await nextTick();
      assert.equal(page.selection.value, selection);
      assert.equal(page.selectedUavAlarm.value.risk_case.risk_case_id, risk_case_id);
      assert.equal(page.selectedUavAlarm.value.eventId, 'observed-event');
      assert.equal(page.videoContext.value.key, videoKey); assert.equal(page.showTargetVideo.value, true);
      assert.equal(page.alarms.value.length, 2, '不同区域保留独立风险，同周期没有预测重复项');
    } finally { page.stop(); }
  }
});


test('预测和实测不弹顶部提示，同风险更新不抢页签，新区域仍展开风险列表', async () => {
  for (const sourceMode of ['live', 'replay']) {
    const now = Date.now(), page = createPage(now), prediction = forecast(`dedup-${sourceMode}`, now);
    const episode = `episode-${sourceMode}`, caseId = `risk-${sourceMode}`;
    prediction.warnings[0] = { ...prediction.warnings[0], episode_id: episode, airspace_id: 'area-one' };
    const first = { id: 'original-alarm', alarmId: 'original-alarm', eventId: prediction.warnings[0].event_id,
      targetInternalId: prediction.target_id, targetId: prediction.target_no, eventState: 'PENDING_VERIFICATION', sourceMode,
      prediction, originKind: 'PREDICTED_AIRSPACE_ENTRY',
      risk_case: { risk_case_id: caseId, version: 1, stage: 'PREDICTED', airspace_id: 'area-one', verification_status: 'PENDING_VERIFICATION' } };
    const target = { id: prediction.target_no, targetId: prediction.target_id, objectTypeCode: 'UAV', relatedAlarms: [first] };
    try {
      page.snapshot.value = { ...page.snapshot.value, predictions: [prediction] }; await nextTick();
      assert.equal(page.stats.notices.length, 0, '首次有效预测只进入风险列表，不弹顶部提示');
      page.alertTab.value = 'route'; page.alertsExpanded.value = false;
      page.snapshot.value = { ...page.snapshot.value, alarms: [first], targets: [target] }; await nextTick();
      assert.equal(page.stats.notices.length, 0, '通过明确episode关联到risk_case，仍不弹顶部提示');
      assert.equal(page.alertTab.value, 'route'); assert.equal(page.alertsExpanded.value, false);
      const entered = { ...first, prediction: undefined, id: 'measured-alarm', alarmId: 'measured-alarm', eventId: 'measured-event',
        risk_case: { ...first.risk_case, stage: 'ENTERED', version: 2 } };
      page.snapshot.value = { ...page.snapshot.value, predictions: [], alarms: [entered] }; await nextTick();
      assert.equal(page.stats.notices.length, 0, '实际入区也不弹顶部提示');
      const other = { ...entered, risk_case: { ...entered.risk_case, risk_case_id: `${caseId}-second-area`, airspace_id: 'area-two' } };
      page.snapshot.value = { ...page.snapshot.value, alarms: [entered, other] }; await nextTick();
      assert.equal(page.stats.notices.length, 0, '不同区域风险保留在列表，不弹顶部提示');
      assert.equal(page.alertsExpanded.value, true);
    } finally { page.stop(); }
  }
});


test('选中目标的详情和预测迟到失败在离页后不弹到其他页面', async () => {
  const now = Date.now(), rejects = [];
  const read = () => new Promise((_resolve, reject) => rejects.push(reject));
  const page = createPage(now, { loadTargetDetail: read, loadTargetPrediction: read });
  try {
    const target = { id: 'current-target', targetId: 'internal-target', objectTypeCode: 'UAV' };
    page.snapshot.value = { ...page.snapshot.value, targets: [target] }; await nextTick();
    page.selectTarget(target); assert.equal(rejects.length, 2); page.leave();
    rejects.forEach(reject => reject(Object.assign(new Error('late failure'), { code: 'TIMEOUT' })));
    await Promise.resolve(); await nextTick(); assert.equal(page.stats.notices.length, 0);
  } finally { page.stop(); }
});


test('SSE正常空闲和无权限不报刷新慢，仅真实目标请求超时或失败提示', async () => {
  const now = Date.now(), page = createPage(now);
  try {
    page.snapshot.value = { ...page.snapshot.value, startedAt: now, generatedAt: now, targetUpdatedAt: now, targetRefreshStartedAt: 0 };
    page.nowTick.value = now + 30000; await nextTick();
    assert.equal(page.refreshSlow.value, false, '没有新观测的正常空闲不代表数据刷新故障');
    page.snapshot.value = { ...page.snapshot.value, targetRefreshStartedAt: now + 10000 }; await nextTick();
    assert.equal(page.refreshSlow.value, true, '实际目标读取已在途20秒');
    page.snapshot.value = { ...page.snapshot.value, deniedSegments: ['targets'] }; await nextTick();
    assert.equal(page.refreshSlow.value, false, '无权限不伪装服务异常');
    page.snapshot.value = { ...page.snapshot.value, deniedSegments: [], targetRefreshStartedAt: 0, failedSegments: ['targets'] }; await nextTick();
    assert.equal(page.refreshSlow.value, true);
    page.snapshot.value = { ...page.snapshot.value, failedSegments: [], targetUpdatedAt: now + 30000 }; await nextTick();
    assert.equal(page.refreshSlow.value, false);
  } finally { page.stop(); }
});

const settle = async () => { for (let i=0;i<6;i++) await Promise.resolve(); await nextTick(); };
function currentCase(sourceMode='replay') {
  const caseId=randomUUID(), targetId=randomUUID(), areaId=randomUUID(), eventId=randomUUID();
  const raw={ alarm_id:randomUUID(), alarm_no:'AL-'+randomUUID(), target_id:targetId,target_no:'UAV-'+randomUUID(),
    event_id:eventId,state:'CONFIRMED',source_mode:sourceMode,
    risk_case:{risk_case_id:caseId,version:5,stage:'ENTERED',verification_status:'CONFIRMED',airspace_id:areaId,action_event_id:eventId} };
  const alarm=toAlarms([raw])[0];
  return {raw,alarm,target:{id:raw.target_no,targetId,sourceMode,objectTypeCode:'UAV',relatedAlarms:[alarm]}};
}
test('所选风险暂时离开列表仍保留身份并暂停动作，轻量读取UNKNOWN及恢复实测不借另一地区', async()=>{
  for(const sourceMode of ['live','replay']) {
    const f=currentCase(sourceMode), replies=[],calls=[];
    const page=createPage(Date.now(),{}, {getUavRiskCase:(id,params)=>{calls.push({id,params});return new Promise(resolve=>replies.push(resolve));}});
    try {
      page.snapshot.value={...page.snapshot.value,targets:[f.target],alarms:[f.alarm]}; await nextTick();
      page.selectAlarm(f.alarm);await nextTick();
      const other={...f.alarm,alarmId:randomUUID(),risk_case:{...f.alarm.risk_case,risk_case_id:randomUUID(),airspace_id:randomUUID()}};
      page.snapshot.value={...page.snapshot.value,alarms:[other],targets:[{...f.target,relatedAlarms:[other]}]};await nextTick();
      assert.equal(page.selectedUavAlarm.value.risk_case.risk_case_id,f.raw.risk_case.risk_case_id);
      assert.equal(page.selectedUavAlarm.value._riskUnavailable,true);
      assert.equal(page.alarms.value.length,1,'保留选中上下文不塞回地图风险列表');
      assert.equal(calls.length,1);assert.deepEqual({...calls[0].params},{purpose:'verification'});
      replies.shift()({alarm:f.raw,event:{},risk_case:{...f.raw.risk_case,version:6,stage:'UNKNOWN',allowed_actions:[]}});await settle();
      assert.equal(page.selectedUavAlarm.value.risk_case.stage,'UNKNOWN');
      assert.equal(page.selectedUavAlarm.value._riskUnavailable,false,'依据不足来自最新服务端状态');
      const entered={...f.alarm,eventId:randomUUID(),risk_case:{...f.alarm.risk_case,version:7,stage:'ENTERED'}};
      page.snapshot.value={...page.snapshot.value,alarms:[entered,other],targets:[{...f.target,relatedAlarms:[other,entered]}]};await nextTick();
      assert.equal(page.selectedUavAlarm.value.eventId,entered.eventId);
      assert.equal(page.selectedUavAlarm.value.risk_case.risk_case_id,f.raw.risk_case.risk_case_id);
      assert.equal(calls.length,1,'正常列表刷新不额外读取详情');
    }finally{page.stop();}
  }
});
test('所选风险回读拒绝其他来源/区域和旧版本；切换目标后迟到响应不能覆盖',async()=>{
  for(const change of ['source','area','version','selection']) {
    const f=currentCase(),g=currentCase('live');let resolve;
    const page=createPage(Date.now(),{}, {getUavRiskCase:()=>new Promise(done=>resolve=done)});
    try{
      page.snapshot.value={...page.snapshot.value,targets:[f.target,g.target],alarms:[f.alarm,g.alarm]};await nextTick();page.selectAlarm(f.alarm);await nextTick();
      page.snapshot.value={...page.snapshot.value,alarms:[g.alarm],targets:[{...f.target,relatedAlarms:[]},g.target]};await nextTick();
      const result={alarm:{...f.raw},risk_case:{...f.raw.risk_case,version:6},event:{}};
      if(change==='source')result.alarm.source_mode='live';
      if(change==='area')result.risk_case.airspace_id=randomUUID();
      if(change==='version')result.risk_case.version=4;
      if(change==='selection'){page.selectAlarm(g.alarm);await nextTick();}
      resolve(result);await settle();
      assert.equal(page.selectedUavAlarm.value.risk_case.risk_case_id,(change==='selection'?g:f).raw.risk_case.risk_case_id);
      if(change!=='selection')assert.equal(page.selectedUavAlarm.value._riskUnavailable,true);
    }finally{page.stop();}
  }
});
test('同case转实测的低event版本可更新处置摘要，旧事件迟到响应不能覆盖',async()=>{
  const f=currentCase(),page=createPage();
  try{
    page.snapshot.value={...page.snapshot.value,targets:[f.target],alarms:[f.alarm]};await nextTick();page.selectAlarm(f.alarm);await nextTick();
    const caseId=f.raw.risk_case.risk_case_id;
    page.updateNotification({event_id:f.alarm.eventId,_riskCaseId:caseId,event_version:90,_fetchedAt:200});
    const entered={...f.alarm,eventId:randomUUID(),risk_case:{...f.alarm.risk_case,version:6}};
    page.snapshot.value={...page.snapshot.value,alarms:[entered],targets:[{...f.target,relatedAlarms:[entered]}]};await nextTick();
    page.updateNotification({event_id:entered.eventId,_riskCaseId:caseId,event_version:2,_fetchedAt:100,can_direct_counter:true});
    assert.equal(page.advisorySummaries.value[caseId].event_id,entered.eventId);
    page.updateNotification({event_id:f.alarm.eventId,_riskCaseId:caseId,event_version:91,_fetchedAt:300});
    assert.equal(page.advisorySummaries.value[caseId].event_id,entered.eventId);
  }finally{page.stop();}
});

test('所选风险回读终态按真实原始state保留，不重新出现在地图或继续轮询',async()=>{
  const f=currentCase();let resolve,reads=0;
  const page=createPage(Date.now(),{}, {getUavRiskCase:()=>{reads++;return new Promise(done=>resolve=done);}});
  try{
    page.snapshot.value={...page.snapshot.value,targets:[f.target],alarms:[f.alarm]};await nextTick();page.selectAlarm(f.alarm);await nextTick();
    page.snapshot.value={...page.snapshot.value,alarms:[],targets:[{...f.target,relatedAlarms:[]}]};await nextTick();
    resolve({alarm:{...f.raw,state:'FALSE_POSITIVE'},risk_case:{...f.raw.risk_case,version:6,stage:'ENDED',verification_status:'FALSE_POSITIVE'},event:{}});await settle();
    assert.equal(page.selectedUavAlarm.value.state,'FALSE_POSITIVE');assert.equal(page.selectedUavAlarm.value.eventState,'FALSE_POSITIVE');
    assert.equal(page.selectedUavAlarm.value.risk_case.stage,'ENDED');assert.equal(page.alarms.value.length,0);
    page.selectedRiskContext.value={...page.selectedRiskContext.value,checkedAt:Date.now()-5000};page.nowTick.value+=5000;await nextTick();
    assert.equal(reads,1);
  }finally{page.stop();}
});

test('真实applySnapshot短暂过滤目标后转实测，所选case和视频不被降为纯预测或清除',async()=>{
  for(const sourceMode of ['live','replay']){
    const now=Date.now(),f=currentCase(sourceMode);let resolve;
    const page=createPage(now,{}, {getUavRiskCase:()=>new Promise(done=>resolve=done)});
    const forecastRaw={...forecast(sourceMode,now),target_id:f.raw.target_id,target_no:f.raw.target_no,source_mode:sourceMode};
    forecastRaw.warnings=[{...forecastRaw.warnings[0],event_id:f.alarm.eventId,risk_case_id:f.raw.risk_case.risk_case_id,airspace_id:f.raw.risk_case.airspace_id}];
    const predicted={...f.alarm,originKind:'PREDICTED_AIRSPACE_ENTRY',prediction:forecastRaw,risk_case:{...f.alarm.risk_case,stage:'PREDICTED'}};
    const target={...f.target,observedAt:now-100,mapExpiresAt:now+5000,posValid:true,lon:118,lat:37};
    try{
      page.applySnapshot({...page.snapshot.value,targets:[target],alarms:[predicted],predictions:[forecastRaw]});await nextTick();
      page.selectAlarm(predicted);await nextTick();page.showTargetVideo.value=true;
      const selected=page.selection.value,key=page.videoContext.value.key;
      page.applySnapshot({...page.snapshot.value,targets:[{...target,mapExpiresAt:now-1}],alarms:[predicted]});await nextTick();
      assert.equal(page.snapshot.value.targets.length,0,'不延长地图目标有效期');
      assert.equal(page.selectedTarget.value,null);
      assert.equal(page.selectedCardTarget.value.targetId,target.targetId,'保留同一紧凑卡的最后观测，不切换另一套大卡');
      assert.equal(page.selectedCardTarget.value._lastObservationOnly,true);
      assert.equal(page.selectedCardAlarm.value._riskUnavailable,true,'最后观测不得用于新动作');
      assert.equal(page.selection.value,selected);assert.equal(page.selection.value.kind,'target');
      assert.equal(page.selectedUavAlarm.value.risk_case.risk_case_id,f.raw.risk_case.risk_case_id);
      assert.equal(page.selectedUavAlarm.value._riskUnavailable,true);assert.equal(page.showSelectionPopup.value,true);
      assert.equal(page.videoContext.value.key,key);assert.equal(page.showTargetVideo.value,true);
      const entered={...f.alarm,eventId:randomUUID(),risk_case:{...f.alarm.risk_case,version:6,stage:'ENTERED'}};
      page.applySnapshot({...page.snapshot.value,targets:[target],alarms:[entered],predictions:[]});await nextTick();
      assert.equal(page.selection.value,selected);assert.equal(page.selectedTarget.value.targetId,f.target.targetId);
      assert.equal(page.selectedCardTarget.value._lastObservationOnly,undefined,'恢复实测后重新使用有效目标');
      assert.equal(page.selectedUavAlarm.value.risk_case.stage,'ENTERED');assert.equal(page.mapPredictions.value.length,0);
      assert.equal(page.videoContext.value.key,key);assert.equal(page.showTargetVideo.value,true);
      resolve({alarm:f.raw,risk_case:f.raw.risk_case,event:{}});await settle();
      assert.equal(page.selectedUavAlarm.value.risk_case.stage,'ENTERED','迟到的旧预测阶段不能覆盖');
    }finally{page.stop();}
  }
});
test('纯预测选择在有效实测目标到达后升级目标选择，预测退出不关闭当前目标',async()=>{
  const now=Date.now(),page=createPage(now),raw=forecast(randomUUID(),now);
  try{
    page.applySnapshot({...page.snapshot.value,predictions:[raw]});await nextTick();page.selectPrediction(page.predictionRows.value[0]);await nextTick();
    assert.equal(page.selection.value.kind,'prediction');
    page.applySnapshot({...page.snapshot.value,predictions:[],targets:[{id:raw.target_no,targetId:raw.target_id,objectTypeCode:'UAV',observedAt:now-100,mapExpiresAt:now+5000}]});await nextTick();
    assert.equal(page.selection.value.kind,'target');assert.equal(page.selectedTarget.value.targetId,raw.target_id);
    assert.equal(page.showSelectionPopup.value,true);assert.equal(page.selectedPrediction.value,null);
  }finally{page.stop();}
});
test('预警先到且明确case时保留选择，目标/实测告警迟到只补同case面板',async()=>{
  const now=Date.now(),f=currentCase();let resolve;const page=createPage(now,{}, {getUavRiskCase:()=>new Promise(done=>resolve=done)});
  const raw={...forecast(randomUUID(),now),target_id:f.raw.target_id,target_no:f.raw.target_no,source_mode:f.raw.source_mode};
  raw.warnings=[{...raw.warnings[0],risk_case_id:f.raw.risk_case.risk_case_id,airspace_id:f.raw.risk_case.airspace_id,event_id:f.raw.event_id}];
  try{
    page.applySnapshot({...page.snapshot.value,predictions:[raw]});await nextTick();page.selectPrediction(page.predictionRows.value[0]);await nextTick();
    const selection=page.selection.value;assert.equal(selection.riskCaseId,f.raw.risk_case.risk_case_id);assert.equal(page.selectedUavAlarm.value._riskUnavailable,true);
    page.applySnapshot({...page.snapshot.value,predictions:[]});await nextTick();assert.equal(page.selection.value,selection);
    resolve({alarm:f.raw,risk_case:f.raw.risk_case,event:{}});await settle();assert.equal(page.selectedUavAlarm.value.risk_case.stage,'ENTERED');
    page.applySnapshot({...page.snapshot.value,targets:[{...f.target,observedAt:now-50,mapExpiresAt:now+5000}],alarms:[f.alarm]});await nextTick();
    assert.equal(page.selection.value,selection);assert.equal(page.selectedTarget.value.targetId,f.raw.target_id);assert.equal(page.showSelectionPopup.value,true);
  }finally{page.stop();}
});
test('核实更新case版本后旧摘要退出，最新摘要同区域同事件同版本才恢复',async()=>{
  const f=currentCase(),page=createPage();
  try{
    page.snapshot.value={...page.snapshot.value,targets:[f.target],alarms:[f.alarm]};await nextTick();page.selectAlarm(f.alarm);await nextTick();
    const risk=f.raw.risk_case,key=risk.risk_case_id;
    for(const version of [undefined,4]){
      page.advisorySummaries.value={[key]:{event_id:f.alarm.eventId,risk_case_id:key,risk_case_version:version,can_direct_counter:true}};await nextTick();
      assert.equal(page.selectedAdvisorySummary.value,null);
    }
    const summary={event_id:f.alarm.eventId,risk_case:{...risk},can_direct_counter:true};
    page.advisorySummaries.value={[key]:summary};await nextTick();assert.equal(page.selectedAdvisorySummary.value.can_direct_counter,true);
    page.snapshot.value={...page.snapshot.value,alarms:[{...f.alarm,risk_case:{...risk,version:6}}]};await nextTick();
    assert.equal(page.selectedAdvisorySummary.value,null);
  }finally{page.stop();}
});


test('相同case版本的阶段或核实状态不同，处置摘要暂停显示资格且不改写风险状态',async()=>{
 const f=currentCase(),page=createPage();
 try{
  page.snapshot.value={...page.snapshot.value,targets:[f.target],alarms:[f.alarm]};await nextTick();page.selectAlarm(f.alarm);await nextTick();
  const risk=f.raw.risk_case,key=risk.risk_case_id;
  for(const patch of [{stage:'UNKNOWN'},{verification_status:'PENDING_VERIFICATION'},{stage:undefined},{verification_status:undefined}]){
   page.updateNotification({event_id:f.alarm.eventId,risk_case:{...risk,...patch},can_direct_counter:true});await nextTick();
   assert.equal(page.selectedAdvisorySummary.value,null);
   assert.equal(page.selectedUavAlarm.value.risk_case.stage,'ENTERED');
   assert.equal(page.selectedUavAlarm.value.risk_case.verification_status,'CONFIRMED');
  }
  page.updateNotification({event_id:f.alarm.eventId,risk_case:{...risk},can_direct_counter:true});await nextTick();
  assert.equal(page.selectedAdvisorySummary.value.can_direct_counter,true);
 }finally{page.stop();}
});

test('同区域同来源更高版本处置摘要推进选中case，旧列表与迟到低版本不能回退',async()=>{
 for(const sourceMode of ['live','replay']) for(const changedEvent of [false,true]){
  const f=currentCase(sourceMode),page=createPage();
  try{
   const prior={...f.alarm,risk_case:{...f.raw.risk_case,stage:'PREDICTED',verification_status:'PENDING_VERIFICATION'}};
   page.snapshot.value={...page.snapshot.value,targets:[{...f.target,relatedAlarms:[prior]}],alarms:[prior]};await nextTick();page.selectAlarm(prior);await nextTick();
   page.showTargetVideo.value=true;const selection=page.selection.value,video=page.videoContext.value.key;
   const eventId=changedEvent?randomUUID():f.alarm.eventId;
   const risk={...f.raw.risk_case,version:6,source_mode:sourceMode,action_event_id:eventId,related_event_ids:[f.alarm.eventId,eventId]};
   const current={event_id:eventId,event_version:2,risk_case:risk,can_direct_counter:true,_fetchedAt:200};
   page.updateNotification(current);await nextTick();
   assert.equal(page.selectedUavAlarm.value.risk_case.version,6);assert.equal(page.selectedUavAlarm.value.risk_case.stage,'ENTERED');
   assert.equal(page.selectedUavAlarm.value.eventId,eventId);assert.equal(page.selectedAdvisorySummary.value.can_direct_counter,true);
   assert.equal(page.selection.value,selection);assert.equal(page.videoContext.value.key,video);assert.equal(page.showTargetVideo.value,true);
   page.snapshot.value={...page.snapshot.value,alarms:[prior]};await nextTick();
   assert.equal(page.selectedUavAlarm.value.risk_case.version,6,'旧列表不能覆盖更高版本');
   page.updateNotification({...current,risk_case:{...risk,version:5,stage:'PREDICTED'},_fetchedAt:300});await nextTick();
   assert.equal(page.selectedUavAlarm.value.risk_case.version,6);assert.equal(page.selectedAdvisorySummary.value.risk_case.version,6);
  }finally{page.stop();}
 }
});

test('更高版本摘要不得串入其他区域或来源，切换办理事件必须有原事件关联',async()=>{
 for(const change of ['case','area','source','event']){
  const f=currentCase(),page=createPage();
  try{
   page.snapshot.value={...page.snapshot.value,targets:[f.target],alarms:[f.alarm]};await nextTick();page.selectAlarm(f.alarm);await nextTick();
   const risk={...f.raw.risk_case,version:6,source_mode:'replay'},event_id=change==='event'?randomUUID():f.alarm.eventId;
   if(change==='case')risk.risk_case_id=randomUUID();
   if(change==='area')risk.airspace_id=randomUUID();
   if(change==='source')risk.source_mode='live';
   if(change==='event')risk.action_event_id=event_id;
   page.updateNotification({event_id,risk_case:risk,can_direct_counter:true});await nextTick();
   assert.equal(page.selectedUavAlarm.value.risk_case.version,5);assert.equal(page.selectedUavAlarm.value.risk_case.risk_case_id,f.raw.risk_case.risk_case_id);
   assert.equal(page.selectedAdvisorySummary.value,null);
  }finally{page.stop();}
 }
});


test('核实成功返回的统一风险与资格在地图刷新完成前原子接续，旧列表不能回退',async()=>{
 for(const sourceMode of ['live','replay']) for(const entered of [false,true]){
  const f=currentCase(sourceMode);let refresh,resolveMap,reads=0;
  const initial={...f.raw.risk_case,source_mode:sourceMode,stage:'PREDICTED',verification_status:'PENDING_VERIFICATION'};
  const raw={...f.raw,risk_case:initial},prior=toAlarms([raw])[0];
  const page=createPage(Date.now(),{refresh:()=>new Promise(resolve=>{resolveMap=resolve;})},{
    getUavRiskCase:async()=>{reads++;return {risk_case:initial,alarm:raw,event:{event_id:prior.eventId}};},
    openModal:()=>({isCurrent:()=>true,close(){}}),openUavVerification:options=>{refresh=options.refresh;return true;}
  });
  try{
   page.snapshot.value={...page.snapshot.value,targets:[{...f.target,relatedAlarms:[prior]}],alarms:[prior]};await nextTick();page.selectAlarm(prior);await nextTick();
   await page.openTargetVerification(null,prior);
   const eventId=entered?randomUUID():prior.eventId;
   const risk={...initial,version:6,stage:entered?'ENTERED':'PREDICTED',verification_status:'CONFIRMED',action_event_id:eventId,related_event_ids:[prior.eventId,eventId]};
   const result={risk_case:risk,alarm:{...raw,event_id:eventId},event:{event_id:eventId},
     advisory:{event_id:eventId,risk_case:{...risk},can_direct_counter:true,event_version:2}};
   const readsBeforeRefresh=reads;const pending=refresh(result);
   assert.equal(page.selectedUavAlarm.value.risk_case.verification_status,'CONFIRMED');
   assert.equal(page.selectedUavAlarm.value.risk_case.stage,risk.stage);assert.equal(page.selectedAdvisorySummary.value.can_direct_counter,true);
   await nextTick();resolveMap();await pending;assert.equal(reads,readsBeforeRefresh,'提交响应已携带event，不重复读取核实详情');
   page.updateNotification({event_id:prior.eventId,risk_case:initial,can_direct_counter:false,_fetchedAt:Date.now()+1000});
   assert.equal(page.selectedAdvisorySummary.value.can_direct_counter,true);
  }finally{page.stop();}
 }
});

test('核实返回身份、来源、区域或资格快照不一致时不能接续为可反制',async()=>{
 for(const field of ['case','target','source','area','version','advisory']){
  const f=currentCase(),page=createPage();try{
   page.snapshot.value={...page.snapshot.value,targets:[f.target],alarms:[f.alarm]};await nextTick();page.selectAlarm(f.alarm);await nextTick();
   const risk={...f.raw.risk_case,source_mode:'replay',version:6},alarm={...f.raw};
   const result={risk_case:risk,alarm,advisory:{event_id:f.alarm.eventId,risk_case:{...risk},can_direct_counter:true}};
   if(field==='case')risk.risk_case_id=randomUUID();if(field==='target')alarm.target_id=randomUUID();
   if(field==='source')alarm.source_mode='live';if(field==='area')risk.airspace_id=randomUUID();
   if(field==='version')risk.version=4;if(field==='advisory')result.advisory.risk_case.version=5;
   assert.equal(page.applySelectedRiskDetail(result),false);assert.equal(page.selectedAdvisorySummary.value,null);
   assert.equal(page.selectedUavAlarm.value.risk_case.version,5);
  }finally{page.stop();}
 }
});
