const assert = require('node:assert/strict');
const test = require('node:test');
const {weatherSampleForPlan, receiptChoices} = require('../web/external-contract.js');

test('historical forecast sample overlaps the plan and is published no later than its period', () => {
  const now = Date.UTC(2026, 8, 24);
  const plan = {plan_id:'old', start_at:now-86400000, end_at:now-82800000};
  const sample = weatherSampleForPlan(plan, now, 'sample-1');
  assert.equal(sample.plan_id, 'old');
  assert.equal(sample.periods[0].from, plan.start_at);
  assert.equal(sample.periods[0].to, plan.end_at);
  assert.ok(sample.published_at <= sample.periods[0].from);
  assert.ok(sample.published_at < now);
});

test('future forecast sample remains future and overlapping', () => {
  const now = Date.UTC(2026, 8, 24);
  const plan = {plan_id:'future', start_at:now+300000, end_at:now+3900000};
  const sample = weatherSampleForPlan(plan, now, 'sample-2');
  assert.equal(sample.published_at, now);
  assert.equal(sample.periods[0].from, plan.start_at);
  assert.equal(sample.message_id, 'sample-2');
});

test('timeout without delivery permits late delivery but not signature', () => {
  assert.deepEqual(receiptChoices({state:'TIMEOUT',result:{delivery_status:'UNKNOWN'}}).map(x=>x[0]), ['DELIVERED']);
});

test('timeout with recorded delivery permits signature', () => {
  assert.deepEqual(receiptChoices({state:'TIMEOUT',result:{delivery_status:'DELIVERED'}}).map(x=>x[0]), ['DELIVERED','ACKNOWLEDGED']);
});

test('input selectors update submitted JSON without losing unrelated edits', () => {
  const {applyInputFields} = require('../web/external-contract.js');
  const original={message_id:'old',route_version_id:'route-old',uav_sn:'CUSTOM-1',start_at:1,end_at:2};
  const next=applyInputFields(original,{kind:'plans',target:'route-new',messageId:'new'});
  assert.deepEqual(next,{...original,message_id:'new',route_version_id:'route-new'});
  assert.equal(original.message_id,'old');
});

test('changing forecast plan realigns period while preserving weather values', () => {
  const {applyInputFields} = require('../web/external-contract.js');
  const now=Date.UTC(2026,8,24);
  const plan={plan_id:'next',start_at:now+60000,end_at:now+3600000};
  const original={message_id:'m1',plan_id:'old',published_at:now,periods:[{from:1,to:2,summary:'雨',temperature_c:5}]};
  const next=applyInputFields(original,{kind:'weather',target:'next',messageId:'m2',plan,now});
  assert.equal(next.plan_id,'next');
  assert.equal(next.message_id,'m2');
  assert.equal(next.periods[0].from,plan.start_at);
  assert.equal(next.periods[0].summary,'雨');
});

test('binding result reports confirmed binding state', () => {
  const {submitResultText} = require('../web/external-contract.js');
  assert.match(submitResultText('/local-interface-simulator/bindings',{enabled:true,expires_at:123}),/已启用/);
  assert.match(submitResultText('/local-interface-simulator/bindings',{enabled:false}),/已停用/);
});

test('unavailable context sections are shown verbatim without disabling available categories', () => {
  const {unavailableNotice} = require('../web/external-contract.js');
  assert.equal(unavailableNotice({unavailable_sections:['飞行计划：无读取权限','风险：无读取权限']}),'飞行计划：无读取权限；风险：无读取权限');
  assert.equal(unavailableNotice({unavailable_sections:[]}), '');
});

test('plan sample stays inside selected route validity', () => {
  const {planSampleForRoute} = require('../web/external-contract.js');
  const now=Date.UTC(2026,8,24);
  const route={route_version_id:'r1',valid_from:now+20*60000,valid_to:now+50*60000};
  const sample=planSampleForRoute(route,now,'m-route');
  assert.equal(sample.start_at,route.valid_from);
  assert.equal(sample.end_at,route.valid_to);
  assert.equal(sample.message_id,'m-route');
});

test('route without validity keeps the prior one-hour sample', () => {
  const {planSampleForRoute} = require('../web/external-contract.js');
  const now=Date.UTC(2026,8,24);
  const sample=planSampleForRoute({route_version_id:'r2'},now,'m-route2');
  assert.equal(sample.start_at,now+5*60000);
  assert.equal(sample.end_at,now+65*60000);
});

test('route ending before the five-minute lead cannot produce a default sample', () => {
  const {planSampleForRoute} = require('../web/external-contract.js');
  const now=Date.UTC(2026,8,24);
  assert.throws(()=>planSampleForRoute({route_version_id:'r3',valid_to:now+1000},now,'m-route3'),/有效期/);
});

test('unknown delivery has no receipt action', () => {
  assert.deepEqual(receiptChoices({state:'UNKNOWN',result:{message:'delivery association failed'}}),[]);
});

test('selecting another route realigns draft times to that route', () => {
  const {applyInputFields}=require('../web/external-contract.js');
  const now=Date.UTC(2026,8,24);
  const route={route_version_id:'next-route',valid_from:now+10*60000,valid_to:now+20*60000};
  const next=applyInputFields({message_id:'m',route_version_id:'old-route',uav_sn:'CUSTOM',start_at:now,end_at:now+3600000},{kind:'plans',target:'next-route',messageId:'m',route,now});
  assert.equal(next.start_at,route.valid_from);
  assert.equal(next.end_at,route.valid_to);
  assert.equal(next.uav_sn,'CUSTOM');
});
