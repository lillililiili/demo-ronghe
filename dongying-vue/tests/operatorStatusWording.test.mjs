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
