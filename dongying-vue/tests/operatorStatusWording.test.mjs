import test from 'node:test';
import assert from 'node:assert/strict';
import { autoHandoffProgress, mergeHandoffProgress, punishmentHandoffProgress } from '../src/ui/punishmentHandoffProgress.js';
import { autoHandoffView, pendingSendStep } from '../src/components/disposal/autoHandoffView.js';
import { uavProcessStatus } from '../src/pages/situation/situationFlow.js';
import { autoSmsView, noReportedPilot, NO_REPORTED_PILOT_TEXT } from '../src/components/disposal/autoSmsView.js';
import { autoVoiceView } from '../src/components/disposal/autoVoiceView.js';
import { currentLegalityText } from '../src/components/disposal/uavNowStatus.js';
import { altitudeSpeedText } from '../src/pages/alarms/alarmMotion.js';
import { counterProgressView, pickCounterAuthorization, AUTOMATION_ACTOR_ID } from '../src/components/disposal/counterProgressView.js';
import { riskHeaderState, noticesLagBehindRisk } from '../src/pages/flights/riskNoticeState.js';
import { countPendingApprovals, pendingApprovalText, canSeePendingApprovals } from '../src/services/pendingApprovals.js';
import { deviceReach } from '../src/ui/deviceReach.js';

const punishment = (delivery, id = 'h-1') => ({ handoff_id: id, handoff_type: 'UAV_PUNISHMENT', delivery_status: delivery });

test('#9 handoff progress: sent vs created-but-not-sent vs none', () => {
  for (const id of ['h-1', 'handoff-998877']) {
    assert.equal(punishmentHandoffProgress([punishment('DELIVERED', id)]), 'HANDED_OFF');
    assert.equal(punishmentHandoffProgress([punishment('SUBMITTED', id)]), 'HANDED_OFF');
    assert.equal(punishmentHandoffProgress([punishment('PENDING_DELIVERY', id)]), 'HANDOFF_PENDING');
  }
  assert.equal(punishmentHandoffProgress([punishment('FAILED')]), null);
  assert.equal(punishmentHandoffProgress([]), null);
  assert.equal(punishmentHandoffProgress([{ handoff_type: 'RISK_NOTICE', delivery_status: 'DELIVERED' }]), null);
  // 读不懂的状态不说成已移送。
  assert.equal(punishmentHandoffProgress([punishment('SOMETHING_NEW')]), 'HANDOFF_PENDING');
  assert.equal(autoHandoffProgress({ handoff_id: 'h', status: 'SUBMITTED' }), 'HANDED_OFF');
  assert.equal(autoHandoffProgress({ handoff_id: 'h', status: 'PENDING' }), 'HANDOFF_PENDING');
  assert.equal(autoHandoffProgress({ handoff_id: 'h', status: 'FAILED' }), null);
  assert.equal(autoHandoffProgress({ status: 'WAITING' }), null);
  assert.equal(mergeHandoffProgress('HANDOFF_PENDING', 'HANDED_OFF'), 'HANDED_OFF');
  assert.equal(mergeHandoffProgress(null, 'HANDOFF_PENDING'), 'HANDOFF_PENDING');
  assert.equal(mergeHandoffProgress(null, null), null);
});

test('#9 situation card status follows the same wording', () => {
  assert.equal(uavProcessStatus({ eventState: 'CONFIRMED', handoff: 'HANDED_OFF' }), '已移送处罚');
  assert.equal(uavProcessStatus({ eventState: 'CONFIRMED', handoff: 'HANDOFF_PENDING' }), '待发送移送');
  assert.equal(uavProcessStatus({ eventState: 'CONFIRMED', handoff: '' }), '告警已确认');
});

