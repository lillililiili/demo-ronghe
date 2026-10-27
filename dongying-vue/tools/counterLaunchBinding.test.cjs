const riskHelpers = require('./riskCaseTestHelpers.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vue = require('vue');

const source = readFileSync(path.join(__dirname, '../src/pages/alarms/CounterLaunch.vue'), 'utf8')
  .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?\n/gm, '');
function fixture(direct = false, overrides = {}) {
  const eventId = randomUUID();
  const summary = { event_id: eventId, counter_launch_visible: true,
    can_request_counter: !direct, can_direct_counter: direct };
  const props = vue.reactive({ eventId, eventLabel: 'test-' + randomUUID(), active: true,
    confirmed: true, showLaunch: true, counterStopped: false, summary });
  const state = { token: randomUUID(), form: null, reads: [], unmounts: [], events: [], notices: [], calls: [], feedback: [] };
  const deps = { ...riskHelpers, ...vue, defineProps: () => props, defineEmits: () => (...args) => state.events.push(args),
    onUnmounted: cb => state.unmounts.push(cb), openModal: value => { state.feedback.push(value); return { close() {} }; }, window: { UI: {} },
    readSessionToken: () => state.token, hasPermission: () => true,
    counterLaunchLabel: () => '', counterPermissionHint: () => '', noCounterEntryVisible: () => true,
    uavAdvisoryApi: { get: async id => { state.reads.push(id); return { ...props.summary }; } },
    disposalApi: { policies: async () => ({}) }, getUavEvent: async () => ({ target_id: randomUUID() }),
    targetApi: { detailTimed: async () => ({ latest_state: null }) },
    loadEnabledDevices: async () => [], toast: message => state.notices.push(message),
    openDisposalRequest: async options => { state.form = { ...options, direct: false }; },
    openDisposalDirect: async options => { state.form = { ...options, direct: true }; }
  };
  deps.getUavRiskCase = async () => {
    const advisory = await deps.uavAdvisoryApi.get(props.eventId, props.riskCase?.risk_case_id);
    return { risk_case: { ...advisory.risk_case, action_event_id: advisory.event_id },
      alarm: { target_id: props.targetId }, advisory };
  };
  Object.assign(deps, overrides);
  const scope = vue.effectScope();
  const api = scope.run(() => new Function(...Object.keys(deps), source + '\nreturn { launch, busy };')(...Object.values(deps)));
  return { props, state, ...api, close() { state.unmounts.forEach(cb => cb()); scope.stop(); } };
}

test('same-event qualification refresh keeps the request bound while current eligibility remains required', async () => {
  for (const direct of [false, true]) {
    const f = fixture(direct);
    try {
      await f.launch();
      const form = f.state.form;
      assert.equal(form.direct, direct);
      assert.equal(form.subjectId, f.props.eventId);
      assert.deepEqual(f.state.reads, [f.props.eventId]);
      for (let version = 2; version <= 6; version++) {
        f.props.summary = { ...f.props.summary, event_version: version, prediction_id: randomUUID() };
        await vue.nextTick();
        assert.equal(form.isCurrent(), true, 'fresh snapshots of the same event do not switch the form');
      }
      f.props.showLaunch = false;
      assert.equal(form.isCurrent(), false, 'unavailable qualification still blocks submission');
      f.props.showLaunch = true;
      assert.equal(form.isCurrent(), true, 'fresh eligibility for the unchanged event restores its existing form');
      assert.equal(form.subjectId, f.props.eventId, 'refresh never retargets an open request');
    } finally { f.close(); }
  }
});

test('real event, page, stop and session changes still invalidate an open request', async () => {
  for (const change of ['eventId', 'active', 'counterStopped', 'session', 'unmount']) {
    const f = fixture();
    try {
      await f.launch();
      const form = f.state.form, original = f.props[change];
      if (change === 'session') f.state.token = randomUUID();
      else if (change === 'unmount') f.state.unmounts.forEach(cb => cb());
      else f.props[change] = change === 'eventId' ? randomUUID() : !original;
      assert.equal(form.isCurrent(), false, change);
      if (['eventId', 'active', 'counterStopped'].includes(change)) {
        f.props[change] = original;
        assert.equal(form.isCurrent(), false, 'returning to previous state cannot revive a switched form');
      }
    } finally { f.close(); }
  }
});


