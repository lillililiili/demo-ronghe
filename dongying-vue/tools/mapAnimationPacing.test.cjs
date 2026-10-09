/* 地图装饰动画让路（ZT-20 复测 2）：一帧画得太慢时，逐帧动画不能把数据刷新挤掉。
   - 偶尔一帧慢（垃圾回收、一次大刷新）不降速；连续 3 帧都慢才降速。
   - 降速后隔“该帧耗时 × 8，至少 2 秒”才画一帧装饰动画；数据变化引起的重画不受影响。
   - 只要有一帧恢复正常，立即回到正常节奏。
   - 动画相位按真实时间走，少画帧只降低帧数，不让扫描、波纹变慢。
   - 详细底图上业务层和装饰层分开：装饰帧只重画装饰层；非融合感知地图只有告警红晕时才画装饰帧。
   - 正常节奏是每秒约 12 帧（隔 80ms），不再每个浏览器帧都画；图上没有在线设备或设备、覆盖图层都关着时不画装饰帧。
   用的是实际 map.js 的 _loop，不在测试里复制节流规则。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let pending = null;
const context = {
  window: { UI: { abnormalActive: item => !!item.abnormal } },
  requestAnimationFrame: callback => { pending = callback; return 1; },
  cancelAnimationFrame: () => { pending = null; }
};
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../public/assets/js/map.js'), 'utf8'), context);
const MapView = context.window.MapView;
const gap = MapView.animationGap;

assert.equal(gap([]), 0, '还没量够 3 帧时照常逐帧画');
assert.equal(gap([16, 17, 16]), 0, '正常机器每帧十几毫秒，逐帧画');
assert.equal(gap([16, 3000, 16]), 0, '偶尔一帧慢不降速');
assert.equal(gap([300, 300, 300]), 2400, '连续 3 帧都慢于 250ms：隔该帧耗时的 8 倍再画');
assert.equal(gap([260, 270, 280]), 2080);
assert.equal(gap([3000, 2600, 2800]), 20800, '云端一帧 2.6 秒：约 21 秒画一帧装饰动画');
assert.equal(gap([3000, 2600, 16]), 0, '有一帧恢复正常就回到逐帧动画');

// 用假的浏览器帧时钟驱动真实的 _loop：画了一帧的回调，到下一次回调要隔“这一帧的耗时”；没画就是 16ms。
const map = Object.create(MapView.prototype);
let clock = 0, drawCost = 16, drew = false;
const drawTimes = [];
Object.assign(map, { opt: {}, t: 0, box: { isConnected: true }, layers: { device: true, coverage: true },
  data: { devices: [{ statusCode: 'ONLINE' }] }, draw() { drew = true; drawTimes.push(clock); this._animDrawnAt = clock; this._animDrawPending = false; } });
function runFor(ms) {
  const end = clock + ms;
  while (clock < end) {
    drew = false;
    const callback = pending; pending = null; callback(clock);
    clock += drew ? drawCost : 16;
  }
}
const drawsBetween = (from, to) => drawTimes.filter(time => time >= from && time < to);
map._loop();

runFor(1000);
assert.equal(drawsBetween(0, 1000).length, 12, '正常机器：装饰动画每秒约 12 帧，不是每个浏览器帧都画');
// 少画帧不能让动画变慢：相位按真实时间走，1 秒内最后一帧 t 约 50–60（旧做法只有 12）（雷达 180 一圈仍是 3 秒）。
assert.ok(map.t >= 48 && map.t <= 61, `1 秒后动画相位按时间走到约 60（实际 ${map.t.toFixed(1)}）`);

const slowFrom = clock;
drawCost = 3000; // 机器画不动了：每画一帧要 3 秒
runFor(90_000);
const slow = drawsBetween(slowFrom, clock);
assert.equal(slow.length, 6, '90 秒里只画 6 帧装饰动画（不让路要画 30 帧）');
assert.ok(slow[0] - slowFrom < 80, '变慢后的第一帧照常按节奏画');
assert.deepEqual(slow.slice(0, 3).map(time => time - slow[0]), [0, 3000, 6000], '先量满 3 帧才降速');
slow.slice(3).forEach((time, i) => assert.ok(time - slow[i + 2] >= 24_000, '降速后两帧装饰动画至少隔 24 秒'));

const recoverFrom = clock;
drawCost = 16; // 机器恢复
runFor(30_000);
const recentFrames = drawsBetween(clock - 5000, clock).length;
assert.ok(recentFrames >= 60 && recentFrames <= 63, `恢复后回到每秒约 12 帧（最近 5 秒画了 ${recentFrames} 帧）`);
assert.ok(drawsBetween(recoverFrom, clock).length > 60, '恢复后不再停在降速节奏');

const idleFrom = clock;
map.data = { devices: [{ statusCode: 'OFFLINE' }] };
runFor(5000);
assert.equal(drawsBetween(idleFrom, clock).length, 0, '没有在线设备：图上没有会动的东西，不画装饰帧');
map.data = { devices: [{ statusCode: 'ONLINE' }] };
map.layers = { device: false, coverage: false };
runFor(5000);
assert.equal(drawsBetween(idleFrom, clock).length, 0, '设备与覆盖范围图层都关着：不画装饰帧');
map.layers = { device: true, coverage: false };
const backFrom = clock;
runFor(1000);
assert.ok(drawsBetween(backFrom, clock).length >= 12, '再打开设备图层，装饰动画恢复');

// 详细底图上分层：装饰帧只重画装饰层，业务层（draw）不动。
const animTimes = [];
map._drawAnimated = () => { drew = true; animTimes.push(clock); };
map._splitLayers = true;
map.opt = { fusionProfile: true };
const splitFrom = clock, drawsBefore = drawTimes.length;
runFor(1000);
assert.equal(drawTimes.length, drawsBefore, '分层后装饰帧不再整张重画业务层');
assert.ok(animTimes.filter(time => time >= splitFrom).length >= 11, '分层后装饰层照常每秒约 12 帧');
map.opt = {};
map._glows = [];
const plainFrom = clock;
runFor(2000);
assert.equal(animTimes.filter(time => time >= plainFrom).length, 0, '非融合感知地图、没有告警红晕：没有会动的东西，不画装饰帧');
map._glows = [{ x: 1, y: 1, size: 24 }];
const glowFrom = clock;
runFor(1000);
assert.ok(animTimes.filter(time => time >= glowFrom).length >= 11, '有告警红晕时装饰层照常闪烁');

map._dead = true;
runFor(16);
assert.equal(pending, null, '销毁后循环停止');

// 融合感知页可单独限制装饰动画帧率；未配置时保持旧页面的逐帧行为。
clock = 0; drawCost = 1; drew = false; pending = null;
const pacedDraws = [];
const paced = Object.create(MapView.prototype);
Object.assign(paced, {
  opt: { animationFps: 12 }, t: 0, box: { isConnected: true },
  layers: { device: true, coverage: true }, data: { devices: [{ statusCode: 'ONLINE' }] },
  draw() { drew = true; pacedDraws.push(clock); this._animDrawnAt = clock; this._animDrawPending = false; }
});
paced._loop();
runFor(1000);
assert.ok(pacedDraws.length >= 9 && pacedDraws.length <= 13,
  `12fps 配置在 1 秒内只绘制约 12 帧（实到 ${pacedDraws.length} 帧）`);
paced._dead = true;
runFor(16);
assert.equal(pending, null, '限制帧率的地图销毁后循环停止');
console.log('全部通过：地图装饰动画让路');

// Exercise the actual queued draw method: repeated requests share a frame and
// animation timing is measured on the next browser frame, not the same tick.
const queue = new Map();
let frameId = 0;
context.requestAnimationFrame = callback => { const id = ++frameId; queue.set(id, callback); return id; };
context.cancelAnimationFrame = id => queue.delete(id);
const queued = Object.create(MapView.prototype);
let frames = 0, hits = 0;
Object.assign(queued, {
  opt: {}, t: 0, box: { isConnected: true }, data: { devices: [] }, layers: {},
  _drawFrame() { frames++; }, _hit() { hits++; }, _animDrawPending: true, _viewHitPending: true
});
queued.draw(); queued.draw(); queued.draw();
assert.equal(queue.size, 1);
const flush = timestamp => { const jobs = [...queue.values()]; queue.clear(); jobs.forEach(job => job(timestamp)); };
flush(100);
assert.equal(frames, 1); assert.equal(hits, 1);
queued._loop();
flush(100);
assert.equal(queued._animDrawnAt, 100, 'same-frame callback must not record a zero-cost frame');
flush(3100);
assert.equal(queued._frameCosts[0], 3000, 'deferred draw cost still drives slow-frame pacing');
queued.draw(); queued.setPaused(true);
assert.equal(queue.size, 0, 'pause cancels queued drawing and decoration callbacks');
queued._dead = true;
queued.draw();
assert.equal(queue.size, 0);
