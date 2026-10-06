const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../web/airspace-form.js');
const source = fs.readFileSync(path.join(__dirname, '../web/airspace.js'), 'utf8');
const scopes = [{owner_org_id: 'org-a', district_id: 'district-a'}];
const boundary = {type: 'Polygon', coordinates: [[[118,37],[119,37],[119,38],[118,37]]]};
const sample = () => ({message_id:'msg-1', revision:'1', action:'UPSERT', airspace_no:'A1', change_reason:'新增', scope:'0', name:'空域 A', kind_code:'PROHIBITED', boundary:JSON.stringify(boundary), min_altitude_m:'', max_altitude_m:'', altitude_datum:'AMSL', valid_from:'2026-09-27T12:00', valid_to:''});

function scopeSandbox() {
 const nodes={'#scope-hint':{},'#submit':{},'#zones':{}};
 const select={value:'',disabled:false,replacements:0,replaceChildren(...options){this.options=options;this.replacements++;}};
 const env={form:{elements:{scope:select,action:{value:'UPSERT'}}},context:null,connected:false,busy:false,zones:[],scopeOptionsKey:'',Option:function(text,value){this.text=text;this.value=value;},$:key=>nodes[key]};
 vm.createContext(env);
 vm.runInContext(source.slice(source.indexOf('function availability('),source.indexOf('function toggle('))+source.slice(source.indexOf('function renderScopes('),source.indexOf('function clearRead(')),env);
 return {env,select,nodes};
}