test('同事件多区反制表单绑定当前风险，并把办理记录导航保留在该风险', async () => {
  const f = fixture();
  try {
    const risk = { risk_case_id: randomUUID(), version: 11 };
    f.props.riskCase = risk; f.props.summary = { ...f.props.summary, risk_case: risk };
    await f.launch();
    assert.deepEqual(f.state.form.riskContext, { risk_case_id: risk.risk_case_id, expected_case_version: risk.version });
    const authorization_id = randomUUID(); f.state.form.onDone({ authorization_id });
    assert.deepEqual(f.state.events.find(row => row[0] === 'records')[1], { eventId: f.props.eventId, riskCaseId: risk.risk_case_id, authorizationId: authorization_id });
    f.props.riskCase = { risk_case_id: randomUUID(), version: 11 };
    assert.equal(f.state.form.isCurrent(), false);
  } finally { f.close(); }
});

test('反制点击立即忙碌且独立读取并行，同一点击期间不重复打开或创建动作',async()=>{
  const waits={},calls=[];
  const wait=name=>{calls.push(name);return new Promise(resolve=>waits[name]=resolve);};
  const f=fixture(true,{uavAdvisoryApi:{get:()=>wait('eligibility')},disposalApi:{policies:()=>wait('policy')},
    targetApi:{detailTimed:()=>wait('target')},loadEnabledDevices:()=>wait('devices')});
  try{
    f.props.targetId=randomUUID();
    const pending=f.launch();assert.equal(f.busy.value,true);await f.launch();
    assert.deepEqual(calls,['eligibility','policy','target','devices']);
    waits.eligibility({...f.props.summary});waits.policy({});waits.target({latest_state:null});waits.devices([]);
    await pending;assert.equal(f.busy.value,false);assert.ok(f.state.form.direct);
    assert.deepEqual(f.state.form.preparedDevices,{items:[]});
  }finally{f.close();}
});
test('准备反制时离页或切换风险明确提示取消，不静默丢失或恢复旧动作',async()=>{
  for(const change of ['unmount','case','eligibility']){
    let resolve;const f=fixture(true,{uavAdvisoryApi:{get:()=>new Promise(done=>resolve=done)}});
    try{
      const pending=f.launch();assert.equal(f.busy.value,true);
      if(change==='unmount')f.state.unmounts.forEach(cb=>cb());
      if(change==='case')f.props.riskCase={risk_case_id:randomUUID(),version:2};
      if(change==='eligibility')f.props.showLaunch=false;
      resolve({...f.props.summary});await pending;
      assert.equal(f.state.form,null);assert.equal(f.state.notices.length,1);
      assert.match(f.state.notices[0],/本次未发起反制/);
    }finally{f.close();}
  }
});

test('当前case版本缺失或落后的摘要不能开放反制，点击后的资格仍重新绑定最新case版本',async()=>{
  for(const stale of [undefined,2]){
    const f=fixture(true);
    try{
      const risk={risk_case_id:randomUUID(),version:3};f.props.riskCase=risk;
      f.props.summary={...f.props.summary,risk_case_id:risk.risk_case_id,risk_case_version:stale};
      await f.launch();assert.equal(f.state.form,null);assert.equal(f.state.reads.length,0);
    }finally{f.close();}
  }
  let risk;
  const f=fixture(true,{uavAdvisoryApi:{get:async()=>({...f.props.summary,risk_case:{...risk,version:2}})}});
  try{
    risk={risk_case_id:randomUUID(),version:3};f.props.riskCase=risk;f.props.summary={...f.props.summary,risk_case:risk};
    await f.launch();assert.equal(f.state.form,null);assert.equal(f.state.feedback.length,1);
    assert.match(f.state.feedback[0].title,/反制条件检查失败/);
  }finally{f.close();}
});


