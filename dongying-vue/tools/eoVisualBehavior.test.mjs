import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { detectionPresentation } from '../src/components/video/deviceVideoState.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('linked video detections are labeled as alerts, while unlinked detections stay non-actionable', () => {
  assert.deepEqual(detectionPresentation({ label: 'UAV-17', eventId: 'event-17' }), {
    label: '告警 · UAV-17', alert: true
  });
  assert.deepEqual(detectionPresentation(null), { label: '未关联告警', alert: false });
});

test('the device video workspace does not render the automatic AI stream badge', () => {
  const source = fs.readFileSync(path.join(root, 'src/components/video/DeviceVideoWorkspace.vue'), 'utf8');
  assert.doesNotMatch(source, /AI 流.*自动/);
});

test('EO map coverage is the live reported sector, rotated only by reported azimuth', () => {
  const context = { window: { UI: { abnormalActive: () => false } } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/assets/js/map.js'), 'utf8'), context);
  const MapView = context.window.MapView;
  const map = Object.create(MapView.prototype);
  map.opt = { now: () => 1000 };
  map._still = () => true;
  const device = {
    typeCode: 'EO', status: '在线', lon: 0, lat: 0,
    coverage: { kind: 'circle', radiusM: 1000 },
    displayCoverage: { kind: 'circle', radiusM: 1000 },
    eoView: { available: true, validUntil: 5000, azimuth: 0, fov: 60 }
  };
  const capture = () => {
    const calls = [];
    const c = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]), set: () => true });
    map._drawDeviceCoverage(c, device, (lon, lat) => [lon, lat]);
    const coverageCallCount = calls.length;
    map._drawEoView(c, device, (lon, lat) => [lon, lat]);
    const wedge = calls.slice(coverageCallCount);
    const firstMove = wedge.findIndex(call => call[0] === 'moveTo');
    const firstPathEnd = wedge.findIndex((call, index) => index > firstMove && call[0] === 'closePath');
    const boundary = wedge.slice(firstMove + 1, firstPathEnd).filter(call => call[0] === 'lineTo');
    const angle = ([, x, y]) => (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
    return { coverage: calls.slice(0, coverageCallCount), start: angle(boundary[0]), end: angle(boundary.at(-1)) };
  };

  const north = capture();
  assert.equal(north.coverage.length, 0, 'EO configuration must not paint a misleading full-circle area');
  assert.ok(Math.abs(north.start - 330) < 0.2, `north-facing 60 degree sector begins at 330 degrees (got ${north.start})`);
  assert.ok(Math.abs(north.end - 30) < 0.2, `north-facing 60 degree sector ends at 30 degrees (got ${north.end})`);

  device.eoView = { ...device.eoView, azimuth: 90 };
  const east = capture();
  assert.ok(Math.abs(east.start - 60) < 0.2, `east-facing sector starts at 60 degrees (got ${east.start})`);
  assert.ok(Math.abs(east.end - 120) < 0.2, `east-facing sector ends at 120 degrees (got ${east.end})`);
});
