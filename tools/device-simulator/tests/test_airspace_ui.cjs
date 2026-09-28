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
