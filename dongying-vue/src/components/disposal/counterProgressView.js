/* 处置进度里的“反制”一行（2026-10-18 rose 确认）：谁发起（自动反制 / 人工反制）、什么时候开始和停止、设备回执。
   只整理授权记录和它的办理事件里已有的事实；开始以设备回执“已打开”为准，只下发了启动指令不算开始。
   不推进授权、不替设备判断结果。 */
import { COUNTERMEASURE_MODE_LABEL, DISPOSAL_STATUS_LABEL, labelOf } from '../../ui/labels.js';

/** 后台自动规则执行身份（AutomationPrincipal.USER_ID）；自动反制都以它发起且为直接授权。 */
export const AUTOMATION_ACTOR_ID = 'automation-rule-runner';

const ACTION = { COUNTERMEASURE: '反制', JAMMING: '信号干扰' };
const STOP_KIND = { COMPLETE: '已停止', STOP: '人工停止', FAIL: '执行失败' };

/** 同一事件可能有多条反制授权：取最近申请的一条反制，没有反制再看历史干扰。 */
export function pickCounterAuthorization(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(row => row && ['COUNTERMEASURE', 'JAMMING'].includes(row.action_type));
  const latest = type => list.filter(row => row.action_type === type)
    .reduce((a, b) => (!a || Number(b.requested_at || 0) >= Number(a.requested_at || 0) ? b : a), null);
  return latest('COUNTERMEASURE') || latest('JAMMING');
}

export function isAutomaticCounter(row) {
  return !!row && row.requested_by === AUTOMATION_ACTOR_ID && row.authorization_mode === 'DIRECT';
}

function statusText(row) {
  if (row.status === 'FAILED' && row.result_code === 'AUTHORIZATION_STOPPED') return '启动被拦截';
  if (row.status === 'STOPPED') return row.action_type === 'COUNTERMEASURE' ? '反制已中止' : '已停止';
  if (row.status === 'EXECUTING') return `${ACTION[row.action_type] || '处置'}中`;
  return labelOf(DISPOSAL_STATUS_LABEL, row.status, '状态待确认');
}

const has = (event, key) => Object.prototype.hasOwnProperty.call(event || {}, key);
const actorOf = (list, kind) => [...list].reverse().find(event => event.event_kind === kind)?.actor_name || '';
const sentence = text => (/[。！？]$/.test(text) ? text : `${text}。`);

/** 人工申请的审批结论（#32）：按状态和办理记录如实写批准、驳回、撤销或过期，驳回把理由带上。 */
function reviewDecision(row, list) {
  const requester = `${row.requested_by_name || '申请人未记录'}申请`;
  const approver = row.approved_by_name || '';
  const note = String(row.decision_note || '').trim();
  switch (row.status) {
    case 'REQUESTED': return { initiator: `${requester}，等待审批`, decisionNote: '' };
    case 'REJECTED': return {
      initiator: `${requester}，${approver || actorOf(list, 'REJECT') || '审批人'}驳回`,
      decisionNote: note ? `驳回理由：${sentence(note)}` : '驳回时没有填写理由。'
    };
    case 'CANCELLED': {
      const canceller = actorOf(list, 'CANCEL')
        || (row.result_code === 'CANCELLED_BY_REQUESTER' ? row.requested_by_name : row.result_code === 'CANCELLED_BY_APPROVER' ? '审批人' : '');
      const approved = approver && row.approved_at != null ? `，${approver}批准` : '';
      return { initiator: `${requester}${approved}，${canceller ? `${canceller}撤销` : '已撤销'}`, decisionNote: '' };
    }
    case 'EXPIRED':
      return { initiator: approver ? `${requester}，${approver}批准，授权到期前没有执行` : `${requester}，已过期`, decisionNote: '' };
    default:
      return { initiator: `${requester}${approver ? `，${approver}批准` : ''}`, decisionNote: '' };
  }
}

