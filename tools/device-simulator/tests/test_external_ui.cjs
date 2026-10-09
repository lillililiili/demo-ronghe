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

test('plan payload keeps its upstream route reference when no selector is shown', () => {
  const {applyInputFields} = require('../web/external-contract.js');
  const next=applyInputFields({message_id:'old',route_version_id:'upstream-route',uav_sn:'CUSTOM-1'},
    {kind:'plans',target:'',messageId:'new'});
  assert.equal(next.route_version_id,'upstream-route');
  assert.equal(next.message_id,'new');
});

test('scene plan writes route geometry into the upstream plan payload', () => {
  const {applyScenePlanRoute} = require('../web/external-contract.js');
  const next=applyScenePlanRoute({message_id:'m',route_version_id:'legacy',route:{owner_org_id:'org-old',district_id:'district-old'}},
    {name:'巡检任务',points:[[118.6,37.46],[118.61,37.47]],width:80,min:30,max:110,altitudeDatum:'AMSL'},
    {owner_org_id:'org-new',district_id:'district-new'});
  assert.equal(Object.hasOwn(next,'route_version_id'),false);
  assert.deepEqual(next.route.geometry,{type:'LineString',coordinates:[[118.6,37.46],[118.61,37.47]]});
  assert.equal(next.route.owner_org_id,'org-new');
  assert.equal(next.route.corridor_width_m,80);
});

test('refresh adopts a newly available upstream route when the draft still uses the old default', () => {
  const {refreshUpstreamRouteDraft} = require('../web/external-contract.js');
  const previous=[{route_version_id:'old-route'}];
  const next=[{route_version_id:'new-route'}];
  assert.equal(refreshUpstreamRouteDraft({route_version_id:'old-route',uav_sn:'CUSTOM'},previous,next).route_version_id,'new-route');
  assert.equal(refreshUpstreamRouteDraft({route_version_id:'manually-edited'},previous,next).route_version_id,'manually-edited');
});

test('weather samples are independent from flight plans', () => {
  const {weatherSample} = require('../web/external-contract.js');
  const now = Date.UTC(2026, 8, 24);
  const sample = weatherSample(now, 'weather-independent');
  assert.equal(sample.message_id, 'weather-independent');
  assert.equal(Object.hasOwn(sample, 'plan_id'), false);
  assert.equal(sample.periods[0].from, now);
  assert.equal(sample.periods[0].to, now + 3600000);
});

test('weather input does not add a flight plan binding when syncing fields', () => {
  const {applyInputFields} = require('../web/external-contract.js');
  const next = applyInputFields({message_id:'old', area_name:'东营区', published_at:1, periods:[]},
    {kind:'weather', target:'', messageId:'new', now:Date.UTC(2026, 8, 24)});
  assert.equal(next.message_id, 'new');
  assert.equal(Object.hasOwn(next, 'plan_id'), false);
  assert.equal(next.area_name, '东营区');
});

test('binding result reports confirmed binding state', () => {
  const {submitResultText} = require('../web/external-contract.js');
  assert.match(submitResultText('/local-interface-simulator/bindings',{enabled:true,expires_at:123}),/已启用/);
  assert.match(submitResultText('/local-interface-simulator/bindings',{enabled:false}),/已停用/);
});

test('a resent forecast says the platform kept its first receipt and made no new risk (CDX-P07)', () => {
  const {submitResultText} = require('../web/external-contract.js');
  const known = [{message_id: 'm-1', kind: 'WEATHER_FORECAST'}, {message_id: 'm-2', kind: 'FLIGHT_PLAN'}];
  assert.match(submitResultText('/local-interface-simulator/weather', {message_id: 'm-1', state: 'ACCEPTED'}, known), /此前已被系统受理.*未重复生成天气风险/);
  assert.equal(submitResultText('/local-interface-simulator/weather', {message_id: 'm-3', state: 'ACCEPTED'}, known), null, '新的预报照常显示系统结果');
  assert.equal(submitResultText('/local-interface-simulator/weather', {message_id: 'm-1'}, undefined), null, '不知道之前有哪些回执时不下结论');
});

test('unavailable context sections are shown verbatim without disabling available categories', () => {
  const {unavailableNotice} = require('../web/external-contract.js');
  assert.equal(unavailableNotice({unavailable_sections:['飞行任务：无读取权限','风险：无读取权限']}),'飞行任务：无读取权限；风险：无读取权限');
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
  // D-2: the simulated upstream task carries its own operator, pilot and reporting unit.
  assert.deepEqual(sample.filing,{source_id:'local-flight-plan-simulator',operator_name:'模拟申报单位',pilot_name:'模拟飞手',pilot_phone:'13800000000',reporting_org_code:'SIM-REPORTING-UNIT',reporting_org_name:'模拟报送单位'});
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
