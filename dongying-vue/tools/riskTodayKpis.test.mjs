import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { beijingDayWindow } from '../src/pages/flights/planFilters.js';

// Exercise the page's actual request orchestration, including a midnight between APIs.
const source = readFileSync(new URL('../src/pages/FlightsPage.vue', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('async function loadRiskKpis()'), source.indexOf('function clearRiskDetail()'));
let now = Date.parse('2026-10-09T15:59:59Z');
const calls = [];
const context = vm.createContext({
  beijingDayWindow: () => beijingDayWindow(now), riskKpiToken: 0, riskKpiDayFrom: null,
  riskKpiTotals: { value: {} }, riskKpiFailed: { value: {} }, routesSummary: { value: {} },
  RISK_KPI_QUERIES: { all: {}, high: { severity: 'HIGH' }, pending: { state: 'PENDING_VERIFICATION' }, bird: { risk_type: 'SPACE_OBJECT' }, weather: { risk_type: 'WEATHER' } },
  EVENT_RISK_SCOPE: { exclude_demo_samples: true, risk_types: 'SPACE_OBJECT,FOREIGN_OBJECT,WEATHER' },
  DISPLAY_RISK_SCOPE: { exclude_demo_samples: true },
  riskApi: {
    async listRisks(query) { calls.push(query); now = Date.parse('2026-10-09T16:00:01Z'); return { total: 3 }; },
    async spaceRiskSummary(query) { calls.push(query); return { routes_involved: { value: 2 } }; }
  }
});
vm.runInContext(code, context);
await context.loadRiskKpis();
assert.equal(calls.length, 6);
for (const query of calls) {
  assert.equal(query.occurred_from, Date.parse('2026-10-08T16:00:00Z'));
  assert.equal(query.occurred_to, Date.parse('2026-10-09T16:00:00Z'));
  assert.equal(query.exclude_demo_samples, true);
}
assert.equal(context.routesSummary.value.value, 2);
calls.length = 0;
await context.loadRiskKpis();
for (const query of calls) assert.equal(query.occurred_from, Date.parse('2026-10-09T16:00:00Z'));
// Failed reads remain unknown rather than becoming zero or yesterday's route total.
context.riskApi.listRisks = async () => { throw new Error('Forbidden'); };
context.riskApi.spaceRiskSummary = async () => { throw new Error('Forbidden'); };
await context.loadRiskKpis();
assert.equal(context.riskKpiTotals.value.all, undefined);
assert.equal(context.riskKpiFailed.value.all, true);
assert.equal(context.routesSummary.value.state, 'error');
assert.equal(context.routesSummary.value.value, null);
console.log('通过：六项统计同一北京时间窗口、跨日请求一致、次日刷新及失败不补零');
