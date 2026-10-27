import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { effectScope, reactive, ref, computed, watch, nextTick } from 'vue';
import { createRiskVerificationSession } from '../src/services/uavRiskVerificationSession.js';

const now = 1793011970000;
function detail(source = 'replay', stage = 'PREDICTED') {
  const id = randomUUID(), eventId = randomUUID(), target = randomUUID();
  const prediction = { prediction_id: randomUUID(), status: 'READY', valid_until: now + 2500,
    based_on_observed_at: now - 500, warning: { state: 'ACTIVE' } };
  return { risk_case: { risk_case_id: id, target_id: target, airspace_id: randomUUID(), source_mode: source,
    version: 2, stage, action_event_id: eventId, verification_status: 'PENDING_VERIFICATION', allowed_actions: ['VERIFY'] },
    alarm: { target_id: target, source_mode: source, origin_kind: 'PREDICTED_AIRSPACE_ENTRY', prediction },
    event: { event_id: eventId, version: 3, verification_basis: { confirmable: true, prediction_id: prediction.prediction_id }, prediction } };
}
function harness(initial = detail(), options = {}) {
  let latest = initial, readCount = 0, writes = [], changes = [], scheduled = new Map(), timerId = 0;
  const optionsRead = options.read;
  const session = createRiskVerificationSession({ event: initial.event, alarm: { ...initial.alarm, risk_case: initial.risk_case },
    now: () => now, pending: new Map(), makeKey: randomUUID,
    read: async (...args) => { readCount++; return optionsRead ? optionsRead(...args) : latest; },
    verify: async (...args) => { writes.push(args); return { risk_case: { ...latest.risk_case, verification_status: 'CONFIRMED' } }; },
    onChange: change => changes.push(change), isUncertain: error => error.status === 409 || error.status >= 500 || error.code === 'TIMEOUT',
    setTimer: fn => { const id = ++timerId; scheduled.set(id, fn); return id; }, clearTimer: id => scheduled.delete(id),
    ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'read')) });
  return { session, writes, changes, scheduled, get reads() { return readCount; }, setLatest: value => { latest = value; } };
}
const values = { conclusion: 'CONFIRMED', note: '已查看实时视频' };

test('blocked initial basis recovers in the same session for both source domains; refresh never submits', async () => {
  for (const source of ['live', 'replay']) {
    const initial = detail(source); initial.event.verification_basis.confirmable = false;
    const h = harness(initial);
    assert.equal(h.session.view().blocked, true);
    const latest = structuredClone(initial); latest.event.verification_basis.confirmable = true;
    h.setLatest(latest); await h.session.refresh();
    assert.equal(h.session.view().blocked, false); assert.equal(h.writes.length, 0);
  }
});

test('polling coalesces refreshes, stops timers and ignores a late response after unmount', async () => {
  let resolve; const initial = detail();
  const h = harness(initial, { read: () => new Promise(done => { resolve = done; }) });
  h.session.start(); const a = h.session.refresh(), b = h.session.refresh();
  assert.equal(h.reads, 1);
  const changed = structuredClone(initial); changed.risk_case.version++;
  h.session.stop(); resolve(changed); await Promise.all([a, b]); await nextTick();
  assert.equal(h.session.view().risk.version, 2); assert.equal(h.scheduled.size, 0); assert.equal(h.writes.length, 0);
});

test('invalid identity or missing version blocks writes without replacing the known risk', async () => {
  for (const mutation of ['area', 'target', 'source', 'case', 'event', 'version']) {
    const initial = detail(), h = harness(initial), wrong = structuredClone(initial);
    if (mutation === 'area') wrong.risk_case.airspace_id = randomUUID();
    if (mutation === 'target') wrong.alarm.target_id = randomUUID();
    if (mutation === 'source') wrong.alarm.source_mode = 'live';
    if (mutation === 'case') wrong.risk_case.risk_case_id = randomUUID();
    if (mutation === 'event') wrong.event.event_id = randomUUID();
    if (mutation === 'version') delete wrong.risk_case.version;
    h.setLatest(wrong);
    await assert.rejects(h.session.submit(values), /不一致/);
    assert.equal(h.writes.length, 0); assert.equal(h.session.view().risk.risk_case_id, initial.risk_case.risk_case_id);
  }
});

