import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoVoiceView } from '../src/components/disposal/autoVoiceView.js';

for (const channel of ['SMS', 'VOICE']) {
  test(`recorded ${channel} departure survives later channel or contact loss`, () => {
    const data = {
      event_id: `event-${channel}`, voice_mode: 'UNAVAILABLE', pilot_contact_missing: true,
      departure_observation: { status: 'RECORDED', presence: 'LEFT', channel },
      auto_sms: { status: 'SIMULATED_DELIVERED' },
      auto_voice: { status: channel === 'SMS' ? 'BLOCKED' : 'SIMULATED_PLAYED',
        reason: '已留存通知终止依据', can_retry: true }
    };
    const view = autoVoiceView(data);
    assert.equal(view.channelUnavailable, false);
    assert.equal(view.pilotContactMissing, false);
    assert.equal(view.canRetry, false);
    assert.equal(view.reason, data.auto_voice.reason);
    assert.equal(view.title, channel === 'SMS' ? '已撤离，不拨打' : '模拟接通并播放完成');
  });
}
test('a live or unknown position cannot hide unavailable channel', () => {
  for (const observation of [{status:'ASSESSED',presence:'LEFT'},{status:'RECORDED',presence:'UNKNOWN'}]) {
    assert.equal(autoVoiceView({voice_mode:'UNAVAILABLE',auto_voice:{status:'WAITING'},departure_observation:observation}).channelUnavailable,true);
  }
});
