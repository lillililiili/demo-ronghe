const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const source = readFileSync(path.join(__dirname, '../src/pages/AlarmsPage.vue'), 'utf8').replace(/\r\n/g, '\n');
function body(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return (source.slice(start - 6, start) === 'async ' ? 'async ' : '')
    + source.slice(start, source.indexOf('\n}\n', start) + 3);
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const rows = () => Array.from({ length: 2 }, () => ({ alarm_id: randomUUID(), event_id: randomUUID() }));
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const previous = rows(), frames = [], requests = [], batches = [], states = new Map();
  const list = { rows: previous, loading: false, error: '', refreshError: '' };
  const st = { page: 1, size: 2 }, totalCount = { value: 20 };
  const scroll = { scrollTop: 75, scrollLeft: 0 };
  const host = { setAttribute: () => {}, querySelector: () => scroll };
  const deps = {
    list, st, totalCount, el: () => host, queryOf: () => ({ page: st.page, size: st.size }),
    listHtml: () => JSON.stringify({ rows: list.rows.map(row => ({ id: row.alarm_id, state: states.get(row.event_id) || 'initial' })), error: list.error, refreshError: list.refreshError }),
    patchHtml: (_, html) => frames.push(JSON.parse(html)), messageOf: error => error.message, refreshFailureText: error => error.message,
    listAlarms: query => { const request = { ...deferred(), query }; requests.push(request); return request.promise; },
    loadPageProgress: pageRows => {
      const batch = { ...deferred(), rows: pageRows };
      batch.partial = () => { states.set(pageRows[0].event_id, 'intermediate'); api.paintList(); };
      batch.finish = () => { pageRows.forEach(row => states.set(row.event_id, 'ready')); api.paintList(); batch.resolve(); };
      batches.push(batch);
      return batch.promise;
    }
  };
  const api = new Function(...Object.keys(deps), `let listSeq = 0, listQueryKey = '';
    ${body('paintList')}
    ${body('loadList')}
    return { loadList, paintList };`)(...Object.values(deps));
  api.paintList(); frames.length = 0; scroll.scrollTop = 75;
  return { ...api, list, st, totalCount, previous, frames, requests, batches, scroll };
}

test('a page appears once with complete progress, without intermediate rows or a premature scroll reset', async () => {
  const f = fixture(), next = rows();
  f.st.page = 2;
  const loading = f.loadList();
  assert.equal(f.scroll.scrollTop, 75, 'keep the current table stable while loading');
  f.requests[0].resolve({ items: next, total: 20 }); await turn();
  f.batches[0].partial();
  assert.deepEqual(f.list.rows, f.previous);
  assert.equal(f.frames.length, 0, 'do not render the next page with partial progress');
  f.batches[0].finish(); await loading;
  assert.equal(f.frames.length, 1);
  assert.deepEqual(f.frames[0].rows, next.map(row => ({ id: row.alarm_id, state: 'ready' })));
  assert.equal(f.scroll.scrollTop, 0);
  assert.equal(f.list.loading, false);
});

test('rapid paging ignores a stale page whose progress finishes after the newest page', async () => {
  const f = fixture(), second = rows(), third = rows();
  f.st.page = 2; const a = f.loadList();
  f.requests[0].resolve({ items: second, total: 20 }); await turn();
  f.st.page = 3; const b = f.loadList();
  f.requests[1].resolve({ items: third, total: 30 }); await turn();
  f.batches[1].finish(); await b;
  f.batches[0].finish(); await a;
  assert.deepEqual(f.list.rows, third);
  assert.equal(f.totalCount.value, 30);
  assert.ok(f.frames.every(frame => frame.rows.every(row => third.some(item => item.alarm_id === row.id))));
});

test('an older list response cannot start loading progress or replace the latest page', async () => {
  const f = fixture(), next = rows();
  f.st.page = 2; const a = f.loadList();
  f.st.page = 3; const b = f.loadList();
  f.requests[1].resolve({ items: next, total: 20 }); await turn();
  f.batches[0].finish(); await b;
  f.requests[0].resolve({ items: rows(), total: 40 }); await a;
  assert.equal(f.batches.length, 1);
  assert.deepEqual(f.list.rows, next);
  assert.equal(f.totalCount.value, 20);
});

test('quiet refresh also publishes complete progress and releases loading after a failure', async () => {
  const f = fixture(), next = rows();
  const loading = f.loadList({ quiet: true });
  f.requests[0].resolve({ items: next, total: 20 }); await turn();
  f.batches[0].partial();
  assert.equal(f.frames.length, 0);
  f.batches[0].finish(); await loading;
  const failed = f.loadList({ quiet: true });
  const rejection = assert.rejects(failed, /offline/);
  f.requests[1].reject(new Error('offline')); await rejection;
  assert.deepEqual(f.list.rows, next);
  assert.equal(f.list.loading, false);
  assert.equal(f.frames.at(-1).refreshError, 'offline');
});

test('a failed page request reports an error instead of presenting the previous page as the new page', async () => {
  const f = fixture();
  f.st.page = 2; const loading = f.loadList();
  f.requests[0].reject(new Error('offline')); await loading;
  assert.deepEqual(f.list.rows, []);
  assert.equal(f.list.loading, false);
  assert.equal(f.frames.at(-1).error, 'offline');
});

test('background refresh without progress changes still avoids extra progress requests', async () => {
  const f = fixture();
  const loading = f.loadList({ quiet: true, progress: false });
  f.requests[0].resolve({ items: f.previous, total: 20 }); await loading;
  assert.equal(f.batches.length, 0);
  assert.equal(f.list.loading, false);
});
