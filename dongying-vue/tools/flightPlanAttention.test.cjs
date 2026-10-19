/* 飞行任务列表“需要处理的放在最上面”（2026-10-16 用户确认设计二）：分组、问题标签、下一步、完整说明、按钮和顶部汇总。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const A = await import('../src/pages/flights/planAttention.js');
  const H = await import('../src/pages/flights/planHandling.js');
  const plan = (status_code, attention) => ({ plan_id: 'p', status_code, ...(attention ? { attention } : {}) });
  const action = (row, key) => A.attentionIssues(row).flatMap(issue => issue.actions).find(item => !key || item.key === key);
  const attention = (kinds, extra = {}) => ({ kinds, match_issue: null, pending_verification_risks: 0, pending_notification_risks: 0, device_tasks: [], ...extra });

  // 分组：有问题的不论状态都进“需要处理”；没问题的按状态分；已结束任务后台不带 attention。
  assert.equal(A.planGroupOf(plan('PENDING', attention(['RISK'], { pending_verification_risks: 1 }))), 'needs');
  assert.equal(A.planGroupOf(plan('EXECUTING', attention([]))), 'executing');
  assert.equal(A.planGroupOf(plan('APPROVED', attention([]))), 'pending');
  assert.equal(A.planGroupOf(plan('COMPLETED')), 'ended');
  assert.equal(A.planGroupOf(plan('CANCELLED')), 'ended');

  // 几种问题同时有：每项保留独立入口；设备写明设备名和处置单状态。
  const several = plan('EXECUTING', attention(['AIRCRAFT', 'DEVICE', 'RISK'], {
    match_issue: 'NO_EVALUATION', pending_verification_risks: 1, pending_notification_risks: 1,
    device_tasks: [{ task_id: 't1', device_name: '雷达-02', workflow_state: 'PROCESSING' }]
  }));
  const issues = A.attentionIssues(several);
  assert.deepEqual(issues.map(issue => issue.tag), ['设备异常 1', '风险 2 条']);
  assert.equal(issues[0].detail, '航线附近的雷达-02 异常，后台处置单“处理中”，飞机可能测不到。请跟进处置单；修好前靠联系报备单位确认飞行情况。');
  assert.equal(issues[0].tagClass, 't-amber');
  assert.equal(issues[1].detail, '这条任务有 2 个风险事件还没处理（待核验 1、待通知 1）。请去核验，确认后通知上级。');
  // 设备已恢复、等后台确认办结时，不再说飞机测不到。
  const recovered = A.attentionIssues(plan('EXECUTING', attention(['DEVICE'], { device_tasks: [{ device_name: '雷达-02', workflow_state: 'READY_TO_COMPLETE' }] })))[0];
  assert.equal(recovered.detail, '雷达-02已恢复，后台处置单“待确认办结”。请跟进后台确认办结。');
  assert.doesNotMatch(recovered.detail, /测不到/);
  // 风险写明种类：气象写具体预警。
  const storm = A.attentionIssues(plan('PENDING', attention(['RISK'], { pending_verification_risks: 1,
    pending_risk_kinds: [{ risk_type: 'WEATHER', reason_code: 'WEATHER_THUNDERSTORM' }] })))[0];
  assert.equal(storm.detail, '这条任务有 1 个风险事件还没处理（待核验 1，雷雨预警）。请去核验，确认后通知上级。');
  assert.equal(storm.next, '核验雷雨预警，确认后通知上级');
  assert.deepEqual(issues.map(issue => issue.actions[0].key), ['devices', 'risks'], '多类问题的入口全部保留');

  // 只有风险：去风险事件；只剩待通知时不再叫人去核验。
  const risky = plan('PENDING', attention(['RISK'], { pending_notification_risks: 2 }));
  assert.equal(action(risky).key, 'risks');
  assert.equal(A.attentionIssues(risky)[0].detail, '这条任务有 2 个风险事件还没处理（待通知 2）。请通知上级。');

  // 没有问题的任务没有问题标签，按钮是“查看详情”。
  assert.deepEqual(A.attentionIssues(plan('EXECUTING', attention([]))), []);
  assert.equal(action(plan('COMPLETED')), undefined);

  // 顶部汇总：后台数量原样显示，选中的种类高亮；后台没给汇总（旧版本）就不显示。
  const bar = A.attentionSummaryChips({ needs_action: 5, deviation: 1, aircraft: 2, device: 1, risk: 2, other_executing: 1 }, 'DEVICE');
  assert.equal(bar.total, 5);
  assert.equal(bar.otherExecuting, 1);
  assert.deepEqual(bar.chips.map(chip => [chip.label, chip.count, chip.active]),
    [['设备异常', 1, true], ['风险待处理', 2, false]]);
  assert.equal(A.attentionSummaryChips(null), null);

  // 页面接线：列表用新组件，按钮分别去合法性判定、只看本任务的风险、右侧详情；“未匹配”改叫“还没对上飞机”。
  const page = fs.readFileSync(path.join(__dirname, '../src/pages/FlightsPage.vue'), 'utf8');
  const has = (re, what) => assert.ok(re.test(page), `FlightsPage.vue 缺少：${what}`);
  has(/<PlanRecordList v-else ref="planList" :items="planRecords"[^>]*@action="onPlanAction"/, '任务列表与按钮');
  has(/attentionSummary\.value = data\.attention_summary \|\| null;[\s\S]*attentionSummary\.value = data\.attention_summary \|\| null;/, '首读与实时刷新都更新顶部汇总');
  has(/@click="choosePlanAttention\(chip\.key\)"/, '汇总按种类筛选');
  has(/showEventsTab\(null, id\)/, '查看风险事件只看本任务');
  has(/openPlanHandling\(id\)/, '列表与详情共用关联入口');
  // 不依赖任务编号或展示文案；变化编号、来源后仍按同一研判的显式关联分流。
  for (const source of ['live', 'replay']) {
    const id = `plan-${source}-${Date.now()}`, eid = `eval-${id}`, tid = `target-${id}`;
    const p = { plan_id: id, status_code: 'EXECUTING' };
    const snapshot = { data: { match: { availability: 'AVAILABLE', evaluation_id: eid, target_id: tid } },
      evaluation: { evaluation_id: eid, plan_id: id, target_id: tid, object_type_code: 'UAV', has_alarm: false, source_mode: source } };
    const rights = { alarms: true, legality: true };
    assert.equal(H.planHandling(p, snapshot, rights).kind, 'legality');
    assert.equal(H.planHandling(p, snapshot, rights).context.evaluation, eid);
    snapshot.evaluation.has_alarm = true;
    assert.equal(H.planHandling(p, snapshot, rights).kind, 'blocked', '隐藏编号不等于无告警');
    snapshot.evaluation.alarm_id = `alarm-${id}`;
    assert.equal(H.planHandling(p, snapshot, rights).kind, 'alarm');
    assert.equal(H.planHandling(p, snapshot, { ...rights, alarms: false }).kind, 'blocked');
    delete snapshot.evaluation.alarm_id;
    delete snapshot.evaluation.has_alarm;
    assert.equal(H.planHandling(p, snapshot, rights).kind, 'blocked', '旧接口未知关联不能猜无告警');
    snapshot.evaluation.has_alarm = false;
    snapshot.evaluation.object_type_code = 'BIRD';
    assert.equal(H.planHandling(p, snapshot, rights).kind, 'none');
    snapshot.evaluation.object_type_code = 'UAV';
    snapshot.evaluation.plan_id = 'other-plan';
    assert.equal(H.planHandling(p, snapshot, rights).kind, 'blocked');
    assert.equal(H.planHandling(p, { error: new Error('网络错误') }, rights).kind, 'blocked');
    assert.equal(H.planHandling(p, { data: { match: { availability: 'NO_EVALUATION' } } }, rights).kind, 'none');
    assert.equal(H.planHandling(p, { data: { match: { availability: 'FORBIDDEN' } } }, rights).kind, 'blocked');
    assert.equal(H.planHandling({ ...p, status_code: 'PENDING' }, snapshot, rights).kind, 'none');
  }
  let reads = 0, evaluationReads = 0;
  const reader = H.createPlanSnapshotReader({ actuals: async () => { reads++; return { match: { availability: 'NO_EVALUATION' } }; },
    getEvaluation: async () => { evaluationReads++; } });
  await Promise.all([reader('same-plan'), reader('same-plan')]);
  assert.equal(reads, 1, '列表与详情同时读取共享请求');
  assert.equal(evaluationReads, 0, '没有研判不查不存在的关联');
  await reader('same-plan');
  assert.equal(reads, 2, '完成后重读，不能永久缓存旧关联');
  assert.ok(!page.includes("'未匹配'"), '“未匹配”应改叫“还没对上飞机”');

  // 相邻组合与权限：匹配分类不抢走设备或风险入口；没有权限的入口解释原因。
  for (const match_issue of ['DEVIATION', 'NO_EVALUATION', 'NONE', 'PARTIAL', 'UNDETERMINED']) {
    const row = { ...several, plan_id: `alternate-${match_issue}`, source_mode: 'live', attention: { ...several.attention, match_issue } };
    const normal = A.attentionIssues(row);
    assert.equal(normal.length, 2);
    assert.ok(normal.every(issue => issue.actions.length));
    const denied = A.attentionIssues(row, { legality: false, risks: false });
    assert.ok(denied.flatMap(issue => issue.actions).filter(a => ['legality', 'risks'].includes(a.key)).every(a => a.blockedReason));
    assert.ok(denied.flatMap(issue => issue.actions).filter(a => ['contacts', 'devices'].includes(a.key)).every(a => !a.blockedReason));
  }
  assert.equal(A.attentionIssues(risky)[0].actions[0].label, '去通知上级');
  assert.equal(issues[1].actions[0].label, '去核验与通知');

  // 后端分页没有单页上限假象；保留被点击的原单，不用同设备的新单替换。
  const pages = [], rows = Array.from({ length: 102 }, (_, n) => ({ task_id: `case-${n}`, workflow_state: n === 101 ? 'COMPLETED' : 'PROCESSING' }));
  const read = async (id, query) => { pages.push([id, query.page]); return { total: rows.length, items: rows.slice((query.page - 1) * 100, query.page * 100) }; };
  const loaded = await A.loadAttentionDeviceTasks('other-plan', ['case-101', 'case-0'], read);
  assert.deepEqual(pages, [['other-plan', 1], ['other-plan', 2]]);
  assert.deepEqual(loaded.items.map(t => t.task_id), ['case-101', 'case-0']);
  assert.equal(loaded.items[0].workflow_state, 'COMPLETED');
  assert.equal((await A.loadAttentionDeviceTasks('other-plan', ['missing'], read)).missing, 1);
  await assert.rejects(A.loadAttentionDeviceTasks('p', ['x'], async () => ({ total: 1, items: [] })), /不完整/);
  await assert.rejects(A.loadAttentionDeviceTasks('p', ['x'], async () => ({ items: [] })), /不完整/);
  await assert.rejects(A.loadAttentionDeviceTasks('p', [], read), /缺少关联/);
  assert.equal(await A.loadAttentionDeviceTasks('p', ['case-101'], read, () => false), null);

  // 实际 Vue 组件渲染：多类入口均可见，无嵌套按钮，权限原因可见，正常任务无多余动作。
  const Vue = require('vue'), { renderToString } = require('@vue/server-renderer');
  const { parse, compileScript } = require('@vue/compiler-sfc');
  const source = fs.readFileSync(path.join(__dirname, '../src/pages/flights/components/PlanRecordList.vue'), 'utf8');
  const { descriptor } = parse(source);
  const compiled = compileScript(descriptor, { id: 'attention-regression', inlineTemplate: true }).content
    .replace(/import \{([^}]+)\} from ['"]vue['"];?/g, (_, names) => `const {${names.replace(/\bas\b/g, ':')}} = Vue;`)
    .replace('export default', 'return');
  const Component = new Function('Vue', compiled)(Vue);
  const record = (id, entry, access) => ({ id, title: `航线 ${id}`, subtitle: '某日任务', status: '执行中', statusClass: 't-blue', tags: [], issues: A.attentionIssues(entry, access) });
  const html = await renderToString(Vue.createSSRApp(Component, { items: [record('A', several)], label: '飞行任务' }));
  // 关联导航独立于两类待办：不增加问题数，也不替换设备和风险按钮。
  for (const kind of ['alarm', 'legality']) {
    const item = record(`linked-${kind}`, several);
    item.handlingAction = { key: kind, label: kind === 'alarm' ? '查看告警' : '查看研判', disabled: true };
    const linkedHtml = await renderToString(Vue.createSSRApp(Component, { items: [item], label: '飞行任务' }));
    assert.equal(item.issues.length, 2);
    assert.match(linkedHtml, /查看设备处置进度/);
    assert.match(linkedHtml, /去核验与通知/);
    assert.match(linkedHtml, /关联研判与告警/);
    assert.match(linkedHtml, new RegExp(`disabled[^>]*>${item.handlingAction.label}`));
    assert.doesNotMatch(linkedHtml, /3 类问题/);
  }

  for (const label of ['查看设备处置进度', '去核验与通知', '有 2 类问题，请分别处理']) assert.ok(html.includes(label), label);
  assert.equal((html.match(/<section /g) || []).length, 2);
  assert.doesNotMatch(html, /<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
  const deniedHtml = await renderToString(Vue.createSSRApp(Component, { items: [record('B', risky, { risks: false })], label: '飞行任务' }));
  assert.match(deniedHtml, /disabled/); assert.match(deniedHtml, /当前账号无权查看风险事件/);
  const normalHtml = await renderToString(Vue.createSSRApp(Component, { items: [record('C', plan('COMPLETED'))], label: '飞行任务' }));
  assert.doesNotMatch(normalHtml, /逐项处理/);

  // 执行真实路由处理器：风险仍按本任务过滤，设备只读打开原单；过期入口不可执行。
  const vm = require('node:vm');
  let focusCalls = 0, watcher;
  const ctx = { plans: { value: [several] }, planActionAccess: { value: {} }, attentionIssues: A.attentionIssues,
    pendingPlanContact: { value: null }, selected: { value: null }, matchedTargetId: { value: null },
    window: { UI: { goto: (page, query) => { ctx.goto = [page, query]; } } }, location: {}, S: {},
    planDetailTab: { value: 'forecast' }, detailLoading: { value: false }, planFilingDetails: { value: { focusContacts: () => focusCalls++ } },
    showEventsTab: (risk, id) => { ctx.risks = [risk, id]; }, toast: message => { ctx.message = message; },
    openModal: options => { ctx.modal = options.render(); }, h: (component, props) => props, PlanMaintenanceProgressModal: {},
    selectPlan: id => { ctx.selected.value = { plan_id: id }; }, nextTick: async () => {}, watch: (deps, fn) => { watcher = fn; } };
  vm.createContext(ctx);
  vm.runInContext(page.slice(page.indexOf('function onPlanAction('), page.indexOf('function syncSelectedPlanHash')), ctx);
  ctx.onPlanAction({ id: 'p', key: 'risks' }); assert.deepEqual(ctx.risks, [null, 'p']); assert.match(ctx.location.hash, /plan=p/);
  ctx.onPlanAction({ id: 'p', key: 'devices' }); assert.equal(ctx.modal.planId, 'p'); assert.equal(ctx.modal.taskIds[0], 't1');
  ctx.onPlanAction({ id: 'missing', key: 'devices' }); assert.match(ctx.message, /情况已变化/);
  for (const match_issue of ['DEVIATION', 'NONE', 'NO_EVALUATION', 'PARTIAL', 'UNDETERMINED']) {
    const removed = plan('EXECUTING', attention(['DEVIATION', 'AIRCRAFT'], { match_issue }));
    assert.equal(A.needsAction(removed), false);
    assert.equal(A.planGroupOf(removed), 'executing');
    assert.deepEqual(A.attentionIssues(removed), []);
  }
  ctx.onPlanAction({ id: 'p', key: 'contacts' }); assert.match(ctx.message, /情况已变化/);
  ctx.planActionAccess.value = { risks: false }; ctx.risks = null;
  ctx.onPlanAction({ id: 'p', key: 'risks' }); assert.equal(ctx.risks, null); assert.match(ctx.message, /无权/);
  console.log('全部通过：分组、多问题独立入口、权限、分页原单、Vue 渲染与任务导航');
})().catch(error => { console.error(error); process.exitCode = 1; });
