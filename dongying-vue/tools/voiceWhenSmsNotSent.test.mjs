import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoVoiceView } from '../src/components/disposal/autoVoiceView.js';
import { userFacingMessage } from '../src/ui/labels.js';

// 新-30（2026-10-09）：短信因没有关联任务、没有飞手或通道原因发不出去时，电话一栏写“不拨打”，原因沿用短信的，
// 不再一直显示“等待短信送达”。
const NO_TASK = '当前事件尚无精确关联任务，不能把单位联系人当作执行飞手';
const overview = (smsStatus, smsReason, voiceStatus, voiceReason, extra = {}) => ({
  event_id: 'e1', voice_mode: 'SIMULATED',
  auto_sms: { status: smsStatus, reason: smsReason }, auto_voice: { status: voiceStatus, reason: voiceReason }, ...extra
});

test('没有关联任务时，电话写“找不到飞手，不拨打”，展开后是短信同一个原因', () => {
  const view = autoVoiceView(overview('BLOCKED', NO_TASK, 'BLOCKED', NO_TASK));
  assert.equal(view.title, '找不到飞手，不拨打');
  assert.equal(view.smsNotSent, true);
  assert.equal(view.tone, 'warning');
  assert.equal(view.canRetry, false);
  assert.match(userFacingMessage(view.reason), /还没匹配到具体任务，无法确定通知哪位飞手/);
});

test('其它原因发不出短信时写“短信未发，不拨打”', () => {
  const disabled = '后台自动短信尚未启用；仅在本地演示环境开启';
  assert.equal(autoVoiceView(overview('DISABLED', disabled, 'BLOCKED', disabled)).title, '短信未发，不拨打');
  const config = '通知配置尚未启用';
  assert.equal(autoVoiceView(overview('BLOCKED', config, 'BLOCKED', config)).title, '短信未发，不拨打');
});

test('缺飞手联系方式和电话通道不可用仍按原来的写法', () => {
  assert.equal(autoVoiceView(overview('BLOCKED', NO_TASK, 'BLOCKED', NO_TASK, { pilot_contact_missing: true })).title, '缺飞手联系方式');
  assert.equal(autoVoiceView(overview('BLOCKED', NO_TASK, 'BLOCKED', NO_TASK, { voice_mode: 'UNAVAILABLE' })).title, '电话通道不可用');
});

test('电话自己的暂停原因和不反制的决定不当成短信没发', () => {
  const left = '最新位置已离开短信发出时所处的告警空域，不拨打电话';
  assert.equal(autoVoiceView(overview('SIMULATED_DELIVERED', '后台已自动模拟发送短信', 'BLOCKED', left)).smsNotSent, false);
  const noCounter = '已人工确认当前无风险并决定不反制，本次处置已结束，继续监测';
  const decided = autoVoiceView(overview('BLOCKED', noCounter, 'BLOCKED', noCounter));
  assert.equal(decided.smsNotSent, false);
  assert.equal(decided.title, '自动电话通知已暂停');
  assert.equal(autoVoiceView(overview('WAITING', '事件尚未核实属实，核实后自动发送短信', 'WAITING', '飞手短信尚未送达，电话要等短信送达并观察 3 秒')).title, '等待自动拨打');
});

test('紧凑卡片标题也用这一句', () => {
  const source = readFileSync(new URL('../src/components/disposal/AutoVoiceNotice.vue', import.meta.url), 'utf8');
  assert.match(source, /view\.value\.smsNotSent\) return view\.value\.title;/);
});
