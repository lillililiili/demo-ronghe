/* 飞行任务列表“需要处理的放在最上面”（2026-10-16 用户确认设计二）：分组、问题标签、下一步、完整说明、按钮和顶部汇总。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const A = await import('../src/pages/flights/planAttention.js');
  const plan = (status_code, attention) => ({ plan_id: 'p', status_code, ...(attention ? { attention } : {}) });
  const attention = (kinds, extra = {}) => ({ kinds, match_issue: null, pending_verification_risks: 0, pending_notification_risks: 0, device_tasks: [], ...extra });

  // 分组：有问题的不论状态都进“需要处理”；没问题的按状态分；已结束任务后台不带 attention。
  assert.equal(A.planGroupOf(plan('PENDING', attention(['RISK'], { pending_verification_risks: 1 }))), 'needs');
  assert.equal(A.planGroupOf(plan('EXECUTING', attention([]))), 'executing');
  assert.equal(A.planGroupOf(plan('APPROVED', attention([]))), 'pending');
  assert.equal(A.planGroupOf(plan('COMPLETED')), 'ended');
  assert.equal(A.planGroupOf(plan('CANCELLED')), 'ended');

  // 偏离：红色标签、去合法性判定。
  const deviated = plan('EXECUTING', attention(['DEVIATION'], { match_issue: 'DEVIATION' }));
  assert.deepEqual(A.attentionIssues(deviated).map(issue => [issue.tag, issue.tagClass]), [['任务偏离', 't-red']]);
  assert.match(A.attentionIssues(deviated)[0].detail, /^飞机实际飞的位置离开了报备航线。请打开合法性判定/);
  assert.equal(A.attentionAction(deviated).key, 'legality');
  assert.equal(A.attentionAction(deviated).primary, true);

  // “未找到对应飞机”和“还没对上飞机”是两种情况，说法和按钮都不同。
  const none = plan('EXECUTING', attention(['AIRCRAFT'], { match_issue: 'NONE' }));
  const notYet = plan('EXECUTING', attention(['AIRCRAFT'], { match_issue: 'NO_EVALUATION' }));
  assert.equal(A.attentionIssues(none)[0].tag, '未找到对应飞机');
  assert.equal(A.attentionIssues(notYet)[0].tag, '还没对上飞机');
  assert.match(A.attentionIssues(notYet)[0].detail, /可能还没起飞，也可能没被探测到/);
  assert.equal(A.attentionAction(none).key, 'legality');
  assert.equal(A.attentionAction(notYet).key, 'detail');
  assert.equal(A.attentionAction(plan('EXECUTING', attention(['AIRCRAFT'], { match_issue: 'PARTIAL' }))).key, 'legality');
  assert.equal(A.attentionAction(plan('EXECUTING', attention(['AIRCRAFT'], { match_issue: 'UNDETERMINED' }))).key, 'detail');

  // 几种问题同时有：逐条列出，下一步用分号连起来；设备写明设备名和处置单状态。
  const several = plan('EXECUTING', attention(['AIRCRAFT', 'DEVICE', 'RISK'], {
    match_issue: 'NO_EVALUATION', pending_verification_risks: 1, pending_notification_risks: 1,
    device_tasks: [{ task_id: 't1', device_name: '雷达-02', workflow_state: 'PROCESSING' }]
  }));
  const issues = A.attentionIssues(several);
  assert.deepEqual(issues.map(issue => issue.tag), ['还没对上飞机', '设备异常 1', '风险 2 条']);
  assert.equal(issues[1].detail, '航线附近的雷达-02 异常，后台处置单“处理中”，飞机可能测不到。请跟进处置单；修好前靠联系报备单位确认飞行情况。');
  assert.equal(issues[1].tagClass, 't-amber');
  assert.equal(issues[2].detail, '这条任务有 2 个风险事件还没处理（待核验 1、待通知 1）。请去核验，确认后通知上级。');
  // 设备已恢复、等后台确认办结时，不再说飞机测不到。
  const recovered = A.attentionIssues(plan('EXECUTING', attention(['DEVICE'], { device_tasks: [{ device_name: '雷达-02', workflow_state: 'READY_TO_COMPLETE' }] })))[0];
  assert.equal(recovered.detail, '雷达-02已恢复，后台处置单“待确认办结”。请跟进后台确认办结。');
  assert.doesNotMatch(recovered.detail, /测不到/);
  // 风险写明种类：气象写具体预警。
  const storm = A.attentionIssues(plan('PENDING', attention(['RISK'], { pending_verification_risks: 1,
    pending_risk_kinds: [{ risk_type: 'WEATHER', reason_code: 'WEATHER_THUNDERSTORM' }] })))[0];
  assert.equal(storm.detail, '这条任务有 1 个风险事件还没处理（待核验 1，雷雨预警）。请去核验，确认后通知上级。');
  assert.equal(storm.next, '核验雷雨预警，确认后通知上级');
  assert.equal(A.attentionAction(several).key, 'detail');
  assert.ok(!A.attentionAction(several).primary, '查看详情不用实心按钮');

  // 只有风险：去风险事件；只剩待通知时不再叫人去核验。
  const risky = plan('PENDING', attention(['RISK'], { pending_notification_risks: 2 }));
  assert.equal(A.attentionAction(risky).key, 'risks');
  assert.equal(A.attentionIssues(risky)[0].detail, '这条任务有 2 个风险事件还没处理（待通知 2）。请通知上级。');

  // 没有问题的任务没有问题标签，按钮是“查看详情”。
  assert.deepEqual(A.attentionIssues(plan('EXECUTING', attention([]))), []);
  assert.deepEqual(A.attentionAction(plan('COMPLETED')), { key: 'detail', label: '查看详情' });

  // 顶部汇总：后台数量原样显示，选中的种类高亮；后台没给汇总（旧版本）就不显示。
  const bar = A.attentionSummaryChips({ needs_action: 5, deviation: 1, aircraft: 2, device: 1, risk: 2, other_executing: 1 }, 'AIRCRAFT');
  assert.equal(bar.total, 5);
  assert.equal(bar.otherExecuting, 1);
  assert.deepEqual(bar.chips.map(chip => [chip.label, chip.count, chip.active]),
    [['任务偏离', 1, false], ['没对上飞机', 2, true], ['设备异常', 1, false], ['风险待处理', 2, false]]);
  assert.equal(A.attentionSummaryChips(null), null);

  // 页面接线：列表用新组件，按钮分别去合法性判定、只看本任务的风险、右侧详情；“未匹配”改叫“还没对上飞机”。
  const page = fs.readFileSync(path.join(__dirname, '../src/pages/FlightsPage.vue'), 'utf8');
  const has = (re, what) => assert.ok(re.test(page), `FlightsPage.vue 缺少：${what}`);
  has(/<PlanRecordList v-else ref="planList" :items="planRecords"[^>]*@action="onPlanAction"/, '任务列表与按钮');
  has(/attentionSummary\.value = data\.attention_summary \|\| null;[\s\S]*attentionSummary\.value = data\.attention_summary \|\| null;/, '首读与实时刷新都更新顶部汇总');
  has(/@click="choosePlanAttention\(chip\.key\)"/, '汇总按种类筛选');
  has(/showEventsTab\(null, id\)/, '查看风险事件只看本任务');
  has(/window\.UI\.goto\('legality', \{ plan: id/, '合法性判定带上本任务');
  assert.ok(!page.includes("'未匹配'"), '“未匹配”应改叫“还没对上飞机”');
  console.log('全部通过：需要处理分组、问题说明、按钮与顶部汇总');
})().catch(error => { console.error(error); process.exitCode = 1; });