test('#9 detail: pending handoff names the next step and who sends it', () => {
  const pending = autoHandoffView({ auto_handoff: { status: 'PENDING', handoff_id: 'h-7', reason: '通知处罚的规则还没有全部满足' } });
  assert.match(pending.title, /^待发送移送/);
  assert.equal(pending.awaitingSend, true);
  const sent = autoHandoffView({ auto_handoff: { status: 'SUBMITTED', handoff_id: 'h-7', trigger_source: 'COUNTERMEASURE_COMPLETED' } });
  assert.equal(sent.title, '已自动移送到处罚');
  assert.equal(sent.awaitingSend, false);
  // 通知决定流程（待决定）沿用原说法，不显示发送按钮。
  const decision = autoHandoffView({ auto_handoff: { status: 'PENDING', handoff_id: 'h-7', notification_decision: { state: 'NOTIFY' } } });
  assert.equal(decision.awaitingSend, false);

  assert.match(pendingSendStep({ permitted: false, status: null }).who, /需由有移送权限的人员发送/);
  assert.equal(pendingSendStep({ permitted: false, status: { can_notify: true } }).canSend, false);
  assert.equal(pendingSendStep({ permitted: true, status: { can_notify: true } }).canSend, true);
  const blocked = pendingSendStep({ permitted: true, status: { can_notify: false, blocked_reason: '原处罚接收方已停用' } });
  assert.equal(blocked.canSend, false);
  assert.equal(blocked.blocked, '原处罚接收方已停用');
  assert.equal(pendingSendStep({ permitted: true, status: null, loading: true }).canSend, false);
});

const NO_PLAN = '当前事件尚无精确关联任务，不能把单位联系人当作执行飞手';
const STALE = '事件已超过自动通知时效，需核对最新情况：告警已超过300秒，情况可能已经变化，系统不再自动发送短信和拨打电话';

test('#13 no reported pilot: same wording before and after the notification window', () => {
  for (const reason of [NO_PLAN, '未找到该任务的执行飞手联系人', `${STALE}；同时${NO_PLAN}`]) {
    const data = { auto_sms: { status: 'BLOCKED', reason, attempt_count: 0 }, auto_voice: { status: 'BLOCKED', reason, attempt_count: 0 } };
    assert.equal(noReportedPilot(data), true, reason);
    const sms = autoSmsView(data), voice = autoVoiceView(data);
    assert.equal(sms.title, '没有报备飞手，不发短信');
    assert.equal(sms.reason, NO_REPORTED_PILOT_TEXT);
    assert.equal(sms.expired, false);
    assert.equal(sms.canRetry, false);
    assert.equal(voice.title, '没有报备飞手，不打电话');
    assert.equal(voice.reason, NO_REPORTED_PILOT_TEXT);
  }
});

test('#13 a reported pilot keeps the original waiting / stale wording', () => {
  const waiting = { auto_sms: { status: 'WAITING', reason: '事件尚未核实属实，核实后自动发送短信', attempt_count: 0 } };
  assert.equal(noReportedPilot(waiting), false);
  assert.equal(autoSmsView(waiting).title, '等待自动通知');
  const stale = { auto_sms: { status: 'BLOCKED', reason: STALE, attempt_count: 0, can_retry: true } };
  assert.equal(noReportedPilot(stale), false);
  assert.equal(autoSmsView(stale).title, '需核对最新情况');
  // 已经发过的以发送记录为准。
  assert.equal(noReportedPilot({ auto_sms: { status: 'BLOCKED', reason: NO_PLAN, attempt_count: 1 } }), false);
  // 任务里有飞手但没电话：仍是“缺飞手联系方式”。
  const contact = autoSmsView({ pilot_contact_missing: true, auto_sms: { status: 'BLOCKED', reason: '执行飞手联系方式尚未有效核验', attempt_count: 0 } });
  assert.equal(contact.title, '缺飞手联系方式');
});

test('#16 current judgment: no valid observation instead of the last legality', () => {
  assert.equal(currentLegalityText({ observationStatus: 'EXPIRED', legalLabel: '合法' }), '已无有效观测');
  assert.equal(currentLegalityText({ observationStatus: 'UNKNOWN', legalLabel: '合法' }), '观测待确认');
  assert.equal(currentLegalityText({ observationStatus: 'CURRENT', legalLabel: '非法' }), '非法');
  assert.equal(currentLegalityText({ observationStatus: 'CURRENT', legalLabel: '合法', stale: true }), '合法');
  assert.equal(currentLegalityText({ stale: true, legalLabel: '合法' }), '已无有效观测');
  assert.equal(currentLegalityText({ legalLabel: '' }), '—');
});

