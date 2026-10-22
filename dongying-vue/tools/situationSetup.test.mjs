import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { computed, ref, watch, effectScope, nextTick } from 'vue';
import * as prediction from '../src/services/predictionView.js';

function createPage(now = Date.now()) {
  const file = readFileSync(new URL('../src/pages/SituationPage.vue', import.meta.url), 'utf8');
  let script = file.match(/<script setup>([\s\S]*?)<\/script>/)[1];
  const bindings = {};
  script = script.replace(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"];?/g, (_, names) => {
    for (const name of names.replace(/[{}]/g, '').split(',').map(name => name.trim()).filter(Boolean)) {
      bindings[name.split(/\s+as\s+/).at(-1)] = () => undefined;
    }
    return '';
  });
  const stats = { watchCount: 0, mapCreated: 0 };
  const context = vm.createContext({ ...bindings, ...prediction,
    computed, ref, nextTick, watch: (...args) => { stats.watchCount++; return watch(...args); },
    onMounted() {}, onUnmounted() {}, serverNow: () => now,
    useRoute: () => ({ query: {} }), createSituationApiSource: () => ({ setSourceTarget() {},
      loadTargetDetail: async () => null, loadTargetPrediction: async () => null }),
    groupRouteRisks: () => [], riskSnapshotMarkers: () => [],
    window: { UI: { icon: () => '', businessIcon: () => '' }, MapView: function () { stats.mapCreated++; } },
    sessionStorage: { getItem: () => null, setItem() {} }, console
  });
  const scope = effectScope();
  try {
    scope.run(() => vm.runInContext(`${script}\n globalThis.page = {
      snapshot, selection, nowTick, predictionRows, predictionClusterIds, visiblePredictionRows,
      selectedPrediction, selectedTarget, mapPredictions, showSelectionPopup, selectPrediction, clearSelection
    };`, context));
    return { ...context.page, stats, stop: () => scope.stop() };
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
