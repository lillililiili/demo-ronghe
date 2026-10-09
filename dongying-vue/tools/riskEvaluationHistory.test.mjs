import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import * as helpers from '../src/ui/riskEvaluationHistory.js';

// P03：鸟群风险详情里的“评估历史”一栏——文字怎么写，以及什么时候显示、怎么跟着实时信号重读。
const NOW = Date.parse('2026-10-08T12:00:00Z'); // 北京时间 10 月 8 日 20:00
const segment = (fields = {}) => ({ segment_no: 1, first_evaluated_at: Date.parse('2026-10-08T11:50:00Z'), last_evaluated_at: Date.parse('2026-10-08T11:54:00Z'),
  evaluation_count: 5, distance_band_m: 100, min_distance_m: 120.4, max_distance_m: 138.6, corridor_relation: 'NEAR', altitude_band: 'CLIMB',
  risk_present: true, severity: 'MEDIUM', ...fields });

test('each segment reads as time, distance to the route, corridor, altitude band and whether it was a risk', () => {
  assert.equal(helpers.segmentTimeText(segment(), NOW), '19:50:00–19:54:00');
  assert.equal(helpers.segmentTimeText(segment({ evaluation_count: 1, last_evaluated_at: Date.parse('2026-10-08T11:50:00Z') }), NOW), '19:50:00');
  assert.equal(helpers.segmentTimeText(segment({ first_evaluated_at: Date.parse('2026-10-07T01:02:03Z'), last_evaluated_at: Date.parse('2026-10-07T01:05:03Z') }), NOW),
    '10月7日 09:02:03–09:05:03');
  assert.equal(helpers.segmentFactsText(segment()), '离航线中心线约 120–139 米 · 邻近航线 · 起降爬升段');
  assert.equal(helpers.segmentFactsText(segment({ min_distance_m: '20.00', max_distance_m: '20.40', corridor_relation: 'INSIDE' })), '离航线中心线约 20 米 · 航线走廊内 · 起降爬升段');
  assert.equal(helpers.segmentFactsText(segment({ min_distance_m: null, max_distance_m: null, distance_band_m: null, corridor_relation: 'UNKNOWN', altitude_band: 'UNKNOWN' })),
    '离航线距离未测到 · 高度未知');
  assert.deepEqual(helpers.segmentVerdict(segment({ severity: 'HIGH' })), { text: '高风险', tag: 't-red' });
  assert.deepEqual(helpers.segmentVerdict(segment({ risk_present: false, severity: null, corridor_relation: 'OUTSIDE' })), { text: '不构成风险', tag: 't-gray' });
});

test('the top line counts every evaluation and older risks say their first evaluation was never kept', () => {
  const history = { applicable: true, evaluation_count: 8, first_evaluated_at: Date.parse('2026-10-08T11:50:00Z'), last_evaluated_at: Date.parse('2026-10-08T11:58:00Z'),
    from_detection: true, total: 3 };
  assert.equal(helpers.evaluationSummaryText(history, NOW), '共评估 8 次，首次 19:50:00，最近 19:58:00');
  assert.equal(helpers.evaluationSummaryText({ ...history, evaluation_count: 0 }, NOW), '');
  assert.equal(helpers.evaluationHistoryNote(history), '');
  assert.match(helpers.evaluationHistoryNote({ ...history, from_detection: false }), /发现那次的评估没有记录，下面是之后的评估/);
  assert.match(helpers.evaluationHistoryNote({ ...history, from_detection: false, total: 0 }), /之后还没有再评估过/);
  assert.equal(helpers.evaluationHistoryNote({ applicable: false, from_detection: false, total: 0 }), '');
  assert.match(helpers.EVALUATION_LEVEL_NOTE, /不会自动改等级/);
});

const source = await readFile(new URL('../src/pages/flights/components/RiskEvaluationHistory.vue', import.meta.url), 'utf8');
const compiled = compileScript(parse(source).descriptor, { id: 'risk-evaluation-history' }).content;
const imports = [...compiled.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"];?/g)];
const bindings = imports.flatMap(match => match[1].startsWith('{')
  ? match[1].slice(1, -1).split(',').map(name => name.trim().replace(/\s+as\s+/, ':'))
  : [match[1].trim()]);
const setupCode = compiled.replace(/import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?/g, '').replace('export default', 'return');
const makeComponent = new Function('deps', `const {${bindings.join(',')}} = deps;\n${setupCode}`);
const renderer = Vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} });
const page = (fields = {}) => ({ applicable: true, evaluation_count: 12, first_evaluated_at: NOW - 600_000, last_evaluated_at: NOW - 60_000, from_detection: true,
  items: [segment()], page: 1, size: 10, total: 12, ...fields });