test('#28 speed keeps the last reported value with its time', () => {
  assert.equal(altitudeSpeedText({ altitude_amsl_m: 120, speed_mps: 8.5 }, null), '120 m / 8.5 m/s');
  const at = Date.UTC(2026, 9, 17, 2, 21, 5);
  assert.equal(altitudeSpeedText({ altitude_amsl_m: 95, speed_mps: null }, { speed_mps: '6.2', observed_at: at }), '95 m / 6.2 m/s（最后一次上报 10:21:05）');
  assert.equal(altitudeSpeedText({ altitude_amsl_m: null, speed_mps: null }, null), '— m / — m/s');
  // 最新状态有速度时不用旧值。
  assert.equal(altitudeSpeedText({ altitude_amsl_m: 30, speed_mps: 0 }, { speed_mps: 9, observed_at: at }), '30 m / 0 m/s');
});

test('#15 countermeasure row: automatic vs manual, start, stop and device receipt', () => {
  const base = { authorization_id: 'a-1', action_type: 'COUNTERMEASURE', authorization_mode: 'DIRECT', requested_at: 10 };
  const auto = { ...base, requested_by: AUTOMATION_ACTOR_ID, status: 'COMPLETED' };
  const events = [
    { event_kind: 'DIRECT_AUTHORIZE', occurred_at: 100 },
    { event_kind: 'EXECUTE', occurred_at: 110 },
    { event_kind: 'RECEIPT', occurred_at: 120, note: '设备回执：已打开，反制中；满 30 秒系统自动全部关闭，也可以随时急停', snapshot: { device_on: true } },
    { event_kind: 'RECEIPT', occurred_at: 150, note: '设备回执：已全部关闭', snapshot: {} },
    { event_kind: 'COMPLETE', occurred_at: 150 }
  ];
  const view = counterProgressView(auto, [...events].reverse());
  assert.equal(view.title, '自动反制');
  assert.equal(view.initiator, '系统按启用的反制规则自动发起');
  assert.equal(view.startedAt, 120);
  assert.equal(view.startText, '设备已打开');
  assert.equal(view.stoppedAt, 150);
  assert.equal(view.receipt, '设备回执：已全部关闭');

  const manual = counterProgressView({ ...base, authorization_mode: 'REVIEW', requested_by: 'u-9', requested_by_name: '值班员甲', approved_by_name: '审批员乙', status: 'STOPPED' },
    [{ event_kind: 'EXECUTE', occurred_at: 5 }, { event_kind: 'STOP', occurred_at: 9, actor_name: '值班员甲' }]);
  assert.equal(manual.title, '人工反制');
  assert.equal(manual.initiator, '值班员甲申请，审批员乙批准');
  assert.equal(manual.status, '反制已中止');
  assert.equal(manual.startedAt, null);
  assert.equal(manual.startText, '已下发启动指令，等待设备回执');
  assert.equal(manual.stopText, '值班员甲停止');
  // 另一个人工直接反制、还没读到办理记录。
  const direct = counterProgressView({ ...base, requested_by: 'u-2', requested_by_name: '处置员丙', status: 'EXECUTING' }, null);
  assert.equal(direct.title, '人工反制');
  assert.equal(direct.eventsKnown, false);
  assert.equal(counterProgressView(null, []), null);

  assert.equal(pickCounterAuthorization([{ action_type: 'JAMMING', requested_at: 50, authorization_id: 'j' },
    { action_type: 'COUNTERMEASURE', requested_at: 10, authorization_id: 'c1' }, { action_type: 'COUNTERMEASURE', requested_at: 20, authorization_id: 'c2' }]).authorization_id, 'c2');
  assert.equal(pickCounterAuthorization([{ action_type: 'JAMMING', requested_at: 50, authorization_id: 'j' }]).authorization_id, 'j');
  assert.equal(pickCounterAuthorization([]), null);
});

