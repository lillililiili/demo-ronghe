/* 反制弹窗里的「附近航班」提示（2026-10-26 用户确认的设计）。
   只在用四通道反制设备反制时出现；没接入航班接收机、或附近没有航班时什么都不显示。
   - 禁止反制范围有航班：红色提示，提交按钮不可用。
   - 提醒范围有航班：橙色提示，勾选「已确认附近航班，继续反制」后才能提交。
   - 收不到航班信息：灰色提示，勾选「仍要反制」后才能提交。
   页面只做提示；服务端提交时、下发前会再查一次，以服务端为准。 */
import { flightAvoidanceApi } from '@/services/flightAvoidanceApi.js';

const ACK_LABEL = { WARN: '已确认附近航班，继续反制', NO_DATA: '仍要反制' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function km(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

/** 这次提交用哪种反制方式检查；不用四通道反制设备时返回 null（不检查）。 */
export function flightModeOf(model) {
  if (model?.channel !== 'COUNTERMEASURE_4CH') return null;
  if (model.action_type === 'JAMMING') return 'DRIVE_AWAY';
  if (model.action_type !== 'COUNTERMEASURE') return null;
  return model.countermeasure_mode === 'DRIVE_AWAY' ? 'DRIVE_AWAY' : 'FORCE_LAND';
}

function stateOf(model) {
  const mode = flightModeOf(model);
  const state = model?._flight;
  if (!mode || !model.device_id || !state || state.key !== `${model.device_id}:${mode}`) return null;
  return state;
}

/** 当前要显示的级别：BLOCK / WARN / NO_DATA，其余（含还没读到）返回空串。 */
export function flightLevel(model) {
  const level = stateOf(model)?.level || '';
  return ['BLOCK', 'WARN', 'NO_DATA'].includes(level) ? level : '';
}

/** 设备或反制方式变了就重新查一次；结果写回表单，供提示和按钮使用。 */
export function refreshFlightCheck(model) {
  const mode = flightModeOf(model);
  const deviceId = String(model?.device_id || '').trim();
  if (!mode || !deviceId || deviceId === '__none__') { if (model._flight) model._flight = null; return; }
  const key = `${deviceId}:${mode}`;
  if (model._flight?.key === key) return;
  model._flight = { key, level: '', aircraft: [] };
  model.flight_check_ack = false;
  flightAvoidanceApi.check(deviceId, mode).then(data => {
    if (model._flight?.key !== key) return;
    model._flight = { key, level: data?.level || '', mode, aircraft: data?.aircraft || [] };
  }).catch(() => {
    // 读不到时按收不到航班信息提示；能不能反制由服务端提交时再查。
    if (model._flight?.key === key) model._flight = { key, level: 'NO_DATA', mode, aircraft: [] };
  });
}

function rowHtml(a) {
  const name = a.callsign || String(a.icao24 || '').toUpperCase();
  const height = a.altitude_m == null ? '高度不明' : `高度 ${a.altitude_m} 米`;
  return `<tr><td>${esc(name)}</td><td>${esc(km(a.distance_km))} 公里</td><td>${esc(height)}</td><td>${a.approaching ? '正在靠近' : '正在飞远'}</td></tr>`;
}

/** 提示块的内容。info 为 true 时（审批弹窗）只说明，不带「改用驱离」之类的操作提示。 */
export function flightNoticeHtml(model, { info = false } = {}) {
  const state = stateOf(model);
  const level = flightLevel(model);
  if (!level) return '';
  const forceLand = state.mode === 'FORCE_LAND';
  const head = level === 'BLOCK' ? `附近有航班，不能${forceLand ? '迫降' : '反制'}` : level === 'WARN' ? '附近有航班' : '暂时收不到航班信息';
  const rows = (state.aircraft || []).filter(a => level !== 'BLOCK' || a.zone === 'BLOCK').slice(0, 5);
  const text = level === 'NO_DATA' ? '无法确认附近有没有航班。'
    : level === 'BLOCK' && !info ? (forceLand ? '可以改用驱离，或等航班飞远后再反制。' : '请等航班飞远后再反制。') : '';
  return `<div class="flight-notice is-${level.toLowerCase()}"><b>${esc(head)}</b>`
    + (rows.length ? `<table>${rows.map(rowHtml).join('')}</table>` : '')
    + (text ? `<div>${esc(text)}</div>` : '') + '</div>';
}

/** 反制弹窗用的两个表单项：提示块和确认勾选。 */
export function flightCheckFields({ info = false } = {}) {
  return [
    { key: '_flight_notice', type: 'html', html: model => flightNoticeHtml(model, { info }), visibleWhen: model => !!flightLevel(model) },
    ...(info ? [] : [{
      key: 'flight_check_ack', type: 'checkbox', class: model => `flight-ack is-${flightLevel(model).toLowerCase()}`,
      boxLabel: model => ACK_LABEL[flightLevel(model)] || '', visibleWhen: model => ['WARN', 'NO_DATA'].includes(flightLevel(model))
    }])
  ];
}

/** 提交前的页面提示；没问题时返回 null。 */
export function flightValidate(model) {
  const level = flightLevel(model);
  if (level === 'BLOCK') return flightModeOf(model) === 'FORCE_LAND' ? '附近有航班，不能迫降。可以改用驱离，或等航班飞远后再反制。' : '附近有航班，不能反制。请等航班飞远后再反制。';
  if ((level === 'WARN' || level === 'NO_DATA') && model.flight_check_ack !== true) return `请先勾选「${ACK_LABEL[level]}」。`;
  return null;
}

/** 写进提交内容：只有显示了勾选框时才带上，避免把没看到的确认发给服务端。 */
export function flightAckOf(model) {
  return ['WARN', 'NO_DATA'].includes(flightLevel(model)) && model.flight_check_ack === true;
}
