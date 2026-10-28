import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PREDICTION_ORIGIN, predictionLocation, predictionIsCurrent, currentPredictionViews, predictionWarningRows, predictionMapData, alarmPredictionState, predictionProximityRows, predictionEntrySeconds } from '../src/services/predictionView.js';
import { predictionDetailsHtml, predictionReasonText, predictionEvidenceNotesText } from '../src/ui/predictionDetails.js';
const origin = Date.now();
function forecast({ id = 'aircraft-a', mode = 'live', shift = 0 } = {}) {
  return { prediction_id: `forecast-${id}`, target_id: id, target_no: `UAV-${id}`, version: 2, status: 'READY',
    based_on_observed_at: origin - 500, generated_at: origin, valid_until: origin + 8000, source_mode: mode, simulated: mode === 'replay',
    anchor: { location: { longitude: 118 + shift, latitude: 37 + shift } },
    points: [10, 20, 30].map(seconds => ({ horizon_seconds: seconds, predicted_at: origin + seconds * 1000,
      location: { longitude: 118 + shift + seconds / 100000, latitude: 37 + shift }, altitude_m: 100, altitude_datum: 'AMSL', uncertainty_m: 5 })),
    warnings: [{ event_id: `event-${id}`, state: 'ACTIVE', airspace_version_id: `area-${id}`, airspace_name: '测试禁飞区',
      entry_at: origin + 18000, entry_location: { longitude: 118 + shift + .00018, latitude: 37 + shift } }] };
}

test('不同编号、位置与来源均采用同一预测投影，实测对象不被写入未来点', () => {
  for (const options of [{}, { id: 'aircraft-z', mode: 'replay', shift: -.5 }]) {
    const raw = forecast(options), original = JSON.stringify(raw);
    const map = predictionMapData([raw], origin, raw.target_id);
    assert.equal(map[0].points.length, 3);
    assert.deepEqual(map[0].points.map(point => point.horizon), [10, 20, 30]);
    assert.equal(map[0].warnings.length, 1);
    assert.equal(JSON.stringify(raw), original);
    assert.equal(Object.hasOwn(raw, 'track'), false);
    assert.equal(predictionMapData([raw], origin, 'another-target')[0].points.length, 0);
  }
});

test('预测过期或读取失败退出融合清单与地图，但不撤销后端事件及告警未知历史', () => {
  for (const [time, failed] of [[origin + 8000, false], [origin, true]]) {
    const raw = forecast();
    assert.equal(predictionIsCurrent(raw, time, failed), false);
    const map = predictionMapData([raw], time, raw.target_id, failed)[0];
    assert.deepEqual(map.points, []); assert.deepEqual(map.warnings, []);
    const rows = predictionWarningRows([raw], time, failed);
    assert.deepEqual(rows, []);
    assert.equal(raw.warnings[0].state, 'ACTIVE', '浏览器不得撤销后端事件');
    const alarm = { origin_kind: PREDICTION_ORIGIN, prediction: { ...raw, status: failed ? 'UNKNOWN' : raw.status, warning: raw.warnings[0] } };
    assert.equal(alarmPredictionState(alarm, time), 'UNKNOWN', '告警页仍能说明该事件的未知依据');
  }
});

test('当前预测投影按结果与有效期筛选，等于到期时刻即隐藏，缺失时效不能冒充当前', () => {
  for (const options of [{ id: 'boundary-live' }, { id: 'boundary-replay', mode: 'replay', shift: -.2 }]) {
    const raw = forecast(options);
    const cases = [
      { change: { valid_until: origin + 1 }, expected: 1 },
      { change: { valid_until: origin }, expected: 0 },
      { change: { valid_until: origin - 1 }, expected: 0 },
      { change: { valid_until: null }, expected: 0 },
      { change: { valid_until: '' }, expected: 0 },
      { change: { valid_until: Infinity }, expected: 0 },
      { change: { based_on_observed_at: origin + 1 }, expected: 0 },
      { change: { based_on_observed_at: null }, expected: 0 },
      { change: { status: 'UNKNOWN' }, expected: 0 }
    ];
    for (const { change, expected } of cases) {
      const candidate = { ...raw, ...change };
      assert.equal(currentPredictionViews([candidate], origin).length, expected, JSON.stringify(change));
      assert.equal(predictionWarningRows([candidate], origin).length, expected, JSON.stringify(change));
    }
    assert.deepEqual(currentPredictionViews([raw], origin, true), []);
    assert.deepEqual(predictionWarningRows([raw], origin, true), []);
  }
});

