const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const source = readFileSync(path.join(__dirname, '../src/pages/AlarmsPage.vue'), 'utf8').replace(/\r\n/g, '\n');
function body(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
}
function fixture() {
  const eventId = randomUUID();
  const deps = {
    cur: { alarm: { event_id: eventId } },
    advisoryLive: { value: { event_id: eventId, counter_launch_visible: true } },
    pageProgress: {}, progressSources: new Map(), disposal: { byAction: {}, handoff: null }
  };
  const api = new Function(...Object.keys(deps), [
    ...['deriveAlarmProgress', 'recordProgressRead', 'selectedDisposalProgress', 'showCounterLaunch'].map(body),
    'return { recordProgressRead, showCounterLaunch };'
  ].join('\n'))(...Object.values(deps));
  api.recordProgressRead(eventId, 'auths', 1, []);
  api.recordProgressRead(eventId, 'handoffs', 1, []);
  return { ...deps, ...api, eventId };
}

test('the same event stops offering a new request when its current progress enters approval or execution', () => {
  for (const action_type of ['COUNTERMEASURE', 'JAMMING']) {
    for (const status of ['REQUESTED', 'APPROVED', 'EXECUTING', 'COMPLETED', 'STOPPED']) {
      const f = fixture();
      assert.equal(f.showCounterLaunch(), true);
      f.recordProgressRead(f.eventId, 'auths', 2, [{ authorization_id: randomUUID(), action_type, status, requested_at: Date.now() }]);
      assert.equal(f.showCounterLaunch(), false, `${action_type}/${status}`);
    }
  }
});

test('missing or failed progress cannot reuse an old eligible summary', () => {
  for (const source of ['auths', 'handoffs']) {
    const f = fixture();
    f.progressSources.get(f.eventId)[source] = undefined;
    assert.equal(f.showCounterLaunch(), false, `missing ${source}`);
    f.recordProgressRead(f.eventId, source, 2, []);
    assert.equal(f.showCounterLaunch(), true);
    f.recordProgressRead(f.eventId, source, 3);
    assert.equal(f.showCounterLaunch(), false, `failed ${source}`);
    f.recordProgressRead(f.eventId, source, 4, []);
    assert.equal(f.showCounterLaunch(), true);
  }
});

test('old responses and another event cannot restore an application entry', () => {
  const f = fixture();
  f.recordProgressRead(f.eventId, 'auths', 3, [{ action_type: 'COUNTERMEASURE', status: 'REQUESTED', requested_at: Date.now() }]);
  f.recordProgressRead(f.eventId, 'auths', 2, []);
  assert.equal(f.showCounterLaunch(), false);
  f.recordProgressRead(f.eventId, 'auths', 4, [{ action_type: 'COUNTERMEASURE', status: 'CANCELLED', requested_at: Date.now() }]);
  assert.equal(f.showCounterLaunch(), true);
  f.advisoryLive.value.event_id = randomUUID();
  assert.equal(f.showCounterLaunch(), false);
});

test('failed advisory refresh preserves a read barrier against older successful replies', () => {
  const eventId = randomUUID(), summaries = new Map([[eventId, { event_id: eventId, event_version: 2, _fetchedAt: 10 }]]);
  const live = { value: { event_id: eventId } };
  const invalidate = new Function('advisorySummaries', 'advisoryLive', body('invalidateAdvisory') + '\nreturn invalidateAdvisory;')(summaries, live);
  invalidate(eventId, 20);
  assert.equal(live.value, null);
  assert.equal(summaries.get(eventId)?._fetchedAt, 20);
  live.value = { event_id: eventId };
  summaries.set(eventId, { event_id: eventId, _fetchedAt: 30 });
  invalidate(eventId, 25);
  assert.equal(live.value.event_id, eventId, 'late failures cannot invalidate a newer success');
});

test('list refresh shares fresh qualification and read failures with the open detail', async () => {
  const eventId = randomUUID(), updates = [], failures = [];
  let unavailable = false;
  const deps = {
    authorizationPageActive: true, pendingProgress: new Set(), progressSources: new Map(), advisorySummaries: new Map(), pageProgress: {},
    cur: { alarm: { event_id: eventId } },
    mapPool: (ids, _, read) => Promise.all(ids.map(read)), recordProgressRead: () => {}, paintList: () => {}, paintDetailContent: () => {},
    disposalApi: { list: async () => ({ items: [] }) }, handoffApi: { listHandoffs: async () => ({ items: [] }) },
    uavAdvisoryApi: { get: async () => { if (unavailable) throw new Error('offline'); return { event_id: eventId, event_version: 3, counter_launch_visible: false }; } },
    updateAdvisory: value => updates.push(value), invalidateAdvisory: id => failures.push(id)
  };
  const refresh = new Function(...Object.keys(deps), 'let progressBatch = null, progressBatchSeq = 0, progressReadSeq = 0;\n' + body('loadPageProgress') + '\nreturn loadPageProgress;')(...Object.values(deps));
  await refresh([{ event_id: eventId, state: 'CONFIRMED' }]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].counter_launch_visible, false);
  assert.ok(updates[0]._fetchedAt > 0);
  unavailable = true;
  await refresh([{ event_id: eventId, state: 'CONFIRMED' }]);
  assert.deepEqual(failures, [eventId]);
});
