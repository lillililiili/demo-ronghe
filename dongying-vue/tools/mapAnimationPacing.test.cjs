/* 地图装饰动画让路（ZT-20 复测 2）：一帧画得太慢时，逐帧动画不能把数据刷新挤掉。
   - 偶尔一帧慢（垃圾回收、一次大刷新）不降速；连续 3 帧都慢才降速。
   - 降速后隔“该帧耗时 × 8，至少 2 秒”才画一帧装饰动画；数据变化引起的重画不受影响。
   - 只要有一帧恢复正常，立即回到正常节奏。
   - 正常节奏是每秒约 12 帧（隔 80ms），不再每个浏览器帧都画；图上没有在线设备或设备、覆盖图层都关着时不画装饰帧。
   用的是实际 map.js 的 _loop，不在测试里复制节流规则。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let pending = null;
const context = {
  window: {},
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
Object.assign(map, { t: 0, box: { isConnected: true }, layers: { device: true, coverage: true },
  data: { devices: [{ statusCode: 'ONLINE' }] }, draw() { drew = true; drawTimes.push(clock); } });
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

map._dead = true;
runFor(16);
assert.equal(pending, null, '销毁后循环停止');
console.log('全部通过：地图装饰动画让路');