test('不同目标多空域只投影ACTIVE预警，旧单项摘要不带回未知或终态且原记录不变', () => {
  const first = forecast({ id: 'north-live' }), second = forecast({ id: 'south-replay', mode: 'replay', shift: .4 });
  const active = first.warnings[0];
  first.warnings = [
    { ...active, event_id: 'north-unknown', state: 'UNKNOWN' },
    active,
    { ...active, event_id: 'north-withdrawn', state: 'WITHDRAWN' },
    { ...active, event_id: 'north-entered', state: 'ENTERED' },
    { ...active, event_id: 'north-second-active', airspace_version_id: 'north-zone-two' }
  ];
  first.warning = first.warnings[0];
  second.warning = second.warnings[0]; delete second.warnings;
  const originals = JSON.stringify([first, second]);
  const views = currentPredictionViews([first, second], origin);
  assert.equal(views.length, 2);
  assert.notEqual(views[0], first); assert.notEqual(views[0].warnings, first.warnings);
  assert.deepEqual(views[0].warnings.map(warning => warning.event_id), ['event-north-live', 'north-second-active']);
  assert.equal(views[0].warning.event_id, 'event-north-live');
  assert.equal(views[1].warning.event_id, 'event-south-replay');
  assert.equal(views[1].warnings.length, 1);
  const rows = predictionWarningRows([first, second], origin);
  assert.deepEqual(rows.map(row => [row.targetId, row.key, row.state]), [
    ['north-live', 'event-north-live', 'ACTIVE'],
    ['north-live', 'north-second-active', 'ACTIVE'],
    ['south-replay', 'event-south-replay', 'ACTIVE']
  ]);
  assert.equal(JSON.stringify([first, second]), originals, '展示筛选不得改写历史预警或来源');
});

test('有效READY但尚无正式预警仍可看未来三点，不计入预警清单', () => {
  const raw = forecast({ id: 'not-yet-warning' });
  raw.warnings[0].state = 'UNKNOWN'; raw.warning = raw.warnings[0];
  const original = JSON.stringify(raw);
  const views = currentPredictionViews([raw], origin);
  assert.equal(views.length, 1);
  assert.deepEqual(views[0].warnings, []); assert.equal(views[0].warning, null);
  assert.deepEqual(predictionWarningRows([raw], origin), []);
  const map = predictionMapData(views, origin, raw.target_id)[0];
  assert.deepEqual(map.points.map(point => point.horizon), [10, 20, 30]);
  assert.deepEqual(map.warnings, []);
  assert.equal(JSON.stringify(raw), original);
});

test('查询恢复只重现当前有效预测，不借恢复刷新复活已过期目标', () => {
  const ready = forecast({ id: 'recovered', mode: 'replay', shift: .1 });
  const expired = { ...forecast({ id: 'expired-other' }), valid_until: origin - 1 };
  const records = [ready, expired], original = JSON.stringify(records);
  assert.deepEqual(currentPredictionViews(records, origin, true), []);
  assert.deepEqual(predictionWarningRows(records, origin, true), []);
  assert.deepEqual(currentPredictionViews(records, origin).map(row => row.target_id), ['recovered']);
  assert.deepEqual(predictionWarningRows(records, origin).map(row => row.targetId), ['recovered']);
  const unknown = { ...ready, status: 'UNKNOWN' };
  assert.deepEqual(currentPredictionViews([unknown], origin), []);
  assert.equal(currentPredictionViews([ready], origin).length, 1);
  assert.equal(JSON.stringify(records), original);
});

test('多区预警逐项保留，撤销和实测入区退出当前预测列表且终态不被过期改写', () => {
  const raw = forecast();
  raw.warnings.push({ ...raw.warnings[0], event_id: 'event-other', airspace_version_id: 'another-version' });
  assert.equal(predictionWarningRows([raw], origin).length, 2);
  for (const state of ['WITHDRAWN', 'ENTERED']) {
    raw.warnings.forEach(warning => { warning.state = state; });
    assert.equal(predictionWarningRows([raw], origin).length, 0);
    assert.equal(alarmPredictionState({ origin_kind: PREDICTION_ORIGIN, prediction: { ...raw, warning: raw.warnings[0] } }, origin + 100000), state);
  }
});

