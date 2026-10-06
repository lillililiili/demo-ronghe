const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

/* ZT-17：大屏统计卡原先不分来源，运行统计和大屏趋势只算 live，同一个数两边对不上。
   统计卡（含它自己补读的"已完成"和设备类型两块）必须跟运行统计同口径只计正式接入，
   并且把被排除的模拟/回放条数写在屏幕上，不然演示库里一排 0 看着像功能坏了。 */
const source = readFileSync(path.join(__dirname, '../src/pages/bigscreen/BigScreenApp.vue'), 'utf8');

test('the statistic cards and the counts the big screen reads itself all ask for live only', () => {
  const completed = source.match(/const completedQuery = [^;]+;/s);
  assert.ok(completed, '找不到"已完成"计划的查询');
  assert.match(completed[0], /source_mode: 'live'/, '已完成必须与今日计划同口径');
  assert.match(source, /'\/device-monitor\/overview\?formal_only=true'/, '设备明细也只能数正式接入设备');
  // 快照里的统计类计数由后端按 live 过滤，前端不得再按全部来源自己算一遍。
  assert.doesNotMatch(source, /source_mode: 'mock'|source_mode: 'replay'/);
});

test('the big screen says which rule the statistic cards use and what it left out', () => {
  assert.match(source, /统计口径：只计正式接入数据，与运行统计一致/);
  // 办理队列与待研判按全部来源，必须在同一句里讲清楚，否则两类数字还是会被当成一个口径。
  assert.match(source, /待研判与办理队列按全部来源/);
  const scope = source.match(/const kpiScope = computed\(\(\) => \{.*?\n\}\);/s);
  assert.ok(scope, '找不到统计口径说明');
  assert.match(scope[0], /simulated_excluded/, '被排除的条数取自后端的 simulated_excluded');
  assert.match(scope[0], /另有模拟\/回放/);
  for (const field of ['sensed_today', 'alarms_today', 'flights_today', 'devices']) {
    assert.match(source, new RegExp(`'${field}'`), `${field} 必须出现在被排除计数里`);
  }
  assert.match(source, /class="bs-kpi-scope"/, '口径说明要显示在统计卡旁边，不能只写在注释里');
});
