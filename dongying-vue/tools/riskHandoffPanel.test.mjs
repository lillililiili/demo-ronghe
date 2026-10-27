import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import { renderToString } from '@vue/server-renderer';
import * as handoffHelpers from '../src/components/disposal/autoHandoffView.js';
import { riskSummaryMatches } from '../src/services/riskCaseView.js';

const source = readFileSync(new URL('../src/components/disposal/UavAdvisoryPanel.vue', import.meta.url), 'utf8');
function panel(summary) {
  const stub = { render: () => null };
  const dependencies = {
    ...Vue, ...handoffHelpers, riskSummaryMatches, userFacingMessage: value => value,
    RiskDisposalSummary: stub, FlightCheckNotice: stub, AutoSmsNotice: stub, AutoVoiceNotice: stub, AdvisoryRecords: stub,
    useUavAdvisory: () => ({ data: Vue.ref(summary), loading: Vue.ref(false), error: Vue.ref(''), load() {} }),
    counterProgressView: () => null, authUser: Vue.ref(null), hasPermission: () => false,
    openFormModal() {}, openConfirm() {}, toast() {}, handoffApi: {}, disposalApi: {},
    newHandoffIdempotencyKey: randomUUID, pendingOperationSettled: () => false
  };
  const { descriptor } = parse(source);
  const imports = {};
  const code = compileScript(descriptor, { id: 'risk-handoff', inlineTemplate: true }).content
    .replace(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"];?/g, (_, list) => {
      for (const item of list.replace(/[{}]/g, '').split(',').map(value => value.trim()).filter(Boolean)) {
        const [name, alias = name] = item.split(/\s+as\s+/);
        assert.ok(name in dependencies, `missing dependency ${name}`);
        imports[alias] = dependencies[name];
      }
      return '';
    }).replace('export default', 'return');
  return new Function(...Object.keys(imports), code)(...Object.values(imports));
}
function context(stage = 'ENTERED') {
  const event = randomUUID();
  return { event, risk: { risk_case_id: randomUUID(), action_event_id: event, airspace_id: randomUUID(),
    stage, version: 12, verification_status: 'CONFIRMED', manual_counter_only: true } };
}
function summaryFor(ctx, auto, permission = false) {
  return { event_id: ctx.event, event_version: 7, risk_case: { ...ctx.risk },
    can_handoff: permission, auto_handoff: auto };
}
const render = (ctx, summary) => renderToString(Vue.createSSRApp(panel(summary), {
  eventId: ctx.event, riskCase: ctx.risk, confirmed: true
}));
const submitButton = html => html.match(/<button[^>]*>选择接收单位并移送<\/button>/)?.[0];

test('manual counter origin does not hide server measured handoff progress or its real block reason', async () => {
  for (const state of ['BLOCKED', 'WAITING', 'SUBMITTED']) {
    const ctx = context();
    const handoffId = state === 'SUBMITTED' ? randomUUID() : null;
    const reason = state === 'BLOCKED' ? '缺少本区域独立实测违法依据' : '等待已启用的通知处罚规则全部满足';
    const html = await render(ctx, summaryFor(ctx, { status: state, reason, handoff_id: handoffId,
      trigger_source: state === 'SUBMITTED' ? 'COUNTERMEASURE_COMPLETED' : null }));
    assert.match(html, /aria-label="处罚移送进度"/);
    assert.match(html, new RegExp(`data-state="${state}"`));
    if (state === 'SUBMITTED') {
      assert.match(html, /已自动移送到处罚/);
      assert.match(html, /查看处罚交接/);
      assert.doesNotMatch(html, /已自动处罚|处罚已办结/);
    } else assert.ok(html.includes(reason));
    assert.equal(submitButton(html), undefined);
  }
});

test('pure prediction exposes the server explanation without granting a handoff action', async () => {
  for (const stage of ['PREDICTED', 'UNKNOWN']) {
    const ctx = context(stage);
    const reason = '仅有预测风险，尚无独立实测违法依据，不移送处罚';
    const html = await render(ctx, summaryFor(ctx, { enabled: false, status: 'NOT_REQUIRED', reason }));
    assert.ok(html.includes(reason));
    assert.match(html, /不需要自动移送/);
    assert.equal(submitButton(html), undefined);
    assert.doesNotMatch(html, /查看处罚交接|已自动移送到处罚/);
  }
});

test('measured stage and confirmed card never substitute server handoff permission', async () => {
  for (const allowed of [true, false, undefined]) {
    const ctx = context();
    const summary = summaryFor(ctx, { status: 'MANUAL_REQUIRED', reason: '需选择接收单位' }, allowed);
    const html = await render(ctx, summary);
    const button = submitButton(html);
    if (allowed === true) { assert.ok(button); assert.doesNotMatch(button, /disabled/); }
    else assert.equal(button, undefined);
  }
});

test('a stale or another regional summary cannot grant an enabled handoff action', async () => {
  for (const change of [risk => ({ ...risk, version: risk.version - 1 }),
    risk => ({ ...risk, risk_case_id: randomUUID() }),
    risk => ({ ...risk, stage: 'PREDICTED' })]) {
    const ctx = context();
    const summary = summaryFor(ctx, { status: 'MANUAL_REQUIRED' }, true);
    summary.risk_case = change(summary.risk_case);
    assert.match(submitButton(await render(ctx, summary)), /disabled/);
  }
});