test('空值、越界与不完整三点不补造线，入区点不借最新目标坐标', () => {
  for (const location of [null, { longitude: null, latitude: 37 }, { longitude: '', latitude: 37 }, { longitude: 181, latitude: 37 }]) assert.equal(predictionLocation(location), null);
  assert.deepEqual(predictionLocation({ longitude: 0, latitude: 0 }), { lon: 0, lat: 0 });
  const raw = forecast(); raw.points.splice(1, 1); raw.warnings[0].entry_location = null;
  const map = predictionMapData([raw], origin, raw.target_id)[0];
  assert.deepEqual(map.points, []); assert.deepEqual(map.warnings, []);
  assert.equal(predictionWarningRows([raw], origin).length, 1);
});

test('未来线不在未知预测上绘制，已过预计入区时间的标记不冒充未来位置', () => {
  const raw = forecast(); raw.status = 'UNKNOWN';
  assert.deepEqual(predictionMapData([raw], origin, raw.target_id)[0].points, []);
  assert.deepEqual(predictionWarningRows([raw], origin), []);
  raw.status = 'READY'; raw.warnings[0].entry_at = origin - 1;
  assert.deepEqual(predictionMapData([raw], origin, raw.target_id)[0].warnings, []);
  assert.equal(predictionWarningRows([raw], origin).length, 1);
});

test('冻结与当前依据分开表述，模拟、海拔/离地、误差说明和服务端文字安全展示', () => {
  const raw = forecast({ mode: 'replay' });
  raw.warnings[0].airspace_name = '<img src=x onerror=alert(1)>';
  raw.points[1].altitude_datum = 'AGL'; raw.evidence_notes = ['ACCURACY_DEFAULTED'];
  raw.uncertainty_note = '估计不确定范围，不代表准确率';
  const html = predictionDetailsHtml(raw, { now: origin });
  assert.match(html, /模拟／回放/); assert.match(html, /海拔/); assert.match(html, /离地/);
  assert.match(html, /默认范围/); assert.match(html, /不代表准确率/);
  assert.equal(html.includes('<img'), false); assert.match(html, /&lt;img/);
  const frozen = predictionDetailsHtml(raw, { now: origin + 100000, frozen: true });
  assert.match(frozen, /预警创建时的预测快照/); assert.doesNotMatch(frozen, /这不代表风险已解除/);
});

