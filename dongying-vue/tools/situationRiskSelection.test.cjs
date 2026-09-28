const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const source = (process.env.CHECK_BASELINE ? execFileSync('git', ['show', 'HEAD:dongying-vue/src/pages/SituationPage.vue'], {encoding:'utf8'}) : fs.readFileSync('src/pages/SituationPage.vue','utf8')).replace(/\r\n/g, '\n');
const functions = ['selectPlan','selectRisk','renderPlanTip'].map(name => source.slice(source.indexOf(`function ${name}(`), source.indexOf('\n}\n', source.indexOf(`function ${name}(`)) + 2)).join('\n');
const plan = { id:'plan-a', planNo:'Plan A', statusLabel:'待执行', relatedRisks:[], activeRisks:[] };
const selection = { value:null };
const scope = { selection, fuseOpen:{value:false}, alertTab:{value:''}, map:null, markViewed:()=>{}, planForRisk:()=>plan, esc:v=>String(v ?? ''), formatClock:()=>'', U:{icon:()=>''}, labelOf:(labels,v)=>labels[v] || '未知', RISK_STATE_LABEL:{PENDING_VERIFICATION:'待核验',PENDING_NOTIFICATION:'待通知',NOTIFIED:'已通知',ACKNOWLEDGED:'已回执',EXCLUDED:'已排除'}, SEVERITY_LABEL:{} };
vm.createContext(scope); vm.runInContext(functions, scope);
for (const [state,label] of Object.entries(scope.RISK_STATE_LABEL)) {
  const risk = {id:'display-same',riskId:state,state,active:state!=='EXCLUDED'};
  plan.relatedRisks.push(risk);
  scope.selectRisk(risk);
  assert.equal(selection.value.riskId,risk.riskId,'risk selection must retain exact internal ID');
  const html=scope.renderPlanTip(plan);
  assert.ok(html.includes(`风险：${label}`));
  assert.ok(html.includes('<dt>计划状态</dt><dd>待执行</dd>'));
}
plan.relatedRisks=[];
assert.ok(scope.renderPlanTip(plan).includes('风险：状态待确认'));
scope.selectPlan(plan);
assert.ok(scope.renderPlanTip(plan).includes('计划：待执行'));
assert.ok(!scope.renderPlanTip(plan).includes('风险：已排除'));
console.log('PASS: five risk states, same-plan switching, missing risk, direct plan selection');
