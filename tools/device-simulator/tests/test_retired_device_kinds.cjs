const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const app = read('web/app.js');
const checker = read('start_check.py');

// 页面里“放置设备组”“添加一台设备”能选的类型，直接取 app.js 里的声明。
const offered = (() => {
  const code = app.slice(app.indexOf('const deviceKinds='), app.indexOf('const auxiliaryDeviceRadiusMetres'));
  const context = vm.createContext({});
  vm.runInContext(`${code};this.out={deviceKinds,targetDeviceKinds,defaultGroupKinds};`, context);
  return context.out;
})();
// 服务端开始前检查里的两张表，取 start_check.py 里的声明。
const tuple = name => [...new RegExp(`${name} = \\(([^)]*)\\)`).exec(checker)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);

test('the page offers exactly the device types the server check lets through', () => {
  assert.deepEqual([...offered.deviceKinds], tuple('CURRENT_KINDS'));
});

test('none of the six retired device types can be placed or added any more', () => {
  const retired = tuple('RETIRED_KINDS');
  assert.deepEqual([...retired].sort(), ['aoa', 'bsc', 'dcd', 'dec', 'ifr', 'rid']);
  assert.deepEqual(retired.filter(kind => offered.deviceKinds.includes(kind)), []);
  assert.deepEqual(retired.filter(kind => offered.targetDeviceKinds.includes(kind)), []);
});

test('a new device group starts with radar, TDOA and EO, every one of them a type that is still offered', () => {
  assert.deepEqual([...offered.defaultGroupKinds], ['radar', 'tdoa', 'eo']);
  for (const kind of offered.defaultGroupKinds) assert.ok(offered.deviceKinds.includes(kind), kind);
  for (const kind of offered.targetDeviceKinds) assert.ok(offered.deviceKinds.includes(kind), kind);
});

test('scenes saved with a retired type still open: the name and icon of that type are kept', () => {
  for (const kind of tuple('RETIRED_KINDS')) assert.match(app, new RegExp(`${kind}:'`), `${kind} still has a label`);
  assert.match(app, /const deviceAsset = kind => \(\{aoa:'tdoa'/);
});
