/* 处置进度里的“反制”一行（2026-10-18 rose 确认）：谁发起（自动反制 / 人工反制）、什么时候开始和停止、设备回执。
   只整理授权记录和它的办理事件里已有的事实；开始以设备回执“已打开”为准，只下发了启动指令不算开始。
   不推进授权、不替设备判断结果。 */
import { DISPOSAL_STATUS_LABEL, labelOf } from '../../ui/labels.js';

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
  if (row.status === 'STOPPED') return row.action_type === 'COUNTERMEASURE' ? '反制已中止' : '已停止';
  if (row.status === 'EXECUTING') return `${ACTION[row.action_type] || '处置'}中`;
  return labelOf(DISPOSAL_STATUS_LABEL, row.status, '状态待确认');
}

/**
 * @param {object|null} row 授权记录（/disposal-authorizations 列表行）
 * @param {Array|null} events 该授权的办理事件；null 表示还没读到或读取失败
 * @returns {null|{ title:string, initiator:string, status:string, startedAt:number|null, startText:string,
 *   stoppedAt:number|null, stopText:string, receipt:string, eventsKnown:boolean }}
 */
export function counterProgressView(row, events) {
  if (!row) return null;
  const automatic = isAutomaticCounter(row);
  const action = ACTION[row.action_type] || '处置';
  const title = `${automatic ? '自动' : '人工'}${action}`;
  const initiator = automatic ? '系统按启用的反制规则自动发起'
    : row.authorization_mode === 'DIRECT'
      ? `${row.requested_by_name || '发起人未记录'}直接发起（免逐次审批）`
      : `${row.requested_by_name || '申请人未记录'}申请${row.approved_by_name ? `，${row.approved_by_name}批准` : ''}`;
  const known = Array.isArray(events);
  const list = known ? [...events].filter(Boolean).sort((a, b) => Number(a.occurred_at || 0) - Number(b.occurred_at || 0)) : [];
  const opened = list.find(event => event.event_kind === 'RECEIPT' && event.snapshot?.device_on === true);
  const issued = list.find(event => event.event_kind === 'EXECUTE');
  const stopped = [...list].reverse().find(event => Object.prototype.hasOwnProperty.call(STOP_KIND, event.event_kind));
  const receipt = [...list].reverse().find(event => event.event_kind === 'RECEIPT' && event.note);
  const startText = opened ? '设备已打开'
    : issued ? '已下发启动指令，等待设备回执'
      : ['REQUESTED', 'APPROVED'].includes(row.status) ? '尚未启动' : known ? '没有设备打开的回执' : '';
  let stopText = '';
  if (stopped) stopText = stopped.event_kind === 'STOP' && stopped.actor_name ? `${stopped.actor_name}停止` : STOP_KIND[stopped.event_kind];
  else if (opened && row.status === 'EXECUTING') stopText = '还在执行，到时系统自动关闭';
  return {
    title, initiator, status: statusText(row),
    startedAt: opened ? Number(opened.occurred_at) : null, startText,
    stoppedAt: stopped ? Number(stopped.occurred_at) : null, stopText,
    receipt: receipt ? String(receipt.note) : known && !opened && !stopped ? '还没有设备回执' : '',
    eventsKnown: known
  };
}
