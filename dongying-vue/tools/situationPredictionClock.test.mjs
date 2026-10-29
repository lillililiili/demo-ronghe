import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { computed, ref } from 'vue';
import { currentPredictionViews, predictionWarningRows } from '../src/services/predictionView.js';
import { currentMapSnapshot } from '../src/services/situationData.js';
import { riskCaseOf } from '../src/services/riskCaseView.js';

const source = readFileSync(new URL('../src/pages/SituationPage.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('function applySnapshot(');
assert.ok(start >= 0);
const applyBody = source.slice(start, source.indexOf('\n}\n', start) + 3);

function pageClock(initialAt) {
  let at = initialAt;
  const snapshot = ref({ targets: [], predictions: [], alarms: [], risks: [] });
  const nowTick = ref(initialAt), projectionTimes = [];
  const unavailable = computed(() => ['failedSegments', 'deniedSegments'].some(key => snapshot.value[key]?.includes('predictions')));
  const currentPredictions = computed(() => currentPredictionViews(snapshot.value.predictions, nowTick.value, unavailable.value));
  const predictionRows = computed(() => predictionWarningRows(currentPredictions.value, nowTick.value));
  const deps = { snapshot, nowTick, currentPredictions, predictionRows, serverNow: () => at, riskCaseOf,
    selection: ref(null), selectedTarget: ref(null), selectedUavAlarm: ref(null), selectedRiskGroup: ref(null),
    predictionClusterIds: ref([]), reportedSourceFailures: new Set(), decorate: value => value,
    currentMapSnapshot: (value, time) => { projectionTimes.push(time); return currentMapSnapshot(value, time); },
    clearSelection() {}, reconcilePredictionSelection() {}, syncMapData() {}, map: null,
    newAlarmCount: computed(() => predictionRows.value.length), newRiskCount: ref(0), statusAnnouncement: ref('') };
  const apply = new Function(...Object.keys(deps), 'let rawSnapshot;\n' + applyBody + '\nreturn applySnapshot;')(...Object.values(deps));
  return { apply, snapshot, nowTick, predictionRows, projectionTimes, receiveAt(value) { at = value; } };
}

function forecast(at, sourceMode) {
  const id = randomUUID();
  return { prediction_id: randomUUID(), target_id: id, source_mode: sourceMode, status: 'READY',
    generated_at: at + 10, based_on_observed_at: at, valid_until: at + 3000,
    warnings: [{ event_id: randomUUID(), risk_case_id: randomUUID(), state: 'ACTIVE' }] };
}
function frame(prediction, extra = {}) {
  return { generatedAt: prediction.generated_at, predictions: [prediction], targets: [], alarms: [], risks: [], ...extra };
}

for (const sourceMode of ['live', 'replay']) {
  test(sourceMode + ' 新预测在秒针之间到达时立即保持可见，不误判为未来观测', () => {
    const base = Date.now();
    const page = pageClock(base);
    page.apply(frame(forecast(base - 100, sourceMode)));
    assert.equal(page.predictionRows.value.length, 1);
    for (const elapsed of [140, 630, 960, 1140, 1630, 1960]) {
      const receivedAt = base + elapsed, next = forecast(receivedAt - 30, sourceMode);
      page.receiveAt(receivedAt);
      page.apply(frame(next));
      assert.equal(page.predictionRows.value.length, 1, '尚未等到下一秒，当前有效预测已可见');
      assert.equal(page.predictionRows.value[0].targetId, next.target_id);
      assert.equal(page.projectionTimes.at(-1), receivedAt, '地图与预测使用本次收到快照时的同一平台时钟');
      assert.equal(page.snapshot.value.predictions[0].valid_until, next.valid_until);
    }
  });

  test(sourceMode + ' 实际未来、到期、未知和读取失败仍退出，慢请求不续期', () => {
    for (const scenario of ['future', 'expired', 'unknown', 'failed', 'denied', 'slow']) {
      const base = Date.now(), page = pageClock(base);
      const fresh = forecast(base - 100, sourceMode);
      page.apply(frame(fresh));
      assert.equal(page.predictionRows.value.length, 1);
      let receivedAt = base + 500;
      const next = forecast(base + 100, sourceMode), extra = {};
      if (scenario === 'future') next.based_on_observed_at = receivedAt + 1;
      if (scenario === 'expired') next.valid_until = receivedAt;
      if (scenario === 'unknown') next.status = 'UNKNOWN';
      if (scenario === 'failed') extra.failedSegments = ['predictions'];
      if (scenario === 'denied') extra.deniedSegments = ['predictions'];
      if (scenario === 'slow') receivedAt = next.valid_until + 500;
      const frozen = structuredClone(next);
      page.receiveAt(receivedAt);
      page.apply(frame(next, extra));
      assert.equal(page.predictionRows.value.length, 0, scenario);
      assert.deepEqual(next, frozen, '展示不改写观测、状态或预测有效期');
    }
    const base = Date.now(), page = pageClock(base), prediction = forecast(base + 100, sourceMode);
    page.receiveAt(base + 200);
    page.apply(frame(prediction));
    assert.equal(page.predictionRows.value.length, 1);
    page.nowTick.value = prediction.valid_until;
    assert.equal(page.predictionRows.value.length, 0, '没有新快照时仍在原有效期退出');
  });
}
