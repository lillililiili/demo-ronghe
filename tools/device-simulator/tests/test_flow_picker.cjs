const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const FlowPicker = require('../web/flow-picker.js');

const group = (enabled, total, ok = true) => ok ? {ok: true, enabled, total, engine: 'ON', engine_message: ''} : {ok: false, reason: 'FORBIDDEN'};

test('all prediction variants stay manual with either automatic-rule configuration', () => {
  for (const variant of ['avoid', 'enter']) for (const enabled of [0,2]) {
    const flow = {flow:9, variant, guide:{prediction_only:true, auto_verify:null}};
    const rules = {verify:group(enabled,2), counter:group(enabled,2)};
    assert.match(FlowPicker.rulesLine(rules,flow), /人工核实、人工发起反制/);
    assert.doesNotMatch(FlowPicker.rulesLine(rules,flow), /全部满足后自动/);
    assert.equal(FlowPicker.ruleConflict(flow,rules),'');
  }
});

test('choosing a flow variant keeps its scene and guide together and leaves other flows unchanged', () => {
  const flow = {flow:9, title:'预测入区预警', default_variant:'avoid', variants:[
    {id:'avoid', label:'转向避开', minutes:5, scene:{name:'avoid'}, guide:{todo:['撤销']}},
    {id:'enter', label:'继续入区', minutes:6, scene:{name:'enter'}, guide:{todo:['关联实测告警', '人工核实申请审批执行']}}
  ]};
  const before = JSON.stringify(flow);
  assert.equal(FlowPicker.selectVariant(flow).scene.name,'avoid');
  assert.equal(FlowPicker.selectVariant(flow,'unknown').variant,'avoid');
  assert.equal(FlowPicker.selectVariant(flow,'silence').variant,'avoid', 'old selection cannot restore the removed scene');
  for (const variant of flow.variants) {
    const selected = FlowPicker.selectVariant(flow,variant.id);
    assert.equal(selected.scene,variant.scene);
    assert.equal(selected.guide,variant.guide);
    assert.equal(selected.variant,variant.id);
    assert.equal(selected.minutes,variant.minutes);
    assert.equal(selected.title,flow.title);
    assert.equal(selected.variantLabel,variant.label);
  }
  assert.equal(JSON.stringify(flow),before);
  const ordinary = {flow:5, scene:{name:'manual'}};
  assert.equal(FlowPicker.selectVariant(ordinary),ordinary);
});

const guidedScene = (turnAt = 44, lastAt = 98.69) => ({sceneGuide: {summary: '直线接近 → 转向 → 停留', stages: [
  {at_seconds: 0, label: '直线接近', description: '查看未来位置'},
  {at_seconds: turnAt, label: '转向', description: '等待平台依据新观测判断'},
  {at_seconds: lastAt, label: '停留', description: '继续上报位置'}
]}});
const guideRun = {flow: 9, startedBatch: 'run-a', ended: false};
const runtimeFor = (scene, elapsed, phase = 'RUNNING', batch = 'run-a') => ({source_scene: scene, elapsed, phase, batch});

test('scene guides are optional and a loaded flow never borrows the previous batch progress', () => {
  assert.equal(FlowPicker.sceneGuideModel({}), null);
  assert.equal(FlowPicker.sceneGuideHtml(null), '');
  const scene = guidedScene();
  assert.equal(FlowPicker.sceneGuideModel(scene).activeIndex, -1);
  assert.equal(FlowPicker.sceneGuideModel(scene, {startedBatch: null}, runtimeFor(scene, 90)).activeIndex, -1);
  assert.equal(FlowPicker.sceneGuideModel(scene, guideRun, runtimeFor(scene, 90, 'RUNNING', 'other-batch')), null);
  assert.equal(FlowPicker.sceneGuideModel(scene, {...guideRun, ended: true}, runtimeFor(scene, 90)), null);
});

test('stage boundaries follow exact metadata seconds across different scene timings', () => {
  for (const [turnAt, lastAt] of [[44, 98.69], [50, 65], [12.5, 45.2]]) {
    const scene = guidedScene(turnAt, lastAt), before = JSON.stringify(scene);
    for (const [elapsed, index] of [[0, 0], [turnAt - 0.01, 0], [turnAt, 1], [lastAt - 0.01, 1], [lastAt, 2], [300, 2]]) {
      assert.equal(FlowPicker.sceneGuideModel(scene, guideRun, runtimeFor(scene, elapsed)).activeIndex, index);
    }
    assert.equal(JSON.stringify(scene), before);
  }
});

