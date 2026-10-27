const riskHelpers = require('./riskCaseTestHelpers.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function executionForm(error, latest = { status: 'APPROVED' }, channel = 'COUNTERMEASURE_4CH') {
  let form, refreshes = 0, closed = 0, sequence = 0;
  const keys = [], messages = [], bodies = [];
  const source = readFileSync(path.join(__dirname, '../src/ui/disposalAuthModal.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
  const context = vm.createContext({ ...riskHelpers,
    openFormModal: value => { form = value; }, closeModal: () => { closed++; },
    toast: message => messages.push(message),
    disposalApi: { execute: async (_id, _body, key) => { keys.push(key); bodies.push(_body); if (error) throw error; return { status: 'EXECUTING' }; } },
    newDisposalIdempotencyKey: () => `test-key-${++sequence}`,
    isDisposalUnavailable: () => false, isUncertainOutcome: value => value.status === 409,
    DISPOSAL_ACTION_LABEL: {}, DISPOSAL_BLOCK_REASON_LABEL: {}, DISPOSAL_CHANNEL_LABEL: {},
    DISPOSAL_STATUS_LABEL: {}, disposalStatusText: value => value.status,
    labelOf: (_labels, value) => value
  });
  vm.runInContext(source, context);
  context.openDisposalExecution({
    authorization: { authorization_id: 'qa-auth', status: 'APPROVED', channel, version: 1 },
    refresh: async () => { refreshes++; return latest; }
  });
  return { form, keys, messages, bodies, refreshes: () => refreshes, closed: () => closed };
}

test('设备故障是明确未下发，回读后仍保留执行弹窗供处理，不提示结果未知', async () => {
  const state = executionForm({ status: 409, code: 'DEVICE_NOT_OPERABLE', message: '设备已上报故障，不能下发启动指令' });
  await assert.rejects(state.form.onSubmit({ note: '' }), /本次没有下发。设备已上报故障/);
  assert.equal(state.refreshes(), 1);
  assert.equal(state.closed(), 0);
  assert.deepEqual(state.messages, []);
  await assert.rejects(state.form.onSubmit({ note: '' }), /本次没有下发/);
  assert.notEqual(state.keys[0], state.keys[1]);
});

test('故障回读发现授权已失效时显示最新状态并关闭过期执行表单', async () => {
  const state = executionForm({ status: 409, code: 'DEVICE_NOT_OPERABLE' }, { status: 'EXPIRED' });
  await state.form.onSubmit({ note: '' });
  assert.equal(state.closed(), 1);
  assert.match(state.messages[0], /本次没有下发.*EXPIRED/);
});

test('设备占用冲突明确显示未下发，不能被当作结果未知', async () => {
  const state = executionForm({ status: 409, code: 'DEVICE_BUSY' });
  await assert.rejects(state.form.onSubmit({ note: '' }), /本次没有下发。设备仍有未完成/);
  assert.equal(state.refreshes(), 1);
  assert.equal(state.closed(), 0);
  assert.deepEqual(state.messages, []);
});

test('未知冲突且无法回读时保留幂等键，不把不确定结果当作设备明确故障', async () => {
  const state = executionForm({ status: 409, code: 'UNEXPECTED_CONFLICT' }, null);
  await assert.rejects(state.form.onSubmit({ note: '' }), /提交结果未确认/);
  await assert.rejects(state.form.onSubmit({ note: '' }), /提交结果未确认/);
  assert.equal(state.keys[0], state.keys[1]);
  assert.equal(state.closed(), 0);
});

for (const channel of ['LINGYUN_B', 'COUNTERMEASURE_4CH']) {
  test(`${channel} 执行只提交已批准参数，不把备注作为设备控制参数`, async () => {
    const state = executionForm(null, { status: 'EXECUTING' }, channel);
    await state.form.onSubmit({ note: '不能下发到设备的自由备注' });
    assert.deepEqual(JSON.parse(JSON.stringify(state.bodies[0])), { expected_version: 1 });
    assert.equal(state.form.fields.some(field => field.key === 'note'), false);
    assert.equal(state.closed(), 1);
    assert.match(state.messages[0], /已下发，等待设备回执/);
  });
}
async function regionalRequest(direct=true) {
  const {randomUUID}=require('node:crypto');
  let form,sequence=0;const sent=[],state={stage:0,checks:0,uncertain:false,blocked:false,current:true};
  const caseId=randomUUID(),oldId=randomUUID(),newId=randomUUID(),device=randomUUID();
  const source=readFileSync(path.join(__dirname,'../src/ui/disposalAuthModal.js'),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/\bexport /g,'');
  const send=async(body,key)=>{sent.push({body:JSON.parse(JSON.stringify(body)),key});if(state.beforeSend)await state.beforeSend(body,key);if(state.sendError)throw state.sendError;if(state.uncertain)throw {status:504,message:'timeout'};return {authorization_id:randomUUID()};};
  const context=vm.createContext({...riskHelpers,openFormModal:value=>{form=value;},closeModal(){},toast(){},
    disposalApi:{directExecute:send,create:send},newDisposalIdempotencyKey:()=>`key-${++sequence}`,
    isDisposalUnavailable:()=>false,isUncertainOutcome:e=>e.status===409||e.status===504||['TIMEOUT','NETWORK_ERROR'].includes(e.code),validPoint:()=>false,
    DISPOSAL_ACTION_LABEL:{COUNTERMEASURE:'反制'},COUNTERMEASURE_MODE_LABEL:{FORCE_LAND:'迫降'},labelOf:(labels,key)=>labels[key]||key});
  vm.runInContext(source,context);
  const options={actionType:'COUNTERMEASURE',subjectKind:'UAV_EVENT',subjectId:oldId,isCurrent:()=>state.current,preparedDevices:{items:[]},
    riskContext:{risk_case_id:caseId,expected_case_version:2},prepareSubmit:async()=>{
      state.checks++;if(state.blocked)throw new Error('当前依据不足，未提交');
      return {subjectId:state.stage?newId:oldId,riskContext:{risk_case_id:caseId,expected_case_version:state.stage+2}};
    }};
  await (direct?context.openDisposalDirect:context.openDisposalRequest)(options);
  return {state,sent,form,oldId,newId,caseId,device,values:{action_type:'COUNTERMEASURE',countermeasure_mode:'FORCE_LAND',channel:'LINGYUN_B',device_id:device,reason:'保留填写事由'}};
}
test('明确确认前重读同风险实际阶段，保留原设备、方式及事由且只提交一次',async()=>{
 for(const direct of [true,false]){
  const f=await regionalRequest(direct);assert.equal(f.state.checks,0);assert.equal(f.sent.length,0);
  f.state.stage=1;await f.form.onSubmit(f.values);
  assert.equal(f.sent.length,1);assert.equal(f.state.checks,1);
  assert.equal(f.sent[0].body.subject_id,f.newId);assert.equal(f.sent[0].body.risk_case_id,f.caseId);
  assert.equal(f.sent[0].body.expected_case_version,3);assert.equal(f.sent[0].body.device_id,f.device);
  assert.equal(f.sent[0].body.reason,f.values.reason);assert.equal(f.sent[0].body.countermeasure_mode,'FORCE_LAND');
 }
});
test('提交结果未知后即使阶段和表单值改变，重试冻结原payload及幂等键',async()=>{
 const f=await regionalRequest();f.state.uncertain=true;
 await assert.rejects(f.form.onSubmit(f.values),/提交结果未确认/);
 f.state.stage=1;
 await assert.rejects(f.form.onSubmit({...f.values,reason:'后来填写',device_id:'different-device'}),/提交结果未确认/);
 assert.equal(f.state.checks,1);assert.equal(f.sent.length,2);
 assert.deepEqual(f.sent[1],f.sent[0]);assert.equal(f.sent[0].body.subject_id,f.oldId);
});
test('提交前真实依据失效时不创建任何授权，恢复后再次明确提交才发送',async()=>{
 const f=await regionalRequest();f.state.blocked=true;
 await assert.rejects(f.form.onSubmit(f.values),/当前依据不足/);assert.equal(f.sent.length,0);
 f.state.blocked=false;f.state.stage=1;await f.form.onSubmit(f.values);
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].body.subject_id,f.newId);assert.equal(f.state.checks,2);
});


