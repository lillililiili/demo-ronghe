const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const start = source.indexOf('function targetValues(');
const end = source.indexOf("document.addEventListener('submit'", start);
const kinds = ['radar', '5ga', 'tdoa', 'aoa', 'dcd', 'rid'];
const context = vm.createContext({targetDeviceKinds: kinds, deviceFor: kind => ({kind})});
vm.runInContext(source.slice(start, end), context);
const save = (kind, datum, transport = 'mqtt') => context.targetValues({
  name: '目标-' + kind, kind: 'uav', deviceId: kind, transport, altitudeDatum: datum,
  height: '50', speed: '5', altitudePathInput: '', dwellSecondsInput: '', silenceWindowsInput: ''
}, {path: [[450, 300]]});

test('saving all six protocol A sources preserves MQTT and unknown height datum', () => {
  for (const kind of kinds) for (const datum of ['', 'AMSL']) {
    const saved = save(kind, datum);
    assert.equal(saved.transport, 'mqtt');
    assert.equal(saved.altitudeDatum, datum || undefined);
    assert.equal(JSON.parse(JSON.stringify(saved)).altitudeDatum, datum || undefined);
  }
});

test('AGL requires an explicit normalized channel and never changes MQTT silently', () => {
  assert.throws(() => save('tdoa', 'AGL'), /AGL/);
  assert.equal(save('tdoa', 'AGL', 'normalized').transport, 'normalized');
  assert.equal(save('radar', 'AMSL', 'normalized').altitudeDatum, 'AMSL');
  assert.throws(() => save('radar', '', 'normalized'), /高度基准/);
});
