const riskHelpers = require('./riskCaseTestHelpers.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function verificationForm(event, verify, alarm = {}, dependencies = {}) {
  let form; const forms=[],handles=[],notices=[];
  const captureForm = value => { form = value; forms.push(value); const handle={current:true,isCurrent:()=>handle.current,close:()=>{handle.current=false;}}; handles.forEach(old=>old.current=false); handles.push(handle); return handle; };
  const source = readFileSync(path.join(__dirname, '../src/ui/uavVerificationModal.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
  const context = vm.createContext({ ...riskHelpers,
    openFormModal: captureForm, openModal: options => captureForm(options.render().props.form),
    h: (component,props)=>({component,props}), RiskVerificationForm: {}, shallowRef: value=>({value}), readSessionToken:()=> 'session',
    setTimeout,clearTimeout, getUavRiskCase:async()=>({risk_case:alarm.risk_case,event,alarm:{alarm_id:'a1',alarm_no:'AL-1',target_id:'t1',...alarm}}),
    closeModal() {}, toast:message=>notices.push(message), crypto: globalThis.crypto,
    verifyUavRiskCase: verify, verifyUavEvent: verify, isUncertainOutcome: error => !!error && (error.status === 409 || error.code === 'TIMEOUT'),
    ALARM_TYPE_LABEL: {}, labelOf: () => '', readableNo: value => value || '', serverNow: () => Date.now(), ...dependencies
  });
  vm.runInContext(readFileSync(path.join(__dirname, '../src/ui/deviceNumber.js'), 'utf8').replace(/\bexport /g, ''), context);
  vm.runInContext(readFileSync(path.join(__dirname, '../src/services/predictionView.js'), 'utf8').replace(/\bexport /g, ''), context);
  vm.runInContext(readFileSync(path.join(__dirname, '../src/services/uavRiskVerificationSession.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, ''), context);
  vm.runInContext(source, context);
  const opened = context.openUavVerification({ event, alarm: { alarm_id: 'a1', alarm_no: 'AL-1', target_id: 't1', ...alarm } });
  return { form, opened, forms, handles, notices };
}

const pending = patch => ({ event_id: 'e1', version: 3, state: 'PENDING_VERIFICATION', allowed_actions: ['VERIFY'], ...patch });

test('缺少核实依据时“属实”不可选并说明原因，误报照常提交', async () => {
  const submitted = [];
  const { form, opened } = verificationForm(pending({
    verification_basis: { confirmable: false, missing: ['NO_CURRENT_DATA'], checked_at: 1,
      message: '缺少依据，不能核实为属实：目标已超过 120 秒没有上报<img src=x>。' }
  }), async (id, body) => { submitted.push({ id, body }); return { state: 'FALSE_POSITIVE' }; });
  assert.equal(opened, true);
  assert.match(form.warning, /缺少依据，不能核实为属实：目标已超过 120 秒没有上报/);
  assert.equal(form.warning.includes('<img'), false, '服务端文案按文本显示');
  const confirmed = form.fields[0].options.find(option => option.value === 'CONFIRMED');
  assert.equal(confirmed.disabled, true);
  assert.match(confirmed.label, /缺少依据/);
  assert.equal(form.initial.conclusion, undefined, '不预选结论');
  assert.match(form.validate({ conclusion: 'CONFIRMED' }), /缺少依据/);
  assert.equal(form.validate({ conclusion: 'FALSE_POSITIVE' }), '', '核实说明为选填');
  assert.match(form.validate({ conclusion: 'FALSE_POSITIVE', note: '字'.repeat(1001) }), /不能超过1000字/);
  assert.equal(form.validate({ conclusion: 'FALSE_POSITIVE', note: '已核对关联观测与证据' }), '');
  await form.onSubmit({ conclusion: 'FALSE_POSITIVE', note: '已核对关联观测与证据' });
  assert.equal(submitted[0].id, 'e1');
  assert.equal(submitted[0].body.conclusion, 'FALSE_POSITIVE');
  assert.equal(submitted[0].body.expected_version, 3);
  assert.equal(submitted[0].body.note, '已核对关联观测与证据');
});

test('依据齐全或接口未返回依据时保持原来的属实预选', () => {
  for (const basis of [undefined, null, { confirmable: true, missing: [], message: '', checked_at: 1 }]) {
    const { form } = verificationForm(pending({ verification_basis: basis }), async () => ({}));
    assert.equal(form.warning, '');
    assert.match(form.introHtml, /<dt>当前状态<\/dt><dd>待人工核实<\/dd>/, '无风险记录的原事件口径保持');
    assert.equal(form.fields[0].options[0].disabled, false);
    assert.equal(form.initial.conclusion, 'CONFIRMED');
    assert.equal(form.validate({ conclusion: 'CONFIRMED' }), '', '核实说明为选填');
    assert.match(form.validate({ conclusion: 'CONFIRMED', note: '字'.repeat(1001) }), /不能超过1000字/);
    assert.equal(form.validate({ conclusion: 'CONFIRMED', note: '核对当前观测和明确违规研判' }), '');
  }
});

test('提交时服务端判定缺依据（422）按明确失败说明原因，下次提交换新幂等键', async () => {
  const keys = [];
  const { form } = verificationForm(pending(), async (id, body, key) => {
    keys.push(key);
    throw Object.assign(new Error('缺少依据，不能核实为属实：本次告警还没有合法性研判。'), { status: 422, code: 'VERIFICATION_BASIS_MISSING' });
  });
  await assert.rejects(form.onSubmit({ conclusion: 'CONFIRMED' }), /本次告警还没有合法性研判/);
  await assert.rejects(form.onSubmit({ conclusion: 'CONFIRMED' }), /缺少依据/);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});


test('预测核实绑定事件返回的快照及事件版本，不用列表旧快照替换', async () => {
  const sent = [];
  const { form } = verificationForm(pending({ verification_basis: { confirmable: true, prediction_id: 'prediction-current' } }),
    async (id, body) => { sent.push(body); return { state: 'CONFIRMED' }; },
    { origin_kind: 'PREDICTED_AIRSPACE_ENTRY', prediction: { prediction_id: 'prediction-old', status: 'READY', based_on_observed_at: Date.now() - 500, valid_until: Date.now() + 60000, warning: { state: 'ACTIVE' } } });
  assert.match(form.fields[0].options[0].label, /预测风险成立/);
  await form.onSubmit({ conclusion: 'CONFIRMED' });
  assert.equal(sent[0].prediction_id, 'prediction-current');
  assert.equal(sent[0].expected_version, 3);
});

test('预测依据缺失时不能确认，且不预选属实；普通核实仍不发送预测字段', async () => {
  const { form } = verificationForm(pending(), async () => ({}), { origin_kind: 'PREDICTED_AIRSPACE_ENTRY' });
  assert.equal(form.fields[0].options[0].disabled, true);
  assert.equal(form.initial.conclusion, undefined);
  assert.match(form.warning, /预测快照/);
  let body;
  const ordinary = verificationForm(pending(), async (id, value) => { body = value; return { state: 'CONFIRMED' }; });
  await ordinary.form.onSubmit({ conclusion: 'CONFIRMED' });
  assert.equal(Object.hasOwn(body, 'prediction_id'), false);
});


test('预测终态不打开核实弹窗，UNKNOWN和打开时过期只允许误报，同周期快照交服务端重验', async () => {
  for (const state of ['WITHDRAWN', 'ENTERED', 'UNKNOWN']) {
    const submitted = [];
    const alarm = { origin_kind: 'PREDICTED_AIRSPACE_ENTRY', prediction: { prediction_id: `prediction-${state}`, status: 'READY',
      based_on_observed_at: Date.now() - 500, valid_until: Date.now() + 60000, warning: { state } } };
    const { form, opened } = verificationForm(pending({ verification_basis: { confirmable: true, prediction_id: `prediction-${state}` } }),
      async (id, body) => { submitted.push(body); return { state: 'FALSE_POSITIVE' }; }, alarm);
    if (state !== 'UNKNOWN') { assert.equal(opened, false); assert.equal(form, undefined); continue; }
    assert.equal(form.fields[0].options[0].disabled, true);
    assert.equal(form.initial.conclusion, undefined);
    assert.match(form.warning, /不能提交预测风险属实/);
    await assert.rejects(form.onSubmit({ conclusion: 'CONFIRMED' }), /不能提交预测风险属实/);
    assert.equal(submitted.length, 0);
    await form.onSubmit({ conclusion: 'FALSE_POSITIVE' });
    assert.equal(submitted[0].conclusion, 'FALSE_POSITIVE');
  }
  const alarm = { origin_kind: 'PREDICTED_AIRSPACE_ENTRY', prediction: { prediction_id: 'expires-after-open', status: 'READY',
    based_on_observed_at: Date.now() - 500, valid_until: Date.now() + 60000, warning: { state: 'ACTIVE' } } };
  const submitted = [];
  const { form } = verificationForm(pending(), async (id, body) => submitted.push(body), alarm);
  assert.equal(form.fields[0].options[0].disabled, false);
  alarm.prediction.valid_until = Date.now() - 1;
  // 已打开的核实仍提交当时选择的快照，由服务端验证当前同周期依据，不因每秒刷新重新要求操作人选择。
  await form.onSubmit({ conclusion: 'CONFIRMED' });
  assert.equal(submitted[0].prediction_id, 'expires-after-open');
  const expired = verificationForm(pending(), async () => { throw new Error('不应请求'); }, alarm);
  assert.equal(expired.form.fields[0].options[0].disabled, true);
  assert.match(expired.form.validate({ conclusion: 'CONFIRMED' }), /不能提交预测风险属实/);
  await assert.rejects(expired.form.onSubmit({ conclusion: 'CONFIRMED' }), /不能提交预测风险属实/);
});

test('统一风险核实提交风险与事件版本，已核实持续风险不重复核实', async () => {
  const submitted = [], risk_case = { risk_case_id: 'case-region-one', version: 7, stage: 'ENTERED', verification_status: 'PENDING_VERIFICATION' };
  const { form } = verificationForm(pending(), async (id, body) => { submitted.push({ id, body }); return { state: 'CONFIRMED' }; }, { risk_case });
  await form.onSubmit({ conclusion: 'CONFIRMED', note: '' });
  assert.equal(submitted[0].id, risk_case.risk_case_id);
  assert.equal(submitted[0].body.expected_case_version, 7);
  assert.equal(submitted[0].body.expected_version, 3);
  const verified = verificationForm(pending(), async () => { throw new Error('不应重复提交'); }, { risk_case: { ...risk_case, verification_status: 'CONFIRMED' } });
  assert.equal(verified.opened, false);
});

test('统一风险核实优先当前区域资格，实测及未知不误用旧预测终态', async () => {
  for (const source_mode of ['live', 'replay']) {
    const submissions = [], risk_case = { risk_case_id: `region-${source_mode}`, version: 9, stage: 'ENTERED',
      verification_status: 'PENDING_VERIFICATION', allowed_actions: ['VERIFY'] };
    const alarm = { source_mode, risk_case, origin_kind: 'PREDICTED_AIRSPACE_ENTRY', prediction: { warning: { state: 'ENTERED' } } };
    const event = pending({ allowed_actions: [], verification_basis: { confirmable: true }, origin_kind: 'PREDICTED_AIRSPACE_ENTRY' });
    const entered = verificationForm(event, async (id, body) => { submissions.push({ id, body }); return { state: 'CONFIRMED' }; }, alarm);
    assert.equal(entered.opened, true); assert.equal(entered.form.fields[0].options[0].disabled, false);
    assert.match(entered.form.fields[0].options[0].label, /风险属实/);
    assert.match(entered.form.introHtml, /<dt>当前状态<\/dt><dd>待核实<\/dd>/);
    assert.match(entered.form.title, /^人工核实/, '手工操作弹窗标题保持');
    const forecast = verificationForm(event, async () => ({}), { ...alarm, prediction: { warning: { state: 'ACTIVE' } }, risk_case: { ...risk_case, stage: 'PREDICTED' } });
    assert.match(forecast.form.introHtml, /<dt>当前状态<\/dt><dd>待人工核实<\/dd>/);
    await entered.form.onSubmit({ conclusion: 'CONFIRMED' });
    assert.equal(submissions[0].id, risk_case.risk_case_id); assert.equal(submissions[0].body.expected_case_version, 9);
    assert.equal(Object.hasOwn(submissions[0].body, 'prediction_id'), false);
    const unknown = verificationForm(event, async () => ({}), { ...alarm, risk_case: { ...risk_case, stage: 'UNKNOWN' } });
    assert.equal(unknown.opened, true); assert.equal(unknown.form.fields[0].options[0].disabled, true);
    await assert.rejects(unknown.form.onSubmit({ conclusion: 'CONFIRMED' }), /当前风险依据不足/);
    const denied = verificationForm(pending(), async () => ({}), { ...alarm, risk_case: { ...risk_case, allowed_actions: [] } });
    assert.equal(denied.opened, false);
  }
});

test('核实弹窗轻量重读未知转有效，原表单绑定最新case/event/预测依据',async()=>{
  const id=crypto.randomUUID(),target=crypto.randomUUID(),area=crypto.randomUUID(),sent=[],reads=[];
  const risk={risk_case_id:id,version:4,stage:'PREDICTED',airspace_id:area,verification_status:'PENDING_VERIFICATION',allowed_actions:['VERIFY']};
  const alarm={target_id:target,source_mode:'replay',origin_kind:'PREDICTED_AIRSPACE_ENTRY',risk_case:risk,
    prediction:{status:'UNKNOWN',warning:{state:'UNKNOWN'}}};
  const newPrediction=crypto.randomUUID();
  const latest={risk_case:{...risk,version:5},alarm:{...alarm,prediction:{prediction_id:newPrediction,status:'READY',based_on_observed_at:Date.now(),valid_until:Date.now()+3000,warning:{state:'ACTIVE'}}},
    event:pending({version:9,verification_basis:{confirmable:true,prediction_id:newPrediction}})};
  const f=verificationForm(pending({verification_basis:{confirmable:false}}),async(id,body)=>{sent.push({id,body});return{};},alarm,
    {getUavRiskCase:async(id,params)=>{reads.push({id,params});return latest;}});
  assert.equal(f.form.fields[0].options[0].disabled,true);
  await f.form.onRefresh({note:'已查看实时视频',conclusion:'FALSE_POSITIVE'});
  const fresh=f.forms[0];assert.equal(f.forms.length,1);assert.equal(fresh.fields[0].options[0].disabled,false);
  assert.equal(fresh.initial.conclusion,undefined,'初始缺依据不替人预选；受控表单保持用户输入');
  assert.equal(reads[0].id,id);assert.equal(reads[0].params.purpose,'verification');
  await fresh.onSubmit({conclusion:'CONFIRMED',note:'已查看实时视频'});
  assert.equal(sent[0].id,id);assert.equal(sent[0].body.expected_case_version,5);assert.equal(sent[0].body.expected_version,9);
  assert.equal(sent[0].body.prediction_id,newPrediction);
});
test('核实重读不延长过期依据，转实测按最新资格，已AUTO不重新打开',async()=>{
  for(const stage of ['PREDICTED','ENTERED','AUTO']) {
    const id=crypto.randomUUID(),risk={risk_case_id:id,stage:'PREDICTED',version:2,verification_status:'PENDING_VERIFICATION',allowed_actions:['VERIFY']};
    const alarm={target_id:'t1',risk_case:risk,origin_kind:'PREDICTED_AIRSPACE_ENTRY'};
    const latestRisk={...risk,stage:stage==='PREDICTED'?stage:'ENTERED',version:3,
      verification_status:stage==='AUTO'?'CONFIRMED':'PENDING_VERIFICATION',allowed_actions:stage==='AUTO'?[]:['VERIFY']};
    const f=verificationForm(pending(),async()=>({}),alarm,{getUavRiskCase:async()=>({risk_case:latestRisk,
      alarm:{...alarm,prediction:{prediction_id:'expired',status:'READY',based_on_observed_at:Date.now()-9000,valid_until:Date.now()-1,warning:{state:'ACTIVE'}}},
      event:pending({version:4,verification_basis:{confirmable:true,prediction_id:'expired'}})})});
    await f.form.onRefresh({note:'review'});
    assert.equal(f.forms.length,1,'始终保留同一个表单');
    assert.equal(f.forms[0].fields[0].options[0].disabled,stage!=='ENTERED');
    if(stage==='AUTO') assert.match(f.forms[0].warning,/已核实/);
  }
});
test('关闭核实窗后迟到重读不再打开；来源或区域不符仍停留原表单',async()=>{
  for(const change of ['close','area','source']) {
    let resolve;const risk={risk_case_id:crypto.randomUUID(),airspace_id:crypto.randomUUID(),stage:'ENTERED',version:2,verification_status:'PENDING_VERIFICATION',allowed_actions:['VERIFY']};
    const alarm={target_id:'t1',source_mode:'live',risk_case:risk};
    const f=verificationForm(pending(),async()=>({}),alarm,{getUavRiskCase:()=>new Promise(done=>resolve=done)});
    const request=f.form.onRefresh({note:'keep'});
    const result={risk_case:{...risk},alarm:{...alarm},event:pending()};
    if(change==='close')f.handles[0].close();
    if(change==='area')result.risk_case.airspace_id=crypto.randomUUID();
    if(change==='source')result.alarm.source_mode='replay';
    resolve(result);
    if(change==='close')await request;else await assert.rejects(request,/不一致/);
    assert.equal(f.forms.length,1);
  }
});

test('实际受控核实表单重读期间立即禁重复与提交，错误保留人工说明',async()=>{
  const vue=require('vue');let reject,reads=0,submits=0;
  const props={fields:[],initial:{note:'已看视频'},onRefresh:()=>{reads++;return new Promise((_resolve,fail)=>reject=fail);},onSubmit:()=>submits++};
  const source=readFileSync(path.join(__dirname,'../src/components/modals/ControlledFormModal.vue'),'utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?\n/gm,'');
  const deps={...vue,defineProps:()=>props};const scope=vue.effectScope();
  try{
    const form=scope.run(()=>new Function(...Object.keys(deps),source+';return {refreshBasis,submit,busy,canSubmit,model,error};')(...Object.values(deps)));
    const waiting=form.refreshBasis();assert.equal(form.busy.value,true);assert.equal(form.canSubmit.value,false);
    await form.refreshBasis();await form.submit();assert.equal(reads,1);assert.equal(submits,0);
    reject(new Error('当前依据读取超时'));await waiting;
    assert.equal(form.error.value,'当前依据读取超时');assert.equal(form.model.note,'已看视频');assert.equal(form.busy.value,false);
  }finally{scope.stop();}
});
