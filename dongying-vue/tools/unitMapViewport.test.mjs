import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitMapViewport } from '../src/pages/situation/unitMapViewport.js';

const user = { user_type: 'FRONTEND', org_id: 'unit-a' };
const bounds = [118, 37, 119, 38];
const device = { posValid: true, lon: 118.55, lat: 37.45 };
const snapshot = { deviceUpdatedAt: 1, devices: [device] };
test('unit personnel and appointed admins focus authorized positions with a useful margin', () => {
  for (const who of [user, { ...user, management_context: { mode: 'UNIT' } }]) {
    const result = unitMapViewport(who, snapshot, bounds);
    assert.equal(result.focus.kind, 'fit');
    assert.ok(result.focus.coordinates[0][0] < device.lon);
    assert.ok(result.focus.coordinates[1][1] > device.lat);
    assert.equal(result.notice, '本单位设备区域');
  }
});
test('platform view stays unchanged and incomplete reads never claim a unit location', () => {
  assert.equal(unitMapViewport({ user_type: 'BACKEND' }, snapshot, bounds).focus, null);
  assert.equal(unitMapViewport(user, { devices: [device] }, bounds).ready, false);
  assert.equal(unitMapViewport(user, { ...snapshot, failedSegments: ['devices'] }, bounds).focus, null);
  assert.equal(unitMapViewport(user, { ...snapshot, deniedSegments: ['devices'] }, bounds).focus, null);
  assert.equal(unitMapViewport(user, snapshot, null).ready, false);
});
test('missing and out-of-package coordinates have explicit fallbacks and never expand the basemap', () => {
  for (const d of [{ posValid: false, lon: null, lat: null }, { posValid: true, lon: NaN, lat: 37 }]) {
    assert.match(unitMapViewport(user, { ...snapshot, devices: [d] }, bounds).notice, /暂无可定位设备/);
  }
  const outside = { posValid: true, lon: 120, lat: 37.5 };
  assert.match(unitMapViewport(user, { ...snapshot, devices: [outside] }, bounds).notice, /不在当前底图/);
  const result = unitMapViewport(user, { ...snapshot, devices: [device, outside] }, bounds);
  assert.match(result.notice, /部分设备/);
  assert.ok(result.focus.coordinates.every(p => p[0] >= 118 && p[0] <= 119 && p[1] >= 37 && p[1] <= 38));
});
