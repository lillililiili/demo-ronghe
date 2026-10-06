const test=require('node:test');
const assert=require('node:assert/strict');
const form=require('../web/plan-form.js');
test('filing edits preserve plan identity and coordinates do not turn empty into zero',()=>{
 const old={message_id:'one',uav_sn:'SN-1',filing:{operator_name:'申报名称',takeoff_longitude:118}};
 const next=form.update(old,'takeoff_longitude','',{});
 assert.equal(next.filing.takeoff_longitude,null);assert.equal(next.uav_sn,'SN-1');assert.equal(old.filing.takeoff_longitude,118);
});
test('selecting operator clears incompatible pilot but preserves reported names',()=>{
 const next=form.update({filing:{operator_name:'原申报单位',pilot_contact_id:'old'}},'operator_org_id','org-2',{organizations:[{id:'org-2',label:'新档案名称'}]});
 assert.equal(next.filing.operator_name,'原申报单位');assert.equal(next.filing.pilot_contact_id,null);
});
test('source changes clear the previous reporting binding',()=>{
 assert.equal(form.update({filing:{source_binding_id:'old'}},'source_id','new',{}).filing.source_binding_id,null);
});
test('complete coordinates are validated with WGS84 ranges',()=>{
 const filing={source_id:'s',operator_name:'单位',pilot_name:'飞手',takeoff_site_name:'起点',landing_site_name:'终点',takeoff_longitude:118,takeoff_latitude:37};
 const times={start_at:Date.parse('2026-10-03T09:00:00+08:00'),end_at:Date.parse('2026-10-03T09:30:00+08:00')};
 assert.doesNotThrow(()=>form.validate({filing,...times}));
 assert.throws(()=>form.validate({filing:{...filing,takeoff_latitude:null},...times}),/成对/);
 assert.throws(()=>form.validate({filing:{...filing,takeoff_longitude:181},...times}),/范围/);
});
test('edit form retains unavailable historical associations without silently clearing',()=>{
 const html=form.fields({filing:{source_id:'old-source',pilot_contact_id:'old-pilot'}},{});
 assert.match(html,/value="old-source" selected/);assert.match(html,/value="old-pilot" selected/);assert.match(html,/不可选/);
});
test('supplement uses current plan version and keeps original filing names',()=>{
 const draft=form.fromDetail({plan:{version:7,source:{source_id:'s'},filing:{operator_name:'申报名'}},subjects:{operator_org_id:'o',pilot_contact_id:'p',source_binding_id:'b'}},'edit-1');
 assert.equal(draft.expected_version,7);assert.equal(draft.filing.source_id,'s');assert.equal(draft.filing.operator_name,'申报名');assert.equal(draft.filing.pilot_contact_id,'p');
});
test('drawn scene plan supplies endpoints and Beijing flight window',()=>{
 const now=Date.parse('2026-10-03T08:00:00+08:00');
 const next=form.applyScenePlan({message_id:'m',uav_sn:'SIM-1',filing:{source_id:'s'}},{id:'p1',name:'巡检航线',start:'09:00',end:'09:30',points:[[118.61,37.42],[118.64,37.45]]},now);
 assert.equal(next.filing.takeoff_longitude,118.61);
 assert.equal(next.filing.takeoff_latitude,37.42);
 assert.equal(next.filing.landing_longitude,118.64);
 assert.equal(next.filing.landing_latitude,37.45);
 assert.equal(next.start_at,Date.parse('2026-10-03T09:00:00+08:00'));
 assert.equal(next.end_at,Date.parse('2026-10-03T09:30:00+08:00'));
 assert.equal(next.filing.takeoff_site_name,'巡检航线起点');
});
test('switching scene plans can refresh derived endpoint names',()=>{
 const now=Date.parse('2026-10-03T08:00:00+08:00');
 const first={id:'p1',name:'巡检计划 1',start:'09:00',end:'09:30',points:[[118.61,37.42],[118.64,37.45]]};
 const second={id:'p2',name:'巡检计划 2',start:'10:00',end:'10:30',points:[[118.70,37.50],[118.72,37.51]]};
 const draft=form.applyScenePlan({filing:{source_id:'s'}},first,now);
 const next=form.applyScenePlan(draft,second,now,{replaceSiteNames:true});
 assert.equal(next.filing.takeoff_site_name,'巡检计划 2起点');
 assert.equal(next.filing.landing_site_name,'巡检计划 2终点');
 assert.equal(next.filing.takeoff_longitude,118.70);
});
test('scene plan keeps manually edited flight window unless the scene plan changes',()=>{
 const now=Date.parse('2026-10-03T08:00:00+08:00');
 const plan={id:'p1',name:'巡检计划 1',start:'09:00',end:'09:30',points:[[118.61,37.42],[118.64,37.45]]};
 const draft=form.applyScenePlan({filing:{source_id:'s'}},plan,now,{replaceWindow:true});
 const edited={...draft,start_at:Date.parse('2026-10-03T11:00:00+08:00'),end_at:Date.parse('2026-10-03T11:30:00+08:00')};
 const rerendered=form.applyScenePlan(edited,plan,now);
 assert.equal(rerendered.start_at,edited.start_at);
 assert.equal(rerendered.end_at,edited.end_at);
 const switched=form.applyScenePlan(edited,plan,now,{replaceWindow:true});
 assert.equal(switched.start_at,Date.parse('2026-10-03T09:00:00+08:00'));
 assert.equal(switched.end_at,Date.parse('2026-10-03T09:30:00+08:00'));
});
test('scene route fields lock manually entered coordinates and expose draw entry',()=>{
 const html=form.fields({filing:{source_id:'s',takeoff_longitude:118,takeoff_latitude:37}},{scene_plan:{name:'地图航线',start:'09:00',end:'09:30',points:[[118.6,37.4],[118.7,37.5]]}});
 assert.match(html,/地图计划航线/);
 assert.match(html,/返回地图编辑航线/);
 assert.match(html,/data-plan-field="takeoff_longitude"[^>]*readonly/);
});
test('plan validation requires a real flight time window',()=>{
 const filing={source_id:'s',operator_name:'单位',pilot_name:'飞手',takeoff_site_name:'起点',landing_site_name:'终点'};
 assert.throws(()=>form.validate({filing}),/计划飞行时间/);
});