test('a new human submission uses freshly read case/event versions and snapshot, not opening-time values', async () => {
  const initial = detail(), h = harness(initial), latest = structuredClone(initial);
  latest.risk_case.version++; latest.event.version += 2;
  latest.event.verification_basis.prediction_id = randomUUID(); h.setLatest(latest);
  await h.session.submit(values);
  const [id, body] = h.writes[0];
  assert.equal(id, initial.risk_case.risk_case_id); assert.equal(body.expected_case_version, 3);
  assert.equal(body.expected_version, 5); assert.equal(body.prediction_id, latest.event.verification_basis.prediction_id);
});

test('prediction-to-measured switches in place; a switch during submit preserves input and asks for review once', async () => {
  const initial = detail(), h = harness(initial), entered = structuredClone(initial);
  entered.risk_case.stage = 'ENTERED'; entered.risk_case.version++; entered.event.version = 0;
  entered.event.event_id = randomUUID(); entered.risk_case.action_event_id = entered.event.event_id;
  h.setLatest(entered);
  await assert.rejects(h.session.submit(values), /已更新为“已实际入区”/);
  assert.equal(h.writes.length, 0); assert.equal(h.session.view().risk.stage, 'ENTERED');
  await h.session.submit(values);
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0][1].expected_version, 0);
  assert.equal(h.writes[0][1].note, values.note); assert.equal(Object.hasOwn(h.writes[0][1], 'prediction_id'), false);
});

test('already automatically verified or false-positive current case is read-only and never resubmitted', async () => {
  for (const status of ['CONFIRMED', 'FALSE_POSITIVE']) {
    const initial = detail(), h = harness(initial), finished = structuredClone(initial);
    finished.risk_case.verification_status = status; finished.risk_case.allowed_actions = [];
    h.setLatest(finished); await h.session.submit(values);
    assert.equal(h.writes.length, 0); assert.equal(h.session.view().done, true);
  }
});

test('expired evidence and lost permission fail closed, but recovery does not discard the form session', async () => {
  for (const kind of ['expired', 'permission', 'unknown']) {
    const initial = detail(), h = harness(initial), unavailable = structuredClone(initial);
    if (kind === 'expired') { unavailable.event.prediction.valid_until = now - 1; unavailable.alarm.prediction.valid_until = now - 1; }
    if (kind === 'permission') unavailable.risk_case.allowed_actions = [];
    if (kind === 'unknown') unavailable.risk_case.stage = 'UNKNOWN';
    h.setLatest(unavailable); await assert.rejects(h.session.submit(values), /依据|权限|过期|不可/);
    assert.equal(h.writes.length, 0);
    h.setLatest(initial); await h.session.refresh(); assert.equal(h.session.view().blocked, false);
  }
});

test('unknown submit result is reconciled by read only, without retrying a committed verification', async () => {
  const initial = detail(), latest = structuredClone(initial); let writes = 0;
  const h = harness(initial, { read: async () => latest, verify: async () => {
    writes++; latest.risk_case.verification_status = 'CONFIRMED'; latest.risk_case.allowed_actions = [];
    throw Object.assign(new Error('读取响应失败'), { status: 500 });
  } });
  await h.session.submit(values); assert.equal(writes, 1); assert.equal(h.session.view().done, true);
  await h.session.submit(values); assert.equal(writes, 1);
});

test('a manually retried uncertain request keeps its exact key and payload; polling never sends it', async () => {
  const initial = detail(), sent = [];
  const h = harness(initial, { verify: async (...args) => { sent.push(args); throw Object.assign(new Error('响应超时'), { code: 'TIMEOUT' }); } });
  await assert.rejects(h.session.submit(values), /结果未确认/);
  await h.session.refresh(); assert.equal(sent.length, 1);
  await assert.rejects(h.session.submit({ ...values, note: '另一结论说明' }), /保留原核实/);
  assert.equal(sent.length, 1);
  await assert.rejects(h.session.submit(values), /结果未确认/);
  assert.equal(sent.length, 2); assert.equal(sent[0][2], sent[1][2]); assert.deepEqual(sent[0][1], sent[1][1]);
});

