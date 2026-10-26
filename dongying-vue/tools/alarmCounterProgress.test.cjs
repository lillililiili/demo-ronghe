const riskHelpers = require('./riskCaseTestHelpers.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');

function loadPure(relative, names) {
  const code = readFileSync(path.join(__dirname, relative), 'utf8').replace(/\bexport /g, '');
  return new Function(`${code}\nreturn { ${names.join(', ')} };`)();
}
const progressAccess = loadPure('../src/pages/alarms/progressAccess.js', ['mergeProgressRead', 'readProgressSource']);
const { punishmentHandoffProgress } = loadPure('../src/ui/punishmentHandoffProgress.js', ['punishmentHandoffProgress']);

const source = readFileSync(path.join(__dirname, '../src/pages/AlarmsPage.vue'), 'utf8').replace(/\r\n/g, '\n');
const progressKey = new Function('riskCaseOf', source.match(/^const progressKey = .*;$/m)[0] + '; return progressKey;')(riskHelpers.riskCaseOf);
function body(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
}
function fixture() {
  const eventId = randomUUID();
  const deps = { authorizationPageActive: true, ...riskHelpers, progressKey,
    ...progressAccess, punishmentHandoffProgress, hasPermission: () => true,
    cur: { alarm: { event_id: eventId } },
    advisoryLive: { value: { event_id: eventId, counter_launch_visible: true } },
    pageProgress: {}, progressSources: new Map(), disposal: { byAction: {}, handoff: null }
  };
  const api = new Function(...Object.keys(deps), [
    ...['deriveAlarmProgress', 'recordProgressRead', 'selectedDisposalProgress', 'showCounterLaunch'].map(body),
    'return { recordProgressRead, showCounterLaunch };'
  ].join('\n'))(...Object.values(deps));
  api.recordProgressRead(eventId, 'auths', 1, { items: [] });
  api.recordProgressRead(eventId, 'handoffs', 1, { items: [] });
  return { ...deps, ...api, eventId };
}

test('the same event stops offering a new request when its current progress enters approval or execution', () => {
  for (const action_type of ['COUNTERMEASURE', 'JAMMING']) {
    for (const status of ['REQUESTED', 'APPROVED', 'EXECUTING', 'COMPLETED']) {
      const f = fixture();
      assert.equal(f.showCounterLaunch(), true);
      f.recordProgressRead(f.eventId, 'auths', 2, { items: [{ authorization_id: randomUUID(), action_type, status, requested_at: Date.now() }] });
      assert.equal(f.showCounterLaunch(), false, `${action_type}/${status}`);
    }
  }
});

test('stopped authorization can be followed by a new request only with fresh eligibility and complete progress reads', () => {
  for (const action_type of ['COUNTERMEASURE', 'JAMMING']) {
    const f = fixture();
    f.recordProgressRead(f.eventId, 'auths', 2, { items: [{ authorization_id: randomUUID(), action_type, status: 'STOPPED', requested_at: Date.now() }] });
    assert.equal(f.showCounterLaunch(), true);
    f.advisoryLive.value.counter_launch_visible = false;
    assert.equal(f.showCounterLaunch(), false);
    f.advisoryLive.value.counter_launch_visible = true;
    f.recordProgressRead(f.eventId, 'auths', 3);
    assert.equal(f.showCounterLaunch(), false);
  }
});

test('missing or failed progress cannot reuse an old eligible summary', () => {
  for (const source of ['auths', 'handoffs']) {
    const f = fixture();
    f.progressSources.get(f.eventId)[source] = undefined;
    assert.equal(f.showCounterLaunch(), false, `missing ${source}`);
    f.recordProgressRead(f.eventId, source, 2, { items: [] });
    assert.equal(f.showCounterLaunch(), true);
    f.recordProgressRead(f.eventId, source, 3);
    assert.equal(f.showCounterLaunch(), false, `failed ${source}`);
    f.recordProgressRead(f.eventId, source, 4, { items: [] });
    assert.equal(f.showCounterLaunch(), true);
  }
});

