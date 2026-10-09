const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

/* ZT-17 与 2026-10-07 用户决定：大屏统计卡与运行统计同一口径，由后台决定计入哪些来源——
   允许模拟的环境算真实设备和设备模拟器的数据，正式环境只算真实设备，系统自带的演示样例都不算。
   页面不再自己按来源拼查询（免得口径两处各写一份），并且写明其中有多少来自设备模拟器。 */
const read = file => readFileSync(path.join(__dirname, '../src/pages/bigscreen', file), 'utf8');
const source = read('BigScreenApp.vue');
const bottom = read('BigScreenBottomStats.vue');

test('every count on the big screen comes from the backend statistics scope', () => {
  // 页面自己不按来源过滤；计数都来自快照或按统计口径的接口。
  assert.doesNotMatch(source, /source_mode: '/, '页面不能自己按来源拼查询');
  assert.match(source, /'\/device-monitor\/overview\?statistics_scope=true'/, '设备类型与设备总数同一统计口径');
  assert.doesNotMatch(source, /formal_only/);
  // 已完成计划随快照给出，与今日计划、执行中同一口径。
  assert.match(source, /snapshot\.value\?\.flights\?\.completed/);
  assert.doesNotMatch(source, /\/flight-plans\?/);
});

test('the big screen says the simulator is counted and how much of the cards came from it', () => {
  const scope = source.match(/const kpiScope = computed\(\(\) => \{.*?\n\}\);/s);
  assert.ok(scope, '找不到统计口径说明');
  assert.match(scope[0], /simulatorCounted/, '口径说明按后台给的计入来源来写');
  assert.match(source, /statistics_source_modes/);
  assert.match(scope[0], /真实设备和设备模拟器的数据都算，系统自带的演示样例不算/);
  assert.match(scope[0], /只算真实设备的数据/, '正式环境不能写成"模拟器也算"');
  assert.match(scope[0], /simulated_included/, '来自模拟器的条数取自后台的 simulated_included');
  assert.match(scope[0], /其中来自设备模拟器/);
  for (const field of ['sensed_today', 'alarms_today', 'flights_today', 'devices']) {
    assert.match(source, new RegExp(`'${field}'`), `${field} 必须出现在模拟器条数里`);
  }
  assert.match(source, /class="bs-kpi-scope"/, '口径说明要显示在统计卡旁边，不能只写在注释里');
});

test('old wording that no longer matches the scope is gone', () => {
  for (const text of [source, bottom]) {
    assert.doesNotMatch(text, /只计正式接入|另有模拟|演示数据/);
  }
  assert.match(bottom, /含设备模拟器的数据/);
});

test('the risk panel counts today\'s targets in the same five tiers as the statistics page (ZT-17 retest 2)', () => {
  const risk = source.match(/const riskItems = computed\(\(\) => \{.*?\n\}\);/s);
  assert.ok(risk, '找不到风险分档');
  assert.deepEqual([...risk[0].matchAll(/name: '([^']+)'/g)].map(match => match[1]),
    ['超高风险', '高风险', '中风险', '低风险', '未识别'], '与运行统计"各异物风险等级分布"同一套分档');
  assert.match(risk[0], /r\.critical/);
  assert.doesNotMatch(source, /未定级|'重点目标'/, '中间的数是今日目标，不再是抽样的"重点目标"');
  assert.match(source, /'今日目标'/);
  const summary = source.match(/const targetSummary = computed\(\(\) => \{.*?\n\}\);/s);
  assert.ok(summary);
  assert.match(summary[0], /dataState\(avail\('targets'\) \? 'risks' : 'targets'\)/, '没有风险读取权限时写明原因');
});
