const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function harness(t, hidden) {
  const streams = [];
  let token = 'session-a';
  global.window = new EventTarget();
  global.document = Object.assign(new EventTarget(), { hidden });
  global.__item4Token = () => token;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const entry = { signal: options.signal, token: options.headers.Authorization };
    streams.push(entry);
    const body = new ReadableStream({ start(controller) { entry.writer = controller; } });
    entry.signal.addEventListener('abort', () => entry.writer.error(new Error('aborted')));
    return new Response(body);
  };
  let source = fs.readFileSync(process.env.ITEM4_REALTIME_SOURCE || path.join(__dirname, '../src/services/realtime.js'), 'utf8')
    .replace(/^import .* from .*;\r?\n/gm, '')
    .replaceAll('import.meta.env.APP_PUBLIC_API_BASE_URL', 'undefined');
  const service = await import('data:text/javascript;base64,' + Buffer.from('const readSessionToken=globalThis.__item4Token;\n'+source).toString('base64') + '#' + Math.random());
  const calls=[];
  const stop=service.onDataChange(['alarm'], (topics, meta) => calls.push({topics,meta}));
  t.after(() => { stop(); global.fetch=originalFetch; });
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  const ready=async()=>{streams.at(-1).writer.enqueue(new TextEncoder().encode('event: ready\ndata: {"listening":true}\n\n'));await flush();};
  const visibility=async value=>{document.hidden=value;document.dispatchEvent(new Event('visibilitychange'));await flush();};
  await flush();
  return { streams, service, calls, ready, visibility, flush, changeToken:value=>{token=value;} };
}

test('hidden tabs do not consume SSE connections, including online and auth changes', async t => {
  const h=await harness(t,true);
  assert.equal(h.streams.length,0);
  window.dispatchEvent(new Event('online'));h.changeToken('session-b');window.dispatchEvent(new Event('auth-access-change'));
  await h.flush();assert.equal(h.streams.length,0);
  await h.visibility(false);
  assert.equal(h.streams.length,1);assert.equal(h.streams[0].token,'Bearer session-b');
  await h.ready();assert.equal(h.service.isRealtimeConnected(),true);
  assert.ok(h.calls.some(call=>call.meta.recovery && call.topics.includes('*')));
});

test('switching away releases the stream and switching back rereads even after a short absence', async t => {
  const h=await harness(t,false);await h.ready();
  assert.equal(h.streams.length,1);
  await h.visibility(true);
  assert.equal(h.streams[0].signal.aborted,true);
  assert.equal(h.service.isRealtimeConnected(),false);
  await h.visibility(false);assert.equal(h.streams.length,2);await h.ready();
  assert.ok(h.calls.some(call=>call.meta.recovery && call.topics.includes('*')));
});