test('#10 risk header follows the notice record', () => {
  const base = { label: state => ({ NOTIFIED: '通知已提交', ACKNOWLEDGED: '已回执', PENDING_NOTIFICATION: '待通知' })[state], tag: () => 't-gray' };
  const notices = [{ delivery_status: 'SUBMITTED', receipt_status: 'PENDING' }];
  assert.equal(riskHeaderState({ state: 'ACKNOWLEDGED' }, notices, base).label, '送达待确认');
  assert.equal(riskHeaderState({ state: 'ACKNOWLEDGED' }, [{ delivery_status: 'DELIVERED', receipt_status: 'ACKNOWLEDGED' }], base).label, '已回执');
  assert.equal(riskHeaderState({ state: 'NOTIFIED' }, [{ delivery_status: 'DELIVERED', receipt_status: 'PENDING' }], base).label, '已送达，等待回执');
  assert.equal(riskHeaderState({ state: 'NOTIFIED' }, [{ delivery_status: 'FAILED' }, { delivery_status: 'DELIVERED', receipt_status: 'TIMEOUT' }], base).label, '回执超时');
  // 未通知的风险、记录没读到时用风险自身状态。
  assert.equal(riskHeaderState({ state: 'PENDING_NOTIFICATION' }, notices, base).label, '待通知');
  assert.equal(riskHeaderState({ state: 'ACKNOWLEDGED' }, notices, { ...base, loaded: false }).label, '已回执');
  assert.equal(riskHeaderState({ state: 'ACKNOWLEDGED' }, [], base).label, '已回执');
  assert.equal(noticesLagBehindRisk({ state: 'ACKNOWLEDGED' }, notices), true);
  assert.equal(noticesLagBehindRisk({ state: 'ACKNOWLEDGED' }, [{ delivery_status: 'DELIVERED', receipt_status: 'ACKNOWLEDGED' }]), false);
  assert.equal(noticesLagBehindRisk({ state: 'PENDING_NOTIFICATION' }, []), false);
});

test('#14 pending approvals count only what this account may approve', async () => {
  const row = (id, by, actions = ['APPROVE', 'REJECT'], channel = 'COUNTERMEASURE_4CH') => ({ authorization_id: id, status: 'REQUESTED', requested_by: by, allowed_actions: actions, channel });
  const all = [row('1', 'u-a'), row('2', 'me'), row('3', 'u-b', ['CANCEL']), row('4', 'u-c', ['APPROVE'], 'MANUAL'), row('5', 'u-d', ['APPROVE'], 'LINGYUN_B')];
  const calls = [];
  const list = async params => { calls.push(params); return { items: all.slice((params.page - 1) * params.size, params.page * params.size), total: all.length }; };
  const result = await countPendingApprovals(list, 'me');
  assert.deepEqual(result, { count: 2, more: false });
  assert.equal(calls[0].status, 'REQUESTED');
  assert.equal(pendingApprovalText(result), '待我审批 2');
  assert.equal(pendingApprovalText({ count: 0, more: false }), '');
  assert.equal(pendingApprovalText({ count: 3, more: true }), '待我审批 3+');
  assert.equal(await countPendingApprovals(list, 'me', () => false), null);
  await assert.rejects(countPendingApprovals(async () => ({ items: null }), 'me'));
  // 换一个账号：自己申请的不算，别人的才算。
  assert.equal((await countPendingApprovals(list, 'u-a')).count, 2);
  const can = codes => code => codes.includes(code);
  assert.equal(canSeePendingApprovals(can(['disposal:approve', 'disposal:read']), () => true), true);
  assert.equal(canSeePendingApprovals(can(['disposal:read']), () => true), false);
  assert.equal(canSeePendingApprovals(can(['disposal:approve', 'disposal:read']), () => false), false);
});

test('#25 coverage: registered range decides, missing range says so plainly', () => {
  const point = { lon: 118.5, lat: 37.4 };
  const device = { longitude: 118.5, latitude: 37.4074 }; // 约 820 米
  const inside = deviceReach({ ...device, coverage: { kind: 'CIRCLE', radius_m: 1500 } }, point);
  assert.equal(inside.inRange, true);
  assert.equal(inside.unknown, false);
  const outside = deviceReach({ ...device, coverage: { kind: 'CIRCLE', radius_m: 500 } }, point);
  assert.equal(outside.inRange, false);
  assert.equal(outside.unknown, false);
  const none = deviceReach({ ...device, coverage: null }, point);
  assert.equal(none.unknown, true);
  assert.equal(none.reason, '这台设备没有登记覆盖范围，无法判断能否覆盖目标');
});

