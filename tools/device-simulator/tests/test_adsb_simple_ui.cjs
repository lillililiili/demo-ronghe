const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = name => fs.readFileSync(path.join(__dirname, '../web', name), 'utf8');

test('the simple page offers the flight target, the receiver device and the receiver footer item', () => {
  const html = read('index.html');
  assert.match(html, /data-action="place-target" data-kind="flight"><img src="assets\/plane\.svg" alt="">民航航班/);
  assert.match(html, /data-simple="adsb-device"><img src="assets\/adsb\.svg" alt="">航班接收机/);
  assert.match(html, /<span id="status-adsb">航班接收机 未放置<\/span>/);
  for (const asset of ['plane.svg', 'adsb.svg']) assert.ok(fs.existsSync(path.join(__dirname, '../web/assets', asset)), asset);
  // 原版页面不加 simple.js，也不列这两样。
  const classic = read('classic.html');
  assert.doesNotMatch(classic, /simple\.js|data-kind="flight"|adsb-device/);
});

test('app.js knows the two new kinds only for labels, icon and colour; simple.js owns the forms', () => {
  const app = read('app.js'), simple = read('simple.js');
  assert.match(app, /flight:'民航航班',adsb:'航班接收机'/);
  assert.match(app, /kind==='flight'\?'plane'/);
  assert.doesNotMatch(app, /targetKinds=\[[^\]]*'flight'/, 'the uav form must not offer 民航航班 as a category');
  assert.match(simple, /deviceKinds\.push\(ADSB\)/);
  assert.match(simple, /function flightForm/);
  assert.match(simple, /function adsbRow/);
  assert.match(simple, /'simulator-map:point'/);
  assert.match(simple, /function flightDefaults/);
});