test('资格预读后风险阶段变化的确定版本拒绝，下一次人工确认重新读取并换键，不自动重发',async()=>{
 for(const direct of [true,false]){
  const f=await regionalRequest(direct);
  f.state.beforeSend=async body=>{
   // 转实测发生在 prepareSubmit 已返回、请求提交之前。
   if(f.state.stage===0)f.state.stage=1;
   if(body.expected_case_version!==f.state.stage+2)throw {status:409,code:'RISK_CASE_VERSION_CONFLICT',message:'风险阶段或办理状态已更新，请刷新'};
  };
  await assert.rejects(f.form.onSubmit(f.values),error=>{
   assert.doesNotMatch(error.message,/提交结果未确认/);
   assert.match(error.message,/本次没有受理/);return true;
  });
  assert.equal(f.sent.length,1);assert.equal(f.state.checks,1);
  await f.form.onSubmit(f.values);
  assert.equal(f.sent.length,2);assert.equal(f.state.checks,2);
  assert.notEqual(f.sent[1].key,f.sent[0].key);
  assert.equal(f.sent[0].body.subject_id,f.oldId);
  assert.equal(f.sent[1].body.subject_id,f.newId);
  assert.equal(f.sent[1].body.expected_case_version,3);
  assert.equal(f.sent[1].body.risk_case_id,f.caseId);
  for(const field of ['device_id','countermeasure_mode','reason'])assert.equal(f.sent[1].body[field],f.values[field]);
 }
});

