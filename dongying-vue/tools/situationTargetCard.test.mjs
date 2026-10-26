import * as riskHelpers from '../src/services/riskCaseView.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import * as prediction from '../src/services/predictionView.js';

const source = readFileSync(new URL('../src/pages/situation/SituationTargetCard.vue', import.meta.url), 'utf8');
const { descriptor } = parse(source);
const imports = {};
const dependencies = { ...riskHelpers, RiskDisposalSummary: { render() { return null; } }, ...Vue, ...prediction, displayTargetNo: value => value,
  pilotLocationText: value => value ? '设备测算的大概位置' : '没有遥控器位置', pilotDistanceNote: () => '',
  useUavAdvisory: () => ({ error: Vue.ref('') }),
  SituationNextStep: { props: ['alarm'], render() { return Vue.h('button', { 'data-action': this.alarm.eventId }, '查看预警详情'); } } };
let compiled = compileScript(descriptor, { id: 'test-card', inlineTemplate: true }).content;
compiled = compiled.replace(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"];?/g, (_, list) => {
  for (const item of list.replace(/[{}]/g, '').split(',').map(value => value.trim()).filter(Boolean)) {
    const [name, alias = name] = item.split(/\s+as\s+/);
    assert.ok(name in dependencies, `missing test dependency ${name}`);
    imports[alias] = dependencies[name];
  }
  return '';
});
const Card = new Function(...Object.keys(imports), 'window', compiled.replace('export default', 'return'))(
  ...Object.values(imports), { UI: { targetIcon: () => '<svg></svg>' } });
const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null });
const renderer = Vue.createRenderer({
  createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (el, text) => { el.text = text; }, setElementText: (el, text) => { el.text = text; el.children = []; },
  patchProp: (el, key, oldValue, value) => { el.props[key] = value; },
  insert(el, parent, anchor = null) {
    if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, el); el.parent = parent;
  },
  remove(el) { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null; },
  parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] || null
});
const all = root => [root, ...root.children.flatMap(all)];
const text = root => [root.text, ...root.children.map(text)].filter(Boolean).join(' ');
const find = (root, predicate) => all(root).find(predicate);
const now = Date.now();
function propsFor(id, lifecycle = 'ACTIVE') {
  return { target: { id, targetId: `target-${id}`, objectTypeCode: 'UAV', typeLabel: '无人机', alt: 100, speed: 30,
    lastSeenAt: now, sourceMode: 'replay' }, alarm: { eventId: `event-${id}`, eventState: 'PENDING_VERIFICATION',
    originKind: 'PREDICTED_AIRSPACE_ENTRY', prediction: { status: 'READY', based_on_observed_at: now - 200, valid_until: now + 60000,
      warning: { event_id: `event-${id}`, state: lifecycle, airspace_name: `区域<${id}>` } } }, now, sourceNames: '雷达 / TDOA' };
}

test('continuous movement preserves card, metric, focus and open-details nodes while values update', async () => {
  for (const id of ['east', 'west']) {
    const root = node('root'); let props = propsFor(id);
    const render = () => renderer.render(Vue.h(Card, props), root);
    render(); await Vue.nextTick();
    const card = root.children[0];
    const details = find(root, el => el.type === 'details');
    const button = find(root, el => el.props['aria-label'] === '关闭目标详情');
    const metric = find(root, el => el.type === 'dd');
    details.open = true; card.scrollTop = 35; button.focused = true;
    for (let index = 1; index <= 40; index++) {
      props = { ...props, now: now + index * 500, target: { ...props.target, lon: 118 + index / 1000,
        lastSeenAt: now + index * 500, alt: 100 + index, speed: 30 + index / 10 } };
      render(); await Vue.nextTick();
      assert.equal(root.children[0], card);
      assert.equal(find(root, el => el.type === 'details'), details);
      assert.equal(find(root, el => el.props['aria-label'] === '关闭目标详情'), button);
      assert.equal(find(root, el => el.type === 'dd'), metric);
      assert.equal(details.open, true); assert.equal(card.scrollTop, 35); assert.equal(button.focused, true);
    }
    assert.equal(metric.text, '140 m');
    assert.match(text(root), /34 m\/s/);
    renderer.render(null, root);
  }
});

test('lifecycle changes stay truthful without replacing the card, and history is not duplicated', async () => {
  const root = node('root'); const props = propsFor('lifecycle');
  renderer.render(Vue.h(Card, props), root); await Vue.nextTick();
  const card = root.children[0];
  for (const state of ['ACTIVE', 'UNKNOWN', 'WITHDRAWN', 'ENTERED']) {
    const alarm = { ...props.alarm, prediction: { ...props.alarm.prediction,
      warning: { ...props.alarm.prediction.warning, state } } };
    renderer.render(Vue.h(Card, { ...props, alarm }), root); await Vue.nextTick();
    assert.equal(root.children[0], card);
    assert.match(text(root), new RegExp(prediction.PREDICTION_STATES[state].replace(/[()]/g, '\\$&')));
    assert.match(text(root), /模拟／回放/);
    assert.doesNotMatch(text(root), /原核实记录保留|本次预测预警已撤销，原核实与通知记录保留/);
    if (['WITHDRAWN', 'ENTERED'].includes(state)) {
      assert.match(text(root), /原预警区域/); assert.doesNotMatch(text(root), /待人工核实/);
    }
  }
  renderer.render(null, root);
});

test('missing metrics are not zero and a plain target has no prediction or disposal card', async () => {
  const root = node('root');
  renderer.render(Vue.h(Card, { target: { id: 'plain', objectTypeCode: 'BIRD', alt: null, speed: undefined }, now }), root);
  await Vue.nextTick();
  assert.doesNotMatch(text(root), /0 m|预测入区|查看预警详情|待人工核实/);
  assert.equal(all(root).filter(el => el.type === 'dd' && el.text === '未提供').length, 4);
  renderer.render(null, root);
});