test('signed-out scope displays a reason and cannot submit instead of showing a blank dropdown',()=>{
 const {env,select,nodes}=scopeSandbox();env.renderScopes([],'请先登录系统');env.availability();
 assert.equal(select.options[0].text,'请先登录系统');assert.equal(select.disabled,true);assert.equal(nodes['#submit'].disabled,true);
});
test('background refresh retains a chosen scope and does not rebuild the open dropdown',()=>{
 const {env,select}=scopeSandbox();const values=[{...scopes[0],owner_org_name:'单位',district_name:'区县'}];
 env.renderScopes(values,'请选择');env.context={scopes:values};env.connected=true;select.value='0';
 env.renderScopes(values,'请选择');env.availability();
 assert.equal(select.replacements,1);assert.equal(select.value,'0');assert.equal(select.disabled,false);
});
test('scope reordering preserves identity and scope removal clears stale selection',()=>{
 const {env,select}=scopeSandbox();const other={owner_org_id:'org-b',district_id:'district-b'};
 env.renderScopes(scopes,'请选择');env.context={scopes};select.value='0';
 env.renderScopes([other,...scopes],'请选择');assert.equal(select.value,'1');env.context={scopes:[other,...scopes]};
 env.renderScopes([other],'请选择');assert.equal(select.value,'');
});
test('authenticated user with no authorized scope sees an explanation and cannot create',()=>{
 const {env,select,nodes}=scopeSandbox();env.connected=true;env.context={scopes:[]};
 env.renderScopes([],'当前账号没有可用的归属范围');env.availability();
 assert.match(nodes['#scope-hint'].textContent,/没有可用/);assert.equal(select.disabled,true);assert.equal(nodes['#submit'].disabled,true);
});
test('Beijing form time roundtrips independently of machine timezone', () => {
 assert.equal(F.time('2026-09-27T12:00'), Date.parse('2026-09-27T04:00:00Z'));
 assert.equal(F.local(F.time('2026-09-27T12:00')), '2026-09-27T12:00:00');
});
test('empty altitude normalizes minimum, maximum and datum to null', () => {
 const p=F.payload(sample(),scopes); assert.equal(p.min_altitude_m,null); assert.equal(p.max_altitude_m,null); assert.equal(p.altitude_datum,null);
});
test('altitude requires both bounds and a datum', () => {
 for(const change of [{min_altitude_m:'1'}, {max_altitude_m:'100'}, {min_altitude_m:'1',max_altitude_m:'100',altitude_datum:''}]) assert.throws(()=>F.payload({...sample(),...change},scopes),/同时/);
});
test('complete altitude is preserved and reversed or nonfinite bounds rejected', () => {
 const p=F.payload({...sample(),min_altitude_m:'1',max_altitude_m:'100'},scopes); assert.equal(p.min_altitude_m,1);assert.equal(p.max_altitude_m,100);assert.equal(p.altitude_datum,'AMSL');
 assert.throws(()=>F.payload({...sample(),min_altitude_m:'101',max_altitude_m:'100'},scopes),/最低/);
 assert.throws(()=>F.payload({...sample(),min_altitude_m:'NaN',max_altitude_m:'100'},scopes),/有效数字/);
});
test('message identity, increasing integer revision and authorized scope are required', () => {
 assert.throws(()=>F.payload({...sample(),message_id:'bad id'},scopes));
 assert.throws(()=>F.payload({...sample(),revision:'1.5'},scopes));
 assert.throws(()=>F.payload({...sample(),scope:''},scopes),/归属/);
 assert.throws(()=>F.payload({...sample(),scope:'9'},scopes),/归属/);
 assert.throws(()=>F.payload({...sample(),kind_code:''},scopes),/空域类型/);
 assert.throws(()=>F.payload({...sample(),kind_code:'UNKNOWN'},scopes),/空域类型/);
});
test('GeoJSON accepts one feature and rejects unclosed rings or multi-feature files', () => {
 assert.deepEqual(F.geometry({type:'Feature',geometry:boundary}),boundary);
 assert.throws(()=>F.geometry({type:'Polygon',coordinates:[[[118,37],[119,37],[119,38],[118,38]]]}),/闭合/);
 assert.throws(()=>F.geometry({type:'FeatureCollection',features:[]}),/一片/);
});
test('withdraw emits only its defined contract and no geometry or source', () => {
 const p=F.payload({...sample(),action:'WITHDRAW',effective_at:'2026-09-27T12:00'},scopes);
 assert.deepEqual(Object.keys(p).sort(),['message_id','revision','action','airspace_no','change_reason','effective_at'].sort());
});
function requestSandbox() {
 let finish;
 const env={session:'old-session',serial:0,context:{old:true},clearRead(){env.context=null;env.cleared=true;},fetch:()=>new Promise(resolve=>{finish=resolve;})};
 vm.createContext(env);
 vm.runInContext(source.slice(source.indexOf('async function call('),source.indexOf('async function refresh('))+';globalThis.run=call;',env);
 return {env,reply:response=>finish(response)};
}
test('late 401 from old session does not clear a new session', async () => {
 const {env,reply}=requestSandbox();const pending=env.run('request',{method:'POST'});
 env.session='new-session';env.context={new:true};reply({status:401,ok:false,json:async()=>({error:'expired'})});
 await assert.rejects(pending,/账号已切换/);assert.equal(env.serial,0);assert.deepEqual(env.context,{new:true});assert.equal(env.cleared,undefined);
});
test('401 from current session clears reads but does not mutate saved draft', async () => {
 const {env,reply}=requestSandbox();env.draft='preserved';const pending=env.run('request',{method:'POST'});
 reply({status:401,ok:false,json:async()=>({error:'expired'})});await assert.rejects(pending,/重新登录/);
 assert.equal(env.context,null);assert.equal(env.serial,1);assert.equal(env.draft,'preserved');
});
test('successful response from an old session is ignored', async () => {
 const {env,reply}=requestSandbox();const pending=env.run('request',{method:'POST'});env.session='new-session';
 reply({status:200,ok:true,json:async()=>({state:'ACCEPTED'})});await assert.rejects(pending,/账号已切换/);
});
test('reissue after withdrawal clears another airspace geometry, identity and altitude', () => {
 const elements={};for(const key of Object.keys(sample()).concat(['effective_at']))elements[key]={value:'OTHER_AIRSPACE'};
 const env={form:{elements,reset(){for(const e of Object.values(elements))e.value='';}},item:{airspace_no:'WITHDRAWN_A',revision:5,action:'WITHDRAW',payload:{effective_at:1}},action:'UPSERT',context:{scopes},F,id:()=> 'new-message',Date,note(){},fill(data){for(const[key,value]of Object.entries(data))if(elements[key])elements[key].value=value;}};
 vm.createContext(env);const handler=source.slice(source.indexOf('button.onclick=()=>{')+'button.onclick='.length,source.indexOf(';row.append(button);'));vm.runInContext('('+handler+')()',env);
 for(const key of ['name','boundary','scope','min_altitude_m','max_altitude_m','altitude_datum'])assert.equal(elements[key].value,'');
 assert.equal(elements.airspace_no.value,'WITHDRAWN_A');assert.equal(elements.revision.value,6);assert.equal(elements.message_id.value,'new-message');
});