async function flush() {
  for (let i = 0; i < 8; i++) await Vue.nextTick();
}

function fixture() {
  const requests = [], realtime = [], selected = Vue.ref('risk-a');
  const deps = Object.fromEntries(bindings.map(name => [name, {}]));
  Object.assign(deps, Vue, helpers, {
    riskApi: { getEvaluationHistory: (id, params) => new Promise((resolve, reject) => requests.push({ id, params, resolve, reject })) },
    useRealtimeRefresh: (topics, reload) => { realtime.push({ topics, reload }); return { trigger() {} }; },
    refreshFailureText: (error, fallback) => error?.message || fallback
  });
  const component = makeComponent(deps);
  component.render = () => null;
  const app = renderer.createApp({ setup: () => () => Vue.h(component, { riskId: selected.value }) });
  app.mount({});
  return { app, requests, realtime, selected, state: app._instance.subTree.component.setupState };
}

test('the section stays out of the way until the first answer and for risks that keep no evaluation history', async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.realtime.map(item => item.topics), [['risk_evaluation']]);
    assert.deepEqual(f.requests.map(item => [item.id, item.params]), [['risk-a', { page: 1, size: 10 }]]);
    assert.equal(f.state.visible, false, 'nothing is shown before the first answer');
    f.requests[0].resolve(page({ applicable: false, evaluation_count: 0, items: [], total: 0, from_detection: false }));
    await flush();
    assert.equal(f.state.visible, false);
    await f.realtime[0].reload(['risk_evaluation']);
    assert.equal(f.requests.length, 1, 'airport-zone and weather risks do not re-read on every evaluation signal');
  } finally { f.app.unmount(); }
});

test('a bird risk shows its segments, pages through them and re-reads the current page on each evaluation signal', async () => {
  const f = fixture();
  try {
    f.requests[0].resolve(page());
    await flush();
    assert.equal(f.state.visible, true);
    assert.equal(f.state.rows.length, 1);
    assert.equal(f.state.rows[0].facts, '离航线中心线约 120–139 米 · 邻近航线 · 起降爬升段');
    assert.equal(f.state.pageCount, 2);
    const next = f.state.load(2);
    assert.deepEqual(f.requests[1].params, { page: 2, size: 10 });
    f.requests[1].resolve(page({ page: 2, items: [segment({ segment_no: 11 }), segment({ segment_no: 12, risk_present: false, severity: null })] }));
    await next;
    assert.equal(f.state.page, 2);
    assert.deepEqual(f.state.rows.map(row => row.verdict.text), ['中风险', '不构成风险']);

    const refresh = f.realtime[0].reload(['risk_evaluation']);
    assert.deepEqual(f.requests[2].params, { page: 2, size: 10 }, 'the signal re-reads the page the user is on');
    f.requests[2].reject(Object.assign(new Error('服务暂时不可用'), { status: 503 }));
    await assert.rejects(refresh, 'a failed silent refresh goes back to the realtime hook for a retry');
    assert.equal(f.state.rows.length, 2, 'what was shown stays on screen');
    assert.equal(f.state.error, '');
    assert.match(f.state.refreshError, /自动刷新失败：服务暂时不可用/);
  } finally { f.app.unmount(); }
});

test('a late answer for the previous risk is dropped and a failed first read offers a retry', async () => {
  const f = fixture();
  try {
    f.selected.value = 'risk-b';
    await flush();
    assert.deepEqual(f.requests.map(item => item.id), ['risk-a', 'risk-b']);
    f.requests[0].resolve(page({ evaluation_count: 99 }));
    await flush();
    assert.equal(f.state.history, null);
    f.requests[1].reject(Object.assign(new Error('暂时连不上系统'), { code: 'NETWORK_ERROR' }));
    await flush();
    assert.equal(f.state.visible, true, 'a failed first read still shows the section with the reason');
    assert.equal(f.state.error, '暂时连不上系统');
    const retry = f.state.load(1);
    f.requests[2].resolve(page({ evaluation_count: 3, total: 1 }));
    await retry;
    assert.equal(f.state.error, '');
    assert.match(f.state.summary, /^共评估 3 次，首次 .+，最近 .+$/);
  } finally { f.app.unmount(); }
});
