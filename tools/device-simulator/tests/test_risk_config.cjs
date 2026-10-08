const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const riskConfig = require('../web/risk-config.js');

const appSource = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
const riskFieldsSource = appSource.slice(appSource.indexOf('function riskFields'), appSource.indexOf('function context'));

test('non-device risk uses plan or airspace as its configured reference', () => {
  assert.deepEqual(riskConfig.referenceFor({type: 'deviation'}), {kind: 'plan', label: '飞行任务'});
  assert.deepEqual(riskConfig.referenceFor({type: 'zone'}), {kind: 'zone', label: '空域'});
  assert.deepEqual(riskConfig.referenceFor({type: 'height', basis: 'plan'}), {kind: 'plan', label: '飞行任务'});
  assert.deepEqual(riskConfig.referenceFor({type: 'height', basis: 'zone'}), {kind: 'zone', label: '空域'});
});

test('non-device risk explains that target association is automatic', () => {
  const notice = riskConfig.associationNotice({type: 'bird'});
  assert.match(notice, /只发送鸟群观测/);
  assert.match(notice, /风险由平台根据目标位置、航线、空域和时间规则自动判定/);
  assert.match(notice, /不发送风险结论/);
  assert.doesNotMatch(notice, /目标关联由设备观测与平台规则自动判定/);
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
  assert.doesNotMatch(riskFieldsSource, /当前没有匹配的模拟观测目标，请先在“模拟目标”中配置对应任务或设备来源/);
});

test('target editor owns observation facts while risk editor keeps rule references', () => {
  const targetFieldsSource = appSource.slice(appSource.indexOf("if(selected.kind==='target')"), appSource.indexOf("if(['plan','zone'].includes(selected.kind))"));
  assert.doesNotMatch(riskFieldsSource, /field\([^\n]*(鸟群数量|气球数量|观测高度|模拟高度)/);
  assert.match(riskFieldsSource, /目标类别、位置\/轨迹、观测高度和鸟群数量在“模拟目标”中设置/);
  assert.match(targetFieldsSource, /基准高度（米）/);
  assert.match(targetFieldsSource, /数量（只）/);
});

test('target observations are added from the target entry while risk conclusions have no add-risk entry', () => {
  assert.match(indexSource, /data-action="add-target"/);
  assert.doesNotMatch(indexSource, /data-action="add-risk"/);
  assert.match(indexSource, /平台风险判定/);
  assert.match(appSource, /这里添加设备上报的目标观测/);
  assert.match(appSource, /目标观测请通过图上的“添加目标”产生，风险结论由平台返回/);
});
