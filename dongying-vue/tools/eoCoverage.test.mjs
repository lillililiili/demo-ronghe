import assert from 'node:assert/strict';
import test from 'node:test';
import { eoCoveragePresentation, eoCoverageView } from '../src/pages/situation/eoCoverage.js';

const rad = Math.PI / 180;
function destination(lon, lat, distance, bearing) {
  const angular = distance / 6371000, azimuth = bearing * rad, latitude = lat * rad;
  const outLat = Math.asin(Math.sin(latitude) * Math.cos(angular)
    + Math.cos(latitude) * Math.sin(angular) * Math.cos(azimuth));
  const outLon = lon * rad + Math.atan2(Math.sin(azimuth) * Math.sin(angular) * Math.cos(latitude),
    Math.cos(angular) - Math.sin(latitude) * Math.sin(outLat));
  return { lon: outLon / rad, lat: outLat / rad };
}
function bearing(origin, point) {
  const a = origin.lat * rad, b = point.lat * rad, dl = (point.lon - origin.lon) * rad;
  return (Math.atan2(Math.sin(dl) * Math.cos(b), Math.cos(a) * Math.sin(b)
    - Math.sin(a) * Math.cos(b) * Math.cos(dl)) / rad + 360) % 360;
}

test('the live EO fan follows camera azimuth while eligible targets remain in configured turning range', () => {
  const device = { typeCode: 'EO', status: '在线', lon: 118.6, lat: 37.4,
    coverage: { kind: 'circle', status: 'available', radiusM: 4000 },
    eoView: { available: true, validUntil: 5000, azimuth: 0, fov: 60 } };
  const north = destination(device.lon, device.lat, 1000, 0);
  const east = destination(device.lon, device.lat, 1000, 90);
  const targets = [north, east].map((position, index) => ({ ...position,
    targetId: `target-${index}`, objectTypeCode: 'UAV', posValid: true }));

  const view = eoCoverageView(device, targets, 1000);
  assert.equal(view.targets.length, 2, 'turning range remains selectable outside the current camera direction');
  assert.equal(view.viewCoordinates.length, 22, 'the current view is a closed fan from camera origin to its angular edge');
  assert.deepEqual(view.viewCoordinates[0], [device.lon, device.lat]);
  assert.ok(Math.abs(bearing(device, { lon: view.viewCoordinates[1][0], lat: view.viewCoordinates[1][1] }) - 330) < 0.2);
  assert.ok(Math.abs(bearing(device, { lon: view.viewCoordinates.at(-1)[0], lat: view.viewCoordinates.at(-1)[1] }) - 30) < 0.2);
  assert.match(view.summary, /可转向/);

  const rotated = eoCoverageView({ ...device, eoView: { ...device.eoView, azimuth: 90 } }, targets, 1000);
  assert.ok(Math.abs(bearing(device, { lon: rotated.viewCoordinates[1][0], lat: rotated.viewCoordinates[1][1] }) - 60) < 0.2);
  assert.ok(Math.abs(bearing(device, { lon: rotated.viewCoordinates.at(-1)[0], lat: rotated.viewCoordinates.at(-1)[1] }) - 120) < 0.2);
  assert.equal(eoCoverageView({ ...device, eoView: { ...device.eoView, validUntil: 1000 } }, targets, 1000).viewCoordinates.length, 0,
    'expired camera orientation must not leave a stale fan on the map');
  assert.equal(eoCoverageView({ ...device, status: '离线' }, targets, 1000).viewCoordinates.length, 0,
    'offline optical equipment must not claim a current view');
});

test('offline optical equipment reports unknown coverage and preserves selected alerts', () => {
  const presentation = eoCoveragePresentation({
    device: { status: '离线' }, view: { targets: [] }, selectedCount: 2
  });
  assert.equal(presentation.coverageLabel, '当前视场未确认');
  assert.match(presentation.emptyMessage, /离线/);
  assert.match(presentation.emptyMessage, /无法确认/);
  assert.match(presentation.emptyMessage, /已选告警仍保留/);
  assert.doesNotMatch(presentation.emptyMessage, /暂无.*无人机/);
});

test('failed target or device reads do not claim that coverage is empty', () => {
  const targetFailure = eoCoveragePresentation({
    device: { status: '在线' }, view: { targets: [] }, targetsUnavailable: true
  });
  assert.equal(targetFailure.coverageLabel, '目标状态未知');
  assert.match(targetFailure.emptyMessage, /读取失败/);
  assert.match(targetFailure.emptyMessage, /无法确认/);

  const deviceFailure = eoCoveragePresentation({
    view: { targets: [] }, devicesUnavailable: true
  });
  assert.equal(deviceFailure.coverageLabel, '设备状态未知');
  assert.match(deviceFailure.emptyMessage, /设备状态读取失败/);
});

test('only a readable online device with an empty valid range says no UAV is in range', () => {
  const presentation = eoCoveragePresentation({
    device: { status: '在线' }, view: { targets: [], reason: '' }
  });
  assert.equal(presentation.coverageLabel, '0 架无人机');
  assert.match(presentation.emptyMessage, /范围内暂无.*无人机/);

  const withTarget = eoCoveragePresentation({
    device: { status: '在线' }, view: { targets: [{ targetId: 'uav-1' }], reason: '' }
  });
  assert.equal(withTarget.coverageLabel, '1 架无人机');
  assert.equal(withTarget.emptyMessage, '');
});
