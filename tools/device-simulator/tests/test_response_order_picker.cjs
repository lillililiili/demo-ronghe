const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const picker = require('../web/flow-picker.js');
const flow = {flow: 1, guide: {prediction_only: true}};
const policy = {ok: true, enabled: true, minimum_risk: 'HIGH', prediction_enabled: true,
  observed_enabled: true, scope_mode: 'ALL', schedule_mode: 'ALL_DAY', max_wait_seconds: 60};

test('policy explanation follows actual enablement, phase, level, scope and waiting duration', () => {
  assert.match(picker.orderLine(null, flow), /暂不可读取/);
  assert.doesNotMatch(picker.orderLine(null, flow), /已启用|短信并行/);
  assert.match(picker.orderLine({response_order: {...policy, enabled: false}}, flow), /未启用，沿用通知优先/);
  assert.match(picker.orderLine({response_order: {...policy, prediction_enabled: false}}, flow), /未纳入优先策略/);
  assert.match(picker.orderLine({response_order: {...policy, observed_enabled: false}}, {flow: 5}), /未纳入优先策略/);
  const standard = picker.orderLine({response_order: policy}, flow);
  assert.match(standard, /高风险，全部空域，全天/);
  assert.match(standard, /真实启动回执且风险持续/);
  assert.match(standard, /等待超过60秒/);
  assert.match(standard, /实际是否命中、通道及授权条件以平台为准/);
  const limited = picker.orderLine({response_order: {...policy, minimum_risk: 'MEDIUM',
    scope_mode: 'AIRSPACES', schedule_mode: 'DAILY', start_time: '22:00', end_time: '06:00', max_wait_seconds: 125}}, flow);
  assert.match(limited, /中风险及以上，指定空域，22:00—06:00（北京时间）/);
  assert.match(limited, /超过125秒/);
  assert.equal(picker.orderLine({response_order: policy}, {flow: 6}), '');
});

test('old flow9 can restore a running banner but never enters the daily selection list', async () => {
  const daily = {flow: 1, title: '统一风险', scene: {}, guide: {todo: ['当前操作']}};
  const legacy = {flow: 9, title: '旧预警', scene: {}, guide: {todo: ['旧运行说明']}};
  let bannerMarkup = '', dialogMarkup = '';
  const banner = {hidden: true, set innerHTML(text) { bannerMarkup = text; }};
  const context = vm.createContext({window: {}, storeKey: 'compatibility-test',
    localStorage: {getItem: () => JSON.stringify({flow: 9, startedBatch: 'old-run', ended: false}), setItem() {}, removeItem() {}},
    document: {addEventListener() {}, querySelector: selector => selector === '#flow-banner' ? banner : selector === '#dialog-shell' ? {hidden: true} : null},
    api: async () => ({flows: [daily], compatibility_flows: [legacy]}),
    liveState: {batch: 'old-run', phase: 'RUNNING'},
    openDialog: (title, markup) => { dialogMarkup = markup; }});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/flow-picker.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(bannerMarkup, /流程 9/);
  assert.match(bannerMarkup, /旧运行说明/);
  await context.window.FlowPicker.open(9);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(dialogMarkup, /data-flow-pick="1"/);
  assert.doesNotMatch(dialogMarkup, /data-flow-pick="9"/);
});
