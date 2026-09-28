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
 assert.doesNotThrow(()=>form.validate({filing}));
 assert.throws(()=>form.validate({filing:{...filing,takeoff_latitude:null}}),/成对/);
 assert.throws(()=>form.validate({filing:{...filing,takeoff_longitude:181}}),/范围/);
});
test('edit form retains unavailable historical associations without silently clearing',()=>{
 const html=form.fields({filing:{source_id:'old-source',pilot_contact_id:'old-pilot'}},{});
 assert.match(html,/value="old-source" selected/);assert.match(html,/value="old-pilot" selected/);assert.match(html,/不可选/);
});
test('supplement uses current plan version and keeps original filing names',()=>{
 const draft=form.fromDetail({plan:{version:7,source:{source_id:'s'},filing:{operator_name:'申报名'}},subjects:{operator_org_id:'o',pilot_contact_id:'p',source_binding_id:'b'}},'edit-1');
 assert.equal(draft.expected_version,7);assert.equal(draft.filing.source_id,'s');assert.equal(draft.filing.operator_name,'申报名');assert.equal(draft.filing.pilot_contact_id,'p');
});
