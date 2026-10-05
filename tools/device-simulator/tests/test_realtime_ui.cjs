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
