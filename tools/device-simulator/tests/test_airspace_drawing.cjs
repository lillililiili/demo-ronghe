const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/app.js'),'utf8');
function drawing(mode,kind){
 const events=[];
 const env={draw:{mode,airspaceInput:mode==='zone',airspaceKind:kind,points:[[100,100],[200,100],[200,200]]},state:{zones:[],plans:[]},selected:null,
 airspaceKinds:{PROHIBITED:'禁飞区',RESTRICTED:'限制区',ALTITUDE_LIMIT:'限高区',PERMITTED:'允许区',TEMPORARY_CONTROL:'临时管制区'},uid:prefix=>prefix+'test',validPolygon:()=>true,dirty(){},render(){},toast(){},cancelDraw(){env.draw=null;},window:{dispatchEvent:e=>events.push(e)},CustomEvent:function(type,options){this.type=type;this.detail=options.detail;}};
 vm.createContext(env);vm.runInContext(source.slice(source.indexOf('function finishDraw('),source.indexOf('function formValues(')),env);
 return {env,events};
}
test('drawing preserves each explicitly selected airspace kind and returns its boundary to the form',()=>{
 for(const kind of ['PROHIBITED','RESTRICTED','ALTITUDE_LIMIT','PERMITTED','TEMPORARY_CONTROL']){
  const {env,events}=drawing('zone',kind);env.finishDraw();
  assert.equal(env.state.zones[0].kindCode,kind);assert.equal(events[0].detail.id,'ztest');assert.equal(events[0].type,'simulator:airspace-drawn');
 }
});
test('untyped boundary is neutral and unknown draw modes cannot create a zone',()=>{
 const {env}=drawing('zone');env.finishDraw();assert.match(env.state.zones[0].name,/空域边界/);assert.equal(env.state.zones[0].kindCode,undefined);
 const invalid=drawing('unexpected');invalid.env.finishDraw();assert.equal(invalid.env.state.zones.length,0);
});
test('route drawing remains a route and never creates an airspace',()=>{
 const {env,events}=drawing('plan');env.finishDraw();assert.equal(env.state.plans.length,1);assert.equal(env.state.zones.length,0);assert.equal(events.length,0);
});
