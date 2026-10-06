/* 告警升级显示口径（2026-10-06，BUG-11 偏航告警不升级、BUG-16 同一架无人机两条告警）：
   同一架无人机再次违规时原告警升级，页面要说清现在的等级、累计的违规原因（偏航写“偏航”）以及谁在什么时候升级。 */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* legalityReviewModal.js 依赖弹窗与接口模块，node 不能直接 import；去掉 import/export 后在沙箱里取出词典。 */
function legalityDictionaries() {
  const source = readFileSync(path.join(__dirname, '../src/ui/legalityReviewModal.js'), 'utf8')
    .replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/\bexport /g, '')
    + '\n;globalThis.__dicts = { RULE_REASON_TEXT, MERGE_KIND_TEXT, ruleReasonText };';
  const context = vm.createContext({ sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
  vm.runInContext(source, context);
  return context.__dicts;
}

(async () => {
  const { ESCALATION_TRIGGER_TEXT, escalationBrief, escalationRecords, reasonListText } = await import('../src/ui/alarmEscalation.js');
  const { RULE_REASON_TEXT, MERGE_KIND_TEXT, ruleReasonText } = legalityDictionaries();
  const SEVERITY = { CRITICAL: '紧急', HIGH: '高', MEDIUM: '中', LOW: '低' };
  const severityText = code => SEVERITY[code] || '';
  const fmt = ms => (ms == null ? '' : `T${ms}`);

  // 偏航要写成“偏航”；升级引擎原告警在合法性页也要有中文说法，不能把 ESCALATED 原样上屏。
  assert.match(RULE_REASON_TEXT.ROUTE_DEVIATION, /^偏航/);
  assert.equal(MERGE_KIND_TEXT.ESCALATED, '升级既有告警');
  assert.equal(reasonListText(['NIGHT_FLIGHT', 'ROUTE_DEVIATION'], ruleReasonText), '夜间飞行、偏航（偏离报备航线）');
  assert.equal(reasonListText(['NIGHT_FLIGHT', ' NIGHT_FLIGHT ', '', null, 'INSIDE_RESTRICTED_AIRSPACE'], ruleReasonText), '夜间飞行、进入禁飞/限制空域');
  // 词典里没有的新原因照原样显示，不吞掉；没有原因时为空串，页面就不显示这一行。
  assert.equal(reasonListText(['NEW_REASON_CODE'], ruleReasonText), 'NEW_REASON_CODE');
  for (const empty of [undefined, null, [], 'ROUTE_DEVIATION', [1, {}]]) assert.equal(reasonListText(empty, ruleReasonText), '');

  // 没升级过（含旧接口没有这个字段）不出升级摘要。
  for (const alarm of [null, {}, { severity: 'LOW', escalation_count: 0 }, { severity: 'LOW', escalation_count: '0' }]) {
    assert.equal(escalationBrief(alarm, severityText), null);
  }
  assert.deepEqual(escalationBrief({ severity: 'HIGH', original_severity: 'LOW', escalation_count: 2, escalated_at: 1700 }, severityText),
    { count: 2, raised: true, level: '低 → 高', at: 1700 });
  // 只新增了原因、等级没变也算升级，但不能说成等级提高了。
  assert.deepEqual(escalationBrief({ severity: 'MEDIUM', original_severity: 'MEDIUM', escalation_count: 1 }, severityText),
    { count: 1, raised: false, level: '等级未变（中）', at: null });
  assert.equal(escalationBrief({ severity: 'UNKNOWN', escalation_count: 1 }, severityText).level, '等级未变（UNKNOWN）');

  const rows = escalationRecords([
    { escalation_id: 'e1', seq: 1, trigger_kind: 'ENGINE', severity_before: 'LOW', severity_after: 'MEDIUM',
      reasons_added: ['INSIDE_RESTRICTED_AIRSPACE'], reasons_after: ['NIGHT_FLIGHT', 'INSIDE_RESTRICTED_AIRSPACE'], created_at: 1000 },
    { escalation_id: 'e2', seq: 2, trigger_kind: 'MANUAL', severity_before: 'MEDIUM', severity_after: 'MEDIUM', reasons_added: [],
      reasons_after: ['NIGHT_FLIGHT', 'INSIDE_RESTRICTED_AIRSPACE'], note: '  飞手承认偏离报备航线  ', actor_id: 'u1', actor_name: '张值班', created_at: 2000 },
    { escalation_id: 'e3', seq: 3, trigger_kind: 'MANUAL', severity_before: 'MEDIUM', severity_after: 'HIGH', reasons_added: ['ROUTE_DEVIATION'],
      actor_id: 'u2', created_at: 3000 }
  ], { severityText, reasonText: ruleReasonText, fmt });
  assert.deepEqual(rows[0], { key: 'e1', title: `第 1 次 · ${ESCALATION_TRIGGER_TEXT.ENGINE}`, raised: true, level: '低 → 中',
    added: '新增原因：进入禁飞/限制空域', actor: '系统自动', note: '', time: 'T1000' });
  assert.deepEqual(rows[1], { key: 'e2', title: '第 2 次 · 人工转告警', raised: false, level: '等级未变（中）',
    added: '没有新增原因', actor: '张值班', note: '飞手承认偏离报备航线', time: 'T2000' });
  // 人工记录没有姓名时退回操作人 ID，不写成“系统自动”。
  assert.equal(rows[2].actor, 'u2');
  assert.equal(rows[2].added, '新增原因：偏航（偏离报备航线）');
  assert.equal(escalationRecords({ items: [] }).length, 0);
  assert.equal(escalationRecords([{ seq: 4, trigger_kind: 'OTHER', created_at: null }], { fmt })[0].time, '时间未知');

  // 告警页：列表与详情都显示累计原因与升级情况，升级记录单独读取并可重试。
  const page = readFileSync(path.join(__dirname, '../src/pages/AlarmsPage.vue'), 'utf8');
  assert.match(page, /listAlarmEscalations\(a\.alarm_id/);
  assert.match(page, /\['违规原因', esc\(reasons\)\]/);
  assert.match(page, /U\.sect\('升级记录'/);
  assert.match(page, /data-al="escalations-retry"/);
  console.log('全部通过：告警升级显示');
})().catch(error => { console.error(error); process.exitCode = 1; });
