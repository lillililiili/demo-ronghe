import test from 'node:test';
import assert from 'node:assert/strict';
import { makeViewFrame, project, unproject, heightFromDrag } from '../src/pages/airspace/airspaceVolumeView.js';
import { makeFrame as realFrame, project as realProject } from '../src/pages/airspace/airspaceVolume.js';

const boundary = (lon, lat, span) => [[[[lon, lat], [lon + span, lat], [lon + span, lat + span], [lon, lat + span]]]];
const camera = { yaw: -.55, pitch: .65, zoom: 1 };

test('wide thin airspaces keep distinct upper and lower surfaces without changing their real coordinates', () => {
  for (const [lon, lat, span, lower, upper] of [[118, 36, 1.8, 0, 150], [-73, 42, 3, -20, 100], [110, -22, .3, 50, 50.01]]) {
    const polygons = boundary(lon, lat, span), snapshot = structuredClone(polygons);
    for (const pitch of [.2, .65, 1.3]) for (const zoom of [.3, 1, 4]) {
      const view = { ...camera, pitch, zoom };
      const frame = makeViewFrame(polygons, lower, upper, view);
      const low = project(polygons[0][0][0], lower, frame, view);
      const high = project(polygons[0][0][0], upper, frame, view);
      assert.ok(low.y - high.y >= 99.99, `height must remain readable at span=${span}, pitch=${pitch}, zoom=${zoom}; got ${low.y - high.y}`);
      assert.ok(Math.abs(heightFromDrag(lower, high.y - low.y, frame, view) - upper) < 1e-8, 'height handle must return actual metres, not display metres');
      const restored = unproject(high, upper, frame, view);
      assert.ok(Math.abs(restored[0] - lon) < 1e-8 && Math.abs(restored[1] - lat) < 1e-8);
    }
    assert.deepEqual(polygons, snapshot, 'display changes must not mutate saved geometry');
  }
});

test('true scale is available, and a naturally thick volume is not exaggerated', () => {
  for (const span of [2, .002]) {
    const polygons = boundary(118, 37, span);
    const frame = makeViewFrame(polygons, -30, 150, camera, false);
    const expected = realFrame(polygons, -30, 150);
    assert.deepEqual(project(polygons[0][0][0], 150, frame, camera), realProject(polygons[0][0][0], 150, expected, camera));
  }
  const thick = boundary(118, 37, .002);
  const frame = makeViewFrame(thick, 0, 200, camera);
  assert.equal(frame.heightScale ?? 1, 1);
});

test('exaggerated projection and both kinds of dragging remain inverse across rotations', () => {
  const polygons = boundary(112, -30, 2);
  for (const yaw of [-2.7, 0, .65, 2.5]) {
    const view = { ...camera, yaw };
    const frame = makeViewFrame(polygons, -40, 120, view);
    const point = [112.4, -29.2];
    for (const altitude of [-40, 120]) {
      const origin = project(point, altitude, frame, view);
      const moved = { x: origin.x + 22, y: origin.y - 18 };
      const changed = unproject(moved, altitude, frame, view);
      const screen = project(changed, altitude, frame, view);
      assert.ok(Math.abs(screen.x - moved.x) < 1e-8 && Math.abs(screen.y - moved.y) < 1e-8);
      const newHeight = heightFromDrag(altitude, -25, frame, view);
      const lifted = project(point, newHeight, frame, view);
      assert.ok(Math.abs(lifted.y - origin.y + 25) < 1e-8);
    }
  }
});

test('missing, zero and inverted altitude ranges do not gain a fabricated height', () => {
  for (const [lower, upper] of [[null, 120], [0, null], [120, 120], [120, 20]]) {
    const frame = makeViewFrame(boundary(118, 37, 2), lower, upper, camera);
    assert.equal(frame.heightScale ?? 1, 1);
  }
});