test('#32 manual counter row follows the review decision and shows the rejection reason', () => {
  const base = { authorization_id: 'a-32', action_type: 'COUNTERMEASURE', authorization_mode: 'REVIEW', requested_by: 'u-1', requested_by_name: '张值班', requested_at: 10 };
  const events = [{ event_kind: 'REQUEST', occurred_at: 10 }, { event_kind: 'REJECT', occurred_at: 20, actor_name: '李审批' }];
  const rejected = counterProgressView({ ...base, status: 'REJECTED', approved_by_name: '李审批', decision_note: '证据不足：请先确认是否为报备任务的备用机' }, events);
  assert.equal(rejected.initiator, '张值班申请，李审批驳回');
  assert.equal(rejected.decisionNote, '驳回理由：证据不足：请先确认是否为报备任务的备用机。');
  assert.equal(rejected.status, '已驳回');
  assert.equal(rejected.startText, '没有启动');
  assert.equal(rejected.receipt, '没有启动，没有设备回执');
  assert.doesNotMatch(rejected.initiator, /批准/);
  // 换人、没写理由、还没读到办理记录：仍按状态写驳回。
  const other = counterProgressView({ ...base, requested_by_name: '王值班', status: 'REJECTED', approved_by_name: '赵审批', decision_note: '' }, null);
  assert.equal(other.initiator, '王值班申请，赵审批驳回');
  assert.equal(other.decisionNote, '驳回时没有填写理由。');
  // 其他审批结论。
  assert.equal(counterProgressView({ ...base, status: 'REQUESTED' }, []).initiator, '张值班申请，等待审批');
  assert.equal(counterProgressView({ ...base, status: 'APPROVED', approved_by_name: '李审批', approved_at: 30 }, []).initiator, '张值班申请，李审批批准');
  assert.equal(counterProgressView({ ...base, status: 'CANCELLED', result_code: 'CANCELLED_BY_REQUESTER' }, []).initiator, '张值班申请，张值班撤销');
  assert.equal(counterProgressView({ ...base, status: 'CANCELLED', approved_by_name: '李审批', approved_at: 30 },
    [{ event_kind: 'CANCEL', occurred_at: 40, actor_name: '李审批' }]).initiator, '张值班申请，李审批批准，李审批撤销');
  assert.equal(counterProgressView({ ...base, status: 'EXPIRED', approved_by_name: '李审批', approved_at: 30 }, []).initiator, '张值班申请，李审批批准，授权到期前没有执行');
  assert.equal(counterProgressView({ ...base, status: 'COMPLETED', approved_by_name: '李审批', approved_at: 30, decision_note: '同意' }, []).decisionNote, '');
});

test('#33 device receipt follows the last receipt or stop fact', () => {
  const base = { authorization_id: 'a-33', action_type: 'COUNTERMEASURE', authorization_mode: 'REVIEW', requested_by_name: '张值班', approved_by_name: '李审批', device_id: 'dev-1', requested_at: 10 };
  const opened = { event_kind: 'RECEIPT', occurred_at: 120, note: '设备回执：已打开，反制中；满 60 秒系统自动全部关闭，也可以随时急停', snapshot: { device_on: true } };
  const events = [{ event_kind: 'EXECUTE', occurred_at: 110 }, opened, { event_kind: 'STOP', occurred_at: 140, actor_name: '张值班' }];
  const stop = status => ({ stop_id: 's-1', requested_at: 140, devices: [{ device_id: 'dev-1', stop_status: status }, { device_id: 'dev-9', stop_status: 'FAILED' }] });
  // 还在执行：沿用打开的回执。
  assert.match(counterProgressView({ ...base, status: 'EXECUTING' }, events.slice(0, 2)).receipt, /已打开/);
  // 急停后已收到全关确认。
  const acked = counterProgressView({ ...base, status: 'STOPPED' }, events, stop('CONTROLLER_ALL_OFF_ACK'));
  assert.equal(acked.receipt, '已全部关闭（控制器已确认全关）');
  assert.equal(acked.stopText, '张值班停止');
  // 停止命令还在等反馈；别的设备失败不算到这台。
  assert.equal(counterProgressView({ ...base, status: 'STOPPED' }, events, stop('WAITING_FEEDBACK')).receipt, '已下发停止，等待设备确认关闭');
  // 换一台设备：按它自己的停止结果写。
  assert.match(counterProgressView({ ...base, device_id: 'dev-9', status: 'STOPPED' }, events, stop('CONTROLLER_ALL_OFF_ACK')).receipt, /设备可能还开着/);
  // 读不到急停记录：已下发全关或只知道已停止，都不再说“已打开，反制中”。
  const issued = counterProgressView({ ...base, status: 'STOPPED', device_stop_result: 'ALL_OFF_ISSUED' }, events, null);
  assert.equal(issued.receipt, '已下发全部关闭，等待设备确认');
  const unknown = counterProgressView({ ...base, status: 'STOPPED' }, events, null);
  assert.equal(unknown.receipt, '已停止，还没有收到设备关闭的回执');
  // 早于这次打开的旧急停记录不算。
  assert.equal(counterProgressView({ ...base, status: 'STOPPED' }, events, { ...stop('CONTROLLER_ALL_OFF_ACK'), requested_at: 100 }).receipt,
    '已停止，还没有收到设备关闭的回执');
  // 到时自动全部关闭：最后一条回执就是关闭回执。
  const completed = counterProgressView({ ...base, status: 'COMPLETED' },
    [...events.slice(0, 2), { event_kind: 'DEVICE_ALL_OFF_ISSUED', occurred_at: 180 }, { event_kind: 'RECEIPT', occurred_at: 181, note: '设备回执：已全部关闭', snapshot: {} }, { event_kind: 'COMPLETE', occurred_at: 181 }]);
  assert.equal(completed.receipt, '设备回执：已全部关闭');
});