const STOP_STATUS_RECEIPT = {
  CONTROLLER_ALL_OFF_ACK: '已全部关闭（控制器已确认全关）',
  MANUALLY_CONFIRMED: '已关闭（现场已确认停止）',
  QUEUED: '停止命令正在排队，等待设备确认关闭',
  WAITING_FEEDBACK: '已下发停止，等待设备确认关闭',
  FAILED: '停止命令失败，设备可能还开着，请看上方急停结果',
  TIMED_OUT: '等待停止反馈超时，设备可能还开着，请看上方急停结果',
  OFFLINE: '设备离线，停止命令没有下发，设备可能还开着',
  UNSUPPORTED: '这台设备不能远程停止，请到现场关停'
};
const ENDED = ['STOPPED', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REJECTED'];
const AFTER_OPEN = ['STOP', 'COMPLETE', 'FAIL', 'CANCEL', 'EXPIRE', 'DEVICE_ALL_OFF_ISSUED'];

/**
 * 设备回执（#33）：按最后一次回执或停止事实写。“已打开”的回执之后又有停止、全关或授权已结束，
 * 就不再沿用“已打开，反制中”，改按急停记录里这台设备的停止结果写；读不到停止结果时如实说“还没有收到关闭回执”。
 */
function receiptText(row, list, known, stop) {
  if (!known) return '';
  if (['REJECTED', 'CANCELLED', 'EXPIRED'].includes(row.status) && !list.some(event => event.event_kind === 'EXECUTE')) return '没有启动，没有设备回执';
  const lastReceipt = [...list].reverse().find(event => event.event_kind === 'RECEIPT' && event.note);
  const receiptAt = lastReceipt ? Number(lastReceipt.occurred_at || 0) : -Infinity;
  const stillOpen = lastReceipt?.snapshot?.device_on === true;
  const laterStop = [...list].reverse().find(event => AFTER_OPEN.includes(event.event_kind) && Number(event.occurred_at || 0) >= receiptAt);
  if (lastReceipt && !(stillOpen && (laterStop || ENDED.includes(row.status)))) return String(lastReceipt.note);
  if (!lastReceipt && !list.some(event => AFTER_OPEN.includes(event.event_kind))) return '还没有设备回执';
  if (!lastReceipt && !list.some(event => event.event_kind === 'EXECUTE')) return '设备没有启动，无需关闭';
  const device = stopDevice(row, stop, lastReceipt ? receiptAt : -Infinity);
  if (device && STOP_STATUS_RECEIPT[device.stop_status]) return STOP_STATUS_RECEIPT[device.stop_status];
  const allOff = [...list].reverse().find(event => event.event_kind === 'DEVICE_ALL_OFF_ISSUED' && Number(event.occurred_at || 0) >= receiptAt);
  if (allOff || row.device_stop_result === 'ALL_OFF_ISSUED') return '已下发全部关闭，等待设备确认';
  return '已停止，还没有收到设备关闭的回执';
}

/** 急停记录里这台设备的停止结果；只认这次打开之后发起的急停。 */
function stopDevice(row, stop, after) {
  if (!stop || !Array.isArray(stop.devices) || Number(stop.requested_at || 0) < after) return null;
  const devices = stop.devices.filter(Boolean);
  if (row.device_id) return devices.find(device => device.device_id === row.device_id) || null;
  return devices.length === 1 ? devices[0] : null;
}

/**
 * @param {object|null} row 授权记录（/disposal-authorizations 列表行）
 * @param {Array|null} events 该授权的办理事件；null 表示还没读到或读取失败
 * @param {object|null} stop 本事件最近一次急停记录（急停面板读到的 latest_stop），没有就不传
 * @returns {null|{ title:string, initiator:string, decisionNote:string, status:string, startedAt:number|null, startText:string,
 *   stoppedAt:number|null, stopText:string, receipt:string, eventsKnown:boolean }}
 */
export function counterProgressView(row, events, stop = null) {
  if (!row) return null;
  const automatic = isAutomaticCounter(row);
  const action = ACTION[row.action_type] || '处置';
  const mode = row.countermeasure_mode ? labelOf(COUNTERMEASURE_MODE_LABEL, row.countermeasure_mode) : '';
  const title = `${automatic ? '自动' : '人工'}${action}${mode ? ` · ${mode}` : ''}`;
  const known = Array.isArray(events);
  const list = known ? [...events].filter(Boolean).sort((a, b) => Number(a.occurred_at || 0) - Number(b.occurred_at || 0)) : [];
  const decision = automatic ? { initiator: '系统按启用的反制规则自动发起', decisionNote: '' }
    : row.authorization_mode === 'DIRECT'
      ? { initiator: `${row.requested_by_name || '发起人未记录'}直接发起（免逐次审批）`, decisionNote: '' }
      : reviewDecision(row, list);
  const opened = list.find(event => event.event_kind === 'RECEIPT' && event.snapshot?.device_on === true);
  const issued = list.find(event => event.event_kind === 'EXECUTE');
  const stopped = [...list].reverse().find(event => has(STOP_KIND, event.event_kind));
  const startText = opened ? '设备已打开'
    : issued ? '已下发启动指令，等待设备回执'
      : ['REQUESTED', 'APPROVED'].includes(row.status) ? '尚未启动'
        : ['REJECTED', 'CANCELLED', 'EXPIRED'].includes(row.status) ? '没有启动' : known ? '没有设备打开的回执' : '';
  let stopText = '';
  if (stopped) stopText = stopped.event_kind === 'STOP' && stopped.actor_name ? `${stopped.actor_name}停止` : STOP_KIND[stopped.event_kind];
  else if (opened && row.status === 'EXECUTING') stopText = '还在执行，到时系统自动关闭';
  else if (['REJECTED', 'CANCELLED', 'EXPIRED'].includes(row.status) && !issued) stopText = '没有启动，无需停止';
  return {
    title, initiator: decision.initiator, decisionNote: decision.decisionNote, status: statusText(row),
    startedAt: opened ? Number(opened.occurred_at) : null, startText,
    stoppedAt: stopped ? Number(stopped.occurred_at) : null, stopText,
    receipt: receiptText(row, list, known, stop),
    eventsKnown: known
  };
}
