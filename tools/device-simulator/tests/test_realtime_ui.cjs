const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../web/realtime.js');
const fs = require('node:fs');
const vm = require('node:vm');
test('expired or absent receiver lease is not online', () => {
  assert.equal(ui.notificationOnline({lease_expires_at: 100}, 101), false);
  assert.equal(ui.notificationOnline({lease_expires_at: 110}, 101), true);
  assert.equal(ui.notificationOnline({}, 101), false);
});
test('configuration locks for active scene or active receiver', () => {
  assert.equal(ui.editLocked({phase:'PAUSED',realtime:{state:'STOPPED'}}), true);
  assert.equal(ui.editLocked({phase:'STOPPED',realtime:{state:'RUNNING'}}), true);
  assert.equal(ui.editLocked({phase:'STOPPED',realtime:{state:'STOPPED'}}), false);
});

test('all run modes have distinct labels and preserve existing choices', () => {
  assert.deepEqual(ui.modeNames,{normal:'正常模式',abnormal:'异常模式',mixed:'混合模式'});
});

test('delayed and mixed receipts are available for all six channels', () => {
  for(const kind of ['ADVISORY_SMS','ADVISORY_VOICE','RISK_NOTICE','UAV_PUNISHMENT','PLAN_FEEDBACK','DEVICE_MAINTENANCE']) {
    const choices=ui.outcomeChoices(kind);
    for(const mode of ['success','failed','timeout','no_receipt','delayed','mixed']) assert.ok(choices[mode],`${kind}: ${mode}`);
    assert.equal('no_answer' in choices,kind==='ADVISORY_VOICE');
    assert.equal('answered_only' in choices,kind==='ADVISORY_VOICE');
  }
});

test('punishment recipient summary counts every enabled recipient like the platform does', () => {
  assert.match(ui.punishmentSummary({enabled_recipients:[]}), /没有启用的处罚接收单位/);
  assert.match(ui.punishmentSummary({enabled_recipients:[{name:'市公安局',simulator:true}]}), /共 1 个，反制完成后自动移送。$/);
  const two = ui.punishmentSummary({enabled_recipients:[{name:'市公安局',simulator:true},{name:'旧接收方',simulator:false}]});
  assert.match(two, /共 2 个，反制完成后要人选再移送/);
  assert.match(two, /其中旧接收方不是在这里配的/);
  assert.equal(ui.sameChoice(['a','b'],['b','a']), true);
  assert.equal(ui.sameChoice(['a'],['a','b']), false);
  assert.equal(ui.sameChoice([],[]), true);
});

test('countermeasure position is shown only while the device listens and says how to set a missing one', () => {
  assert.equal(ui.countermeasurePositionText({countermeasure:{listening:false},countermeasure_position:{longitude:118.6,latitude:37.46}}), '');
  assert.equal(ui.countermeasurePositionText({countermeasure:{listening:true},countermeasure_position:{longitude:118.6104,latitude:37.464}}), '位置 118.61040, 37.46400');
  assert.match(ui.countermeasurePositionText({countermeasure:{listening:true},countermeasure_position:null}), /位置未设置.*收发模式设置.*经纬度/);
  assert.equal(ui.positionValue(''), null);
  assert.equal(ui.positionValue('  '), null);
  assert.equal(ui.positionValue('118.61'), 118.61);
});

test('isolated QA visibly disables transports without disabling scene controls', () => {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {disabled:false,textContent:'',addEventListener(){},before(){},setAttribute(){}});
    return nodes.get(selector);
  };
  const context = {document:{createElement:()=>node('bar'),querySelector:node}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../web/realtime.js'),'utf8'),context);
  context.RealtimeUI.update({scene_mode:'isolated_qa',phase:'IDLE',realtime:null});
  assert.match(node('#realtime-summary').textContent,/隔离.*场景/);
  assert.match(node('#realtime-detail').textContent,/通知.*反制/);
  for(const id of ['realtime-settings','realtime-start','realtime-stop']) assert.equal(node('#'+id).disabled,true);
  assert.equal(node('[data-action=integration]').disabled,false);
  assert.equal(node('#duration').disabled,false);
  context.RealtimeUI.update({scene_mode:'isolated_qa',phase:'RUNNING',realtime:null});
  assert.equal(node('[data-action=integration]').disabled,true);
  assert.equal(node('#duration').disabled,true);
  context.RealtimeUI.update({scene_mode:'isolated_qa',phase:'STOPPED',realtime:null});
  assert.equal(node('[data-action=integration]').disabled,false);
});