test('a paused run uses its reported position in time and preparation or missing time highlights no stage', () => {
  const scene = guidedScene();
  const paused = FlowPicker.sceneGuideModel(scene, guideRun, runtimeFor(scene, 44, 'PAUSED'));
  assert.equal(paused.activeIndex, 1);
  assert.equal(paused.paused, true);
  assert.match(FlowPicker.sceneGuideHtml(paused, true), /已暂停/);
  for (const phase of ['PREPARING', 'STOPPING', 'STOPPED', 'COMPLETED', 'FAILED', 'UNKNOWN']) {
    assert.equal(FlowPicker.sceneGuideModel(scene, guideRun, runtimeFor(scene, 100, phase)).activeIndex, -1);
  }
  for (const elapsed of [undefined, null, '44', -1, NaN, Infinity]) {
    assert.equal(FlowPicker.sceneGuideModel(scene, guideRun, runtimeFor(scene, elapsed)).activeIndex, -1);
  }
});

test('running guide belongs to the frozen runtime scene rather than a newly published variant', () => {
  const published = guidedScene(44), frozen = guidedScene(70);
  assert.equal(FlowPicker.sceneGuideModel(published, guideRun, runtimeFor(frozen, 50)).activeIndex, 0);
  assert.equal(FlowPicker.sceneGuideModel(published, guideRun, {batch: 'run-a', phase: 'RUNNING', elapsed: 50}), null);
  assert.equal(FlowPicker.sceneGuideModel(published, guideRun, runtimeFor({}, 50)), null);
  assert.equal(FlowPicker.sceneGuideModel(published, guideRun, {batch: 'run-a', phase: 'RUNNING', elapsed: 50, scene: frozen}).activeIndex, 0);
});

test('invalid or ambiguous metadata is not silently rearranged into a flight schedule', () => {
  const cases = [null, {}, {summary: ' ', stages: []}];
  for (const bad of [-1, NaN, Infinity, '44', null]) {
    const guide = guidedScene().sceneGuide;
    guide.stages[1].at_seconds = bad;
    cases.push(guide);
  }
  for (const modify of [g => g.stages.reverse(), g => g.stages[1].at_seconds = 0,
    g => g.stages[1].label = '', g => g.stages[1].description = {}, g => g.stages.push(null)]) {
    const guide = guidedScene().sceneGuide; modify(guide); cases.push(guide);
  }
  for (const sceneGuide of cases) assert.equal(FlowPicker.sceneGuideModel({sceneGuide}), null);
});

test('guide markup escapes scene text and labels current simulation without claiming a business result', () => {
  const scene = guidedScene();
  scene.sceneGuide.summary = '<script>unsafe()</script>';
  scene.sceneGuide.stages[1].description = '<img onerror="unsafe()">';
  const html = FlowPicker.sceneGuideHtml(FlowPicker.sceneGuideModel(scene, guideRun, runtimeFor(scene, 45)), true);
  assert.match(html, /模拟飞行阶段/);
  assert.match(html, /当前模拟阶段/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img onerror=&quot;/);
  assert.doesNotMatch(html, /<script>|<img|已核实|已送达|已完成/);
  assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
  const full = FlowPicker.sceneGuideHtml(FlowPicker.sceneGuideModel(scene));
  assert.doesNotMatch(full, /aria-current/);
  assert.match(full, /预警、核实、通知和反制结果以平台为准/);
});

test('compact guide keeps one action sentence and the full dialog retains every stage description', () => {
  const scene = guidedScene();
  const loaded = FlowPicker.sceneGuideHtml(FlowPicker.sceneGuideModel(scene), true);
  assert.match(loaded, /开始后：<\/b>在融合感知选中无人机/);
  assert.doesNotMatch(loaded, /<h4>|scene-guide-note|等待平台依据新观测判断|继续上报位置/);
  const running = FlowPicker.sceneGuideHtml(FlowPicker.sceneGuideModel(scene, guideRun, runtimeFor(scene, 45)), true);
  assert.match(running, /当前模拟阶段：<\/b>等待平台依据新观测判断/);
  assert.doesNotMatch(running, /查看未来位置|继续上报位置|scene-guide-note|<h4>/);
  const full = FlowPicker.sceneGuideHtml(FlowPicker.sceneGuideModel(scene));
  for (const stage of scene.sceneGuide.stages) assert.ok(full.includes(stage.description));
});