test('second precision supports minutes and seconds while immediate updates advance past previous validity', () => {
 const at=Date.parse('2026-09-27T04:00:31Z');
 assert.equal(F.time('2026-09-27T12:00:31'),at);
 assert.equal(F.time('2026-09-27T12:00'),Date.parse('2026-09-27T04:00:00Z'));
 for (const payload of [{valid_from:at},{effective_at:at},{valid_from:at+900}]) {
   const next=F.nextEffective({payload},at);
   assert.ok(F.time(F.local(next))>Number(payload.valid_from||payload.effective_at));
   assert.ok(next>=at);
 }
 assert.equal(F.nextEffective({payload:{valid_from:at+60000}},at),at+61000);
 assert.equal(F.nextEffective({payload:{valid_from:at-60000}},at+400),at+1000);
});

// Reissuing a map zone (BUG-10): every accepted delivery uses up its message ID; issuing the same airspace again is a new delivery.
const accepted = (overrides = {}) => ({message_id:'msg-1', airspace_no:'A1', revision:1, action:'UPSERT', payload:{...F.payload(sample(),scopes), ...overrides}});
const NOW = Date.parse('2026-10-06T02:00:00.400Z');
test('first delivery of a new airspace keeps the drafted message, revision and time', () => {
 const body=F.payload(sample(),scopes), prepared=F.prepareIssue(body,[],{id:()=>'unused',now:NOW});
 assert.deepEqual(prepared,{body,replay:false,changes:[]});
});
test('resending an accepted message unchanged is an idempotent replay, whatever the clock says', () => {
 const item=accepted(), prepared=F.prepareIssue(F.payload(sample(),scopes),[item],{id:()=>'unused',now:NOW});
 assert.equal(prepared.replay,true);assert.deepEqual(prepared.changes,[]);assert.equal(prepared.body.message_id,'msg-1');
 assert.ok(F.sameContent({b:1,a:[{y:2,x:1}]},{a:[{x:1,y:2}],b:1}));
 assert.equal(F.sameContent({a:[1,2]},{a:[2,1]}),false);
});
test('issuing an accepted airspace again gets a new message, the next revision and a current effective time', () => {
 for (const values of [{...sample(),max_altitude_m:'120',min_altitude_m:'0'}, {...sample(),message_id:'fresh-tab'}, sample()]) {
  const item=accepted(), body=F.payload(values,scopes), consumed=body.message_id==='msg-1'&&F.sameContent(item.payload,body);
  if (consumed) continue; // covered by the replay test
  const prepared=F.prepareIssue(body,[item],{id:()=>'msg-2',now:NOW});
  assert.equal(prepared.replay,false);
  assert.equal(prepared.body.message_id,body.message_id==='msg-1'?'msg-2':body.message_id);
  assert.equal(prepared.body.revision,2);
  assert.equal(prepared.body.valid_from,Date.parse('2026-10-06T02:00:01Z'));
  assert.ok(prepared.changes.includes('revision')&&prepared.changes.includes('valid_from'));
 }
});
test('a chosen future time and a higher revision are kept; a message used by another airspace is replaced', () => {
 const other={...accepted(),airspace_no:'B9',message_id:'msg-9'};
 const body={...F.payload({...sample(),message_id:'msg-9',revision:'7',valid_from:'2026-10-07T08:00'},scopes)};
 const prepared=F.prepareIssue(body,[accepted(),other],{id:()=>'msg-new',now:NOW});
 assert.equal(prepared.body.message_id,'msg-new');assert.equal(prepared.body.revision,7);assert.equal(prepared.body.valid_from,F.time('2026-10-07T08:00'));
 assert.deepEqual(prepared.changes,['message_id']);
});
test('an update must keep the original name and owner, and a bumped time must stay before the end time', () => {
 const item=accepted();
 assert.throws(()=>F.prepareIssue(F.payload({...sample(),message_id:'m2',name:'改名'},scopes),[item],{id:()=>'x',now:NOW}),/保持原名称和归属/);
 assert.throws(()=>F.prepareIssue({...F.payload({...sample(),message_id:'m2'},scopes),owner_org_id:'org-b'},[item],{id:()=>'x',now:NOW}),/保持原名称和归属/);
 assert.throws(()=>F.prepareIssue(F.payload({...sample(),message_id:'m2',valid_to:'2026-10-06T09:30'},scopes),[item],{id:()=>'x',now:NOW}),/结束时间/);
});
test('withdrawal moves to the next free instant and an already withdrawn airspace is not withdrawn twice', () => {
 const withdraw=F.payload({...sample(),message_id:'w1',revision:'2',action:'WITHDRAW',effective_at:'2026-09-27T12:00'},scopes);
 const prepared=F.prepareIssue(withdraw,[accepted()],{id:()=>'x',now:NOW});
 assert.equal(prepared.body.effective_at,Date.parse('2026-10-06T02:00:01Z'));assert.deepEqual(prepared.changes,['effective_at']);
 const gone={message_id:'w0',airspace_no:'A1',revision:2,action:'WITHDRAW',payload:{effective_at:NOW-60000}};
 assert.throws(()=>F.prepareIssue({...withdraw,revision:3},[gone],{id:()=>'x',now:NOW}),/已撤销/);
 const reissue=F.prepareIssue(F.payload({...sample(),message_id:'u3'},scopes),[gone],{id:()=>'x',now:NOW});
 assert.equal(reissue.body.revision,3);assert.equal(reissue.body.valid_from,Date.parse('2026-10-06T02:00:01Z'));
});
test('map zones share the full-chain airspace number, including its hashed long form', async () => {
 // Expected values come from fullchain.stable_airspace_no.
 assert.equal(await F.stableAirspaceNo('restricted-zone'),'sim-map-airspace-restricted-zone');
 assert.equal(await F.stableAirspaceNo('__'),'sim-map-airspace-zone');
 assert.equal(await F.stableAirspaceNo('a😀b'),'sim-map-airspace-a-b');
 assert.equal(await F.stableAirspaceNo('区区区'+'x'.repeat(60)),'sim-map-airspace-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-44ca171f73');
});
test('a zone keeps the number it was already issued under and otherwise uses its stable number', () => {
 const zone={id:'restricted-zone',name:'空域 A',boundary};
 const typed={...accepted(),airspace_no:'DEMO-ZONE-02',payload:{...accepted().payload,boundary:{coordinates:boundary.coordinates,type:'Polygon'}}};
 assert.equal(F.zoneAirspaceNo(zone,[typed],'sim-map-airspace-restricted-zone'),'DEMO-ZONE-02');
 assert.equal(F.zoneAirspaceNo(zone,[typed,{...typed,airspace_no:'sim-map-airspace-restricted-zone'}],'sim-map-airspace-restricted-zone'),'sim-map-airspace-restricted-zone');
 assert.equal(F.zoneAirspaceNo({...zone,name:'其他'},[typed],'sim-map-airspace-restricted-zone'),'sim-map-airspace-restricted-zone');
 assert.equal(F.zoneAirspaceNo(zone,[{...typed,action:'WITHDRAW'}],'sim-map-airspace-restricted-zone'),'sim-map-airspace-restricted-zone');
});
test('owner defaults to the airspace owner, then the simulator connection, then the only authorized scope', () => {
 const list=[{owner_org_id:'org-a',district_id:'district-a'},{owner_org_id:'org-b',district_id:'district-b'}];
 const connection={owner_org_id:'org-b',district_id:'district-b'};
 assert.equal(F.defaultScope(list,{payload:{owner_org_id:'org-a',district_id:'district-a'}},connection),'0');
 assert.equal(F.defaultScope(list,{payload:{effective_at:1}},connection),'1');
 assert.equal(F.defaultScope(list,null,{owner_org_id:'org-x',district_id:'district-a'}),'');
 assert.equal(F.defaultScope([list[0]],null,null),'0');
 assert.equal(F.defaultScope([],null,connection),'');
});

