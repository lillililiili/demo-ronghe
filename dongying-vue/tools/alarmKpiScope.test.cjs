const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

/* OBS-15：统计卡"今日告警 10"与"待核实 14"对不上——待核实那张卡当初不带日期条件，数的是全部历史。
   告警类的卡必须同一口径（同一个北京时间自然日的发生时间），并各自写明自己数的是什么。 */
/* totals(query) 给出这次计数的结果；默认今天没有演示告警。 */
function loadKpis(recorded, totals = query => query.source_mode === 'mock' ? 0 : query.state ? 4 : 10) {
  const source = readFileSync(path.join(__dirname, '../src/pages/AlarmsPage.vue'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('const KPI_DEFS = [');
  const body = source.slice(start, source.indexOf('\n}\n', source.indexOf('async function loadKpis()')) + 3);
  const listAlarms = query => { recorded.push(query); return Promise.resolve(totals(query)).then(total => ({ total })); };
  const disposalApi = { list: () => Promise.resolve({ total: 1 }) };
  const names = ['ref', 'listAlarms', 'disposalApi', 'DISPOSAL_ACTIVE', 'isDisposalUnavailable', 'DISPOSAL_UNAVAILABLE_TEXT', 'esc', 'messageOf', 'U',
    'PENDING_DISPOSAL_QUERY'];
  const values = [value => ({ value }), listAlarms, disposalApi, ['APPROVED', 'EXECUTING'], () => false, '处置授权功能暂不可用',
    String, error => String(error), { num: value => String(value) },
    new Function(`${source.match(/^const PENDING_DISPOSAL_QUERY = .*;$/m)[0]} return PENDING_DISPOSAL_QUERY;`)()];
  return new Function(...names, body + '; return { run: loadKpis, kpiList };')(...values);
}

test('every alarm statistic card counts the same Beijing day and says so', async () => {
  const recorded = [];
  const { run, kpiList } = loadKpis(recorded);
  await run();

  const alarmQueries = recorded.filter(q => q.occurred_from != null && q.source_mode == null);
  assert.equal(alarmQueries.length, 4, '今日总数、待核实、已确认、误报四张卡都按发生时间统计');
  const demoQueries = recorded.filter(q => q.occurred_from != null && q.source_mode === 'mock');
  const windows = new Set([...alarmQueries, ...demoQueries].map(q => `${q.occurred_from}-${q.occurred_to}`));
  assert.equal(windows.size, 1, '四张卡和要扣掉的演示告警必须用同一个时间窗口，否则两个数对不上');
  const [{ occurred_from: from, occurred_to: to }] = alarmQueries;
  assert.equal(to - from, 86400000, '窗口是一个自然日');
  assert.equal((from + 8 * 3600000) % 86400000, 0, '自然日按北京时间切分');
  assert.deepEqual(alarmQueries.map(q => q.state || ''), ['', 'PENDING_VERIFICATION', 'CONFIRMED', 'FALSE_POSITIVE']);
  assert.deepEqual(demoQueries.map(q => q.state || ''), ['', 'PENDING_VERIFICATION', 'CONFIRMED', 'FALSE_POSITIVE'],
    '每张今日卡各数一遍同状态的演示告警');
  assert.equal(recorded.filter(q => q.source_mode != null && q.source_mode !== 'mock').length, 0, '设备模拟器（回放）和真实设备的告警不另外扣');

  const cards = kpiList.value;
  const byLabel = Object.fromEntries(cards.map(card => [card.label, card]));
  assert.equal(byLabel['今日告警总数'].value, '10');
  assert.equal(byLabel['今日待核实'].value, '4', '待核实数的是今天的告警，不是全部历史');
  for (const label of ['今日告警总数', '今日待核实', '今日已确认', '今日误报']) {
    assert.equal(byLabel[label].caption, '按发生时间统计');
    assert.match(byLabel[label].desc, /北京时间今天/);
  }
  for (const label of ['当前反制中', '当前干扰中']) assert.equal(byLabel[label].caption, '实时状态');

  // "待处置"不限日期：属实且处置还没结束的告警，与列表"待处置"筛选同一个后端分组口径。
  const pending = recorded.filter(q => q.occurred_from == null && q.attention_group);
  assert.deepEqual(pending.map(q => [q.state, q.attention_group]), [['CONFIRMED', 'CURRENT,AWAITING_CONFIRMATION']]);
  assert.equal(byLabel['待处置'].caption, '实时，不限日期');
  assert.equal(byLabel['待处置'].value, '4');
});

/* 新-2（D-4）：告警页今日四张卡和大屏同一口径——系统自带的演示告警（来源“模拟”）不算，设备模拟器的告警照算；
   卡片下面写明另有几条演示告警没算进来，列表里仍能看到它们。 */
test('today cards leave out the built-in demo alarms and say how many were left out', async () => {
  const recorded = [];
  const { run, kpiList } = loadKpis(recorded, query => query.source_mode === 'mock' ? (query.state ? 1 : 3) : query.state ? 4 : 10);
  await run();
  const byLabel = Object.fromEntries(kpiList.value.map(card => [card.label, card]));
  assert.equal(byLabel['今日告警总数'].value, '7');
  assert.equal(byLabel['今日告警总数'].caption, '另有演示告警 3 条未计入');
  for (const label of ['今日待核实', '今日已确认', '今日误报']) {
    assert.equal(byLabel[label].value, '3', label);
    assert.equal(byLabel[label].caption, '另有演示告警 1 条未计入', label);
  }
  for (const label of ['今日告警总数', '今日待核实', '今日已确认', '今日误报']) {
    assert.match(byLabel[label].desc, /北京时间今天/);
    assert.match(byLabel[label].desc, /演示告警（来源标“模拟”）不算/);
    assert.match(byLabel[label].desc, /设备模拟器产生的告警（来源标“回放”）照算/);
  }
  assert.equal(byLabel['待处置'].value, '4', '待处置不按日期，也不在这次改动里');
});

test('if the demo count cannot be read the card shows all sources and says it may include demo alarms', async () => {
  const { run, kpiList } = loadKpis([], query => query.source_mode === 'mock' ? Promise.reject(new Error('网络中断')) : query.state ? 4 : 10);
  await run();
  const byLabel = Object.fromEntries(kpiList.value.map(card => [card.label, card]));
  assert.equal(byLabel['今日告警总数'].value, '10');
  assert.equal(byLabel['今日待核实'].value, '4');
  for (const label of ['今日告警总数', '今日待核实', '今日已确认', '今日误报']) {
    assert.equal(byLabel[label].caption, '可能含演示告警', label);
    assert.match(byLabel[label].desc, /演示告警数读取失败（Error: 网络中断）/, label);
  }
});

test('if the card count itself cannot be read the card shows a dash, never a demo-only number', async () => {
  const { run, kpiList } = loadKpis([], query => query.source_mode == null && query.state === 'CONFIRMED' && query.occurred_from != null
    ? Promise.reject(new Error('超时')) : query.source_mode === 'mock' ? 1 : query.state ? 4 : 10);
  await run();
  const card = kpiList.value.find(k => k.label === '今日已确认');
  assert.equal(card.value, '—');
  assert.equal(card.caption, '按发生时间统计');
  assert.match(card.desc, /^读取失败/);
});
