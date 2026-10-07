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

test('risk inbox displays frozen coordinates and distinguishes missing or hidden material',async()=>{
 const sandbox={document,window:{ExternalContract:require('../web/external-contract.js')},setInterval(){},fetch:async()=>({ok:true,status:200,json:async()=>({connected:false})})};
 vm.createContext(sandbox);
 vm.runInContext(source+'\nglobalThis.__test={inboxRecord};',sandbox);
 await new Promise(resolve=>setImmediate(resolve));
 const base={kind:'risk',subject:'risk:test',recipient:'上级',status:'DELIVERED',received:true};
 for(const [longitude,latitude] of [[118.624321,37.478123],[-73.985321,40.748123],[0,0]]){
  const html=sandbox.__test.inboxRecord({...base,details:{material:{risk:{location:{longitude,latitude,coordinate_system:'WGS84',observed_at:Date.now()-30000,altitude_m:85,altitude_datum:'AGL'}}}}});
  const summary=html.split('<details')[0];
  assert.ok(summary.includes('经度 '+longitude.toFixed(6)));
  assert.ok(summary.includes('纬度 '+latitude.toFixed(6)));
  assert.match(summary,/WGS-84/);assert.match(summary,/观测时间/);assert.match(summary,/85 米（相对地面）/);
 }
 for(const location of [undefined,{longitude:null,latitude:null},{longitude:181,latitude:37},{longitude:118,latitude:''}]){
  const html=sandbox.__test.inboxRecord({...base,details:{material:{risk:{location}}}}).split('<details')[0];
  assert.match(html,/通知未记录有效坐标/);assert.doesNotMatch(html,/经度 0/);
 }
 const hidden=sandbox.__test.inboxRecord({...base,details:{availability:{material:'FORBIDDEN'}}}).split('<details')[0];
 assert.match(hidden,/位置材料不可查看/);assert.doesNotMatch(hidden,/未记录有效坐标/);
});

test('selected map plan renders editable times and retains edits when the form is rebuilt',async()=>{
 const sandbox={document,window:{ExternalContract:require('../web/external-contract.js'),PlanForm:require('../web/plan-form.js'),WeatherForm:require('../web/weather-form.js')},setInterval(){},fetch:async()=>({ok:true,status:200,json:async()=>({connected:false})})};
 vm.createContext(sandbox);
 vm.runInContext(source+`\nglobalThis.__test={buildPlanInput,readDraft,set(data){tab='plans';context={routes:[],plans:[],messages:[]};scenePlans=[{id:'p1',name:'巡检任务',start:'09:00',end:'09:30',points:[[118.6,37.4],[118.7,37.5]]}];selectedScenePlanId='p1';drafts.plans=JSON.stringify(data);}};`,sandbox);
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

test('route owner follows the chosen unit and district; with no routes and several choices nothing is guessed',async()=>{
 const sandbox={document,window:{ExternalContract:require('../web/external-contract.js'),PlanForm:require('../web/plan-form.js'),WeatherForm:require('../web/weather-form.js')},setInterval(){},fetch:async()=>({ok:true,status:200,json:async()=>({connected:false})})};
 vm.createContext(sandbox);
 vm.runInContext(source+`\nglobalThis.__test={buildPlanInput,readDraft,set(routes,scopes,chosen,connection){tab='plans';editingPlan=null;context={routes,plans:[],messages:[]};planScopes=scopes;planScope=chosen||null;planConnectionScope=connection||null;scenePlans=[{id:'p1',name:'巡检计划',start:'09:00',end:'09:30',points:[[118.6,37.4],[118.7,37.5]]}];selectedScenePlanId='p1';drafts.plans=JSON.stringify({message_id:'m',uav_sn:'SIM-1',filing:{source_id:'s'}});}};`,sandbox);
 await new Promise(resolve=>setImmediate(resolve));
 const a={owner_org_id:'org-a',owner_org_name:'甲单位',district_id:'d-a',district_name:'甲区'};
 const b={owner_org_id:'org-b',owner_org_name:'乙单位',district_id:'d-b',district_name:'乙区'};
 sandbox.__test.set([],[a,b]);
 let html=sandbox.__test.buildPlanInput();
 assert.match(html,/航线归属单位与区县/);
 assert.match(html,/<option value="" selected>请选择<\/option>/);
 assert.equal(sandbox.__test.readDraft().route.owner_org_id,'');
 assert.throws(()=>sandbox.window.PlanForm.validate(sandbox.__test.readDraft()),/归属单位与区县/);
 sandbox.__test.set([],[a,b],b);
 html=sandbox.__test.buildPlanInput();
 assert.equal(sandbox.__test.readDraft().route.owner_org_id,'org-b');
 assert.equal(sandbox.__test.readDraft().route.district_id,'d-b');
 assert.match(html,/<option value="1" selected>乙单位 · 乙区<\/option>/);
 sandbox.__test.set([],[a]);
 sandbox.__test.buildPlanInput();
 assert.equal(sandbox.__test.readDraft().route.owner_org_id,'org-a');
 sandbox.__test.set([{route_version_id:'r1',owner_org_id:'org-r',district_id:'d-r'}],[]);
 html=sandbox.__test.buildPlanInput();
 assert.equal(sandbox.__test.readDraft().route.owner_org_id,'org-r');
 assert.match(html,/沿用报文中的归属单位与区县/);
 sandbox.__test.set([{route_version_id:'r1',owner_org_id:'org-b',district_id:'d-b'}],[a,b]);
 html=sandbox.__test.buildPlanInput();
 assert.equal(sandbox.__test.readDraft().route.owner_org_id,'org-b');
 assert.match(html,/<option value="1" selected>乙单位 · 乙区<\/option>/);
 // The simulator's device data connection decides first, ahead of an existing route's owner, as on the airspace page.
 const connection={owner_org_id:'org-a',district_id:'d-a',broker_name:'local-lingyun-replay'};
 sandbox.__test.set([{route_version_id:'r1',owner_org_id:'org-b',district_id:'d-b'}],[a,b],null,connection);
 html=sandbox.__test.buildPlanInput();
 assert.equal(sandbox.__test.readDraft().route.owner_org_id,'org-a');
 assert.equal(sandbox.__test.readDraft().route.district_id,'d-a');
 assert.match(html,/<option value="0" selected>甲单位 · 甲区<\/option>/);
 sandbox.__test.set([],[a,b],null,connection);
 sandbox.__test.buildPlanInput();
 assert.equal(sandbox.__test.readDraft().route.owner_org_id,'org-a');
 // A connection the account may not use, or one not found, is ignored; a choice made on the form always wins.
 sandbox.__test.set([],[a,b],null,{owner_org_id:'org-x',district_id:'d-x'});
 sandbox.__test.buildPlanInput();
 assert.equal(sandbox.__test.readDraft().route.owner_org_id,'');
 sandbox.__test.set([],[a,b],null,{owner_org_id:null,district_id:null,message:'未找到启用的回放 MQTT 连接 local-lingyun-replay，请手动选择归属单位与区县'});
 sandbox.__test.buildPlanInput();
 assert.equal(sandbox.__test.readDraft().route.owner_org_id,'');
 sandbox.__test.set([],[a,b],b,connection);
 sandbox.__test.buildPlanInput();
 assert.equal(sandbox.__test.readDraft().route.owner_org_id,'org-b');
});
