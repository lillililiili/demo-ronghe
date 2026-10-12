// Exercise the real frame scheduler, shared route installers and route painter.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
async function main() {
const { toAirspaces, AIRSPACE_LAYERS } = await import('../src/services/situationData.js');
const root = process.env.MAP_TEST_ROOT || path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const jobs = new Map();
let nextId = 0;
const sandbox = {
  toAirspaces, window: { UI: { captureAlarmGlows: () => [], releaseAlarmGlows() {} } },
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
  const strokes = [], order = [], labels = [];
  let points = [];
  const ctx = new Proxy({
    clearRect() { strokes.length = 0; order.push('clear'); },
    beginPath() { points = []; },
    moveTo(x, y) { points.push([x, y]); },
    lineTo(x, y) { points.push([x, y]); },
    stroke() { strokes.push({ color: this.strokeStyle, points: points.slice() }); },
    fillText(text, x, y) { labels.push({ text, color: this.fillStyle, x, y }); },
    measureText(text) { return { width: text.length * 7 }; }
  }, { get(target, key) { return key in target ? target[key] : () => {}; } });
  const map = Object.assign(Object.create(MapView.prototype), {
    w: 800, h: 600, ctx, actx: { clearRect() {} }, opt: {}, online, map: online ? {} : null,
    box: { isConnected: true, querySelector() { return null; } }, scale: 1, offset: 0,
    data: { airspaces: [], devices: [], targets: [], alarms: [] }, layers: { nofly: true, suit: true, limit: true },
    unpx() { return [0, 0]; }, _levelForScale() { return 1; },
    px(lon, lat) { return [lon * this.scale + this.offset, lat * this.scale]; },
    _drawStatic() { ctx.clearRect(); labels.length = 0; order.push('base'); this._paintLayers(ctx, this.w, this.h); },
    _drawAnimated() { order.push('animation'); },
    _hit() { order.push('hit'); }, _loop() {}
  });
  return { map, strokes, order, labels };
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
  sandbox.installOverlays(map, { centerline: routes[1], airspaces: [{ version: { airspace_version_id: 'v-example', airspace_id: 'a-example', kind_code: 'PROHIBITED', boundary: { type: 'MultiPolygon' }, airspace_detail: { name: '任务引用禁飞区' } }, polygons: [[[[10, 10], [20, 10], [20, 20], [10, 10]]]] }] });
  map.draw(); flush();
  const nextPoints = routes[1].map(([x, y]) => [x * 2 + 23, y * 2]);
  assert.equal(strokes.filter(stroke => stroke.color === '#8ca0a8'
    && JSON.stringify(stroke.points) === JSON.stringify(nextPoints)).length, 1);
  assert.ok(strokes.some(stroke => stroke.color === '#d52d42e6'), 'airspace remains on the same frame');
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

// Every map uses the same identity and palette; historical geometry is not replaced by the directory's current version.
for (const [index, meta] of AIRSPACE_LAYERS.entries()) {
  const polygons = [[[[10 + index, 10], [30 + index, 10], [30 + index, 40], [10 + index, 10]]]];
  const version = { airspace_version_id: `v-${index}`, airspace_id: `a-${index}`, kind_code: meta.kindCode,
    boundary: { type: 'MultiPolygon', coordinate_system: 'WGS84', coordinates: polygons },
    airspace_detail: { airspace_id: `a-${index}`, airspace_no: `AREA-${index}`, name: `命名区域${index}`,
      current_version: { kind_code: 'PERMITTED', boundary: { type: 'MultiPolygon', coordinates: [] } } } };
  const overlays = [{ version, polygons }];
  const features = sandbox.mapAirspaceOverlays(overlays);
  assert.equal(features[0].name, version.airspace_detail.name);
  assert.equal(features[0].color, meta.color);
  assert.equal(features[0].kindCode, meta.kindCode);
  assert.deepEqual(features[0].rings, polygons[0]);
  assert.equal(sandbox.mapAirspaceOverlays([...overlays, ...overlays]).length, 1);
  const { map, labels } = makeMap(true);
  sandbox.installOverlays(map, { airspaces: overlays }); flush();
  assert.ok(labels.some(label => label.text.includes(version.airspace_detail.name) && label.color === meta.color));
  // Zoom into the polygon: the original center can leave the screen, but the visible area's label remains.
  map.scale = 50; map.offset = -500; map.draw(); flush();
  assert.ok(labels.some(label => label.text.includes(version.airspace_detail.name)));
  assert.ok(labels.every(label => label.x >= 0 && label.y >= 0 && label.x < map.w && label.y < map.h));
  assert.equal(sandbox.mapAirspaceOverlays([{ ...overlays[0], version: { ...version, airspace_detail: null } }])[0].name, '空域名称未读取');
  assert.equal(sandbox.mapAirspaceOverlays([{ ...overlays[0], version: { ...version, kind_code: 'UNKNOWN' } }]).length, 0);
}
const repeatedFeature = toAirspaces([{ airspace_id: 'overlap-a', name: '重叠空域甲', current_version: {
  kind_code: 'PROHIBITED', boundary: { type: 'MultiPolygon', coordinates: [[[[20, 20], [200, 20], [200, 200], [20, 20]]]] }
} }])[0];
const { map: overlapMap, labels: overlapLabels } = makeMap(true);
overlapMap.setData({ airspaces: [repeatedFeature, { ...repeatedFeature }, { ...repeatedFeature, airspaceId: 'overlap-b', name: '重叠空域乙' }] });
flush();
assert.equal(overlapLabels.length, 2, 'identical versions share one label, while distinct airspace identities retain their labels');
assert.equal(overlapMap.data.airspaces.length, 3, 'label deduplication does not remove boundary facts');
console.log('PASS: all five airspace kinds share management names/colors; version boundaries, missing metadata and zoom labels verified');
}
main().catch(error => { console.error(error); process.exitCode = 1; });