test('runtime polling redraws the banner only when its stage or lifecycle state changes', async () => {
  const scene = guidedScene(), saved = {...guideRun, baseBatch: 'old', reminder: false};
  let writes = 0, markup = '';
  const banner = {hidden: true, set innerHTML(value) { writes++; markup = value; }};
  const context = vm.createContext({window: {}, storeKey: 'guide-test',
    localStorage: {getItem: () => JSON.stringify(saved), setItem() {}, removeItem() {}},
    document: {addEventListener() {}, querySelector: selector => selector === '#flow-banner' ? banner : {hidden: true}},
    api: async () => ({flows: [{flow: 9, title: '预测', scene, guide: {todo: ['查看平台结果']}}]}),
    liveState: runtimeFor(scene, 1)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/flow-picker.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 1);
  assert.doesNotMatch(markup, /你要做什么|查看平台结果|做完点|scene-guide-note/);
  assert.match(markup, /完整说明/);
  for (const elapsed of [2.5, 4, 43.9]) {
    context.liveState = runtimeFor(scene, elapsed);
    context.window.FlowPicker.onRuntime(context.liveState);
  }
  assert.equal(writes, 1, 'unchanged stage does not recreate banner buttons');
  context.liveState = runtimeFor(scene, 44);
  context.window.FlowPicker.onRuntime(context.liveState);
  assert.equal(writes, 2);
  assert.match(markup, /当前模拟阶段：<\/b>等待平台依据新观测判断/);
  context.liveState = runtimeFor(scene, 44, 'PAUSED');
  context.window.FlowPicker.onRuntime(context.liveState);
  assert.equal(writes, 3);
  assert.match(markup, /模拟已暂停：<\/b>等待平台依据新观测判断/);
  context.liveState = runtimeFor(scene, 44, 'COMPLETED');
  context.window.FlowPicker.onRuntime(context.liveState);
  assert.equal(banner.hidden, true);
  assert.equal(markup, '');
});

test('ordinary flow banner retains its action list and footer', async () => {
  let markup = '';
  const context = vm.createContext({window: {}, storeKey: 'ordinary-test',
    localStorage: {getItem: () => JSON.stringify({...guideRun, flow: 5}), setItem() {}, removeItem() {}},
    document: {addEventListener() {}, querySelector: () => ({set innerHTML(value) { markup = value; }})},
    api: async () => ({flows: [{flow: 5, title: '人工处置', scene: {}, guide: {todo: ['普通流程原步骤']}}]}),
    liveState: runtimeFor({}, 30)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/flow-picker.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(markup, /你要做什么/);
  assert.match(markup, /普通流程原步骤/);
  assert.match(markup, /做完点“停止”/);
  assert.doesNotMatch(markup, /scene-guide/);
});

test('the rule line distinguishes enabled rules from their checked automatic action', () => {
  const line = FlowPicker.rulesLine({verify: group(2, 3), counter: group(1, 2)});
  assert.match(line, /^规则管理里现在：/);
  assert.match(line, /核实规则启用 2\/3 条，全部满足后自动核实/);
  assert.match(line, /反制规则启用 1\/2 条，全部满足且证据、设备等校验通过后自动发起；不满足时由有权限的人发起/);
});

test('no enabled counter rules requires a permitted human action', () => {
  const line = FlowPicker.rulesLine({counter: group(0, 2)});
  assert.match(line, /反制规则一条都没启用，由有权限的人发起反制/);
  assert.doesNotMatch(line, /自动发起/);
});

test('with every verify rule off the line says alarms will stay waiting to be verified', () => {
  assert.match(FlowPicker.rulesLine({verify: group(0, 3), counter: group(1, 2)}), /核实规则一条都没启用，不会自动核实，告警会一直停在“待核实”/);
});

test('a group the account cannot read is left out, and when nothing is readable there is no line at all', () => {
  const onlyCounter = FlowPicker.rulesLine({verify: group(0, 0, false), counter: group(1, 2)});
  assert.doesNotMatch(onlyCounter, /核实规则/);
  assert.match(onlyCounter, /反制规则启用 1\/2 条/);
  assert.equal(FlowPicker.rulesLine({verify: group(0, 0, false), counter: group(0, 0, false)}), '');
  assert.equal(FlowPicker.rulesLine({}), '');
  assert.equal(FlowPicker.rulesLine(null), '');
});

test('a flow that needs auto verify off is flagged when it is on, and the other way round', () => {
  const needsOff = {flow: 4, guide: {auto_verify: false}}, needsOn = {flow: 1, guide: {auto_verify: true}};
  assert.match(FlowPicker.ruleConflict(needsOff, {verify: group(2, 3)}), /自动核实现在是开着的（还有 2 条核实规则启用）。请先到规则管理关掉/);
  assert.equal(FlowPicker.ruleConflict(needsOff, {verify: group(0, 3)}), '');
  assert.match(FlowPicker.ruleConflict(needsOn, {verify: group(0, 3)}), /自动核实现在是关着的，告警不会自动核实。请先到规则管理打开/);
  assert.equal(FlowPicker.ruleConflict(needsOn, {verify: group(1, 3)}), '');
});

test('no complaint about rules the simulator could not read or a flow that does not care', () => {
  assert.equal(FlowPicker.ruleConflict({flow: 4, guide: {auto_verify: false}}, {verify: group(0, 0, false)}), '');
  assert.equal(FlowPicker.ruleConflict({flow: 4, guide: {auto_verify: false}}, null), '');
  assert.equal(FlowPicker.ruleConflict({flow: 5, guide: {}}, {verify: group(2, 3)}), '');
  assert.equal(FlowPicker.ruleConflict({flow: 5}, {verify: group(2, 3)}), '');
});

const loaded = {flow: 4, baseBatch: 'b0', startedBatch: null, ended: false, reminder: false};

test('a loaded flow starts when a new batch appears and ends when it stops, completes or fails', () => {
  assert.deepEqual(FlowPicker.advance(null, {batch: 'b1', phase: 'RUNNING'}), {current: null, event: null});
  assert.equal(FlowPicker.advance(loaded, {batch: 'b0', phase: 'RUNNING'}).event, null, 'the batch that was already there is not this flow');
  assert.equal(FlowPicker.advance(loaded, {batch: undefined, phase: 'IDLE'}).event, null);
  const started = FlowPicker.advance(loaded, {batch: 'b1', phase: 'PREPARING'});
  assert.equal(started.event, 'started');
  assert.equal(started.current.startedBatch, 'b1');
  assert.equal(FlowPicker.advance(started.current, {batch: 'b1', phase: 'RUNNING'}).event, null);
  assert.equal(FlowPicker.advance(started.current, {batch: 'b1', phase: 'PAUSED'}).event, null, 'paused is not the end');
  for (const phase of ['STOPPED', 'COMPLETED', 'FAILED']) {
    const ended = FlowPicker.advance(started.current, {batch: 'b1', phase});
    assert.equal(ended.event, 'ended', phase);
    assert.equal(ended.current.ended, true);
  }
});

test('the flow also ends when another run takes its place, and an ended flow stays ended', () => {
  const started = FlowPicker.advance(loaded, {batch: 'b1', phase: 'RUNNING'}).current;
  const replaced = FlowPicker.advance(started, {batch: 'b2', phase: 'RUNNING'});
  assert.equal(replaced.event, 'ended');
  assert.equal(FlowPicker.advance(replaced.current, {batch: 'b2', phase: 'STOPPED'}).event, null);
  assert.equal(FlowPicker.advance(replaced.current, {batch: 'b3', phase: 'RUNNING'}).event, null);
});

test('a run that is already over by the time the page notices still counts as started and ended', () => {
  const quick = FlowPicker.advance(loaded, {batch: 'b1', phase: 'COMPLETED'});
  assert.equal(quick.event, 'ended');
  assert.equal(quick.current.startedBatch, 'b1');
  assert.equal(quick.current.ended, true);
});

test('a flow loaded before any run existed starts with the first batch there is', () => {
  const fresh = FlowPicker.advance({...loaded, baseBatch: null}, {batch: 'b1', phase: 'RUNNING'});
  assert.equal(fresh.event, 'started');
});

test('advancing never changes the object it was given', () => {
  const before = JSON.stringify(loaded);
  FlowPicker.advance(loaded, {batch: 'b1', phase: 'RUNNING'});
  assert.equal(JSON.stringify(loaded), before);
});

test('the chip beside the flow name says where the flow is', () => {
  assert.equal(FlowPicker.statusText({...loaded}, 'IDLE'), '已载入，还没开始');
  assert.equal(FlowPicker.statusText({...loaded, startedBatch: 'b1'}, 'PREPARING'), '正在准备资料');
  assert.equal(FlowPicker.statusText({...loaded, startedBatch: 'b1'}, 'RUNNING'), '运行中');
  assert.equal(FlowPicker.statusText({...loaded, startedBatch: 'b1'}, 'PAUSED'), '已暂停');
  assert.equal(FlowPicker.statusText({...loaded, startedBatch: 'b1'}, 'STOPPING'), '正在停止');
  assert.equal(FlowPicker.statusText({...loaded, startedBatch: 'b1'}, 'SOMETHING'), '运行中');
  assert.equal(FlowPicker.statusText({...loaded, startedBatch: 'b1', ended: true}, 'STOPPED'), '已结束');
});

test('the page puts the picker, the banner and the check where the scripts expect them', () => {
  const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  const order = name => { const at = html.indexOf(`<script src="${name}`); assert.ok(at > 0, `${name} is loaded`); return at; };
  assert.ok(order('plan-time.js') < order('app.js'), 'app.js reads PlanTime while it loads');
  assert.ok(order('runtime.js') < order('start-check.js') && order('realtime.js') < order('start-check.js'));
  assert.ok(order('start-check.js') < order('flow-picker.js') && order('app.js') < order('flow-picker.js'), 'the picker uses the globals app.js declares');
  assert.match(html, /<link rel="stylesheet" href="flow-picker\.css/);
  assert.match(html, /<div id="flow-banner" class="flow-banner"[^>]* hidden><\/div>/);
  assert.ok(html.indexOf('id="flow-banner"') < html.indexOf('<main>'), 'the banner sits above the map, not inside a panel');
});
