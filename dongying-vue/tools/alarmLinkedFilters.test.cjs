const { riskCaseKey } = require('./riskCaseTestHelpers.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

const source = readFileSync(path.join(__dirname, '../src/pages/AlarmsPage.vue'), 'utf8').replace(/\r\n/g, '\n');
function body(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
}

test('linked alarms remain searchable after a recent or custom time filter', async () => {
  const { timeFilterWindow } = await import('../src/services/timeFilter.js');
  for (const time of ['TODAY', 'LAST_7D', 'CUSTOM']) {
    const now = Date.now();
    const st = { page: 5, size: 20, sort: 'priority', level: 'HIGH', status: '全部',
      targetNo: randomUUID(), kind: 'NO_AUTHORIZATION', region: randomUUID(), time, timeRange: [now - 3600000, now] };
    const targetNoInput = { value: st.targetNo };
    const controls = ['level', 'time', 'region'].map(key => ({ dataset: { f: key }, value: st[key] }));
    const root = { value: { querySelectorAll: () => controls } };
    const bindings = new Function('st', 'root', 'STATUS_FILTER', 'VIOLATION_REASON_CODES', 'timeFilterWindow', 'targetNoInput', 'PREDICTION_ORIGIN',
      `${body('resetLinkedAlarmFilters')}\n${body('queryOf')}\nreturn { resetLinkedAlarmFilters, queryOf };`)
      (st, root, {}, ['NO_AUTHORIZATION'], timeFilterWindow, targetNoInput, 'PREDICTED_AIRSPACE_ENTRY');
    assert.ok(bindings.queryOf().occurred_from, `${time} is active before the linked navigation`);
    bindings.resetLinkedAlarmFilters();
    assert.deepEqual(bindings.queryOf(), { view: 'risk_case', page: 1, size: 20, sort: 'priority' });
    assert.equal(st.timeRange, null);
    assert.equal(targetNoInput.value, '');
    assert.equal(controls.find(control => control.dataset.f === 'time').value, '');
  }
});

test('target search resets pagination and clears stale details before selecting a matching result', async () => {
  for (const matching of [[], [{ alarm_id: randomUUID() }]]) {
    const st = { page: 8, selId: randomUUID(), targetNo: '' }, targetNoInput = { value: '  new-number  ' };
    const list = { rows: matching }, selected = [];
    const run = new Function('riskCaseKey', 'st', 'targetNoInput', 'list', 'loadList', 'selectAlarm', `
      let detailSeq=0, disposalSeq=0, cur={ alarm: { alarm_id: st.selId } };
      const emptyDetail=()=>({alarm:null}), paintDetail=()=>{}, focusMap=()=>{};
      async ${body('applyTargetNo')}
      return { applyTargetNo, detail:()=>cur.alarm };`)(riskCaseKey, st, targetNoInput, list,
      async () => { assert.equal(st.selId, null); return true; }, id => selected.push(id));
    await run.applyTargetNo();
    assert.equal(st.page, 1);
    assert.equal(st.targetNo, 'new-number');
    assert.equal(targetNoInput.value, 'new-number');
    assert.equal(run.detail(), null);
    assert.deepEqual(selected, matching.map(row => row.alarm_id));
  }
});


test('预测类别与状态下发服务端且与既有条件相交；深链重置两项预测筛选', async () => {
  const { timeFilterWindow } = await import('../src/services/timeFilter.js');
  const st = { page: 4, size: 20, sort: 'priority', level: 'HIGH', status: '全部', kind: '全部', region: '全部',
    time: '', targetNo: 'UAV-X', originKind: 'PREDICTED_AIRSPACE_ENTRY', predictionStatus: 'UNKNOWN' };
  const targetNoInput = { value: st.targetNo }, root = { value: { querySelectorAll: () => [] } };
  const bindings = new Function('st', 'root', 'STATUS_FILTER', 'VIOLATION_REASON_CODES', 'timeFilterWindow', 'targetNoInput', 'PREDICTION_ORIGIN',
    `${body('resetLinkedAlarmFilters')}
${body('queryOf')}
return { resetLinkedAlarmFilters, queryOf };`)
    (st, root, {}, [], timeFilterWindow, targetNoInput, 'PREDICTED_AIRSPACE_ENTRY');
  assert.deepEqual(bindings.queryOf(), { view: 'risk_case', page: 4, size: 20, sort: 'priority', severity: 'HIGH', target_no: 'UAV-X', origin_kind: 'PREDICTED_AIRSPACE_ENTRY', prediction_status: 'UNKNOWN' });
  bindings.resetLinkedAlarmFilters();
  assert.equal(st.originKind, ''); assert.equal(st.predictionStatus, '');
  assert.deepEqual(bindings.queryOf(), { view: 'risk_case', page: 1, size: 20, sort: 'priority' });
});


test('待核实和待处置筛选下发当前待办参数，历史筛选及深链保留原条件', async () => {
  const { timeFilterWindow } = await import('../src/services/timeFilter.js');
  const constants = source.match(/^const PENDING_DISPOSAL_QUERY = .*;$/m)[0] + '\n'
    + source.match(/^const STATUS_FILTER = \{[\s\S]*?^\};/m)[0];
  const filters = new Function(`${constants} return STATUS_FILTER;`)();
  for (const status of ['PENDING_VERIFICATION', 'PENDING_DISPOSAL', 'DISPOSAL_ENDED', 'FALSE_POSITIVE', '全部']) {
    const st = { page: 1, size: 20, sort: 'priority', level: '全部', status, kind: '全部', region: '全部', time: '', targetNo: '' };
    const bindings = new Function('st', 'root', 'STATUS_FILTER', 'VIOLATION_REASON_CODES', 'timeFilterWindow', 'targetNoInput', 'PREDICTION_ORIGIN',
      `${body('resetLinkedAlarmFilters')}\n${body('queryOf')}\nreturn { resetLinkedAlarmFilters, queryOf };`)
      (st, { value: { querySelectorAll: () => [] } }, filters, [], timeFilterWindow, { value: '' }, 'PREDICTED_AIRSPACE_ENTRY');
    const query = bindings.queryOf();
    assert.equal(query.current_pending === true, ['PENDING_VERIFICATION', 'PENDING_DISPOSAL'].includes(status), status);
    if (status === 'PENDING_DISPOSAL') assert.equal(query.attention_group, 'CURRENT,AWAITING_CONFIRMATION');
    if (status === 'DISPOSAL_ENDED') assert.equal(query.attention_group, 'HISTORY');
    bindings.resetLinkedAlarmFilters();
    assert.equal(bindings.queryOf().current_pending, undefined, '历史告警深链不可因待办筛选消失');
  }
});