test('the real controlled form keeps notes and the human choice while live eligibility props change', async () => {
  const scope = effectScope();
  try {
    const props = reactive({ fields: [], initial: { ...values }, onSubmit: async () => {}, onCancel() {}, submitEnabled: () => true });
    const source = readFileSync(new URL('../src/components/modals/ControlledFormModal.vue', import.meta.url), 'utf8')
      .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?\n/gm, '');
    const deps = { computed, nextTick, reactive, ref, watch, defineProps: () => props };
    const form = scope.run(() => new Function(...Object.keys(deps), `${source}; return {model, canSubmit};`)(...Object.values(deps)));
    props.fields = [{ key: 'conclusion', options: [{ value: 'CONFIRMED', disabled: true }] }]; props.submitEnabled = () => false;
    await nextTick(); assert.equal(form.canSubmit.value, false); assert.deepEqual({ ...form.model }, values);
    props.fields = [{ key: 'conclusion', options: [{ value: 'CONFIRMED', disabled: false }] }]; props.submitEnabled = () => true;
    await nextTick(); assert.equal(form.canSubmit.value, true); assert.deepEqual({ ...form.model }, values);
  } finally { scope.stop(); }
});
test('post-commit detail failure never offers another write while waiting for the saved ledger result', async () => {
  const initial = detail(); let writes = 0, readable = true;
  const h = harness(initial, { read: async () => { if (!readable) throw new Error('详情暂时不可读'); return initial; },
    verify: async () => { writes++; readable = false; throw Object.assign(new Error('核实已保存'), { status: 503, code: 'VERIFICATION_RESPONSE_UNAVAILABLE' }); } });
  await assert.rejects(h.session.submit(values), /核实已保存/);
  assert.equal(h.session.view().awaitingResult, true); assert.equal(writes, 1);
  readable = true;
  await assert.rejects(h.session.submit(values), /核实已保存/); assert.equal(writes, 1);
  initial.risk_case.verification_status = 'CONFIRMED'; initial.risk_case.allowed_actions = [];
  await h.session.refresh(); assert.equal(h.session.view().done, true); assert.equal(h.session.view().awaitingResult, false);
});

test('a POST-time stage and version race refreshes the same form and rebinds a new key on the next human click', async () => {
  const initial = detail(), sent = []; let latest = structuredClone(initial);
  const h = harness(initial, { read: async () => latest, verify: async (...args) => {
    sent.push(args);
    if (sent.length === 1) { latest.risk_case.version++; latest.risk_case.stage='ENTERED'; latest.event.event_id=randomUUID(); latest.event.version=0; latest.risk_case.action_event_id=latest.event.event_id; throw Object.assign(new Error('风险已更新'), { status: 409, code: 'RISK_CASE_CHANGED' }); }
    return { risk_case: { ...latest.risk_case, verification_status: 'CONFIRMED' } };
  } });
  await assert.rejects(h.session.submit(values), /风险已更新/);
  assert.equal(h.session.view().uncertain, false);
  await h.session.submit(values); assert.equal(sent.length, 2);
  assert.notEqual(sent[0][2], sent[1][2]); assert.equal(sent[1][1].expected_case_version, 3);
  assert.equal(sent[1][1].expected_version,0); assert.equal(Object.hasOwn(sent[1][1],'prediction_id'),false);
});
test('a conflict on retry cannot erase the outcome of an earlier timeout or unlock a different request', async () => {
  const initial = detail(), sent = []; let latest = structuredClone(initial);
  const h = harness(initial, { read: async () => latest, verify: async (...args) => {
    sent.push(args);
    if (sent.length === 1) throw Object.assign(new Error('结果未知'), { code: 'TIMEOUT' });
    throw Object.assign(new Error('本次重试版本已变化'), { status: 409, code: 'RISK_CASE_CHANGED' });
  } });
  await assert.rejects(h.session.submit(values), /结果未确认/);
  latest.risk_case.stage = 'ENTERED'; latest.risk_case.version++; latest.event.event_id = randomUUID();
  latest.event.version = 0; latest.risk_case.action_event_id = latest.event.event_id;
  await h.session.refresh();
  await assert.rejects(h.session.submit(values), /结果未确认/);
  assert.equal(h.session.view().uncertain, true);
  await assert.rejects(h.session.submit({ ...values, conclusion: 'FALSE_POSITIVE' }), /保留原核实/);
  assert.equal(sent.length, 2);
  await assert.rejects(h.session.submit(values), /结果未确认/);
  for (const [, body, key] of sent) { assert.equal(key, sent[0][2]); assert.deepEqual(body, sent[0][1]); }
  latest.risk_case.verification_status = 'CONFIRMED'; latest.risk_case.allowed_actions = [];
  await h.session.refresh(); await h.session.submit(values); assert.equal(sent.length, 3);
  assert.equal(h.session.view().uncertain, false);
});