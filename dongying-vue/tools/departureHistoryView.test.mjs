import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoVoiceView } from '../src/components/disposal/autoVoiceView.js';
import { isPredictionAlarm } from '../src/services/predictionView.js';
import * as riskHelpers from '../src/services/riskCaseView.js';
import { autoHandoffProgress, HANDED_OFF, HANDOFF_PENDING, mergeHandoffProgress } from '../src/ui/punishmentHandoffProgress.js';

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
    assert.equal(view.title, channel === 'SMS' ? '当时判定已撤离，未拨打' : '模拟接通并播放完成');
  });
}
test('a live or unknown position cannot hide unavailable channel', () => {
  for (const observation of [{status:'ASSESSED',presence:'LEFT'},{status:'RECORDED',presence:'UNKNOWN'}]) {
    assert.equal(autoVoiceView({voice_mode:'UNAVAILABLE',auto_voice:{status:'WAITING'},departure_observation:observation}).channelUnavailable,true);
  }
});


// 通知撤离展示回归：更换事件、时间与渠道，不依赖验收对象或实时位置。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { alarmDepartureView, recordedDepartureKey } from '../src/components/disposal/alarmDepartureView.js';
import { notificationProgressView } from '../src/components/disposal/autoHandoffView.js';
import { uavNowStatus, uavNowHtml } from '../src/components/disposal/uavNowStatus.js';

function fixture(channel = 'SMS') {
  const id = randomUUID(), at = Date.now() - 300000;
  return {
    alarm: { event_id: id, target_id: randomUUID(), state: 'CONFIRMED', attention_group: 'HISTORY', observation_status: 'EXPIRED' },
    summary: { event_id: id, event_version: 3, notify_phase: null, counter_launch_visible: false,
      departure_observation: { event_id: id, status: 'RECORDED', presence: 'LEFT', channel, evaluated_at: at,
        basis: 'AIRSPACE', position: { observed_at: at - 1000, longitude: 118.6, latitude: 37.4 } },
      auto_sms: { status: 'SIMULATED_DELIVERED' },
      auto_voice: { status: channel === 'SMS' ? 'BLOCKED' : 'SIMULATED_PLAYED', attempt_count: channel === 'SMS' ? 0 : 1 },
      auto_handoff: { status: 'NOT_REQUIRED' } },
    sources: { auths: { items: [] }, handoffs: { items: [] } }, progress: null
  };
}

for (const channel of ['SMS', 'VOICE']) {
  test(`${channel} recorded withdrawal remains ended after observations expire without another decision`, () => {
    const f = fixture(channel), original = JSON.stringify(f), view = alarmDepartureView(f);
    assert.equal(view.title, '已撤离');
    assert.equal(f.alarm.state, 'CONFIRMED');
    assert.equal(view.verification, undefined);
    assert.match(view.notification, /短信：模拟已送达/);
    assert.match(view.notification, channel === 'SMS' ? /电话：未拨打/ : /电话：模拟接通并播放完成/);
    assert.match(view.conclusion, /无需再次确认/);
    assert.equal(JSON.stringify(f), original, 'projection must not mutate verification or write a no-counter decision');
  });
}

test('only a bound recorded departure and backend HISTORY classify an alarm as departed', () => {
  const invalid = [
    f => { f.summary._unavailable = true; },
    f => { f.summary.event_id = randomUUID(); },
    f => { f.summary.departure_observation.event_id = randomUUID(); },
    f => { delete f.summary.departure_observation; },
    ...['ASSESSED', 'NOT_STARTED'].map(status => f => { f.summary.departure_observation.status = status; }),
    ...['UNKNOWN', 'STILL_PRESENT'].map(presence => f => { f.summary.departure_observation.presence = presence; }),
    ...[0, null, 'invalid'].map(at => f => { f.summary.departure_observation.evaluated_at = at; }),
    f => { f.summary.departure_observation.channel = 'UNKNOWN'; },
    ...['PENDING_VERIFICATION', 'FALSE_POSITIVE'].map(state => f => { f.alarm.state = state; }),
    ...['CURRENT', 'AWAITING_CONFIRMATION', undefined].map(group => f => { f.alarm.attention_group = group; }),
    ...['auths', 'handoffs'].flatMap(key => [f => { delete f.sources[key]; }, f => { f.sources[key].failed = true; }]),
    f => { f.summary.notify_phase = 'AWAIT_COUNTER'; },
    f => { f.summary.no_counter = { review_required: true }; },
    f => { f.summary.no_counter = { decision_active: true }; },
    f => { f.summary.auto_handoff = { status: 'SUBMITTED', handoff_id: randomUUID() }; },
    f => { f.summary.auto_handoff = { status: 'PENDING_DECISION', handoff_id: randomUUID() }; }
  ];
  for (const mutate of invalid) {
    const f = fixture(); mutate(f);
    assert.equal(alarmDepartureView(f), null, mutate.toString());
  }
});