function zoneSandbox({context=null, values={}, zone}={}) {
 const elements={};for(const key of ['action','message_id','airspace_no','revision','name','scope','kind_code','altitude_datum','min_altitude_m','max_altitude_m','valid_from','valid_to','boundary','effective_at','change_reason'])elements[key]={value:values[key]??''};
 elements.action.value=values.action||'WITHDRAW';
 const nodes={'#zones':{value:zone.id},'#boundary-summary':{}};
 const env={form:{elements},$:key=>nodes[key],F,zones:[zone],context,connectionScope:{owner_org_id:'org-b',district_id:'district-b'},zonePending:null,saved:0,toggled:0,id:()=> 'rotated-id',save(){env.saved++;},toggle(){env.toggled++;}};
 vm.createContext(env);
 vm.runInContext(source.slice(source.indexOf('function defaultScope('),source.indexOf('const adjusted='))+source.slice(source.indexOf("$('#zones').onchange="),source.indexOf("$('#file').onchange=")),env);
 return {env,elements,nodes,run:()=>vm.runInContext("$('#zones').onchange()",env)};
}
const demoZone={id:'restricted-zone',name:'02 演示禁飞区',kind_code:'PROHIBITED',min_altitude_m:0,max_altitude_m:120,altitude_datum:'AGL',boundary};
const twoScopes=[{owner_org_id:'org-a',district_id:'district-a'},{owner_org_id:'org-b',district_id:'district-b'}];
test('choosing the demo zone prepares a complete delivery with no typing', async () => {
 const {elements,env,run}=zoneSandbox({context:{scopes:twoScopes,items:[]},zone:demoZone,values:{message_id:'draft-1',revision:'4'}});
 await run();
 assert.equal(elements.action.value,'UPSERT');assert.equal(env.toggled,1);
 assert.equal(elements.airspace_no.value,'sim-map-airspace-restricted-zone');assert.equal(elements.name.value,'02 演示禁飞区');
 assert.equal(elements.kind_code.value,'PROHIBITED');assert.deepEqual([elements.min_altitude_m.value,elements.max_altitude_m.value,elements.altitude_datum.value],[0,120,'AGL']);
 assert.equal(elements.revision.value,1);assert.equal(elements.message_id.value,'draft-1');assert.equal(elements.scope.value,'1');
 assert.match(elements.change_reason.value,/02 演示禁飞区/);assert.deepEqual(JSON.parse(elements.boundary.value),boundary);
});
test('choosing an already issued zone continues that airspace: next revision, unused message and its own owner', async () => {
 const item={message_id:'draft-1',airspace_no:'sim-map-airspace-restricted-zone',revision:3,action:'UPSERT',payload:{name:'02 演示禁飞区',owner_org_id:'org-a',district_id:'district-a',valid_from:NOW,boundary}};
 const {elements,run}=zoneSandbox({context:{scopes:twoScopes,items:[item]},zone:demoZone,values:{message_id:'draft-1',scope:'1',change_reason:'保留原因'}});
 await run();
 assert.equal(elements.revision.value,4);assert.equal(elements.message_id.value,'rotated-id');assert.equal(elements.scope.value,'0');assert.equal(elements.change_reason.value,'保留原因');
});
test('an untyped zone keeps the chosen kind, and a zone chosen before the receipts load is completed later', async () => {
 const {elements,env,run}=zoneSandbox({zone:{...demoZone,kind_code:''},values:{kind_code:'RESTRICTED'}});
 await run();
 assert.equal(elements.kind_code.value,'RESTRICTED');assert.equal(env.zonePending,'restricted-zone');assert.equal(elements.airspace_no.value,'');
 env.context={scopes:twoScopes,items:[]};await vm.runInContext('zoneContext(zones[0])',env);
 assert.equal(elements.airspace_no.value,'sim-map-airspace-restricted-zone');assert.equal(elements.scope.value,'1');
});

