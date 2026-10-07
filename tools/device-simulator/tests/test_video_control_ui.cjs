const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '../web/video-control.js');
const ui = fs.existsSync(file) ? require(file) : {};
function model(data) {
  assert.equal(typeof ui.viewModel, 'function', 'video controls are missing');
  return ui.viewModel(data);
}
const running = {video_control_available:true,connected:true, phase:'RUNNING', video_config:{enabled:true,publisher_password_set:true}, eo:{enabled:true,devices:[]}};
test('enabling without a task waits, never claims playback', () => {
  assert.match(model(running).summary, /等待跟踪/);
  assert.match(model({...running,phase:'IDLE'}).summary, /等待开始模拟/);
  assert.equal(model(running).label, '停止视频推流');
});
test('independent toggle stays available while MQTT is running', () => {
  assert.equal(model(running).disabled, false);
  assert.equal(model({...running,connected:false}).disabled, false, 'stop remains possible after login expiry');
  assert.equal(model({...running,connected:false,video_config:{enabled:false}}).disabled, true);
  assert.equal(model({...running,phase:'PREPARING'}).disabled, true);
});
test('switch acknowledgement and encoder errors remain distinguishable', () => {
  assert.match(model({...running,eo:{enabled:false,devices:[]}}).summary, /开启中/);
  const devices=[{device:'camera-72',tracking:'TRACKING',video:'FAILED',error:'媒体服务不可用'}];
  assert.match(model({...running,eo:{enabled:true,devices}}).summary, /推流失败/);
  assert.match(model({...running,eo:{enabled:true,devices}}).error, /媒体服务不可用/);
  assert.match(model({...running,eo:{enabled:true,devices:[{...devices[0],video:'PUBLISHING',error:''}]}}).summary, /正在推流/);
  assert.doesNotMatch(model(running).summary, /可播放|播放成功/);
});