for(const error of [{status:408,code:'TIMEOUT'},{status:0,code:'NETWORK_ERROR'},{status:409,code:'UNEXPECTED_CONFLICT'},{status:409,code:'RISK_CASE_CHANGED'}]){
 test(`${error.code} 未知结果继续冻结原主体、版本和幂等键，不误认成风险版本明确拒绝`,async()=>{
  const f=await regionalRequest();f.state.sendError=error;
  await assert.rejects(f.form.onSubmit(f.values),/提交结果未确认/);
  assert.equal(f.sent.length,1);
  f.state.stage=1;
  await assert.rejects(f.form.onSubmit({...f.values,reason:'新填事由',device_id:'other-device'}),/提交结果未确认/);
  assert.equal(f.state.checks,1);assert.equal(f.sent.length,2);
  assert.deepEqual(f.sent[1],f.sent[0]);assert.equal(f.sent[1].body.subject_id,f.oldId);
 });
}


test('同键首次结果未知后收到版本拒绝，不据后一次拒绝撤销原结果未知或换键',async()=>{
 for(const direct of [true,false]){
  const f=await regionalRequest(direct);
  f.state.sendError={status:408,code:'TIMEOUT'};
  await assert.rejects(f.form.onSubmit(f.values),/提交结果未确认/);
  f.state.stage=1;
  f.state.sendError={status:409,code:'RISK_CASE_VERSION_CONFLICT',message:'风险已更新'};
  await assert.rejects(f.form.onSubmit({...f.values,reason:'新事由'}),error=>{
   assert.match(error.message,/此前提交仍未确认/);
   assert.doesNotMatch(error.message,/本次没有受理/);return true;
  });
  await assert.rejects(f.form.onSubmit(f.values),/此前提交仍未确认/);
  assert.equal(f.state.checks,1);assert.equal(f.sent.length,3);
  assert.deepEqual(f.sent[1],f.sent[0]);assert.deepEqual(f.sent[2],f.sent[0]);
 }
});


test('未知提交后重试准备阶段失效，仍保存原请求，不因本次未发送而清除前次未知',async()=>{
 const f=await regionalRequest();f.state.sendError={status:0,code:'NETWORK_ERROR'};
 await assert.rejects(f.form.onSubmit(f.values),/提交结果未确认/);
 f.state.current=false;
 await assert.rejects(f.form.onSubmit(f.values),/提交结果未确认/);
 assert.equal(f.sent.length,1);
 f.state.current=true;f.state.stage=1;
 await assert.rejects(f.form.onSubmit(f.values),/提交结果未确认/);
 assert.equal(f.state.checks,1);assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1],f.sent[0]);
});
