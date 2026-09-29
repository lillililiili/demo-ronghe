const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { computed, ref } = require('vue');

function fixtures(allowed) {
  const hasPermission = code => allowed && code === 'handoff:create';
  const flight = readFileSync(path.join(__dirname, '../src/pages/FlightsPage.vue'), 'utf8');
  const itemFunction = flight.match(/function canNotifyItem\(item\) \{[^\n]+\}/)[0];
  const canNotifyItem = new Function('hasPermission', itemFunction + '; return canNotifyItem;')(hasPermission);
  const source = readFileSync(path.join(__dirname, '../src/pages/airspace/AirspaceRiskEventDetail.vue'), 'utf8');
  const expression = source.slice(source.indexOf('const canNotify = computed('), source.indexOf('const notifyReason = computed('));
  const risk = ref(null), submitted = ref(null);
  const canNotify = new Function('computed', 'hasPermission', 'loading', 'noticesLoading', 'noticesError', 'submitted', 'risk', expression + '; return canNotify;')(
    computed, hasPermission, ref(false), ref(false), ref(''), submitted, risk);
  return { canNotifyItem, canNotify, risk, submitted };
}

test('read-only users cannot notify from either risk entry, including a stale NOTIFY action', () => {
  const f = fixtures(false);
  for (const actions of [[], ['NOTIFY']]) {
    const risk = { state: 'PENDING_NOTIFICATION', allowed_actions: actions };
    assert.equal(f.canNotifyItem(risk), false);
    f.risk.value = risk;
    assert.equal(f.canNotify.value, false);
  }
});

test('authorized users can notify a pending risk and cannot resubmit an existing notice', () => {
  const f = fixtures(true);
  const risk = { state: 'PENDING_NOTIFICATION', allowed_actions: [] };
  assert.equal(f.canNotifyItem(risk), true);
  f.risk.value = risk;
  assert.equal(f.canNotify.value, true);
  f.submitted.value = { delivery_status: 'SUBMITTED' };
  assert.equal(f.canNotify.value, false);
  assert.equal(f.canNotifyItem({ state: 'PENDING_VERIFICATION', allowed_actions: [] }), false);
});
