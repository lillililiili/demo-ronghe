const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

const source = readFileSync(path.join(__dirname, '../src/pages/AlarmsPage.vue'), 'utf8').replace(/\r\n/g, '\n');
function body(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
}
function fixture() {
  const alarm = { alarm_id: randomUUID(), target_id: randomUUID(), event_id: randomUUID() };
  const event = { event_id: alarm.event_id, state: 'FALSE_POSITIVE', version: 2 };
  const cur = { alarm, event, chain: { files: [] }, verificationsLoaded: true };
  const st = { selId: alarm.alarm_id };
  const calls = [], paints = [];
  const nextChain = { files: [{ evidence_id: randomUUID(), kind_code: 'EO_STILL' }, { evidence_id: randomUUID(), kind_code: 'EO_VIDEO' }] };
  let subscription;
  const deps = {
    cur, st, list: { rows: [alarm] }, detailSeq: 1, disposalSeq: 1,
    disposal: {}, getAlarm: async () => ({ ...alarm }), getUavEvent: async () => ({ ...event }),
    getEvidenceChain: async (...args) => { calls.push(args); return nextChain; },
    hasPermission: () => true, loadChain: () => assert.fail('existing authorized chain must refresh in place'),
    loadList: async () => {}, realtimeKpis() {}, takeProgress: () => false,
    refreshEventDisposals: async () => {}, paintList() {}, paintDetail() {},
    paintDetailContent: () => paints.push(cur.chain), loadTarget: async () => {},
    loadEscalations: async () => {}, loadVerifications: async () => {},
    shouldRetryRefresh: () => false,
    useRealtimeRefresh: (topics, reload) => { subscription = { topics, reload }; return {}; }
  };
  const binding = source.match(/^const realtime = useRealtimeRefresh\([^\n]+/m)[0];
  new Function(...Object.keys(deps), [body('refreshChain'), body('refreshSelected'), body('realtimeRefresh'), binding].join('\n'))(...Object.values(deps));
  return { cur, st, calls, paints, nextChain, subscription, alarm };
}

test('saved image and video refresh an unchanged event through the evidence signal', async () => {
  const f = fixture();
  assert.ok(f.subscription.topics.includes('evidence'), 'subscribe to evidence changes');
  await f.subscription.reload(['evidence']);
  assert.deepEqual(f.calls, [['EVENT', f.alarm.event_id]]);
  assert.deepEqual(f.cur.chain, f.nextChain);
  assert.deepEqual(f.paints, [f.nextChain]);
});

test('recovery also reloads evidence when alarm and event versions are unchanged', async () => {
  const f = fixture();
  await f.subscription.reload(['*']);
  assert.deepEqual(f.cur.chain, f.nextChain);
  assert.equal(f.calls.length, 1);
});

test('unrelated changes and no selected alarm do not fetch an evidence chain', async () => {
  const f = fixture();
  await f.subscription.reload(['target']);
  assert.equal(f.calls.length, 0);
  f.st.selId = '';
  await f.subscription.reload(['evidence']);
  assert.equal(f.calls.length, 0);
});
