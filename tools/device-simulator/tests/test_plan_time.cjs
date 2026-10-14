const assert = require('node:assert/strict');
const test = require('node:test');
const PlanTime = require('../web/plan-time.js');

// 北京时间 2026-10-13 的 hh:mm（比 UTC 早 8 小时）；中午 12:30 与服务端 test_start_check.py 里的 NOW 一致。
const at = (hour, minute, second = 0) => Date.UTC(2026, 9, 13, hour - 8, minute, second);
const NOON = at(12, 30);

test('a new task starts now and lasts one hour, on the Beijing clock whatever the machine time zone is', () => {
  assert.deepEqual(PlanTime.nowWindow(at(21, 5)), {start: '21:05', end: '22:05'});
  assert.deepEqual(PlanTime.nowWindow(at(9, 0)), {start: '09:00', end: '10:00'});
  assert.deepEqual(PlanTime.nowWindow(at(12, 30, 59)), {start: '12:30', end: '13:30'}, 'seconds are dropped, not rounded up');
});

test('a task started late in the evening ends the next morning instead of being cut at midnight', () => {
  assert.deepEqual(PlanTime.nowWindow(at(23, 30)), {start: '23:30', end: '00:30'});
  assert.deepEqual(PlanTime.nowWindow(at(0, 0)), {start: '00:00', end: '01:00'});
  assert.deepEqual(PlanTime.nowWindow(at(23, 59)), {start: '23:59', end: '00:59'});
});

test('the window check ends exclusive and understands overnight windows', () => {
  assert.equal(PlanTime.windowContains('09:00', '09:30', NOON), false);
  assert.equal(PlanTime.windowContains('12:00', '13:00', NOON), true);
  assert.equal(PlanTime.windowContains('12:00', '12:30', NOON), false, 'the end minute is not inside');
  assert.equal(PlanTime.windowContains('12:30', '13:00', NOON), true, 'the start minute is inside');
  assert.equal(PlanTime.windowContains('22:00', '14:00', NOON), true);
  assert.equal(PlanTime.windowContains('22:00', '02:00', NOON), false);
  assert.equal(PlanTime.windowContains('22:00', '02:00', at(1, 0)), true, 'still inside the tail of last night\'s window');
  assert.equal(PlanTime.windowContains('22:00', '02:00', at(23, 0)), true);
});

test('windows that cannot be judged give no answer instead of a wrong one', () => {
  assert.equal(PlanTime.windowContains('12:00', '12:00', NOON), null);
  assert.equal(PlanTime.windowContains('9点', '10点', NOON), null);
  assert.equal(PlanTime.windowContains('09:00', '', NOON), null);
  assert.equal(PlanTime.windowContains(undefined, undefined, NOON), null);
  assert.equal(PlanTime.windowContains('24:00', '25:00', NOON), null);
  assert.equal(PlanTime.windowContains('12:60', '13:00', NOON), null);
  assert.equal(PlanTime.windowText('9点', '10点', NOON), '');
  assert.equal(PlanTime.windowText('09:00', '09:00', NOON), '');
});

test('the window is described with the day and says the clock is Beijing time, same words as the server check', () => {
  assert.equal(PlanTime.windowText('09:00', '09:30', NOON), '今天 09:00–09:30（北京时间）');
  assert.equal(PlanTime.windowText('22:00', '02:00', NOON), '今天 22:00 到 明天 02:00（北京时间）');
  assert.equal(PlanTime.windowText('22:00', '02:00', at(1, 0)), '昨天 22:00 到 今天 02:00（北京时间）');
});

const scene = (plan = {}, extra = {}) => ({
  plans: [{id: 'p1', name: '巡检任务 01', start: '09:00', end: '09:30', ...plan}],
  targets: [{id: 't1', planId: 'p1'}],
  risks: [],
  ...extra,
});

test('a task in use whose window misses now is reported with its window', () => {
  assert.deepEqual(PlanTime.outsidePlans(scene(), NOON), [{id: 'p1', name: '巡检任务 01', window: '今天 09:00–09:30（北京时间）'}]);
});

test('windows that contain now, overnight ones included, are not reported', () => {
  assert.deepEqual(PlanTime.outsidePlans(scene({start: '12:00', end: '13:00'}), NOON), []);
  assert.deepEqual(PlanTime.outsidePlans(scene({start: '22:00', end: '14:00'}), NOON), []);
  assert.deepEqual(PlanTime.outsidePlans(scene({start: '22:00', end: '02:00'}), at(1, 0)), []);
  assert.equal(PlanTime.outsidePlans(scene({start: '22:00', end: '02:00'}), NOON).length, 1);
});

test('unused tasks, past tasks, deliberately late targets and unreadable times are left alone', () => {
  assert.deepEqual(PlanTime.outsidePlans(scene({}, {targets: [{id: 't1', planId: ''}]}), NOON), []);
  assert.deepEqual(PlanTime.outsidePlans(scene({timeMode: 'past'}), NOON), []);
  const late = scene({}, {risks: [{id: 'r9', type: 'time', enabled: true, targetId: 't1', planId: 'p1'}]});
  assert.deepEqual(PlanTime.outsidePlans(late, NOON), []);
  const unticked = scene({}, {risks: [{id: 'r9', type: 'time', enabled: false, targetId: 't1', planId: 'p1'}]});
  assert.equal(PlanTime.outsidePlans(unticked, NOON).length, 1, 'a late-time condition that is not ticked does not excuse the task');
  assert.deepEqual(PlanTime.outsidePlans(scene({start: '9点', end: '10点'}), NOON), []);
  assert.deepEqual(PlanTime.outsidePlans({}, NOON), []);
  assert.deepEqual(PlanTime.outsidePlans(null, NOON), []);
});

test('a task that only a ticked non-time condition uses still counts as in use', () => {
  const byRisk = scene({}, {targets: [], risks: [{id: 'r1', type: 'deviation', enabled: true, planId: 'p1'}]});
  assert.deepEqual(PlanTime.usedPlanIds(byRisk), new Set(['p1']));
  assert.equal(PlanTime.outsidePlans(byRisk, NOON).length, 1);
});
