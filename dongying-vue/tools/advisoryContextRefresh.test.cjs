const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const vue = require('vue');
const tick = async () => { for (let i=0;i<8;i++) await Promise.resolve(); await vue.nextTick(); };
function harness() {
  const pending=[],timers=[],updates=[],unavailable=[],callbacks={},unmounts=[];
  const risk=vue.ref({risk_case_id:randomUUID(),version:1,stage:'PREDICTED',verification_status:'PENDING_VERIFICATION'});
  const event=vue.ref(randomUUID());
  const document={hidden:false,addEventListener:(name,fn)=>callbacks[name]=fn,removeEventListener(){}};
  const deps={...vue,onMounted:fn=>fn(),onUnmounted:fn=>unmounts.push(fn),
    uavAdvisoryApi:{get:(id,caseId)=>new Promise((resolve,reject)=>pending.push({id,caseId,resolve,reject}))},
    shouldRetryRefresh:e=>!e.status||e.status===408||e.status>=500,refreshFailureText:()=> '服务暂时不可用',
    setTimeout:(fn,ms)=>{const t={fn,ms,cleared:false};timers.push(t);return t;},clearTimeout:t=>{if(t)t.cleared=true;},
    document,useRealtimeRefresh:(_topics,fn)=>callbacks.sse=fn};
  const source=readFileSync(path.join(__dirname,'../src/hooks/useUavAdvisory.js'),'utf8')
    .replace(/^import .*;\r?\n/gm,'').replace('export function useUavAdvisory','function useUavAdvisory');
  const hook=new Function(...Object.keys(deps),source+';return useUavAdvisory;')(...Object.values(deps));
  const scope=vue.effectScope();
  const state=scope.run(()=>hook(()=>event.value,v=>updates.push(v),1000,(...args)=>unavailable.push(args),()=>risk.value.risk_case_id,()=>risk.value));
  const reply=(index,context={...risk.value},fields={})=>pending[index].resolve({event_id:pending[index].id,
    risk_case:{...context},response_order:{voice_status:'PAUSED'},...fields});
  const scheduled=()=>timers.filter(t=>!t.cleared);
  const fire=async()=>{const due=scheduled();assert.equal(due.length,1);due[0].cleared=true;due[0].fn();await tick();return due[0].ms;};
  return {risk,event,state,pending,updates,unavailable,callbacks,document,reply,scheduled,fire,stop:()=>{unmounts.forEach(fn=>fn());scope.stop();}};
}

test('核实变更碰上旧在途读取，唯一SSE不丢失且旧资格不发布',async()=>{
  const h=harness();try{
    const before={...h.risk.value};h.risk.value={...before,version:2,verification_status:'CONFIRMED'};await tick();
    h.callbacks.sse();assert.equal(h.pending.length,1);
    h.reply(0,before,{can_direct_counter:true});await tick();
    assert.equal(h.updates.length,0);assert.equal(h.state.data.value,null);
    await h.fire();assert.equal(h.pending.length,2);
    h.reply(1,undefined,{can_direct_counter:true});await tick();
    assert.equal(h.updates.length,1);assert.equal(h.state.data.value.risk_case.version,2);assert.equal(h.scheduled().length,0);
  }finally{h.stop();}
});

test('相同身份已成功读取后仅case状态变化也主动重读，无须等待下一次SSE',async()=>{
  const h=harness();try{
    h.reply(0);await tick();assert.equal(h.updates.length,1);
    h.risk.value={...h.risk.value,version:2,verification_status:'CONFIRMED'};await tick();
    assert.equal(h.pending.length,2);assert.equal(h.state.data.value,null);
    h.reply(1,undefined,{can_direct_counter:true});await tick();assert.equal(h.state.data.value.can_direct_counter,true);
    h.risk.value={...h.risk.value,version:3,stage:'UNKNOWN'};await tick();assert.equal(h.state.data.value,null);
    h.reply(2,undefined,{can_direct_counter:false,counter_block_reason:'依据不足'});await tick();
    assert.equal(h.state.data.value.can_direct_counter,false);
  }finally{h.stop();}
});

test('补读失败先阻断，退避后恢复新资格，403停止自行重读',async()=>{
  const h=harness();try{
    h.reply(0,undefined,{can_direct_counter:true});await tick();
    h.risk.value={...h.risk.value,version:2,verification_status:'CONFIRMED'};await tick();
    h.pending[1].reject(Object.assign(new Error('unavailable'),{status:503}));await tick();
    assert.equal(h.unavailable.length,1);assert.equal(h.state.data.value,null);assert.match(h.state.error.value,/自动重试/);
    assert.equal(await h.fire(),2000);h.reply(2,undefined,{can_direct_counter:true});await tick();
    assert.equal(h.state.data.value.risk_case.version,2);assert.equal(h.state.error.value,'');
    h.callbacks.sse();h.callbacks.sse();h.pending[3].reject(Object.assign(new Error('forbidden'),{status:403}));await tick();
    assert.equal(h.state.data.value,null);assert.equal(h.scheduled().length,0);
  }finally{h.stop();}
});

test('预测转实测和切换其他风险时旧响应不能覆盖当前身份',async()=>{
  for(const anotherCase of [false,true]){
    const h=harness();try{
      const old={...h.risk.value};h.event.value=randomUUID();h.risk.value={...h.risk.value,
        risk_case_id:anotherCase?randomUUID():old.risk_case_id,version:2,stage:'ENTERED',verification_status:'CONFIRMED'};await tick();
      assert.equal(h.pending.length,2);h.reply(1,undefined,{can_direct_counter:false});await tick();
      h.reply(0,old,{can_direct_counter:true});await tick();
      assert.equal(h.updates.length,1);assert.equal(h.state.data.value.event_id,h.event.value);
      assert.equal(h.state.data.value.risk_case.risk_case_id,h.risk.value.risk_case_id);assert.equal(h.state.data.value.can_direct_counter,false);
    }finally{h.stop();}
  }
});

test('在途新信号只补一次读取，页面隐藏时暂停补读且恢复后重读',async()=>{
  const h=harness();try{
    h.callbacks.sse();h.callbacks.sse();h.callbacks.sse();h.reply(0);await tick();
    assert.equal(h.pending.length,1);await h.fire();assert.equal(h.pending.length,2);
    h.reply(1);await tick();assert.equal(h.scheduled().length,0);
    h.callbacks.sse();h.callbacks.sse();h.document.hidden=true;h.reply(2);await tick();
    assert.equal(h.scheduled().length,0,'后台页不补读');h.document.hidden=false;h.callbacks.visibilitychange();
    assert.equal(h.pending.length,4);h.reply(3);await tick();assert.equal(h.scheduled().length,0);
  }finally{h.stop();}
});


test('只读风险快照冲突自动补读，其他409不会当作可恢复资格',async()=>{
 const h=harness();try{
  h.pending[0].reject(Object.assign(new Error('risk changed'),{status:409,code:'RISK_CASE_CHANGED'}));await tick();
  assert.equal(h.unavailable.length,1);assert.equal(await h.fire(),2000);
  h.reply(1);await tick();assert.equal(h.state.error.value,'');
  h.callbacks.sse();h.pending[2].reject(Object.assign(new Error('session changed'),{status:409,code:'SESSION_CHANGED'}));await tick();
  assert.equal(h.scheduled().length,0);assert.equal(h.unavailable.length,2);
 }finally{h.stop();}
});
