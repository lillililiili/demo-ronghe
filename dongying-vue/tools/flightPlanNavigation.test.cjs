const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync('src/pages/FlightsPage.vue', 'utf8');
const load = source.slice(source.indexOf('async function loadPlans('), source.indexOf('\nlet planDetailToken'));
function setup({ denied = false, missing = false, target = 'p25' } = {}) {
  const rows = Array.from({ length: 42 }, (_, i) => ({ plan_id: `p${i + 1}` }));
  const calls = [];
  const ctx = { planListToken: 0, planDetailToken: 0, trajectoryToken: 0, planFailure: null, S: { selectedPlanId: target }, JSON,
    filters: {}, planListQuery: (f, p) => ({ ...f, ...p }), nextTick: async () => {},
    flightApi: {
      list: async q => { calls.push(q); return { page: q.page, total: rows.length, items: rows.slice((q.page - 1) * q.size, q.page * q.size) }; },
      detail: async id => { if (denied || missing) throw Object.assign(new Error('unavailable'), { status: denied ? 403 : 404 }); return rows.find(row => row.plan_id === id); }
    },
    loadRowActuals() {}, loadPlanKpis() {}, loadUpstreamStatus() {}, destroyRouteMap() {},
    syncSelectedPlanHash(id) { ctx.hashId = id; },
    async loadDetail(id, plan) { ctx.selected.value = plan || await ctx.flightApi.detail(id); ctx.S.selectedPlanId = id; }
  };
  for (const [key, value] of Object.entries({ page: 1, size: 20, total: 0, plans: [], selected: null,
    activeTab: 'route', routeLoaded: false, loading: false, detailLoading: false, error: '', detailError: '', routeVersion: null,
    airspaceVersions: [], conflicts: [], routeGeometryError: '', airspaceError: '', planList: null })) ctx[key] = { value };
  vm.createContext(ctx); vm.runInContext(load, ctx);
  return { ctx, calls };
}
(async () => {
  const { ctx, calls } = setup();
  await ctx.loadPlans(1, 'p25');
  assert.equal(ctx.total.value, 42, '关联跳转保留全部任务总数');
  assert.equal(ctx.page.value, 2, '自动进入目标所在页');
  assert.equal(ctx.plans.value.length, 20, '同页其他任务保留');
  assert.equal(ctx.selected.value.plan_id, 'p25');
  await ctx.loadPlans(2, null, { quiet: true });
  assert.equal(ctx.selected.value.plan_id, 'p25', '刷新保留选中任务和完整列表');
  await ctx.loadPlans(3);
  assert.equal(ctx.page.value, 3); assert.equal(ctx.selected.value.plan_id, 'p41', '翻页后不被关联目标锁住');
  assert.equal(calls.length, 4);
  const bad = setup({ denied: true });
  await bad.ctx.loadPlans(1, 'p25');
  assert.equal(bad.ctx.total.value, 42, '关联任务无权限不阻断普通列表');
  assert.equal(bad.ctx.selected.value, null, '不得用其他任务冒充关联任务');
  assert.match(bad.ctx.detailError.value, /无权/);
  const missing = setup({ missing: true });
  await missing.ctx.loadPlans(1, 'p25');
  assert.equal(missing.ctx.plans.value.length, 20);
  assert.equal(missing.ctx.selected.value, null);
  assert.match(missing.ctx.detailError.value, /不存在/);
  const stale = setup();
  stale.ctx.flightApi.detail = async () => { stale.ctx.planListToken++; return { plan_id: 'p25' }; };
  await stale.ctx.loadPlans(1, 'p25');
  assert.equal(stale.calls.length, 0, '离开页面或新查询作废旧定位');
  console.log('flight plan navigation: passed');
})();
