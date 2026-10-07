const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sourceRoot = path.resolve(__dirname, '../src');
const load = file => import(pathToFileURL(path.join(sourceRoot, file)).href);

test('several punishment recipients ask a person to choose, and only accounts that may hand off get the button', async () => {
  const { autoHandoffView, partyWarning } = await load('components/disposal/autoHandoffView.js');
  const manual = { status: 'MANUAL_REQUIRED', reason: '启用了 2 个处罚接收单位，系统不会替你选择。请选择接收单位后移送到处罚',
    party_status: 'UNIDENTIFIED', party_reasons: ['没有匹配到本次飞行的报备计划，找不到飞手和运营单位'] };
  const allowed = autoHandoffView({ can_handoff: true, auto_handoff: manual });
  assert.equal(allowed.title, '需要选择处罚接收单位');
  assert.equal(allowed.tone, 'warning');
  assert.equal(allowed.canSubmit, true);
  assert.equal(allowed.partyUnidentified, true);
  assert.match(partyWarning(allowed), /^当事人不明，按待补线索移送：没有匹配到本次飞行的报备计划/);
  assert.equal(autoHandoffView({ can_handoff: false, auto_handoff: manual }).canSubmit, false);
  assert.equal(autoHandoffView({ auto_handoff: manual }).canSubmit, false);
  // 已经有交接时不再给入口，改为查看交接。
  const linked = autoHandoffView({ can_handoff: true, auto_handoff: manual }, 'handoff-1');
  assert.equal(linked.canSubmit, false);
  assert.equal(linked.handoffId, 'handoff-1');
  assert.equal(partyWarning(autoHandoffView({ can_handoff: true, auto_handoff: { status: 'MANUAL_REQUIRED' } })), '');
});

test('the handoff line tells apart automatic, manual, not sent yet and not needed', async () => {
  const { autoHandoffView } = await load('components/disposal/autoHandoffView.js');
  const auto = autoHandoffView({ auto_handoff: { status: 'SUBMITTED', handoff_id: 'h-1', trigger_source: 'JAMMING_COMPLETED', reason: '已提交' } });
  assert.deepEqual([auto.title, auto.tone, auto.reason, auto.handoffId], ['已自动移送到处罚', 'success', '', 'h-1']);
  assert.equal(autoHandoffView({ auto_handoff: { status: 'SUBMITTED', handoff_id: 'h-2', trigger_source: 'MANUAL' } }).title, '已选定接收单位移送到处罚');
  assert.equal(autoHandoffView({ auto_handoff: { status: 'SUBMITTED', handoff_id: 'h-3' } }).title, '已移送到处罚');
  const pending = autoHandoffView({ auto_handoff: { status: 'PENDING', handoff_id: 'h-4', reason: '处罚交接已建立，还没有发给处罚部门' } });
  assert.deepEqual([pending.title, pending.tone, pending.reason], ['处罚交接已建立，还没有发出', 'warning', '处罚交接已建立，还没有发给处罚部门']);
  const falsePositive = autoHandoffView({ can_handoff: true, auto_handoff: { status: 'NOT_REQUIRED', reason: '已核实为误报，不需要移送处罚' } });
  assert.deepEqual([falsePositive.title, falsePositive.tone, falsePositive.canSubmit], ['不需要自动移送', 'muted', false]);
  assert.equal(autoHandoffView({ auto_handoff: { status: 'WAITING', reason: '干扰完成后自动移送到处罚' } }).title, '等待移送到处罚');
  assert.equal(autoHandoffView(null).title, '移送状态暂不可用');
  assert.equal(autoHandoffView(null, 'h-5').title, '已移送到处罚');
});

test('handoff submit errors never invite a blind second submit', async () => {
  const { handoffSubmitError } = await load('components/disposal/autoHandoffView.js');
  assert.match(handoffSubmitError({ code: 'TIMEOUT' }), /不要重复提交/);
  assert.match(handoffSubmitError({ code: 'NETWORK_ERROR' }), /不要重复提交/);
  assert.match(handoffSubmitError({ code: 'HANDOFF_ALREADY_EXISTS' }), /已经移送/);
  assert.match(handoffSubmitError({ code: 'VERSION_CONFLICT' }), /刷新后再提交/);
  assert.match(handoffSubmitError({ code: 'RECIPIENT_NOT_CONFIGURED' }), /重新选择/);
  assert.equal(handoffSubmitError({ message: '后端说明' }), '后端说明');
  assert.equal(handoffSubmitError(null), '提交失败，请稍后重试。');
});

