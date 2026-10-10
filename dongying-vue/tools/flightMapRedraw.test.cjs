const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the page's real map installation with MapView's deferred frame and
// canvas clearing. A synchronous draw wrapper loses its route on that frame.
async function main() {
const { toAirspaces } = await import('../src/services/situationData.js');
const queue = new Map();
let nextId = 0;
const sandbox = {
  toAirspaces, window: { UI: { applyAlarmGlow() {} } },
  requestAnimationFrame(callback) { const id = ++nextId; queue.set(id, callback); return id; },
  cancelAnimationFrame(id) { queue.delete(id); }
};
vm.createContext(sandbox);
const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
vm.runInContext(read('public/assets/js/map.js'), sandbox);
vm.runInContext(read('src/services/positionMap.js').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''), sandbox);
const MapView = sandbox.window.MapView;
const canvas = [];
const context = new Proxy({
  clearRect() { canvas.length = 0; },
  stroke() { canvas.push(this.strokeStyle); },
  fillText(text) { canvas.push(text); },
  measureText() { return { width: 30 }; }
}, { get: (object, key) => key in object ? object[key] : () => {} });
function TestMap(host, opt) {
  Object.assign(this, { box: host, opt, ctx: context, actx: { clearRect() {} },
    w: 800, h: 600, online: true, map: {}, layers: {},
    _paintLayers() {}, _drawAnimated() {},
    setData(data) { this.data = data; this.draw(); },
    fitTo() { this.draw(); }, px(lon, lat) { return [lon * 10, lat * 10]; },
    destroy() { this._dead = true; sandbox.cancelAnimationFrame(this._drawRaf); }
  });
}
TestMap.prototype = Object.create(MapView.prototype);
Object.setPrototypeOf(TestMap, MapView);
sandbox.window.MapView = TestMap;
sandbox.strokePlannedRoute = (ctx, map, coordinates, options) => MapView.strokePlannedRoute(
  ctx, coordinates.map(point => map.px(...point)), options);
vm.runInContext(read('src/services/trajectoryDrawing.js')
  .replace(/^import .*;\r?\n/gm, '').replace(/export /g, ''), sandbox);
const ref = value => ({ value });
Object.assign(sandbox, {
  routeMap: null,
  activeTab: ref('route'), mapHost: ref({ isConnected: true }), riskMapHost: ref({ isConnected: true }),
  trustedCenterline: ref([[10, 20], [30, 40]]), trustedAirspaces: ref([]), matchedTarget: ref(null),
  trajectoryPoints: ref([]), mapDevices: ref([]), locatedPlanRisks: ref([]),
  syncDeviceMarkers() {}, syncPlanRiskMarkers() {},
  riskMapCoords: ref([[10, 20], [30, 40]]), riskPoint: ref(null), riskTarget: ref(null),
  riskWeather: ref(null), weatherRing: ref(null), objectTrail: ref([]),
  riskRouteVersion: ref({}), objectRiskSelected: ref(false),
  destroyRouteMap() { if (sandbox.routeMap) sandbox.routeMap.destroy(); sandbox.routeMap = null; }
});
const page = read('src/pages/FlightsPage.vue');
for (const name of ['renderRouteMap', 'renderRiskMap']) {
  const start = page.indexOf(`function ${name}()`);
  const end = page.indexOf('\n}\n', start) + 2;
  vm.runInContext(page.slice(start, end), sandbox);
}
function flush() {
  const jobs = [...queue.values()]; queue.clear(); jobs.forEach(job => job(100));
}
for (const [tab, render] of [['route', 'renderRouteMap'], ['events', 'renderRiskMap']]) {
  for (const split of [false, true]) {
    sandbox.window.UI.captureAlarmGlows = split ? () => [] : undefined;
    sandbox.activeTab.value = tab;
    sandbox[render]();
    flush();
    assert.ok(canvas.includes('#8ca0a8'), `${tab}: route must survive the first deferred map clear (split=${split})`);
    assert.ok(canvas.includes('起') && canvas.includes('终'), 'both route terminals remain visible');
    const existing = sandbox.routeMap;
    sandbox[render]();
    flush();
    assert.equal(sandbox.routeMap, existing, 'background data refresh keeps the map instance');
    assert.equal(canvas.filter(value => value === '起').length, 1, 'refresh must not nest old drawing callbacks');
    canvas.length = 0;
    sandbox.routeMap.draw(); sandbox.routeMap.draw(); sandbox.routeMap.draw();
    assert.equal(queue.size, 1, 'pan/zoom and data updates still share one frame');
    flush();
    assert.ok(canvas.includes('#8ca0a8'), `${tab}: route remains after subsequent redraws`);
    sandbox.routeMap.draw(); sandbox.destroyRouteMap(); flush();
    assert.equal(queue.size, 0, 'switching records cancels the old pending frame');
  }
}
console.log('PASS: flight task and risk routes survive deferred redraw, terminals, coalescing and disposal');

}
main().catch(error => { console.error(error); process.exitCode = 1; });
