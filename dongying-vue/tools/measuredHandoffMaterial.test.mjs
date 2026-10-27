import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import { renderToString } from '@vue/server-renderer';
import * as views from '../src/pages/punish/handoffMaterialView.js';
import { CONCLUSION_LABEL, labelOf } from '../src/ui/labels.js';

const source = readFileSync(new URL('../src/pages/punish/HandoffMaterialFacts.vue', import.meta.url), 'utf8');
const dependencies = { ...Vue, ...views, CONCLUSION_LABEL, labelOf, ruleReasonText: value => value,
  FrozenEvidenceContent: { render: () => null } };
const imports = {};
const compiled = compileScript(parse(source).descriptor, { id: 'measured-material', inlineTemplate: true }).content
  .replace(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"];?/g, (_, list) => {
    for (const item of list.replace(/[{}]/g, '').split(',').map(value => value.trim()).filter(Boolean)) {
      const [name, alias = name] = item.split(/\s+as\s+/);
      assert.ok(name in dependencies, `missing dependency ${name}`);
      imports[alias] = dependencies[name];
    }
    return '';
  }).replace('export default', 'return');
const Facts = new Function(...Object.keys(imports), compiled)(...Object.values(imports));
const render = (material, part = 'details') => renderToString(Vue.createSSRApp(Facts, { material, part }));
function material(source_mode = 'replay') {
  const event_id = randomUUID(), now = Date.now();
  return { schema_version: 2, event: { event_id, state: 'PENDING_VERIFICATION', source_mode },
    measured_risk_basis: { basis_kind: 'INDEPENDENT_MEASURED_ENTRY', event_id, risk_case_id: randomUUID(),
      evaluation_id: randomUUID(), authorization_id: randomUUID(), airspace_id: randomUUID(), airspace_version_id: randomUUID(),
      point_id: randomUUID(), observation_id: randomUUID(), source_id: randomUUID(), device_id: randomUUID(),
      observed_at: now - 20000, evaluated_at: now - 19000, completed_at: now - 10000,
      longitude: 117.2865, latitude: 36.8253, altitude_amsl_m: 103, position_accuracy_m: 7, source_mode,
      risk_verification_is_legal_verdict: false,
      risk_verification: { verification_id: randomUUID(), conclusion: 'CONFIRMED', basis_kind: 'OBSERVED',
        trigger_mode: 'AUTO', automation_run_id: randomUUID(), created_at: now - 18000 } } };
}

test('新冻结材料分开展示风险处置核实与独立实测依据，原始待核实状态不被投射改写', async () => {
  for (const source_mode of ['live', 'replay']) {
    const data = material(source_mode), frozen = JSON.stringify(data);
    const view = views.measuredRiskBasisView(data);
    assert.equal(view.measured, true);
    assert.equal(view.verification.conclusion, '风险属实');
    assert.equal(view.verification.trigger, '规则自动核实');
    const summary = await render(data, 'summary'), detail = await render(data);
    assert.match(summary, /风险核实（处置资格）/);
    assert.match(summary, /已保存本禁飞区独立实测入区依据/);
    assert.match(detail, /风险核实用于本次处置/);
    assert.match(detail, /实测风险依据/);
    assert.ok(detail.includes(data.measured_risk_basis.evaluation_id));
    assert.ok(detail.includes(data.measured_risk_basis.airspace_version_id));
    assert.match(detail, /WGS84 117.2865, 36.8253/);
    assert.match(detail, /海拔 103 米（AMSL）/);
    assert.match(detail, source_mode === 'replay' ? /模拟／回放来源/ : /实时来源/);
    assert.doesNotMatch(detail, /核实人未记录|告警已确认|自动处罚完成/);
    assert.equal(views.eventMaterialStateText(data, { PENDING_VERIFICATION: '待人工核实', CONFIRMED: '告警已确认' }), '原始事件记录（移送时）：待人工核实');
    assert.equal(JSON.stringify(data), frozen);
  }
  const simulated = material('live'); simulated.measured_risk_basis.simulated = true;
  assert.equal(views.measuredRiskBasisView(simulated).source, '模拟来源');
  assert.match(await render(simulated), /模拟来源/);
});

test('预测风险人工核实只能展示为处置资格，不能冒充独立实测核实', async () => {
  const data = material();
  data.measured_risk_basis.risk_verification = { conclusion: 'CONFIRMED', basis_kind: 'PREDICTION', trigger_mode: 'MANUAL',
    actor_id: randomUUID(), actor_name: '值班员甲', created_at: Date.now() - 40000, note: '已核对预警目标' };
  const html = await render(data);
  assert.match(html, /人工核实 · 预测风险依据/);
  assert.match(html, /操作人 值班员甲/);
  assert.doesNotMatch(html, /规则自动核实/);
});

test('旧材料无新依据字段时沿用已冻结历史，不从原始状态补造风险核实或实测依据', async () => {
  const old = { event: { event_id: randomUUID(), state: 'CONFIRMED' },
    verifications: [{ conclusion: 'CONFIRMED', created_at: Date.now(), note: '原事件人工核实' }] };
  assert.equal(views.measuredRiskBasisView(old), null);
  assert.match(await render(old, 'summary'), /原事件核实/);
  assert.doesNotMatch(await render(old), /独立实测入区依据|风险核实（处置资格）/);
  assert.equal(views.eventMaterialStateText(old, { CONFIRMED: '告警已确认' }), '原始事件记录（移送时）：告警已确认');
});

test('新增依据缺失字段如实提示，零值高度不丢失且不猜测坐标或核实方式', async () => {
  const data = material();
  const basis = data.measured_risk_basis;
  delete basis.risk_verification; delete basis.observed_at; delete basis.longitude;
  basis.altitude_amsl_m = 0; basis.height_agl_m = 0;
  const view = views.measuredRiskBasisView(data);
  assert.equal(view.verification, null); assert.equal(view.position, '实测位置未记录');
  assert.equal(view.observedAt, null); assert.equal(view.altitude, '海拔 0 米（AMSL）；离地 0 米（AGL）');
  const html = await render(data);
  assert.match(html, /风险核实记录未随材料保存/);
  assert.match(html, /时间未记录/);
});

test('仅预测或不同事件的冻结字段不能显示为已保存本事件独立实测依据', async () => {
  for (const mutate of [data => { data.measured_risk_basis.basis_kind = 'PREDICTION'; },
    data => { data.measured_risk_basis.event_id = randomUUID(); }]) {
    const data = material(); mutate(data);
    assert.equal(views.measuredRiskBasisView(data).measured, false);
    assert.doesNotMatch(await render(data, 'summary'), /已保存本禁飞区独立实测入区依据/);
    assert.match(await render(data), /待核查/);
  }
});