test('the time-window note the backend appends is stripped in both its old and new wording', async () => {
  const { autoSmsView } = await load('components/disposal/autoSmsView.js');
  for (const lead of ['本地演示策略', '自动通知时效']) {
    const view = autoSmsView({ auto_sms: { status: 'BLOCKED', can_retry: false,
      reason: `事件已超过自动通知时效；${lead}：目标和研判有效期120秒，事件及人工确认有效期300秒` } });
    assert.equal(view.reason, '原告警已超过自动发送时效；本次核实不会更新原告警和目标观测时间。');
  }
});

test('an alert past the notification window asks to check the latest situation before any SMS or call', async () => {
  const { autoSmsView, smsExpired } = await load('components/disposal/autoSmsView.js');
  const reason = '事件已超过自动通知时效，需核对最新情况：告警已超过300秒，情况可能已经变化，系统不再自动发送短信和拨打电话';
  const stale = autoSmsView({ auto_sms: { status: 'BLOCKED', can_retry: true, reason } });
  assert.equal(stale.title, '需核对最新情况');
  assert.equal(stale.tone, 'warning');
  assert.equal(stale.reason, '告警已超过300秒，情况可能已经变化，系统不再自动发送短信和拨打电话');
  assert.deepEqual([stale.expired, stale.canRetry, stale.recheck], [true, true, true]);
  assert.match(stale.guidance, /核对后发送飞手短信/);
  const noPermission = autoSmsView({ auto_sms: { status: 'BLOCKED', can_retry: false, reason } });
  assert.deepEqual([noPermission.recheck, noPermission.canRetry], [false, false]);
  assert.match(noPermission.guidance, /有权限的人员核对后/);
  // 本来就发不了（通道没接通）时保留原状态，只补一句核对提示，不叫人去登记发送。
  const unavailable = autoSmsView({ auto_sms: { status: 'UNAVAILABLE', can_retry: false, reason: `${reason}；同时正式短信渠道尚未接入，真实来源不能冒充模拟送达` } });
  assert.equal(unavailable.title, '需核对最新情况');
  assert.equal(unavailable.guidance, '请先核对目标现在的位置和违规情况。');
  assert.equal(smsExpired({ status: 'SIMULATED_DELIVERED', reason }), false);
  assert.equal(smsExpired({ status: 'WAITING', reason: '已核对最新情况并登记发送，等待后台发送' }), false);
  const queued = autoSmsView({ auto_sms: { status: 'WAITING', reason: '已核对最新情况并登记发送，等待后台发送', trigger_source: 'MANUAL_RECHECK' } });
  assert.deepEqual([queued.title, queued.reason, queued.source], ['等待自动通知', '已核对最新情况并登记发送，等待后台发送', 'MANUAL_RECHECK']);
});

test('a false positive closes the SMS and call steps instead of leaving them waiting', async () => {
  const { autoSmsView } = await load('components/disposal/autoSmsView.js');
  const { autoVoiceView } = await load('components/disposal/autoVoiceView.js');
  const sms = autoSmsView({ auto_sms: { status: 'NOT_REQUIRED', can_retry: true, reason: '已核实为误报，不需要发送飞手短信' } });
  assert.deepEqual([sms.title, sms.tone, sms.canRetry, sms.recheck], ['不需要发送短信', 'muted', false, false]);
  const voice = autoVoiceView({ auto_voice: { status: 'NOT_REQUIRED', can_retry: true, reason: '已核实为误报，不需要拨打飞手电话' } });
  assert.deepEqual([voice.title, voice.tone, voice.canRetry], ['不需要拨打飞手电话', 'muted', false]);
  const staleVoice = autoVoiceView({ auto_voice: { status: 'BLOCKED', can_retry: false, reason: '短信因超过自动通知时效没有自动发送，电话也不自动拨打；请先核对最新情况' } });
  assert.deepEqual([staleVoice.title, staleVoice.canRetry], ['超过时效，不自动拨打', false]);
});

