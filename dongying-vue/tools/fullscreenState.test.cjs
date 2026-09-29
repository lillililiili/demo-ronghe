const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

function fixture(mode) {
  const source = readFileSync(path.join(__dirname, '../src/layout/HeaderBar.vue'), 'utf8');
  const start = source.indexOf('async function toggleBig');
  const code = source.slice(start < 0 ? source.indexOf('function toggleBig') : start, source.indexOf('/* ---------- 用户菜单'));
  const classes = new Set(), notices = [], store = { bigscreen: false };
  const document = { body: { classList: {
    contains: key => classes.has(key), remove: key => classes.delete(key),
    toggle(key, force) { const on = force === undefined ? !classes.has(key) : force; if (on) classes.add(key); else classes.delete(key); return on; },
  } }, documentElement: {}, fullscreenElement: null };
  if (mode !== 'unsupported') document.documentElement.requestFullscreen = async () => {
    if (mode === 'rejected') throw new Error('Fullscreen denied');
    document.fullscreenElement = document.documentElement;
  };
  document.exitFullscreen = async () => { document.fullscreenElement = null; };
  const api = new Function('document', 'window', 'store', 'toast', 'Event', code + ';return {toggleBig,onFsChange}')(
    document, { dispatchEvent() {} }, store, message => notices.push(message), class {});
  return { ...api, document, store, classes, notices };
}
test('unsupported fullscreen does not claim success or apply fullscreen layout', async () => {
  const f = fixture('unsupported'); await f.toggleBig();
  assert.equal(f.store.bigscreen, false); assert.equal(f.classes.has('bigscreen'), false);
  assert.equal(f.notices.length, 1);
});
test('rejected fullscreen restores normal state and reports the failure', async () => {
  const f = fixture('rejected'); await f.toggleBig();
  assert.equal(f.store.bigscreen, false); assert.equal(f.classes.has('bigscreen'), false);
  assert.equal(f.notices.length, 1);
});
test('successful enter, external escape and explicit exit follow browser state', async () => {
  const f = fixture('success'); await f.toggleBig();
  assert.equal(f.store.bigscreen, true);
  f.document.fullscreenElement = null; f.onFsChange(); assert.equal(f.store.bigscreen, false);
  await f.toggleBig(); await f.toggleBig();
  assert.equal(f.document.fullscreenElement, null); assert.equal(f.store.bigscreen, false);
});
