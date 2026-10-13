const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

async function harness({ failStart = false } = {}) {
  const elements = new Map(), calls = [], timers = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, disabled:false, value:'', textContent:'', events:{},
      addEventListener(event,fn) { this.events[event]=fn; }, replaceChildren() {}, append() {},
      setAttribute() {}, classList:{toggle() {}} });
    return elements.get(id);
  };
  const manual = element('manual-config'), automatic = element('config');
  manual.elements = {longitude:element('manual-longitude'),latitude:element('manual-latitude')};
  automatic.elements = {longitude:element('auto-longitude'),latitude:element('auto-latitude')};
  let state = {state:'STOPPED',frames_sent:0};
  const context = vm.createContext({ console, Date,
    document:{hidden:false,getElementById:element,createElement:()=>element('option-'+Math.random()),
      querySelectorAll:selector=>selector==='#config input'?Object.values(automatic.elements)
        :selector==='#manual-config input'?Object.values(manual.elements):[...Object.values(automatic.elements),...Object.values(manual.elements)]},
    FormData:class {
      constructor(form) { this.values=Object.fromEntries(Object.entries(form.elements).filter(([,x])=>!x.disabled).map(([k,x])=>[k,x.value])); }
      get(key) { return this.values[key] ?? null; }
    },
    setInterval:fn=>timers.push(fn),
    fetch:async(url,options)=>{
      let result;
      if(options.method==='POST') {
        calls.push({url,body:JSON.parse(options.body)});
        if(url.endsWith('/manual/start')) {
          if(failStart)return {ok:false,status:400,json:async()=>({error:'请先登录'})};
          state={state:'RUNNING',connected:false,frames_sent:0,...JSON.parse(options.body)};
        } else if(url.endsWith('/manual/stop')) state={...state,state:'STOPPED'};
      }
      if(url.endsWith('/context'))result={scopes:[{org_id:'org',district_id:'district',org_name:'单位',district_name:'区域'}]};
      else result=url.includes('/manual/')?state:{state:'RUNNING',frames_sent:12,device_id:'old-device'};
      return {ok:true,status:200,json:async()=>result};
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/tcp-radar.js'),'utf8'),context);
  for(let i=0;i<20;i++)await Promise.resolve();
  return {element,manual,calls,timers,context};
}
test('manual submission preserves entered coordinates before controls are disabled and leaves original mode alone',async()=>{
  for(const [longitude,latitude] of [[118.61,37.47],[-73.4,-31.8]]) {
    const h=await harness();
    assert.equal(h.manual.elements.longitude.disabled,false);
    h.manual.elements.longitude.value=String(longitude);h.manual.elements.latitude.value=String(latitude);
    await h.manual.events.submit({target:h.manual,preventDefault(){}});
    assert.deepEqual(h.calls,[{url:'/api/tcp-radar/manual/start',body:{longitude,latitude}}]);
    assert.equal(h.element('manual-connection').textContent,'等待后台手动接入');
    assert.equal(h.element('manual-stop').disabled,false);
    await h.element('manual-stop').events.click();
    assert.equal(h.calls[1].url,'/api/tcp-radar/manual/stop');
    assert.equal(h.element('state').textContent,'● 正在发送');
  }
});
test('login failure remains visible after an idle status poll',async()=>{
  const h=await harness({failStart:true});
  h.manual.elements.longitude.value='118';h.manual.elements.latitude.value='37';
  await h.manual.events.submit({target:h.manual,preventDefault(){}});
  await vm.runInContext('refreshManual()',h.context);
  assert.equal(h.element('manual-message').textContent,'请先登录');
  assert.equal(h.element('manual-start').disabled,false);
});