test('handoff material shows the frozen party, judgments and evidence chain with hashes', async () => {
  const { evidenceChainView, judgmentViews, partyView } = await load('pages/punish/handoffMaterialView.js');
  const material = {
    party: { status: 'UNIDENTIFIED', label: '当事人不明，按待补线索移送', reasons: ['没有匹配到本次飞行的报备计划，找不到飞手和运营单位'], uav_sn: 'SN-1' },
    judgments: [
      { basis: 'EVENT_ALARM', evaluation_id: 'e-1', legal_status: 'ILLEGAL', plan_match_code: 'NONE', violation_reasons: ['INSIDE_RESTRICTED_AIRSPACE'], unknown_reasons: [], evaluated_at: 1 },
      { basis: 'LATEST', evaluation_id: 'e-2', legal_status: 'LEGAL', review_state: 'OVERRIDDEN', manual_status: 'ILLEGAL', violation_reasons: [], unknown_reasons: ['POSITION_UNKNOWN'] }
    ],
    evidence_chain: [
      { category: 'VIDEO', source_kind: 'FILE', source_id: 'ev/1', evidence_no: 'EV-1', name: 'eo.mp4', kind_code: 'EO_VIDEO', sha256: 'a'.repeat(64), captured_at: 5 },
      { category: 'TRACK', source_kind: 'TRACK', source_id: 'tr-1', evidence_no: 'tr-1', name: 'T-9', point_count: 12, started_at: 3 },
      { category: 'COMMAND', source_kind: 'COMMAND', source_id: 'c-1', evidence_no: 'CMD-1', name: 'EO_BEGIN_TRACK', captured_at: 4 }
    ]
  };
  const party = partyView(material);
  assert.deepEqual([party.unidentified, party.title, party.lines, party.uavSn], [true, '当事人不明，按待补线索移送', material.party.reasons, 'SN-1']);
  const known = partyView({ party: { status: 'IDENTIFIED', pilot_name: '张飞手', operator_name: '某运营公司', plan_no: 'P-1' } });
  assert.deepEqual([known.unidentified, known.lines, known.plan], [false, ['飞手：张飞手', '运营单位：某运营公司'], 'P-1']);
  const reasons = { INSIDE_RESTRICTED_AIRSPACE: '进入禁飞/限制空域', POSITION_UNKNOWN: '位置未知' };
  const judgments = judgmentViews(material, code => reasons[code] || code);
  assert.deepEqual(judgments.map(row => [row.basis, row.legal, row.tone]), [['告警依据的研判', '非法', 't-red'], ['移送时最新研判', '合法', 't-green']]);
  assert.deepEqual(judgments[0].reasons, ['进入禁飞/限制空域']);
  assert.equal(judgments[0].planMatch, '计划匹配：无匹配计划');
  assert.equal(judgments[0].plan, '');
  assert.equal(judgments[1].review, '人工改判为非法');
  // 无匹配时研判里留的计划只是候选，不能写成“报备计划”。
  const plans = judgmentViews({ judgments: [{ plan_match_code: 'NONE', plan_no: 'P-9' }, { plan_match_code: 'FULL', plan_no: 'P-1' }] });
  assert.deepEqual(plans.map(row => row.plan), ['候选计划 P-9（未匹配上这条计划）', '报备计划 P-1']);
  assert.deepEqual(judgments[1].unknowns, ['位置未知']);
  const chain = evidenceChainView(material);
  assert.equal(chain.total, 3);
  assert.deepEqual(chain.items.map(row => [row.category, row.name, row.no]), [['录像', 'eo.mp4', 'EV-1'], ['轨迹', '目标 T-9 的轨迹', ''], ['指令', '开始光电跟踪', 'CMD-1']]);
  assert.equal(chain.items[0].sha256, 'a'.repeat(64));
  assert.equal(chain.items[0].href, '#/evidence?file=ev%2F1');
  assert.equal(chain.items[1].href, '');
  assert.equal(chain.items[1].points, '12 个点');
  // 旧材料没有这几段：不显示，不拿现在的数据补。
  assert.equal(partyView({}), null);
  assert.equal(judgmentViews({}), null);
  assert.equal(evidenceChainView({ evidence: [] }), null);
  assert.deepEqual(evidenceChainView({ evidence_chain: [] }), { total: 0, items: [] });
  assert.deepEqual(judgmentViews({ judgments: [] }), []);
});
