import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { disposalStatusText } from '../src/ui/labels.js';
import { nextStep, resultText } from '../src/pages/alarms/authorizationQueueView.js';
import { counterProgressView } from '../src/components/disposal/counterProgressView.js';

test('启动资格拦截使用明确结果码，不改历史状态也不假定旧指令均未发送',()=>{
 for(const channel of ['LINGYUN_B','COUNTERMEASURE_4CH']){
  const row={authorization_id:randomUUID(),status:'FAILED',result_code:'AUTHORIZATION_STOPPED',channel,action_type:'COUNTERMEASURE'};
  const before=JSON.stringify(row);
  assert.equal(disposalStatusText(row),'启动被拦截');assert.equal(nextStep(row),'启动被拦截，请查看阻断原因');
  assert.match(resultText(row),/阻断原因与设备反馈/);assert.doesNotMatch(resultText(row),/尚未下发|未发送|设备没有启动/);
  const progress=counterProgressView(row,[{event_kind:'EXECUTE',occurred_at:Date.now()}]);
  assert.equal(progress.status,'启动被拦截');assert.match(progress.startText,/已下发启动指令/);
  assert.equal(JSON.stringify(row),before);
  const detail='启动指令尚未下发，已取消：当前依据不足';
  assert.equal(resultText({...row,result_detail:detail}),detail,'只有服务端证明的具体说明可以声称未下发');
 }
});

test('邻近设备失败、超时及非失败状态不改成启动拦截',()=>{
 for(const result_code of ['DEVICE_FAILED','ADAPTER_TIMEOUT','DEVICE_TIMED_OUT',undefined]){
  const row={status:'FAILED',result_code,channel:'COUNTERMEASURE_4CH',action_type:'COUNTERMEASURE',result_detail:'文本提到 AUTHORIZATION_STOPPED'};
  assert.equal(disposalStatusText(row),'执行失败');assert.doesNotMatch(nextStep(row),/启动被拦截/);
  assert.equal(counterProgressView(row,null).status,'执行失败');
  if(result_code?.includes('TIME'))assert.match(resultText(row),/超时不代表设备未执行/);
 }
 assert.equal(disposalStatusText({status:'EXECUTING',result_code:'AUTHORIZATION_STOPPED'}),'执行中');
 assert.doesNotMatch(resultText({status:'EXECUTING',result_code:'AUTHORIZATION_STOPPED'}),/启动资格/);
});
