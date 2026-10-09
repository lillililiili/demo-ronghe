/* 飞行任务列表（OBS-02 / ZT-21）：按编号搜索、统计卡筛选、同名任务可区分、实时刷新保留筛选、上级任务接口不可用提示；其他页面的任务下拉。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const F = await import('../src/pages/flights/planFilters.js');

  // 北京时间今天：2026-10-06 00:30（北京）仍属 10 月 6 日；窗口与机器时区无关。
  const now = Date.parse('2026-10-05T16:30:00Z');
  assert.deepEqual(F.beijingDayWindow(now), { from: Date.parse('2026-10-05T16:00:00Z'), to: Date.parse('2026-10-06T16:00:00Z') });
  assert.deepEqual(F.beijingDayWindow(Date.parse('2026-10-05T15:59:59Z')), { from: Date.parse('2026-10-04T16:00:00Z'), to: Date.parse('2026-10-05T16:00:00Z') });

  // 关键词去首尾空格、截断到后端上限；空关键词不发送（flightApi 丢弃空串）。
  assert.equal(F.normalizePlanKeyword('  计划-0911-105 '), '计划-0911-105');
  assert.equal(F.normalizePlanKeyword(null), '');
  assert.equal(F.normalizePlanKeyword('x'.repeat(200)).length, 128);
  assert.deepEqual(F.planListQuery({ status_code: 'EXECUTING', keyword: ' EXT-SIM ' }, { page: 2, size: 20, now }),
    { page: 2, size: 20, status_code: 'EXECUTING', keyword: 'EXT-SIM' });
  assert.deepEqual(F.planListQuery({ status_code: '', keyword: '', today: true }, { page: 1, size: 20, now }),
    { page: 1, size: 20, status_code: '', keyword: '', window_from: Date.parse('2026-10-05T16:00:00Z'), window_to: Date.parse('2026-10-06T16:00:00Z') });

  // 统计卡：点“执行中”只看今天执行中的计划并清空关键词；当前筛选决定哪张卡高亮；再点一次恢复全部。
  const executing = F.planKpiFilters({ status_code: '', keyword: '0911', today: false }, 'executing');
  assert.deepEqual(executing, { status_code: 'EXECUTING', keyword: '', today: true });
  assert.equal(F.activePlanKpi(executing), 'executing');
  assert.equal(F.activePlanKpi({ ...executing, keyword: '0911' }), 'executing');
  assert.equal(F.activePlanKpi({ status_code: 'EXECUTING', today: false }), null);
  assert.equal(F.activePlanKpi({ status_code: 'CANCELLED', today: true }), null);
  assert.equal(F.activePlanKpi({ status_code: '', today: true }), 'today');
  assert.deepEqual(F.planKpiFilters(executing, 'executing'), { status_code: '', keyword: '', today: false });
  assert.deepEqual(F.planKpiFilters(executing, 'pending'), { status_code: 'PENDING', keyword: '', today: true });
  assert.deepEqual(F.planKpiFilters(executing, 'unmatched'), executing);
  assert.deepEqual(Object.keys(F.PLAN_KPI_STATUS), ['today', 'executing', 'pending', 'completed']);

  // 同名计划：编号与北京时间时段区分；内部 ID 不上屏。
  const start = Date.parse('2026-10-05T01:21:05Z');
  assert.equal(F.planWindowText({ start_at: start, end_at: start + 3_600_000 }), '2026/10/5 09:21–10:21');
  assert.equal(F.planWindowText({ start_at: Date.parse('2026-10-05T15:30:00Z'), end_at: Date.parse('2026-10-05T16:30:00Z') }), '2026/10/5 23:30 – 2026/10/6 00:30');
  assert.equal(F.planWindowText({ start_at: null, end_at: start }), '任务时段未提供');
  assert.equal(F.planNumberText({ plan_no: '计划-0911-105' }), '计划-0911-105');
  assert.equal(F.planNumberText({ plan_no: '6a39f0c2-1111-4222-8333-944455556666' }), '编号未提供');
  assert.equal(F.planNumberText({}), '编号未提供');

  // 任务下拉（合法性研判等）：默认只查结束时间不早于现在的任务，勾“含已过期”才不带时间窗；
  // 每项显示“航线名称（编号）· 月/日 时:分”，没有航线名称时只显示编号。
  assert.deepEqual(F.planPickerQuery({ now }), { page: 1, size: 100, window_from: now, window_to: now + 366 * 86_400_000 });
  assert.deepEqual(F.planPickerQuery({ includeExpired: true, now }), { page: 1, size: 100 });
  const pickPlan = { plan_id: 'p-1', plan_no: 'FP-20261008-001', route: { name: ' 东营港巡检 ' }, start_at: start };
  assert.equal(F.planPickerLabel(pickPlan), '东营港巡检（FP-20261008-001） · 10/5 09:21');
  assert.equal(F.planPickerLabel({ ...pickPlan, route: null }), 'FP-20261008-001 · 10/5 09:21');
  assert.equal(F.planPickerLabel({ ...pickPlan, start_at: null }), '东营港巡检（FP-20261008-001）');
  assert.deepEqual(F.planPickerItems([{ status_code: 'CANCELLED' }, { status_code: 'EXECUTING' }]), [{ status_code: 'EXECUTING' }]);
  assert.equal(F.planPickerItems([{ status_code: 'CANCELLED' }], { includeExpired: true }).length, 1);

  // 上级任务接口不可用：说清取不到、原因与最近一次收到；可用或状态读不到时不提示。
  const time = value => `T${value}`;
  assert.equal(F.upstreamPlanNotice(null, time), null);
  assert.equal(F.upstreamPlanNotice({ available: true, status: 'CONNECTED' }, time), null);
  const missing = F.upstreamPlanNotice({ status: 'NOT_CONFIGURED', available: false, message: '管服平台任务接口尚未配置，上级任务数据暂时取不到' }, time);
  assert.equal(missing.title, '上级任务数据暂时取不到');
  assert.match(missing.detail, /^管服平台任务接口尚未配置；尚未收到过上级任务。/);
  assert.match(missing.detail, /下方列表只含本系统已有的任务（模拟或本地录入），可能不全或已过时，不代表上级没有任务。$/);
  const waiting = F.upstreamPlanNotice({ status: 'AWAITING_ADAPTER', available: false, configured_at: 5, last_received_at: 7 }, time);
  assert.match(waiting.detail, /^管服平台任务接口已于 T5 保存配置，但尚未接通；最近一次收到上级任务：T7。下方列表为本系统已有的任务（含此前收到的上级任务），/);
  const unknown = F.upstreamPlanNotice({ status: 'FAILING', available: false, message: '管服平台任务接口连接失败，上级任务数据暂时取不到' }, time);
  assert.match(unknown.detail, /^管服平台任务接口连接失败；尚未收到过上级任务。/);

  // 页面接线：列表、定时重读与实时刷新共用同一筛选；统计卡可点击并高亮；行内显示计划编号与时段；状态变化不再经 watch 抢先重读。
  const page = fs.readFileSync(path.join(__dirname, '../src/pages/FlightsPage.vue'), 'utf8');
  const pageReads = page.match(/flightApi\.list\([^)]*\)/g) || [];
  // 统计卡只读 total；列表首读、翻页/定时重读与实时刷新都必须带同一份筛选。
  assert.deepEqual(pageReads.filter(call => !call.includes('size: 1')), [
    'flightApi.list(planListQuery(filters, { page: nextPage, size: size.value })',
    'flightApi.list(planListQuery(filters, { page: page.value, size: size.value })'
  ]);
  // 页面整份源码很长，断言失败时只报缺了哪条接线，不把整页打印出来。
  const has = (re, what) => assert.ok(re.test(page), `FlightsPage.vue 缺少：${what}`);
  const lacks = (re, what) => assert.ok(!re.test(page), `FlightsPage.vue 不应再有：${what}`);
  has(/async function realtimeRefreshPlans[\s\S]*?planListQuery\(filters, \{ page: page\.value, size: size\.value \}\)/, '实时刷新按当前筛选重读');
  lacks(/status_code: filters\.status_code \}/, '只带状态、丢掉关键词的列表请求');
  lacks(/watch\(\(\) => filters\.status_code/, '状态 watch 抢先重读');
  has(/@update:model-value="chooseStatus"/, '状态下拉直接查询');
  has(/@keyup\.enter="applyKeyword"/, '关键词回车查询');
  has(/:maxlength="PLAN_KEYWORD_MAX"/, '搜索框长度与后端上限一致');
  has(/<UKpis :list="kpiList" @click="onPlanKpiClick" @keydown="onPlanKpiKeydown" \/>/, '统计卡点击与键盘操作');
  has(/chosen = activePlanKpi\(filters\)/, '统计卡高亮按当前筛选判断');
  has(/active: chosen === key, attr: `data-plan-kpi="\$\{key\}" aria-pressed="\$\{chosen === key\}"`/, '统计卡可点击属性与选中状态');
  has(/planNumberText\(plan\)/, '行内计划编号');
  has(/planWindowText\(plan\)/, '行内计划时段');
  has(/upstreamPlanNotice\(/, '上级计划接口不可用提示');
  has(/flightApi\.upstreamStatus\(\)/, '读取上级计划接口状态');
  console.log('全部通过：飞行任务搜索、统计卡筛选、同名任务区分、任务下拉与上级接口提示');
})().catch(error => { console.error(error); process.exitCode = 1; });
