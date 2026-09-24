const assert=require('node:assert/strict');
const test=require('node:test');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const nodes=new Map();
function node(selector){
 if(!nodes.has(selector))nodes.set(selector,{textContent:'',innerHTML:'',value:'',options:[],classList:{toggle(){}},addEventListener(){},contains(){return false;}});
 return nodes.get(selector);
}
const document={hidden:false,activeElement:null,querySelector:node,querySelectorAll(){return [];},addEventListener(){}};
const source=fs.readFileSync(path.join(__dirname,'../web/external.js'),'utf8');

test('401 on a write clears connection and context immediately while keeping draft',async()=>{
 const sandbox={document,window:{ExternalContract:require('../web/external-contract.js')},setInterval(){},fetch:async url=>url.endsWith('/status')?{ok:true,status:200,json:async()=>({connected:false})}:{ok:false,status:401,json:async()=>({error:'expired'})}};
 vm.createContext(sandbox);
 vm.runInContext(source+'\nglobalThis.__test={call,set(){connected=true;context={messages:[]};drafts.plans="saved draft";setConnection({connected:true,user:{account:"operator"}});},get(){return {connected,context,draft:drafts.plans}}};',sandbox);
 await new Promise(resolve=>setImmediate(resolve));
 sandbox.__test.set();
 await assert.rejects(sandbox.__test.call('request',{method:'POST',path:'/local-interface-simulator/plans',body:{},key:'one'}),/重新登录/);
 assert.equal(sandbox.__test.get().connected,false);
 assert.equal(sandbox.__test.get().context,null);
 assert.equal(sandbox.__test.get().draft,'saved draft');
 assert.match(node('#external-status').textContent,/尚未登录/);
});