test('approval, execution, completed devices, emergency stop and transfer keep precedence', () => {
  for (const progress of ['PENDING_APPROVAL', 'COUNTERMEASURE_ACTIVE', 'JAMMING_ACTIVE', 'COUNTERMEASURE_DONE', 'JAMMING_DONE', 'COUNTER_STOPPED', 'HANDED_OFF']) {
    assert.equal(alarmDepartureView({ ...fixture(), progress }), null, progress);
  }
});

test('SMS withdrawal cannot hide a call that has already started or completed', () => {
  for (const [status, expected] of [['CALLING', '系统正在拨打'], ['SIMULATED_PLAYED', '模拟接通并播放完成'], ['UNKNOWN', '通话结果未确认']]) {
    const f = fixture(); f.summary.auto_voice = { status, attempt_count: 1 };
    assert.ok(alarmDepartureView(f).notification.includes(expected));
    assert.ok(!alarmDepartureView(f).notification.includes('未拨打'));
  }
  const f = fixture();
  f.summary.records = [{ kind: 'VOICE_SIMULATED', created_at: Date.now() }];
  assert.ok(!alarmDepartureView(f).notification.includes('未拨打'));
  delete f.summary.auto_voice.attempt_count;
  assert.ok(!alarmDepartureView(f).notification.includes('未拨打'));
});

test('redacted position and unavailable channels retain the historical evidence without inventing receipts', () => {
  const f = fixture();
  f.summary.departure_observation.position = null;
  f.summary.auto_sms = null; f.summary.auto_voice = null;
  const view = alarmDepartureView(f);
  assert.match(view.notification, /短信：结果待确认；电话：结果待确认/);
  assert.match(view.basis, /通知后的实测位置/);
});