test('地图预测独立层：关闭不绘制；打开只画选择目标，近距预警聚合不改坐标', () => {
  const context = { window: {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
  vm.runInNewContext(readFileSync(new URL('../public/assets/js/map.js', import.meta.url), 'utf8'), context);
  const first = forecast(), second = forecast({ id: 'another', shift: .00001 });
  const raw = predictionMapData([first, second], origin, null), original = JSON.stringify(raw);
  const operations = [], canvas = new Proxy({}, { get: (_, name) => (...args) => operations.push([name, ...args]), set: () => true });
  const map = { opt: { fusionProfile: true }, layers: { prediction: false }, data: { predictions: raw } };
  let picks = [];
  const render = context.window.MapView.prototype._drawPredictions;
  render.call(map, canvas, (lon, lat) => [lon * 100, lat * 100], picks);
  assert.equal(operations.length, 0);
  map.layers.prediction = true;
  render.call(map, canvas, (lon, lat) => [lon * 100, lat * 100], picks);
  assert.equal(picks.length, 1); assert.equal(picks[0].data.rows.length, 2);
  assert.equal(JSON.stringify(raw), original);
  assert.equal(operations.filter(([name, text]) => name === 'fillText' && String(text).startsWith('预测 +')).length, 0);
  map.data.predictions = predictionMapData([first], origin, first.target_id); picks = []; operations.length = 0;
  render.call(map, canvas, (lon, lat) => [lon * 10000, lat * 10000], picks);
  assert.deepEqual(operations.filter(([name, text]) => name === 'fillText' && String(text).startsWith('预测 +')).map(row => row[1]), ['预测 +10秒', '预测 +20秒', '预测 +30秒']);
});


test('候选接近只在有效选中详情提示，正式预警同区去重；未知不展示旧接近', () => {
  for (const id of ['near-alpha', 'near-zeta']) {
    const raw = forecast({ id }); raw.warnings[0].airspace_id = `${id}-formal`;
    raw.proximity = [
      { airspace_id: `${id}-formal`, airspace_name: '已有正式预警', state: 'CONFIRMING' },
      { airspace_id: `${id}-candidate`, airspace_name: '<候选禁飞区>', state: 'CONFIRMING', reason_codes: ['PREDICTED_ENTRY_CONFIRMED'], airspace_version_ids: ['future-v1'] },
      { airspace_id: `${id}-possible`, airspace_name: '高度待确认区域', state: 'POSSIBLE', reason_codes: ['ALTITUDE_RELATION_UNKNOWN'] }
    ];
    assert.equal(predictionProximityRows(raw, origin).length, 2);
    const html = predictionDetailsHtml(raw, { now: origin, showProximity: true });
    assert.match(html, /稳定性确认中/); assert.match(html, /可能接近，暂不能确认/);
    assert.match(html, /&lt;候选禁飞区&gt;/); assert.match(html, /高度与空域的关系暂不明确/);
    assert.doesNotMatch(html, /已有正式预警/);
    assert.doesNotMatch(predictionDetailsHtml(raw, { now: origin }), /稳定性确认中|可能接近，暂不能确认/);
    assert.equal(predictionWarningRows([raw], origin).length, 1);
    for (const [at, unavailable] of [[origin + 8000, false], [origin, true]]) assert.deepEqual(predictionProximityRows(raw, at, unavailable), []);
    raw.status = 'UNKNOWN'; assert.deepEqual(predictionProximityRows(raw, origin), []);
  }
});

test('空域多版本与预警状态版本保留，实测先到及复合未知原因可读', () => {
  const raw = forecast(); Object.assign(raw.warnings[0], { airspace_version_ids: ['first-version', 'next-version'], version: 9, reason: 'ACTUAL_ENTRY_BEFORE_WARNING' });
  const html = predictionDetailsHtml(raw, { now: origin });
  assert.match(html, /first-version、next-version/); assert.match(html, /预警状态版本 9/);
  assert.match(html, /稳定预警形成前已实测入区/);
  assert.equal(predictionReasonText('ALTITUDE_RELATION_UNKNOWN,UNCERTAINTY_OR_BOUNDARY_CONTACT'), '预测高度与空域的关系暂不明确；位置误差范围或边界接触尚不能确认入区');
});


test('撤销和实测入区的历史预测过期或读取失败不再提示待确认，首次快照保持冻结口径', () => {
  for (const [state, expected] of [
    ['WITHDRAWN', '已撤销的预测预警保留为历史记录'],
    ['ENTERED', '已确认实测入区，后续查看实际入区处置进度']
  ]) {
    const raw = forecast({ id: `terminal-${state}`, mode: state === 'ENTERED' ? 'replay' : 'live' });
    raw.warnings[0].state = state;
    for (const options of [{ now: origin + 8000 }, { now: origin, unavailable: true }]) {
      const html = predictionDetailsHtml(raw, options);
      assert.match(html, /历史预测依据/);
      assert.ok(html.includes(expected));
      assert.match(html, /未来线已隐藏/);
      assert.doesNotMatch(html, /预警保留待确认|这不代表风险已解除|预测暂不可判断/);
    }
    const frozen = predictionDetailsHtml(raw, { now: origin + 8000, frozen: true });
    assert.match(frozen, /预警创建时的预测快照/);
    assert.doesNotMatch(frozen, /未来线已隐藏|历史预测依据|预警保留待确认/);
  }
});

test('同目标多区包含终态与未结束预警时只把未结束事项列为待确认', () => {
  const raw = forecast({ id: 'mixed-zones', shift: .3 });
  raw.warnings.push(
    { ...raw.warnings[0], event_id: 'withdrawn-zone-event', state: 'WITHDRAWN' },
    { ...raw.warnings[0], event_id: 'entered-zone-event', state: 'ENTERED' }
  );
  const html = predictionDetailsHtml(raw, { now: origin + 8000 });
  assert.match(html, /预测暂不可判断/);
  assert.match(html, /尚未结束的预警保留待确认；这不代表风险已解除/);
  assert.match(html, /已撤销的预测预警保留为历史记录/);
  assert.match(html, /已确认实测入区，后续查看实际入区处置进度/);
  assert.doesNotMatch(html, /现有预警保留待确认|历史预测依据/);
  raw.warnings = [];
  const empty = predictionDetailsHtml(raw, { now: origin + 8000 });
  assert.match(empty, /是否存在入区风险仍需有效依据确认/);
  assert.doesNotMatch(empty, /预警保留待确认|历史预测依据/);
});


test('依据说明显示已知语义和配置版本，未知说明去重且安全转义', () => {
  const notes = ['FUSION_TRACK_CONFIG:track-v2', 'FUSION_CURRENT_CONFIG:<current-v3>', 'ACCURACY_DEFAULTED',
    'ALTITUDE_ERROR_IS_MODEL_ASSUMPTION', 'ERROR_BOUNDS_ARE_MODEL_ESTIMATES', 'SIMULATOR_DEFAULT_CONFIGURATION_NOT_HISTORICALLY_FROZEN',
    'FUTURE_NOTE_A', 'FUTURE_NOTE_B', 'ALTITUDE_ERROR_IS_MODEL_ASSUMPTION'];
  const text = predictionEvidenceNotesText(notes);
  assert.match(text, /实测轨迹融合配置版本：track-v2/);
  assert.match(text, /当前目标融合配置版本：<current-v3>/);
  assert.match(text, /高度误差采用模型假设值/);
  assert.match(text, /误差范围为模型估计，不代表准确率/);
  assert.match(text, /模拟器默认配置未在历史观测中冻结/);
  assert.equal(text.match(/其他预测依据说明已更新/g).length, 1);
  assert.equal(text.match(/高度误差采用模型假设值/g).length, 1);
  const html = predictionDetailsHtml({ ...forecast(), evidence_notes: notes }, { now: origin });
  assert.match(html, /&lt;current-v3&gt;/);
  assert.doesNotMatch(html, /<current-v3>/);
  assert.equal(predictionReasonText('ENTRY_AWAITING_CONFIRMATION'), '预测将进入禁飞区，等待连续新实测确认');
});

test('统一风险的入区预测历史保留失效事实并在同条记录继续办理', () => {
  for (const mode of ['live', 'replay']) for (const stage of ['ENTERED', 'UNKNOWN']) {
    const raw = forecast({ id: `same-case-${mode}-${stage}`, mode });
    raw.warnings[0].state = 'ENTERED';
    const riskCase = { risk_case_id: `case-${mode}-${stage}`, stage };
    for (const options of [{ now: origin + 8000 }, { now: origin, unavailable: true }]) {
      const html = predictionDetailsHtml(raw, { ...options, riskCase });
      assert.match(html, /预测已转为实测入区/);
      assert.match(html, /同一风险记录中办理/);
      assert.match(html, /当前状态以风险阶段为准/);
      assert.match(html, /未来线已隐藏/);
      assert.match(html, options.unavailable ? /预测读取失败/ : /预测依据不足或已经过期/);
      assert.doesNotMatch(html, /后续查看实际入区处置进度|请查看实际入区告警/);
    }
    const frozen = predictionDetailsHtml(raw, { now: origin + 8000, frozen: true, riskCase });
    assert.match(frozen, /预警创建时的预测快照/);
    assert.doesNotMatch(frozen, /未来线已隐藏/);
  }
});

test('预计入区倒计时只取当前有效预测里尚未到达的入区时间', () => {
  const base = { status: 'READY', based_on_observed_at: origin - 500, valid_until: origin + 8000 };
  const warn = (state, at) => ({ state, entry_at: at, airspace_name: '禁飞区' });
  assert.equal(predictionEntrySeconds({ ...base, warnings: [warn('ACTIVE', origin + 19200), warn('ACTIVE', origin + 25000)] }, origin), 20);
  assert.equal(predictionEntrySeconds({ ...base, warnings: [warn('ENTERED', origin + 5000)] }, origin), null);
  assert.equal(predictionEntrySeconds({ ...base, warnings: [warn('ACTIVE', origin - 1000)] }, origin), null);
  assert.equal(predictionEntrySeconds({ ...base, warnings: [warn('ACTIVE', origin + 5000)] }, origin, true), null, '读取失败不显示倒计时');
  assert.equal(predictionEntrySeconds({ ...base, valid_until: origin - 1, warnings: [warn('ACTIVE', origin + 5000)] }, origin), null, '过期预测不显示');
});
