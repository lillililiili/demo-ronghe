import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alarmReasonView, departureBasisText, uavNowHtml, uavNowPillHtml, uavNowStatus } from '../src/components/disposal/uavNowStatus.js';

const now = Date.UTC(2026, 9, 14, 5, 37, 20);
const base = { current: true, observedAt: now - 3000, now, reasonText: code => ({ PLAN_ALTITUDE_EXCEEDED: '超出任务高度飞行', INSIDE_RESTRICTED_AIRSPACE: '进入禁飞/限制空域' })[code] || code };
const left = (at, basis = 'SMS_AIRSPACE') => ({ status: 'RECORDED', presence: 'LEFT', channel: 'SMS', basis, position: { observed_at: at, longitude: 118.6, latitude: 37.4 } });

test('latest violation wins over an earlier departure snapshot', () => {
  for (const reasons of [['PLAN_ALTITUDE_EXCEEDED'], ['INSIDE_RESTRICTED_AIRSPACE', 'PLAN_ALTITUDE_EXCEEDED']]) {
    const status = uavNowStatus({ ...base, legalStatus: 'ILLEGAL', legalReasons: reasons, departure: left(now - 60000) });
    assert.equal(status.key, 'VIOLATING');
    assert.equal(status.tone, 'red');
    assert.match(status.title, /^仍在违规：/);
    assert.match(status.detail, /曾判定已离开，但最新研判仍为违规$/);
    assert.equal(status.basis, '13:37:17 实测 · 刚刚');
  }
});

test('departure only counts with a current position', () => {
  assert.equal(uavNowStatus({ ...base, departure: left(now - 9000) }).key, 'LEFT');
  assert.equal(uavNowStatus({ ...base, departure: left(now - 9000, 'LATEST_LEGALITY') }).key, 'COMPLIANT');
  for (const departure of [left(now - 9000), null]) {
    const lost = uavNowStatus({ ...base, current: false, observedAt: now - 7 * 60000, legalStatus: 'LEGAL', departure });
    assert.equal(lost.key, 'UNKNOWN_POSITION');
    assert.match(lost.detail, /不能当作已飞离/);
    assert.match(lost.basis, /7 分钟前/);
  }
  assert.equal(uavNowStatus({ ...base, current: false, observedAt: null }).basis, '');
});

test('other states', () => {
  assert.equal(uavNowStatus({ ...base, departure: { presence: 'STILL_PRESENT', basis: 'SMS_AIRSPACE' } }).key, 'VIOLATING');
  assert.equal(uavNowStatus({ ...base, departure: { presence: 'UNKNOWN', basis: 'AIRSPACE_BOUNDARY' } }).key, 'BOUNDARY');
  assert.equal(uavNowStatus({ ...base, legalStatus: 'LEGAL' }).key, 'COMPLIANT');
  for (const legalStatus of ['UNDETERMINED', 'ABNORMAL', undefined]) assert.equal(uavNowStatus({ ...base, legalStatus }).key, 'PENDING');
});

test('basis text and html escape', () => {
  assert.match(departureBasisText(left(now)), /已离开告警时所在区域/);
  assert.match(departureBasisText({ presence: 'UNKNOWN', basis: 'NO_CURRENT_POSITION' }), /无法判断/);
  assert.equal(departureBasisText(null), '');
  const html = uavNowHtml({ ...uavNowStatus({ ...base, legalStatus: 'ILLEGAL', legalReasons: ['<x>'] }) }, { process: '告警已确认' });
  assert.match(html, /&lt;x&gt;/);
  assert.match(html, /告警已确认/);
  assert.match(uavNowPillHtml(uavNowStatus({ ...base, legalStatus: 'LEGAL' })), /已不再违规/);
});

// 2026-10-14 rose 选「直接消失」：只有有效位置证明已离开、且最新研判不再违规，才从融合感知去掉。
test('departed flag', () => {
  assert.equal(uavNowStatus({ ...base, departure: left(now - 9000) }).departed, true);
  assert.equal(uavNowStatus({ ...base, departure: left(now - 9000, 'LATEST_LEGALITY') }).departed, true);
  assert.equal(uavNowStatus({ ...base, legalStatus: 'ILLEGAL', departure: left(now - 9000) }).departed, false);
  assert.equal(uavNowStatus({ ...base, current: false, departure: left(now - 9000) }).departed, false);
  assert.equal(uavNowStatus({ ...base, legalStatus: 'LEGAL' }).departed, false);
});

test('alarm reason shows latest judgment first', () => {
  const text = code => ({ A: '超出任务高度飞行', B: '进入禁飞/限制空域' })[code] || code;
  const same = alarmReasonView({ legalStatus: 'ILLEGAL', legalReasons: ['A'], alarmReasons: ['A'], reasonText: text });
  assert.deepEqual([same.label, same.text, same.atAlarm, same.tone], ['现在的违规原因 · 最新研判', '超出任务高度飞行', '', 'risk']);
  const cleared = alarmReasonView({ legalStatus: 'LEGAL', legalReasons: [], alarmReasons: ['B'], reasonText: text });
  assert.deepEqual([cleared.text, cleared.atAlarm, cleared.tone], ['已无违规', '进入禁飞/限制空域', 'ok']);
  const unknown = alarmReasonView({ legalStatus: 'UNDETERMINED', alarmReasons: [], reasonText: text });
  assert.deepEqual([unknown.label, unknown.text], ['告警原因（出告警时）', '未记录具体触发原因']);
});
