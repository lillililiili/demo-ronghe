const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const overview = () => ({ today: { total: 10, pending_verification: 4, confirmed: 5, false_positive: 1 },
  excluded_mock: { total: 0, pending_verification: 0, confirmed: 0, false_positive: 0 }, pending_disposal: 7,
  occurred_from: Date.UTC(2026, 8, 10, 16), occurred_to: Date.UTC(2026, 8, 11, 16) });
async function harness(read = async () => overview(), { readDisposal = async () => ({ total: 1 }), readable = true } = {}) {
  const { canReadProgressSource } = await import('../src/pages/alarms/progressAccess.js');
  const source = readFileSync(path.join(__dirname, '../src/pages/AlarmsPage.vue'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('const KPI_DEFS = [');
  const body = source.slice(start, source.indexOf('\n}\n', source.indexOf('async function loadKpis()')) + 3);
  const calls = { overview: 0, list: 0, disposal: 0, disposalQueries: [], scheduled: 0 };
  const deps = { ref: value => ({ value }), getAlarmOverview: () => { calls.overview++; return Promise.resolve().then(read); },
    listAlarms: () => { calls.list++; throw new Error('统计不得回退列表扫描'); },
    disposalApi: { list: async query => { calls.disposal++; calls.disposalQueries.push(query); return readDisposal(query); } },
    DISPOSAL_ACTIVE: ['APPROVED', 'EXECUTING'], isDisposalUnavailable: () => false,
    DISPOSAL_UNAVAILABLE_TEXT: '处置授权功能暂不可用', esc: String, messageOf: String,
    U: { num: String }, canReadProgressSource, hasPermission: () => readable,
    realtimeKpis: () => { calls.scheduled++; } };
  return { calls, ...new Function(...Object.keys(deps), body + '; return { run: loadKpis, kpiList, leave: () => { kpiActive = false; } };')(...Object.values(deps)) };
}
const cards = page => Object.fromEntries(page.kpiList.value.map(card => [card.label, card]));

test('今日四卡共用一次服务端北京时间聚合，待处置不限日期，授权记录维持独立口径', async () => {
  const page = await harness(); await page.run(); const value = cards(page);
  assert.equal(page.calls.overview, 1); assert.equal(page.calls.list, 0); assert.equal(page.calls.disposal, 5);
  assert.equal(value['今日告警总数'].value, '10'); assert.equal(value['今日待核实'].value, '4');
  assert.equal(value['今日已确认'].value, '5'); assert.equal(value['今日误报'].value, '1');
  for (const label of ['今日告警总数', '今日待核实', '今日已确认', '今日误报']) {
    assert.equal(value[label].caption, '按发生时间统计'); assert.match(value[label].desc, /北京时间今天/);
  }
  assert.equal(value['待处置'].caption, '实时，不限日期'); assert.equal(value['待处置'].value, '7');
  assert.equal(value['执行中反制'].value, '2'); assert.equal(value['已完成反制'].value, '1');
  assert.equal(page.kpiList.value.length, 7);
  assert.ok(page.kpiList.value.every(card => !/记录|执行中干扰/.test(card.label)));
});

test('执行中反制合计两类执行记录，待执行与已完成保持独立', async () => {
  for (const [counter, jamming] of [[2, 5], [0, 9], [0, 0]]) {
    const page = await harness(undefined, { readDisposal: async query => ({ total: query.status === 'COMPLETED' ? 13
      : query.status === 'APPROVED' ? (query.action_type === 'COUNTERMEASURE' ? 3 : 4)
      : query.action_type === 'COUNTERMEASURE' ? counter : jamming }) });
    await page.run(); const value = cards(page);
    assert.equal(value['执行中反制'].value, String(counter + jamming));
    assert.match(value['执行中反制'].desc, /7 起已批准待执行/);
    assert.equal(value['已完成反制'].value, '13');
    assert.deepEqual(page.calls.disposalQueries.filter(query => query.status === 'EXECUTING').map(query => query.action_type).sort(),
      ['COUNTERMEASURE', 'JAMMING']);
  }
});

test('任一执行类型读取失败时不展示部分合计，已完成统计仍可读取', async () => {
  for (const failedType of ['COUNTERMEASURE', 'JAMMING']) {
    const page = await harness(undefined, { readDisposal: async query => {
      if (query.action_type === failedType && query.status === 'EXECUTING') throw new Error('处置读取中断');
      return { total: 6 };
    } });
    await page.run(); const value = cards(page);
    assert.equal(value['执行中反制'].value, '—');
    assert.match(value['执行中反制'].desc, /读取失败/);
    assert.equal(value['已完成反制'].value, '6');
  }
});

test('没有处置读取权限时不请求处置统计，合并卡片保留无权提示', async () => {
  const page = await harness(undefined, { readable: false }); await page.run();
  assert.equal(page.calls.disposal, 0);
  for (const label of ['执行中反制', '已完成反制']) {
    assert.equal(cards(page)[label].value, '—');
    assert.match(cards(page)[label].desc, /无权查看/);
  }
});

test('明确排除的旧mock数同次返回，回放来源继续计入', async () => {
  const payload = overview(); payload.excluded_mock = { total: 3, pending_verification: 1, confirmed: 2, false_positive: 0 };
  const page = await harness(async () => payload); await page.run(); const value = cards(page);
  assert.equal(value['今日告警总数'].value, '7'); assert.equal(value['今日告警总数'].caption, '另有演示告警 3 条未计入');
  assert.equal(value['今日待核实'].value, '3'); assert.equal(value['今日已确认'].value, '3');
  assert.equal(value['今日误报'].value, '1'); assert.equal(value['待处置'].value, '7');
  assert.match(value['今日告警总数'].desc, /系统自带的演示告警不计入$/);
});

test('聚合失败时相关五卡未知，不显示0且不回退九个列表请求', async () => {
  const page = await harness(async () => { throw new Error('网络中断'); }); await page.run(); const value = cards(page);
  for (const label of ['今日告警总数', '今日待核实', '今日已确认', '今日误报', '待处置']) {
    assert.equal(value[label].value, '—'); assert.match(value[label].desc, /读取失败/);
  }
  assert.equal(value['执行中反制'].value, '2'); assert.equal(page.calls.overview, 1); assert.equal(page.calls.list, 0);
});

test('缺失、负数和非整数计数不能冒充真实0，其他已知卡仍可展示', async () => {
  for (const bad of [undefined, null, -1, 1.2, '4']) {
    const payload = overview(); payload.today.confirmed = bad;
    const page = await harness(async () => payload); await page.run();
    assert.equal(cards(page)['今日已确认'].value, '—'); assert.equal(cards(page)['今日告警总数'].value, '10');
  }
});

test('聚合读取尚未结束时合并刷新，完成后只安排一次补读', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const page = await harness(() => gate);
  const first = page.run(); const others = Array.from({ length: 15 }, () => page.run());
  await Promise.resolve(); assert.equal(page.calls.overview, 1);
  release(overview()); await Promise.all([first, ...others]);
  assert.equal(page.calls.overview, 1); assert.equal(page.calls.scheduled, 1); assert.equal(page.calls.disposal, 5);
});

test('页面离开后迟到统计不再写卡片或补发刷新', async () => {
  let release; const page = await harness(() => new Promise(resolve => { release = resolve; }));
  const first = page.run(); void page.run(); await Promise.resolve(); page.leave(); release(overview()); await first;
  assert.ok(page.kpiList.value.every(card => card.value === '读取中')); assert.equal(page.calls.scheduled, 0);
});