test('同版本摘要阶段或核实状态不一致不能开放反制，点击后的返回同样重验',async()=>{
 for(const patch of [{stage:'UNKNOWN'},{verification_status:'PENDING_VERIFICATION'}]){
  const f=fixture(true);
  try{
   const risk={risk_case_id:randomUUID(),version:6,stage:'ENTERED',verification_status:'CONFIRMED'};
   f.props.riskCase=risk;f.props.summary={...f.props.summary,risk_case:{...risk,...patch}};
   await f.launch();assert.equal(f.state.form,null);assert.equal(f.state.reads.length,0);
  }finally{f.close();}
  const g=fixture(true,{uavAdvisoryApi:{get:async()=>({...g.props.summary,risk_case:{...g.props.riskCase,...patch}})}});
  try{
   const risk={risk_case_id:randomUUID(),version:6,stage:'ENTERED',verification_status:'CONFIRMED'};
   g.props.riskCase=risk;g.props.summary={...g.props.summary,risk_case:risk};
   await g.launch();assert.equal(g.state.form,null);assert.equal(g.state.feedback.length,1);
  }finally{g.close();}
 }
});


test('点击反制收到同case更高版本先通知父级同步，未同步前不借新资格放行',async()=>{
 for(const promoted of [false,true]){
  let f;
  const deps={uavAdvisoryApi:{get:async()=>({...f.props.summary,risk_case:{...f.props.riskCase,version:7}})}};
  if(promoted)deps.defineEmits=()=> (name,value)=>{
   f.state.events.push([name,value]);
   if(name==='updated'){f.props.riskCase=value.risk_case;f.props.summary=value;}
  };
  f=fixture(true,deps);
  try{
   const risk={risk_case_id:randomUUID(),version:6,stage:'ENTERED',verification_status:'CONFIRMED'};
   f.props.riskCase=risk;f.props.summary={...f.props.summary,risk_case:risk};
   await f.launch();
   assert.equal(f.state.events.find(row=>row[0]==='updated')[1].risk_case.version,7);
   if(promoted){assert.equal(f.state.form.riskContext.expected_case_version,7);assert.equal(f.state.form.isCurrent(),true);}
   else {assert.equal(f.state.form,null);assert.equal(f.state.feedback.length,1);}
  }finally{f.close();}
 }
});


test('每秒同case对象和版本刷新不取消准备，完整一致资格返回后打开表单；真实切换仍取消',async()=>{
 for(const direct of [false,true]) for(const switched of [false,true]){
  let resolve;const f=fixture(direct,{uavAdvisoryApi:{get:()=>new Promise(done=>resolve=done)}});
  try{
   const caseId=randomUUID(),base={risk_case_id:caseId,version:3,stage:'ENTERED',verification_status:'CONFIRMED'};
   f.props.riskCase=base;f.props.summary={...f.props.summary,risk_case:base};
   const preparing=f.launch();assert.equal(f.busy.value,true);
   for(let tick=0;tick<8;tick++){
    const risk={...f.props.riskCase,version:3+Math.floor(tick/2)};
    f.props.riskCase=risk;f.props.summary={...f.props.summary,risk_case:{...risk},event_version:10+tick};
    await vue.nextTick();assert.equal(f.busy.value,true,'同身份对象刷新不得取消准备');
    assert.equal(f.state.notices.length,0);assert.equal(f.state.form,null);
   }
   const latest={...f.props.summary};
   if(switched)f.props.riskCase={...f.props.riskCase,risk_case_id:randomUUID()};
   resolve(latest);await preparing;
   assert.equal(f.busy.value,false);
   if(switched){assert.equal(f.state.form,null);assert.equal(f.state.notices.length,1);assert.match(f.state.notices[0],/本次未发起反制/);}
   else{
    assert.equal(f.state.form.direct,direct);assert.equal(f.state.form.riskContext.risk_case_id,caseId);
    assert.equal(f.state.form.riskContext.expected_case_version,6);assert.equal(f.state.form.isCurrent(),true);
    f.props.riskCase={...f.props.riskCase};await vue.nextTick();assert.equal(f.state.form.isCurrent(),true);
    assert.equal(f.state.notices.length,0);
    f.props.riskCase={...f.props.riskCase,risk_case_id:randomUUID()};await vue.nextTick();assert.equal(f.state.form.isCurrent(),false);
   }
  }finally{f.close();}
 }
});

