const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const FlowPicker = require('../web/flow-picker.js');

const group = (enabled, total, ok = true) => ok ? {ok: true, enabled, total, engine: 'ON', engine_message: ''} : {ok: false, reason: 'FORBIDDEN'};

test('the rule line distinguishes enabled rules from their checked automatic action', () => {
  const line = FlowPicker.rulesLine({verify: group(2, 3), counter: group(1, 2)});
  assert.match(line, /^规则管理里现在：/);
  assert.match(line, /核实规则启用 2\/3 条，全部满足后自动核实/);
  assert.match(line, /反制规则启用 1\/2 条，全部满足且证据、设备等校验通过后自动发起；不满足时由有权限的人发起/);
});

test('no enabled counter rules requires a permitted human action', () => {
  const line = FlowPicker.rulesLine({counter: group(0, 2)});
  assert.match(line, /反制规则一条都没启用，由有权限的人发起反制/);
  assert.doesNotMatch(line, /自动发起/);
});

test('with every verify rule off the line says alarms will stay waiting to be verified', () => {
  assert.match(FlowPicker.rulesLine({verify: group(0, 3), counter: group(1, 2)}), /核实规则一条都没启用，不会自动核实，告警会一直停在“待核实”/);
});

test('a group the account cannot read is left out, and when nothing is readable there is no line at all', () => {
  const onlyCounter = FlowPicker.rulesLine({verify: group(0, 0, false), counter: group(1, 2)});
  assert.doesNotMatch(onlyCounter, /核实规则/);
  assert.match(onlyCounter, /反制规则启用 1\/2 条/);
  assert.equal(FlowPicker.rulesLine({verify: group(0, 0, false), counter: group(0, 0, false)}), '');
  assert.equal(FlowPicker.rulesLine({}), '');
  assert.equal(FlowPicker.rulesLine(null), '');
});

test('a flow that needs auto verify off is flagged when it is on, and the other way round', () => {
  const needsOff = {flow: 4, guide: {auto_verify: false}}, needsOn = {flow: 1, guide: {auto_verify: true}};
  assert.match(FlowPicker.ruleConflict(needsOff, {verify: group(2, 3)}), /自动核实现在是开着的（还有 2 条核实规则启用）。请先到规则管理关掉/);
  assert.equal(FlowPicker.ruleConflict(needsOff, {verify: group(0, 3)}), '');
  assert.match(FlowPicker.ruleConflict(needsOn, {verify: group(0, 3)}), /自动核实现在是关着的，告警不会自动核实。请先到规则管理打开/);
  assert.equal(FlowPicker.ruleConflict(needsOn, {verify: group(1, 3)}), '');
});

test('no complaint about rules the simulator could not read or a flow that does not care', () => {
  assert.equal(FlowPicker.ruleConflict({flow: 4, guide: {auto_verify: false}}, {verify: group(0, 0, false)}), '');
  assert.equal(FlowPicker.ruleConflict({flow: 4, guide: {auto_verify: false}}, null), '');
  assert.equal(FlowPicker.ruleConflict({flow: 5, guide: {}}, {verify: group(2, 3)}), '');
  assert.equal(FlowPicker.ruleConflict({flow: 5}, {verify: group(2, 3)}), '');
});

const loaded = {flow: 4, baseBatch: 'b0', startedBatch: null, ended: false, reminder: false};

