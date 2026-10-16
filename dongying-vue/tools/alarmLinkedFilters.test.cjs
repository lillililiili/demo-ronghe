const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

const source = readFileSync(path.join(__dirname, '../src/pages/AlarmsPage.vue'), 'utf8').replace(/\r\n/g, '\n');
function body(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
}

test('linked alarms remain searchable after a recent or custom time filter', async () => {
  const { timeFilterWindow } = await import('../src/services/timeFilter.js');
  for (const time of ['TODAY', 'LAST_7D', 'CUSTOM']) {
    const now = Date.now();
    const st = { page: 5, size: 20, sort: 'priority', level: 'HIGH', status: '全部',
      kind: 'NO_AUTHORIZATION', region: randomUUID(), time, timeRange: [now - 3600000, now] };
    const controls = ['level', 'time', 'region'].map(key => ({ dataset: { f: key }, value: st[key] }));
    const root = { value: { querySelectorAll: () => controls } };
    const bindings = new Function('st', 'root', 'STATUS_FILTER', 'VIOLATION_REASON_CODES', 'timeFilterWindow',
      `${body('resetLinkedAlarmFilters')}\n${body('queryOf')}\nreturn { resetLinkedAlarmFilters, queryOf };`)
      (st, root, {}, ['NO_AUTHORIZATION'], timeFilterWindow);
    assert.ok(bindings.queryOf().occurred_from, `${time} is active before the linked navigation`);
    bindings.resetLinkedAlarmFilters();
    assert.deepEqual(bindings.queryOf(), { page: 1, size: 20, sort: 'priority' });
    assert.equal(st.timeRange, null);
    assert.equal(controls.find(control => control.dataset.f === 'time').value, '');
  }
});