const source = readFileSync(new URL('../src/pages/AlarmsPage.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const identityKeys = new Function('riskCaseOf', source.match(/^const progressKey =.*$/m)[0] + '\n' + source.match(/^const summaryKey =.*$/m)[0] + '\nreturn { progressKey, summaryKey };')(riskHelpers.riskCaseOf);
function body(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
}
const keys = source.slice(source.indexOf('const advisoryPageKey ='), source.indexOf('function updateAdvisory('));
const { pageKey } = new Function('recordedDepartureKey', keys + '\nreturn { pageKey: advisoryPageKey };')(recordedDepartureKey);

test('stable page key reacts to saved withdrawal, not to current polling timestamps', () => {
  const f = fixture();
  const key = pageKey(f.summary);
  assert.equal(key, pageKey({ ...f.summary, _fetchedAt: Date.now(), departure_observation: { ...f.summary.departure_observation } }));
  assert.notEqual(key, pageKey({ ...f.summary, departure_observation: { ...f.summary.departure_observation, evaluated_at: Date.now() } }));
  const live = { ...f.summary, departure_observation: { ...f.summary.departure_observation, status: 'ASSESSED' } };
  assert.equal(pageKey(live), pageKey({ ...live, departure_observation: { ...live.departure_observation, evaluated_at: Date.now() } }));
});

function pageFixture(f) {
  const deps = { ...riskHelpers, ...identityKeys,
    cur: { alarm: f.alarm, target: { object_type_code: 'UAV' }, event: { version: 3 } },
    advisorySummaries: new Map([[f.alarm.event_id, f.summary]]), advisoryLive: { value: f.summary },
    pageProgress: { [f.alarm.event_id]: f.progress }, progressSources: new Map([[f.alarm.event_id, f.sources]]),
    pendingProgress: new Set(), stateOf: a => ({ t: a.state }), NOTIFY_PHASE: {},
    ALARM_PROGRESS_LABEL: { PENDING_APPROVAL: '待审批', COUNTERMEASURE_ACTIVE: '反制中', COUNTERMEASURE_DONE: '已反制', COUNTER_STOPPED: '反制已中止', HANDED_OFF: '已移送处罚' },
    ALARM_PROGRESS_TAG: {}, alarmDepartureView, recordedDepartureKey, notificationProgressView,
    autoHandoffProgress, HANDED_OFF, HANDOFF_PENDING, mergeHandoffProgress, isPredictionAlarm,
    esc: s => String(s).replaceAll('<', '&lt;').replaceAll('>', '&gt;'), fmt: ms => String(ms),
    uavNowStatus, uavNowHtml, serverNow: Date.now, ruleReasonText: s => s, alarmCounterBlockHtml: () => ''
  };
  const api = new Function(...Object.keys(deps), ['displayState', 'departureView', 'alarmNowHtml'].map(body).join('\n') + '\nreturn { displayState, alarmNowHtml };')(...Object.values(deps));
  return { ...deps, ...api };
}
test('list and top detail agree on withdrawal while original verification and other progress remain intact', () => {
  const f = fixture(), p = pageFixture(f);
  assert.equal(p.displayState(f.alarm).t, '已撤离');
  assert.match(p.alarmNowHtml(), /通知与撤离结果/);
  assert.doesNotMatch(p.alarmNowHtml(), /核实结论|无风险不反制/);
  assert.match(p.alarmNowHtml(), /撤离确认/);
  for (const progress of Object.keys(p.ALARM_PROGRESS_LABEL)) {
    p.pageProgress[f.alarm.event_id] = progress;
    assert.equal(p.displayState(f.alarm).t, p.ALARM_PROGRESS_LABEL[progress]);
    assert.equal(p.alarmNowHtml(), '');
  }
  p.pageProgress[f.alarm.event_id] = null;
  f.alarm.state = 'FALSE_POSITIVE';
  assert.equal(p.displayState(f.alarm).t, 'FALSE_POSITIVE');
  assert.equal(p.alarmNowHtml(), '');
});

test('new withdrawal reloads backend classification and counters once; stale replies and polling cannot repeat it', async () => {
  const f = fixture(), calls = [];
  f.alarm.attention_group = 'CURRENT';
  const old = { ...f.summary, departure_observation: null, _fetchedAt: 10 };
  const deps = { ...riskHelpers, ...identityKeys,
    cur: { alarm: f.alarm, event: { version: 3 } }, advisoryLive: { value: old }, advisorySummaries: new Map([[f.alarm.event_id, old]]),
    recordedDepartureKey, departureEnded: { value: false }, departureView: () => alarmDepartureView(f), el: () => null, patchHtml: () => {}, alarmNowHtml: () => '', paintList: () => {}, paintDetailContent: () => {},
    loadList: async opts => { calls.push(['list', opts]); },
    refreshSelected: async () => { calls.push(['detail']); f.alarm.attention_group = 'HISTORY'; },
    loadKpis: async () => { calls.push(['kpis']); }, refreshEventDisposals: async () => { calls.push(['progress']); }
  };
  const update = new Function(...Object.keys(deps), keys + '\nlet progressReloadFor = "";\n' + body('updateAdvisory') + '\nreturn updateAdvisory;')(...Object.values(deps));
  update({ ...f.summary, _fetchedAt: 20 });
  await Promise.resolve();
  assert.deepEqual(calls.map(x => x[0]), ['list', 'detail', 'kpis']);
  assert.equal(calls[0][1].quiet, true);
  assert.equal(f.alarm.attention_group, 'HISTORY');
  update({ ...old, _fetchedAt: 15 });
  update({ ...f.summary, _fetchedAt: 30 });
  assert.equal(calls.length, 3);
  update({ ...f.summary, event_version: 4, counter_launch_visible: true, _fetchedAt: 40 });
  assert.equal(calls.at(-1)[0], 'progress', 'subsequent business changes still refresh disposal progress');
  update({ ...old, event_version: 2, _fetchedAt: 50 });
  assert.equal(deps.advisorySummaries.get(f.alarm.event_id).event_version, 4);
});

test('completed departure hides the manual choice while other branches retain it', () => {
  const template = source.slice(source.indexOf('<template>'));
  const guard = template.match(/<CounterLaunch v-if="([^"]+)"/)[1];
  const visible = new Function('advisorySubject', 'departureEnded', `return ${guard};`);
  for (const group of ['HISTORY', 'CURRENT', 'AWAITING_CONFIRMATION']) {
    const f = fixture(); f.alarm.attention_group = group;
    assert.equal(visible({ id: f.alarm.event_id }, !!alarmDepartureView(f)), group !== 'HISTORY');
  }
  const f = fixture(); f.progress = 'COUNTER_STOPPED';
  assert.equal(visible({ id: f.alarm.event_id }, !!alarmDepartureView(f)), true, 'emergency stop still allows new manual applications');
});