test('同一风险由预测转实测时重读当前办理对象，准备与设备表单保持',async()=>{
 for(const direct of [false,true]){
  let f,phase=0,resolve;
  const caseId=randomUUID(),firstId=randomUUID(),nextId=randomUUID(),area=randomUUID(),target=randomUUID();
  const risk=()=>({risk_case_id:caseId,airspace_id:area,source_mode:'replay',version:phase+3,
    stage:phase?'ENTERED':'PREDICTED',verification_status:'CONFIRMED',action_event_id:phase?nextId:firstId});
  const result=()=>({event_id:phase?nextId:firstId,risk_case:risk(),counter_launch_visible:true,
    can_direct_counter:direct,can_request_counter:!direct});
  f=fixture(direct,{getUavRiskCase:()=>new Promise(done=>resolve=()=>done({risk_case:risk(),alarm:{target_id:target},advisory:result()})),
   defineEmits:()=> (name,value)=>{f.state.events.push([name,value]);if(name==='updated'){f.props.riskCase=value.risk_case;f.props.eventId=value.event_id;f.props.summary=value;}}});
  try{
   f.props.eventId=firstId;f.props.riskCase=risk();f.props.targetId=target;f.props.summary=result();
   const pending=f.launch();assert.equal(f.busy.value,true);
   phase=1;f.props.eventId=nextId;f.props.riskCase=risk();f.props.summary=result();await vue.nextTick();
   assert.equal(f.busy.value,true,'同风险入区不取消准备');resolve();await pending;
   const form=f.state.form;assert.equal(form.subjectId,nextId);assert.equal(form.isCurrent(),true);assert.equal(f.state.notices.length,0);
   const fresh=form.prepareSubmit();resolve();const binding=await fresh;
   assert.equal(binding.subjectId,nextId);assert.equal(binding.riskContext.expected_case_version,4);
   f.close();
   // Closing a form while a new qualification read is pending must never authorize a send.
   assert.equal(form.isCurrent(),false);
  }finally{f.close();}
 }
});

test('已打开反制表单提交前重新读取，明确依据不足、权限收回和读取失败均不能沿用旧资格',async()=>{
 for(const mode of ['unknown','permission','read-error']){
  let f,failed=false;
  const caseId=randomUUID();
  f=fixture(true,{getUavRiskCase:async()=>{
   if(failed&&mode==='read-error')throw new Error('读取失败');
   const advisory={...f.props.summary,...(failed?{can_direct_counter:false,can_request_counter:false,counter_block_reason:mode==='unknown'?'当前依据不足':'当前账号无直接反制权限'}:{})};
   return {risk_case:{...f.props.riskCase,action_event_id:f.props.eventId},alarm:{},advisory};
  }});
  try{
   f.props.riskCase={risk_case_id:caseId,version:4,stage:'ENTERED',verification_status:'CONFIRMED'};
   f.props.summary={...f.props.summary,risk_case:f.props.riskCase};
   await f.launch();assert.ok(f.state.form);failed=true;
   await assert.rejects(f.state.form.prepareSubmit(),mode==='unknown'?/当前依据不足/:mode==='permission'?/无直接反制权限/:/读取失败/);
   assert.equal(f.state.form.riskContext.risk_case_id,caseId);
  }finally{f.close();}
 }
});
