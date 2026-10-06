const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

/* OBS-15：统计卡"今日告警 10"与"待核实 14"对不上——待核实那张卡当初不带日期条件，数的是全部历史。
   告警类的卡必须同一口径（同一个北京时间自然日的发生时间），并各自写明自己数的是什么。 */
function loadKpis(recorded) {
  const source = readFileSync(path.join(__dirname, '../src/pages/AlarmsPage.vue'), 'utf8');
  const start = source.indexOf('const KPI_DEFS = [');
  const body = source.slice(start, source.indexOf('\n}\n', source.indexOf('async function loadKpis()')) + 3);
  const listAlarms = query => { recorded.push(query); return Promise.resolve({ total: query.state ? 4 : 10 }); };
  const disposalApi = { list: () => Promise.resolve({ total: 1 }) };
  const names = ['ref', 'listAlarms', 'disposalApi', 'DISPOSAL_ACTIVE', 'isDisposalUnavailable', 'DISPOSAL_UNAVAILABLE_TEXT', 'esc', 'messageOf', 'U'];
  const values = [value => ({ value }), listAlarms, disposalApi, ['APPROVED', 'EXECUTING'], () => false, '处置授权功能暂不可用',
    String, error => String(error), { num: value => String(value) }];
  return new Function(...names, body + '; return { run: loadKpis, kpiList };')(...values);
}

test('every alarm statistic card counts the same Beijing day and says so', async () => {
  const recorded = [];
  const { run, kpiList } = loadKpis(recorded);
  await run();

  const alarmQueries = recorded.filter(q => q.occurred_from != null);
  assert.equal(alarmQueries.length, 4, '今日总数、待核实、已确认、误报四张卡都按发生时间统计');
  const windows = new Set(alarmQueries.map(q => `${q.occurred_from}-${q.occurred_to}`));
  assert.equal(windows.size, 1, '四张卡必须用同一个时间窗口，否则两个数对不上');
  const [{ occurred_from: from, occurred_to: to }] = alarmQueries;
  assert.equal(to - from, 86400000, '窗口是一个自然日');
  assert.equal((from + 8 * 3600000) % 86400000, 0, '自然日按北京时间切分');
  assert.deepEqual(alarmQueries.map(q => q.state || ''), ['', 'PENDING_VERIFICATION', 'CONFIRMED', 'FALSE_POSITIVE']);

  const cards = kpiList.value;
  const byLabel = Object.fromEntries(cards.map(card => [card.label, card]));
  assert.equal(byLabel['今日告警总数'].value, '10');
  assert.equal(byLabel['今日待核实'].value, '4', '待核实数的是今天的告警，不是全部历史');
  for (const label of ['今日告警总数', '今日待核实', '今日已确认', '今日误报']) {
    assert.equal(byLabel[label].caption, '按发生时间统计');
    assert.match(byLabel[label].desc, /北京时间今天/);
  }
  for (const label of ['当前反制中', '当前干扰中']) assert.equal(byLabel[label].caption, '实时状态');
});