test('#34 progress sources are read only with the matching view permission', async () => {
  const { canReadProgressSource, readProgressSource, mergeProgressRead, PROGRESS_SOURCE_PERMISSION } = await import('../src/pages/alarms/progressAccess.js');
  const { noCounterEntryVisible } = await import('../src/components/disposal/counterNextStep.js');
  const lead = code => ['alarm:read'].includes(code);
  const exec = code => ['alarm:read', 'disposal:read', 'disposal:execute'].includes(code);
  const duty = code => ['alarm:read', 'alarm:verify', 'disposal:read', 'handoff:read'].includes(code);
  assert.deepEqual(PROGRESS_SOURCE_PERMISSION, { auths: 'disposal:read', handoffs: 'handoff:read' });
  let calls = 0;
  const request = async () => { calls += 1; return { items: [{ id: 'x' }] }; };
  assert.deepEqual(await readProgressSource('handoffs', request, lead), { forbidden: true });
  assert.deepEqual(await readProgressSource('auths', request, lead), { forbidden: true });
  assert.deepEqual(await readProgressSource('handoffs', request, exec), { forbidden: true });
  assert.equal(calls, 0, '没有权限不发请求');
  assert.deepEqual(await readProgressSource('auths', request, exec), { items: [{ id: 'x' }] });
  assert.equal(calls, 1);
  assert.equal(canReadProgressSource('handoffs', duty), true);
  assert.equal(canReadProgressSource('unknown', duty), false);
  // 服务端仍按 403 拒绝（权限刚被收回）：按无权查看，不算失败；别的错误才算读取失败。
  assert.deepEqual(await readProgressSource('auths', async () => { throw Object.assign(new Error('x'), { status: 403 }); }, duty), { forbidden: true });
  const failed = await readProgressSource('auths', async () => { throw Object.assign(new Error('x'), { status: 500 }); }, duty);
  assert.equal(failed.failed, true);
  // 并入来源状态：无权查看是“没有可见记录”，不是失败；失败保留上次事实；旧结果不覆盖新结果。
  assert.deepEqual(mergeProgressRead(undefined, 1, { forbidden: true }), { seq: 1, items: [], failed: false, forbidden: true });
  const ok = mergeProgressRead(undefined, 2, { items: [1] });
  assert.deepEqual(mergeProgressRead(ok, 3, { failed: true }), { seq: 3, items: [1], failed: true });
  assert.equal(mergeProgressRead(ok, 1, { items: [9] }), ok);
  // “无风险不反制”入口只给有告警核实权限的账号。
  assert.equal(noCounterEntryVisible(lead), false);
  assert.equal(noCounterEntryVisible(exec), false);
  assert.equal(noCounterEntryVisible(duty), true);
  assert.equal(noCounterEntryVisible(null), false);
});