test('a loaded flow starts when a new batch appears and ends when it stops, completes or fails', () => {
  assert.deepEqual(FlowPicker.advance(null, {batch: 'b1', phase: 'RUNNING'}), {current: null, event: null});
  assert.equal(FlowPicker.advance(loaded, {batch: 'b0', phase: 'RUNNING'}).event, null, 'the batch that was already there is not this flow');
  assert.equal(FlowPicker.advance(loaded, {batch: undefined, phase: 'IDLE'}).event, null);
  const started = FlowPicker.advance(loaded, {batch: 'b1', phase: 'PREPARING'});
  assert.equal(started.event, 'started');
  assert.equal(started.current.startedBatch, 'b1');
  assert.equal(FlowPicker.advance(started.current, {batch: 'b1', phase: 'RUNNING'}).event, null);
  assert.equal(FlowPicker.advance(started.current, {batch: 'b1', phase: 'PAUSED'}).event, null, 'paused is not the end');
  for (const phase of ['STOPPED', 'COMPLETED', 'FAILED']) {
    const ended = FlowPicker.advance(started.current, {batch: 'b1', phase});
    assert.equal(ended.event, 'ended', phase);
    assert.equal(ended.current.ended, true);
  }
});

test('the flow also ends when another run takes its place, and an ended flow stays ended', () => {
  const started = FlowPicker.advance(loaded, {batch: 'b1', phase: 'RUNNING'}).current;
  const replaced = FlowPicker.advance(started, {batch: 'b2', phase: 'RUNNING'});
  assert.equal(replaced.event, 'ended');
  assert.equal(FlowPicker.advance(replaced.current, {batch: 'b2', phase: 'STOPPED'}).event, null);
  assert.equal(FlowPicker.advance(replaced.current, {batch: 'b3', phase: 'RUNNING'}).event, null);
});

test('a run that is already over by the time the page notices still counts as started and ended', () => {
  const quick = FlowPicker.advance(loaded, {batch: 'b1', phase: 'COMPLETED'});
  assert.equal(quick.event, 'ended');
  assert.equal(quick.current.startedBatch, 'b1');
  assert.equal(quick.current.ended, true);
});

test('a flow loaded before any run existed starts with the first batch there is', () => {
  const fresh = FlowPicker.advance({...loaded, baseBatch: null}, {batch: 'b1', phase: 'RUNNING'});
  assert.equal(fresh.event, 'started');
});

test('advancing never changes the object it was given', () => {
  const before = JSON.stringify(loaded);
  FlowPicker.advance(loaded, {batch: 'b1', phase: 'RUNNING'});
  assert.equal(JSON.stringify(loaded), before);
});

test('the chip beside the flow name says where the flow is', () => {
  assert.equal(FlowPicker.statusText({...loaded}, 'IDLE'), '已载入，还没开始');
  assert.equal(FlowPicker.statusText({...loaded, startedBatch: 'b1'}, 'PREPARING'), '正在准备资料');
  assert.equal(FlowPicker.statusText({...loaded, startedBatch: 'b1'}, 'RUNNING'), '运行中');
  assert.equal(FlowPicker.statusText({...loaded, startedBatch: 'b1'}, 'PAUSED'), '已暂停');
  assert.equal(FlowPicker.statusText({...loaded, startedBatch: 'b1'}, 'STOPPING'), '正在停止');
  assert.equal(FlowPicker.statusText({...loaded, startedBatch: 'b1'}, 'SOMETHING'), '运行中');
  assert.equal(FlowPicker.statusText({...loaded, startedBatch: 'b1', ended: true}, 'STOPPED'), '已结束');
});

test('the page puts the picker, the banner and the check where the scripts expect them', () => {
  const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  const order = name => { const at = html.indexOf(`<script src="${name}`); assert.ok(at > 0, `${name} is loaded`); return at; };
  assert.ok(order('plan-time.js') < order('app.js'), 'app.js reads PlanTime while it loads');
  assert.ok(order('runtime.js') < order('start-check.js') && order('realtime.js') < order('start-check.js'));
  assert.ok(order('start-check.js') < order('flow-picker.js') && order('app.js') < order('flow-picker.js'), 'the picker uses the globals app.js declares');
  assert.match(html, /<link rel="stylesheet" href="flow-picker\.css/);
  assert.match(html, /<div id="flow-banner" class="flow-banner"[^>]* hidden><\/div>/);
  assert.ok(html.indexOf('id="flow-banner"') < html.indexOf('<main>'), 'the banner sits above the map, not inside a panel');
});
