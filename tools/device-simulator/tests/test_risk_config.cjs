const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const riskConfig = require('../web/risk-config.js');

const appSource = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const riskFieldsSource = appSource.slice(appSource.indexOf('function riskFields'), appSource.indexOf('function context'));

test('non-device risk uses plan or airspace as its configured reference', () => {
  assert.deepEqual(riskConfig.referenceFor({type: 'deviation'}), {kind: 'plan', label: '飞行计划'});
  assert.deepEqual(riskConfig.referenceFor({type: 'zone'}), {kind: 'zone', label: '空域'});
  assert.deepEqual(riskConfig.referenceFor({type: 'height', basis: 'plan'}), {kind: 'plan', label: '飞行计划'});
  assert.deepEqual(riskConfig.referenceFor({type: 'height', basis: 'zone'}), {kind: 'zone', label: '空域'});
});

test('non-device risk explains that target association is automatic', () => {
  assert.match(riskConfig.associationNotice({type: 'bird'}), /设备观测/);
  assert.match(riskConfig.associationNotice({type: 'bird'}), /自动判定/);
  assert.equal(riskConfig.associationNotice({type: 'offline'}), '');
});

test('device risk keeps its device reference and does not claim target association', () => {
  assert.deepEqual(riskConfig.referenceFor({type: 'offline'}), {kind: 'device', label: '设备'});
  assert.equal(riskConfig.associationNotice({type: 'fault'}), '');
});

test('auxiliary reporting devices include every nearby device', () => {
  assert.match(appSource, /auxiliaryDeviceRadiusMetres=5000/);
  assert.match(appSource, /auxiliaryDevicesFor\(x\)/);
  assert.match(appSource, /目标整条轨迹周边 5 公里内/);
  assert.match(appSource, /所有设备/);
});

test('risk editor describes automatic target association instead of manual target/device selectors', () => {
  assert.doesNotMatch(riskFieldsSource, /selectField\('关联目标','targetId'/);
  assert.doesNotMatch(riskFieldsSource, /selectField\('上报设备','deviceId'/);
  assert.match(riskFieldsSource, /associationNotice/);
  assert.doesNotMatch(riskFieldsSource, /当前没有匹配的模拟观测目标，请先在“模拟目标”中配置对应计划或设备来源/);
});
