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

function createPage(now = Date.now(), sourceOverrides = {}) {
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
    sessionStorage: { getItem: () => null, setItem() {} }, console
  });
  const scope = effectScope();
  try {
    scope.run(() => vm.runInContext(`${script}\n globalThis.page = {
      snapshot, selection, nowTick, refreshSlow, predictionRows, alertTab, alertsExpanded, predictionClusterIds, visiblePredictionRows,
      selectedPrediction, selectedTarget, selectedUavAlarm, alarms, videoContext, showTargetVideo, mapPredictions, showSelectionPopup, selectPrediction, selectAlarm, selectTarget, clearSelection,
      eoDevice, eoSelected, setEoExpanded, onMapPick, attachMap: value => { map = value; syncMapData(); }
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


test('预测先读回、同风险列表迟到及转实测只提示一次，新区域或新周期单独提示', async () => {
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
      assert.equal(page.stats.notices.length, 1, '首次有效预测不是历史基线，立即提示');
      page.alertTab.value = 'route'; page.alertsExpanded.value = false;
      page.snapshot.value = { ...page.snapshot.value, alarms: [first], targets: [target] }; await nextTick();
      assert.equal(page.stats.notices.length, 1, '通过明确episode关联到risk_case，不重复提示');
      assert.equal(page.alertTab.value, 'route'); assert.equal(page.alertsExpanded.value, false);
      const entered = { ...first, prediction: undefined, id: 'measured-alarm', alarmId: 'measured-alarm', eventId: 'measured-event',
        risk_case: { ...first.risk_case, stage: 'ENTERED', version: 2 } };
      page.snapshot.value = { ...page.snapshot.value, predictions: [], alarms: [entered] }; await nextTick();
      assert.equal(page.stats.notices.length, 1, '入区阶段变化不改变风险身份');
      const other = { ...entered, risk_case: { ...entered.risk_case, risk_case_id: `${caseId}-second-area`, airspace_id: 'area-two' } };
      page.snapshot.value = { ...page.snapshot.value, alarms: [entered, other] }; await nextTick();
      assert.equal(page.stats.notices.length, 2, '同一实测事件不同区域独立提醒');
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
