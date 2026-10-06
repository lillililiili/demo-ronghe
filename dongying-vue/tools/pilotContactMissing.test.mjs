import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoSmsView } from '../src/components/disposal/autoSmsView.js';
import { autoVoiceView } from '../src/components/disposal/autoVoiceView.js';

// BLOCK-03（2026-10-06 用户确认）：飞手信息只来自上级计划；计划里没有飞手电话时，告警的通知进度直接写明“缺飞手联系方式”。
const overview = (sms, voice, missing) => ({
  event_id: 'e1', pilot_contact_missing: missing,
  auto_sms: { status: sms, reason: '未找到该计划的执行飞手联系人', can_retry: false },
  auto_voice: { status: voice, reason: '短信尚未送达，暂不拨打飞手电话' }
});

test('计划缺飞手电话且尚未发出时，短信和电话都写明缺飞手联系方式', () => {
  for (const [sms, voice] of [['BLOCKED', 'WAITING'], ['WAITING', 'WAITING'], ['UNAVAILABLE', 'BLOCKED'], ['DISABLED', 'DISABLED']]) {
    const smsView = autoSmsView(overview(sms, voice, true)), voiceView = autoVoiceView(overview(sms, voice, true));
    assert.equal(smsView.title, '缺飞手联系方式', sms);
    assert.equal(smsView.pilotContactMissing, true);
    assert.equal(smsView.tone, 'warning');
    assert.match(smsView.reason, /计划里没有执行飞手的电话/);
    assert.match(smsView.guidance, /不能补录/);
    assert.doesNotMatch(smsView.reason + smsView.guidance, /管理员补全/);
    assert.equal(voiceView.title, '缺飞手联系方式', voice);
    assert.match(voiceView.reason, /无法给飞手打电话/);
  }
});

test('后端未标缺失时（无精确计划、待核验、停用等）保持原状态与原因', () => {
  for (const missing of [false, undefined, 'true']) {
    const smsView = autoSmsView(overview('BLOCKED', 'WAITING', missing));
    assert.equal(smsView.title, '暂不满足自动发送条件');
    assert.equal(smsView.pilotContactMissing, false);
    assert.equal(autoVoiceView(overview('BLOCKED', 'WAITING', missing)).title, '等待自动拨打');
  }
});

test('已经在发、已送达、失败或结果未知时以发送记录为准，不改写成缺联系方式', () => {
  for (const status of ['SENDING', 'SIMULATED_DELIVERED', 'FAILED', 'UNKNOWN', 'NOT_REQUIRED']) {
    const view = autoSmsView(overview(status, 'WAITING', true));
    assert.notEqual(view.title, '缺飞手联系方式', status);
    assert.equal(view.pilotContactMissing, false);
  }
  for (const status of ['CALLING', 'SIMULATED_PLAYED', 'FAILED', 'UNKNOWN']) {
    assert.notEqual(autoVoiceView(overview('SIMULATED_DELIVERED', status, true)).title, '缺飞手联系方式', status);
  }
});

test('紧凑卡片的标题先看缺飞手联系方式，不再显示“等待短信送达”', () => {
  const sms = readFileSync(new URL('../src/components/disposal/AutoSmsNotice.vue', import.meta.url), 'utf8');
  const voice = readFileSync(new URL('../src/components/disposal/AutoVoiceNotice.vue', import.meta.url), 'utf8');
  assert.match(sms, /const compactTitle = computed\(\(\) => view\.value\.pilotContactMissing \? view\.value\.title :/);
  assert.match(voice, /const compactTitle = computed\(\(\) => \{\s*if \(view\.value\.pilotContactMissing\) return view\.value\.title;/);
});
