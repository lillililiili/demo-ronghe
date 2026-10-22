import test from 'node:test';
import assert from 'node:assert/strict';
import { openBoundary, closeBoundary, validateVolume, makeFrame, project, unproject, heightFromDrag, editableSeaLevelBounds } from '../src/pages/airspace/airspaceVolume.js';

test('upstream AGL and unknown altitude datum require explicit AMSL re-entry without relabelling old values', () => {
  for (const datum of ['AGL', null, 'UNKNOWN']) {
    const version = { altitude_datum: datum, min_altitude_m: 20, max_altitude_m: 120 };
    assert.deepEqual(editableSeaLevelBounds(version), { lower: null, upper: null });
    assert.equal(version.max_altitude_m, 120);
  }
  assert.deepEqual(editableSeaLevelBounds({altitude_datum:'AMSL', min_altitude_m:-25.5,max_altitude_m:180.25}), {lower:-25.5,upper:180.25});
});

test('closed multipolygons and holes round trip without losing coordinates', () => {
  const boundary = { type: 'MultiPolygon', coordinates: [
    [[[118,37],[118.02,37],[118.02,37.02],[118,37]], [[118.01,37.005],[118.015,37.005],[118.015,37.01],[118.01,37.005]]],
    [[[119,38],[119.01,38],[119,38.01],[119,38]]]
  ] };
  const draft = openBoundary(boundary);
  assert.equal(draft[0][0].length, 3);
  assert.deepEqual(closeBoundary(draft), boundary);
  draft[0][0][0][0] = 117;
  assert.equal(boundary.coordinates[0][0][0][0], 118);
});

for (const [longitude, latitude] of [[118.4,37.5], [110.2,-20.1], [-72,49]]) {
  test(`rotated three-dimensional projection preserves longitude and latitude at ${longitude}, ${latitude}`, () => {
    const polygons = [[[[longitude, latitude], [longitude + .02, latitude], [longitude, latitude + .015]]]];
    const frame = makeFrame(polygons, -30, 400);
    for (const yaw of [-2.7, 0, .65, 2.5]) for (const pitch of [.2, .75, 1.3]) {
      const camera = { yaw, pitch, zoom: 1.4 };
      for (const altitude of [-30, 400]) {
        const point = [longitude + .004, latitude + .007];
        const screen = project(point, altitude, frame, camera);
        const back = unproject(screen, altitude, frame, camera);
        assert.ok(Math.abs(back[0] - point[0]) < 1e-8);
        assert.ok(Math.abs(back[1] - point[1]) < 1e-8);
      }
      const low = project(polygons[0][0][0], -30, frame, camera);
      const high = project(polygons[0][0][0], 400, frame, camera);
      assert.ok(high.y < low.y, 'upper surface must be above lower surface');
      assert.ok(Math.abs(heightFromDrag(-30, high.y - low.y, frame, camera) - 400) < 1e-8);
    }
  });
}

test('blank, inverted, zero-thickness and invalid longitude cannot be saved; negative AMSL is valid', () => {
  const p = [[[[118,37],[118.01,37],[118,37.01]]]];
  assert.equal(validateVolume(p, -30, 100), '');
  assert.match(validateVolume(p, null, 100), /海拔/);
  assert.match(validateVolume(p, 100, 100), /高于/);
  assert.match(validateVolume(p, 200, 100), /高于/);
  assert.match(validateVolume(p, 100.001, 100.002), /两位小数/);
  assert.match(validateVolume(p, 0, 100000000), /范围/);
  assert.equal(validateVolume(p, -30.01, 100.99), '');
  assert.match(validateVolume([[[[181,37],[118.01,37],[118,37.01]]]], 0, 100), /经纬度/);
  assert.match(validateVolume([[[[null,null],[118.01,37],[118,37.01]]]], 0, 100), /经纬度/);
  assert.match(validateVolume([[[[118,37],[118,37],[118,37.01]]]], 0, 100), /重复/);
  assert.match(validateVolume([[[[118,37],[118.01,37.01],[118,37.01],[118.01,37]]]], 0, 100), /相交/);
});