function submitSandbox({items, reply}) {
 const elements={};const values={...sample(),message_id:'msg-1',revision:'1',scope:'0'};
 for(const [key,value] of Object.entries(values))elements[key]={value};elements.effective_at={value:''};
 const posts=[],notes=[];
 const env={form:{elements},F,context:{scopes,items},connected:true,busy:false,id:()=> 'msg-2',Date,JSON,Number,Object,Error,
  FormData:function(f){return Object.entries(f.elements).map(([k,e])=>[k,e.value]);},
  $:()=>({textContent:'',disabled:false}),note:text=>notes.push(text),toggle(){},save(){},availability(){},refresh:async()=>{},
  call:async(path,command)=>{posts.push(command.body);return reply(command.body);}};
 vm.createContext(env);
 vm.runInContext(source.slice(source.indexOf('function fill('),source.indexOf('function availability('))+source.slice(source.indexOf('const adjusted='),source.indexOf('async function call('))+source.slice(source.indexOf('form.onsubmit='),source.indexOf("$('#refresh').onclick")),env);
 return {env,elements,posts,notes,submit:()=>env.form.onsubmit({preventDefault(){}})};
}
test('after a delivery is accepted the form holds the next one, so the same zone can be issued again directly', async () => {
 const items=[];
 const {elements,posts,notes,submit}=submitSandbox({items,reply:body=>{const receipt={message_id:body.message_id,airspace_no:body.airspace_no,revision:body.revision,action:body.action,payload:body};items.splice(0,items.length,receipt);return {...receipt,state:'ACCEPTED'};}});
 await submit();
 assert.equal(posts.length,1);assert.equal(posts[0].message_id,'msg-1');assert.match(notes.at(-1),/第 1 次下发/);
 assert.equal(elements.message_id.value,'msg-2');assert.equal(elements.revision.value,2);
 await submit();
 assert.equal(posts.length,2);assert.equal(posts[1].message_id,'msg-2');assert.equal(posts[1].revision,2);
 assert.ok(posts[1].valid_from>posts[0].valid_from);assert.match(notes.at(-1),/第 2 次下发/);
});
test('an unknown result keeps the message so the retry is the same delivery', async () => {
 let fail=true;const items=[];
 const {elements,posts,notes,submit}=submitSandbox({items,reply:body=>{if(fail){fail=false;items.push({message_id:body.message_id,airspace_no:body.airspace_no,revision:body.revision,action:body.action,payload:body});throw Error('提交结果未知，请恢复服务后刷新记录，再使用原消息重试。');}return {message_id:body.message_id,revision:body.revision,state:'ACCEPTED'};}});
 await submit();
 assert.match(notes.at(-1),/结果未知/);assert.equal(elements.message_id.value,'msg-1');
 await submit();
 assert.equal(posts.length,2);assert.deepEqual(posts[1],posts[0]);assert.match(notes.at(-1),/原回执/);assert.equal(elements.message_id.value,'msg-2');
});
