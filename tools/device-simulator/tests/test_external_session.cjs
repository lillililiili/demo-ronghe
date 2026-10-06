const assert=require('node:assert/strict');
const test=require('node:test');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const nodes=new Map();
function node(selector){
 if(!nodes.has(selector))nodes.set(selector,{textContent:'',innerHTML:'',value:'',options:[],classList:{toggle(){}},addEventListener(){},contains(){return false;}});
 return nodes.get(selector);
}
const document={hidden:false,activeElement:null,querySelector:node,querySelectorAll(){return [];},addEventListener(){}};
const source=fs.readFileSync(path.join(__dirname,'../web/external.js'),'utf8');

test('selected map plan renders editable times and retains edits when the form is rebuilt',async()=>{
 const sandbox={document,window:{ExternalContract:require('../web/external-contract.js'),PlanForm:require('../web/plan-form.js'),WeatherForm:require('../web/weather-form.js')},setInterval(){},fetch:async()=>({ok:true,status:200,json:async()=>({connected:false})})};
 vm.createContext(sandbox);
 vm.runInContext(source+`\nglobalThis.__test={buildPlanInput,readDraft,set(data){tab='plans';context={routes:[],plans:[],messages:[]};scenePlans=[{id:'p1',name:'巡检计划',start:'09:00',end:'09:30',points:[[118.6,37.4],[118.7,37.5]]}];selectedScenePlanId='p1';drafts.plans=JSON.stringify(data);}};`,sandbox);
 await new Promise(resolve=>setImmediate(resolve));
 const edited={message_id:'time-edit',uav_sn:'SIM-TIME',start_at:Date.parse('2026-10-06T11:00:00+08:00'),end_at:Date.parse('2026-10-06T11:30:00+08:00'),filing:{source_id:'s'}};
 sandbox.__test.set(edited);
 for(let render=0;render<2;render++){
  const html=sandbox.__test.buildPlanInput();
  for(const key of ['start_at','end_at']){
   const input=html.match(new RegExp('<input[^>]*data-plan-field="'+key+'"[^>]*>'))?.[0];
   assert.ok(input,`${key} input must be present`);
   assert.doesNotMatch(input,/\b(?:readonly|disabled)\b/);
   assert.equal(sandbox.__test.readDraft()[key],edited[key]);
  }
 }
});

test('401 on a write clears connection and context immediately while keeping draft',async()=>{
 const sandbox={document,window:{ExternalContract:require('../web/external-contract.js')},setInterval(){},fetch:async url=>url.endsWith('/status')?{ok:true,status:200,json:async()=>({connected:false})}:{ok:false,status:401,json:async()=>({error:'expired'})}};
 vm.createContext(sandbox);
 vm.runInContext(source+'\nglobalThis.__test={call,set(){connected=true;context={messages:[]};drafts.plans="saved draft";setConnection({connected:true,user:{account:"operator"}});},get(){return {connected,context,draft:drafts.plans}}};',sandbox);
 await new Promise(resolve=>setImmediate(resolve));
 sandbox.__test.set();
 await assert.rejects(sandbox.__test.call('request',{method:'POST',path:'/local-interface-simulator/plans',body:{},key:'one'}),/重新登录/);
 assert.equal(sandbox.__test.get().connected,false);
 assert.equal(sandbox.__test.get().context,null);
 assert.equal(sandbox.__test.get().draft,'saved draft');
 assert.match(node('#external-status').textContent,/尚未登录/);
});
