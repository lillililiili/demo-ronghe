// 不调用业务接口：验证枚举、资产、地图航向与不可信 key 的安全边界。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const window = {};
const images = [];
class Image { constructor() { this.complete = true; this.naturalWidth = 64; images.push(this); } }
vm.runInNewContext(fs.readFileSync(path.join(root, 'public/assets/js/ui.js'), 'utf8'), {
  window, Image, document: { addEventListener(){} }, getComputedStyle: () => ({ getPropertyValue: () => '#00b8ff' })
});
const U = window.UI;
const cases = { RADAR:'radar', EO:'eo', FIVE_G_A:'5ga', TDOA:'tdoa', AOA:'aoa', SPEC:'spec', CM:'cm', DEC:'dec', IFR:'ifr', CV:'cv', ISRS:'isrs', DCD:'dcd', BSC:'bsc', RID:'rid', FUSION_BOX:'fusion' };
for (const [type, key] of Object.entries(cases)) {
  assert.match(U.deviceIcon({ typeCode: type }), new RegExp(`data-business-icon="${key}"`));
  assert.match(U.deviceIcon({ typeCode: type, status:'离线' }), new RegExp(`data-business-icon="${key}"`));
}
assert.match(U.deviceIcon({ typeCode:'NOT_A_DEVICE' }), /data-business-icon="unknown-device"/);
assert.equal(U.targetIconKey({ object_type_code:'UAV' }), 'uav');
for (const [type,key] of Object.entries({ BIRD_FLOCK:'bird', BALLOON:'balloon', KITE:'kite', SKY_LANTERN:'lantern' })) {
  assert.equal(U.targetIconKey({ space_fact:{ subtype_code:type } }), key);
}
assert.equal(U.targetIconKey(null), 'unknown');
assert.equal(U.targetIconKey({ object_type_code:'FOREIGN_OBJECT' }), 'unknown');
assert.equal(U.businessIcon('<img src=x onerror=alert(1)>'), U.businessIcon('unknown'));
assert.doesNotMatch(U.icon('radar'), /business-icon/); // 导航与通用监测操作不变。
assert.match(U.icon('business:radar'), /business-icon/);
const rotations = [], draws = [];
const context = { save(){}, restore(){}, translate(){}, rotate:r=>rotations.push(r), drawImage:(...args)=>draws.push(args) };
for (const heading of [null, undefined, NaN, '90', -1, 360, Infinity]) U.drawBusinessIcon(context,'uav',0,0,30,heading);
assert.equal(rotations.length,0);
U.drawBusinessIcon(context,'uav',0,0,30,0);
U.drawBusinessIcon(context,'uav',0,0,30,90);
assert.deepEqual(rotations,[0,Math.PI/2]);
U.drawBusinessIcon(context,'bird',0,0,30,90);
assert.equal(rotations.length,2);
assert.equal(images.length,2); // 同类型地图图形复用缓存。
const dir = path.join(root,'public/assets/img/business');
const files = fs.readdirSync(dir).filter(file=>file.endsWith('.svg'));
assert.equal(files.length,23);
for (const file of files) {
  const svg = fs.readFileSync(path.join(dir,file),'utf8');
  assert.match(svg, /viewBox="0 0 64 64"/);
  assert.doesNotMatch(svg, /<(script|foreignObject|image|text)\b|(?:fill|stop-color)="(?:black|#000(?:000)?)"/i);
}
console.log('PASS: 15 device mappings; six target types; 23 transparent SVG assets; safe unknown fallback; category preserved offline; valid numeric UAV heading only; bounded image cache.');
