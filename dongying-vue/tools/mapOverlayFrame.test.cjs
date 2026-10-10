// Exercise the real frame scheduler, shared route installers and route painter.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.MAP_TEST_ROOT || path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const jobs = new Map();
let nextId = 0;
const sandbox = {
  window: { UI: { captureAlarmGlows: () => [], releaseAlarmGlows() {} } },
  requestAnimationFrame(callback) { const id = ++nextId; jobs.set(id, callback); return id; },
  cancelAnimationFrame(id) { jobs.delete(id); }
};
vm.createContext(sandbox);
vm.runInContext(read('public/assets/js/map.js'), sandbox);
vm.runInContext(read('src/services/positionMap.js').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''), sandbox);
const MapView = sandbox.window.MapView;
function flush() {
  const callbacks = [...jobs.values()]; jobs.clear();
  callbacks.forEach(callback => callback(100));
}
function makeMap(online) {
  const strokes = [], order = [];
  let points = [];
  const ctx = new Proxy({
    clearRect() { strokes.length = 0; order.push('clear'); },
    beginPath() { points = []; },
    moveTo(x, y) { points.push([x, y]); },
    lineTo(x, y) { points.push([x, y]); },
    stroke() { strokes.push({ color: this.strokeStyle, points: points.slice() }); },
    measureText() { return { width: 10 }; }
  }, { get(target, key) { return key in target ? target[key] : () => {}; } });
  const map = Object.assign(Object.create(MapView.prototype), {
    w: 800, h: 600, ctx, actx: { clearRect() {} }, opt: {}, online, map: online ? {} : null,
    box: { isConnected: true }, scale: 1, offset: 0,
    px(lon, lat) { return [lon * this.scale + this.offset, lat * this.scale]; },
    _drawStatic() { ctx.clearRect(); order.push('base'); },
    _drawAnimated() { order.push('animation'); },
    _hit() { order.push('hit'); }, _loop() {}
  });
  return { map, strokes, order };
}
const routes = [ [[31, 42], [63, 71]], [[112, 16], [139, 83], [179, 96]] ];
for (const online of [true, false]) for (const coordinates of routes) {
  const { map, strokes, order } = makeMap(online);
  const baseOverlay = map.drawOverlay.bind(map);
  sandbox.installCenterline(map, coordinates);
  map.draw(); map.draw(); map.draw();
  assert.equal(strokes.length, 0, 'requesting a frame must not paint an overlay early');
  assert.equal(jobs.size, 1, 'multiple redraw requests still coalesce');
  flush();
  const routeStroke = () => strokes.find(stroke => stroke.color === '#8ca0a8');
  assert.deepEqual(routeStroke().points, coordinates, 'route survives the scheduled canvas clear');
  const staticImage = JSON.stringify(strokes);
  if (online) map._drawAnimated();
  flush();
  assert.equal(JSON.stringify(strokes), staticImage, 'idle/decoration frames keep the business route');
  map.scale = 2; map.offset = 23; map._viewHitPending = true;
  map.draw(); map.draw(); flush();
  assert.deepEqual(routeStroke().points, coordinates.map(([x, y]) => [x * 2 + 23, y * 2]), 'zoom/pan uses the latest projection');
  assert.equal(order.at(-1), 'hit', 'hit testing runs after overlays update');
  // Same-map data refresh, as used by legality evidence: replace, do not stack old painters.
  map.drawOverlay = baseOverlay;
  sandbox.installOverlays(map, { centerline: routes[1], airspaces: [{ polygons: [[[[10, 10], [20, 10], [20, 20], [10, 10]]]] }] });
  map.draw(); flush();
  const nextPoints = routes[1].map(([x, y]) => [x * 2 + 23, y * 2]);
  assert.equal(strokes.filter(stroke => stroke.color === '#8ca0a8'
    && JSON.stringify(stroke.points) === JSON.stringify(nextPoints)).length, 1);
  assert.ok(strokes.some(stroke => stroke.color === '#7545c7'), 'airspace remains on the same frame');
  assert.deepEqual(routeStroke().points, routes[1].map(([x, y]) => [x * 2 + 23, y * 2]));
  map.drawOverlay = baseOverlay;
  sandbox.installOverlays(map, { centerline: null, airspaces: [] });
  map.draw(); flush();
  assert.equal(strokes.length, 0, 'missing geometry does not retain an old route');
  sandbox.installCenterline(map, coordinates);
  map.draw(); map.setPaused(true); flush();
  assert.equal(strokes.length, 0, 'pause cancels pending overlays');
  map.setPaused(false); flush();
  assert.ok(routeStroke(), 'resume repaints overlays');
  map.draw(); map._dead = true; flush();
  assert.equal(jobs.size, 0, 'destroyed maps do not schedule another frame');
}

// Page-specific risk halos must be collected before the decoration layer paints.
const { map: glowMap, order } = makeMap(true);
glowMap.drawOverlay = function () { order.push('overlay'); this._glows.push({ x: 20, y: 30 }); };
glowMap._drawAnimated = function () { assert.equal(this._glows.length, 1); order.push('animation'); };
glowMap.draw(); flush();
assert.deepEqual(order, ['clear', 'base', 'overlay', 'animation']);

// All page consumers must extend the synchronous hook, never the queued request.
for (const file of ['src/pages/FlightsPage.vue', 'src/pages/LegalityPage.vue',
  'src/pages/airspace/AirspacePage.vue', 'src/pages/spacerisk/SpaceRiskPage.vue', 'src/services/positionMap.js']) {
  const source = read(file);
  assert.doesNotMatch(source, /\.draw\s*=|\.draw\.bind\(/, `${file} still extends the asynchronous request`);
  assert.match(source, /\.drawOverlay\s*=/);
}
console.log('PASS: routes persist across coalesced frames, idle, zoom/pan, data replacement, pause/resume and both base-map modes');