test('old responses and another event cannot restore an application entry', () => {
  const f = fixture();
  f.recordProgressRead(f.eventId, 'auths', 3, { items: [{ action_type: 'COUNTERMEASURE', status: 'REQUESTED', requested_at: Date.now() }] });
  f.recordProgressRead(f.eventId, 'auths', 2, { items: [] });
  assert.equal(f.showCounterLaunch(), false);
  f.recordProgressRead(f.eventId, 'auths', 4, { items: [{ action_type: 'COUNTERMEASURE', status: 'CANCELLED', requested_at: Date.now() }] });
  assert.equal(f.showCounterLaunch(), true);
  f.advisoryLive.value.event_id = randomUUID();
  assert.equal(f.showCounterLaunch(), false);
});

test('failed advisory refresh preserves a read barrier against older successful replies', () => {
  const eventId = randomUUID(), summaries = new Map([[eventId, { event_id: eventId, event_version: 2, _fetchedAt: 10 }]]);
  const live = { value: { event_id: eventId } };
  const invalidate = new Function('advisorySummaries', 'advisoryLive', 'cur', 'progressKey', body('invalidateAdvisory') + '\nreturn invalidateAdvisory;')(summaries, live, { alarm: { event_id: eventId } }, progressKey);
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
  const deps = { authorizationPageActive: true, ...riskHelpers, progressKey,
    pendingProgress: new Set(), progressSources: new Map(), advisorySummaries: new Map(), pageProgress: {},
    ...progressAccess, punishmentHandoffProgress, hasPermission: () => true,
    cur: { alarm: { event_id: eventId } },
    mapPool: (ids, _, read) => Promise.all(ids.map(read)), recordProgressRead: () => {}, paintList: () => {}, paintDetailContent: () => {},
    disposalApi: { list: async () => ({ items: [] }) }, handoffApi: { listHandoffs: async () => ({ items: [] }) },
    uavAdvisoryApi: { get: async () => { if (unavailable) throw new Error('offline'); return { event_id: eventId, event_version: 3, counter_launch_visible: false }; } },
    updateAdvisory: value => updates.push(value), invalidateAdvisory: id => failures.push(id)
  };
  const refresh = new Function(...Object.keys(deps), 'let progressBatch = null, progressBatchSeq = 0, progressReadSeq = 0;\n' + source.match(/^const readEventAuthorizations = .*;$/m)[0] + '\n' + source.match(/^const readEventHandoffs = .*;$/m)[0] + '\n' + body('loadPageProgress') + '\nreturn loadPageProgress;')(...Object.values(deps));
  await refresh([{ event_id: eventId, state: 'CONFIRMED' }]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].counter_launch_visible, false);
  assert.ok(updates[0]._fetchedAt > 0);
  unavailable = true;
  await refresh([{ event_id: eventId, state: 'CONFIRMED' }]);
  assert.deepEqual(failures, [eventId]);
});

test('同事件其他风险的读取失败不会清除当前区域的资格', () => {
  const eventId = randomUUID(), selectedCase = randomUUID(), otherCase = randomUUID();
  const summaries = new Map(), live = { value: { event_id: eventId, _riskCaseId: selectedCase } };
  const cur = { alarm: { event_id: eventId, risk_case: { risk_case_id: selectedCase } } };
  const invalidate = new Function('advisorySummaries', 'advisoryLive', 'cur', 'progressKey', body('invalidateAdvisory') + '\nreturn invalidateAdvisory;')(summaries, live, cur, progressKey);
  invalidate(eventId, 20, otherCase);
  assert.equal(live.value._riskCaseId, selectedCase);
  assert.equal(summaries.get(otherCase)._unavailable, true);
  invalidate(eventId, 21, selectedCase);
  assert.equal(live.value, null);
});
