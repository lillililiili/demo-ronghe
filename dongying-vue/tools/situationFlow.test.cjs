#!/usr/bin/env node
/* 融合感知页动作可见性纯函数测试：用 data URL 替换 Vite 别名，仅测试生产源文件。 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; return; }
  failed++;
  console.error(`✗ ${name}\n  期望 ${JSON.stringify(expected)}\n  实到 ${JSON.stringify(actual)}`);
}

async function main() {
  const filename = path.resolve(__dirname, '../src/pages/situation/situationFlow.js');
  const dataUrl = pathToFileURL(path.resolve(__dirname, '../src/services/situationData.js')).href;
  const source = fs.readFileSync(filename, 'utf8')
    .replace(/(?:@\/|\.\.\/\.\.\/)services\/situationData\.js/, dataUrl)
    .replace('../../services/riskCaseView.js', pathToFileURL(path.resolve(__dirname, '../src/services/riskCaseView.js')).href)
    .replace(/(?:@\/|\.\.\/\.\.\/)services\/serverClock\.js/, pathToFileURL(path.resolve(__dirname, '../src/services/serverClock.js')).href);
  const flow = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

  const eo = { typeCode: 'EO', lon: 118.5, lat: 37.4,
    coverage: { kind: 'circle', status: 'available', radiusM: 5000 } };
  const target = { lon: 118.51, lat: 37.4, objectTypeCode: 'UAV', relatedAlarms: [{ eventState: 'CONFIRMED' }] };
  check('目标位于可用 EO 覆盖内时可跟踪', flow.eoCanMonitor(target, [eo]), true);
  check('离线 EO 覆盖不能冒充可跟踪', flow.eoCanMonitor(target, [{ ...eo, coverage: { ...eo.coverage, status: 'unavailable' } }]), false);
  check('干扰执行中不冒充反制', flow.disposalStage({ status: 'EXECUTING', actionType: 'JAMMING' }), 'jamming');
  check('反制执行中不冒充干扰', flow.disposalStage({ status: 'EXECUTING', actionType: 'COUNTERMEASURE' }), 'counter');
  check('处置完成后不再显示误报入口', flow.uavProcessActions({ eventState: 'CONFIRMED', disposalStage: 'countered' }), []);
  check('审批中不显示前端伪成功动作', flow.uavProcessActions({ eventState: 'CONFIRMED', disposalStage: 'requested' }), []);
  check('待核实事件只显示核实', flow.uavProcessActions({ eventState: 'PENDING_VERIFICATION', disposalStage: 'none' }), ['verify']);
  check('核实属实后显示反制候选入口并移除核实', flow.uavProcessActions({ eventState: 'CONFIRMED', disposalStage: 'none' }), ['counter']);
  check('未知状态不开放核实或反制', flow.uavProcessActions({ eventState: 'UNKNOWN', disposalStage: 'none' }), []);
  check('执行中不重复发起反制', flow.uavProcessActions({ eventState: 'CONFIRMED', disposalStage: 'counter' }), []);
  check('已移送不再发起反制', flow.uavProcessActions({ eventState: 'CONFIRMED', handoff: true }), []);
  check('误报事件不再显示动作', flow.uavProcessActions({ eventState: 'FALSE_POSITIVE', disposalStage: 'none' }), []);
  check('处罚交接完成后显示已移送', flow.uavProcessStatus({ eventState: 'CONFIRMED', disposalStage: 'countered', handoff: true }), '已移送处罚');
  check('反制完成不写成已干扰', flow.uavProcessStatus({ eventState: 'CONFIRMED', disposalStage: 'countered' }), '反制已完成');
  check('待核实告警进入融合感知待办', flow.situationAlarmNeedsAttention({ eventState: 'PENDING_VERIFICATION' }), true);
  check('已核实且尚未处置的告警显示待反制', flow.situationAlarmNeedsAttention({ eventState: 'CONFIRMED', disposalStage: 'none' }), true);
  check('已进入处置的告警不重复显示为待反制', flow.situationAlarmNeedsAttention({ eventState: 'CONFIRMED', disposalStage: 'counter' }), false);
  check('已移送告警不重复显示为待办', flow.situationAlarmNeedsAttention({ eventState: 'CONFIRMED', disposalStage: 'none', handoff: true }), false);
  check('航线风险待办只显示待通知', flow.situationRouteRiskNeedsAttention({ active: true, state: 'PENDING_NOTIFICATION' }), true);
  check('航线待核验风险不进入待通知列表', flow.situationRouteRiskNeedsAttention({ active: true, state: 'PENDING_VERIFICATION' }), false);
  check('失去当前依据的待通知风险不进入列表', flow.situationRouteRiskNeedsAttention({ active: false, state: 'PENDING_NOTIFICATION' }), false);
  check('待通知航线风险进入融合感知列表', flow.situationRouteRiskVisible({
    state: 'PENDING_NOTIFICATION', riskType: 'SPACE_OBJECT', planId: 'p1', routeVersionId: 'rv1'
  }), true);
  check('待核验航线风险进入融合感知列表', flow.situationRouteRiskVisible({
    state: 'PENDING_VERIFICATION', riskType: 'SPACE_OBJECT', planId: 'p1', routeVersionId: 'rv1'
  }), true);
  check('过期但未核验的风险保留列表入口，不冒充当前地图风险', flow.situationRouteRiskVisible({
    state: 'PENDING_VERIFICATION', riskType: 'FOREIGN_OBJECT', planId: 'p2', routeVersionId: 'rv2',
    active: false, mapVisible: false, currentStatus: 'UNKNOWN'
  }), true);
  for (const state of ['NOTIFIED', 'ACKNOWLEDGED', 'EXCLUDED', 'UNKNOWN']) {
    check(`${state} 不混入待处理航线风险`, flow.situationRouteRiskVisible({
      state, riskType: 'SPACE_OBJECT', planId: 'p2', routeVersionId: 'rv2'
    }), false);
  }
  check('没有航线关联的风险不进入航线风险列表', flow.situationRouteRiskVisible({
    state: 'PENDING_VERIFICATION', riskType: 'SPACE_OBJECT', planId: 'p1'
  }), false);

  const S = await import(dataUrl);
  for (const [sourceMode, displayMode, expected] of [['replay','mock',true],['replay','replay',false],['live','live',false]]) {
    const mapped=S.toRisks([{risk_id:`mode-${sourceMode}-${displayMode}`,source_mode:sourceMode,source_display_mode:displayMode}])[0];
    check(`风险来源标识遵循后端展示契约 ${sourceMode}/${displayMode}`,[mapped.simulated,mapped.sourceMode],[expected,sourceMode]);
  }
  const { groupRouteRisks } = await import(pathToFileURL(path.resolve(__dirname, '../src/pages/situation/routeRiskGroups.js')).href);
  const { riskSnapshotMarkers } = await import(pathToFileURL(path.resolve(__dirname, '../src/pages/situation/riskSnapshotMarkers.js')).href);
  const { randomUUID } = require('node:crypto');
  for (const [index, sourceMode] of ['live', 'mock', 'replay'].entries()) {
    const now = Date.now() + index * 86400000;
    const plan = { planId: randomUUID(), routeVersionId: randomUUID(), statusCode: 'EXECUTING', startAt: now - 60000, endAt: now + 60000 };
    const target = { targetId: randomUUID(), sourceMode, posValid: true, observedAt: now - 1000, mapExpiresAt: now + 10000, lon: 110 + index, lat: 32 + index };
    const risk = { riskId: randomUUID(), riskType: 'SPACE_OBJECT', state: 'PENDING_VERIFICATION', currentStatus: 'CURRENT',
      planId: plan.planId, routeVersionId: plan.routeVersionId, targetInternalId: target.targetId, sourceMode };
    const visible = (r = risk, p = plan, t = target, at = now) => flow.situationRouteRiskIsCurrent(r, p, t, at);
    check(`${sourceMode} 当前任务有效观测且后端确认持续才显示`, visible(), true);
    for (const state of ['PENDING_NOTIFICATION','NOTIFIED','ACKNOWLEDGED']) check(`${sourceMode} ${state} 不等于解除`, visible({ ...risk, state }), true);
    for (const currentStatus of ['UNKNOWN','CLEARED','EXPIRED','NOT_STARTED','EXCLUDED','',undefined]) {
      check(`${sourceMode} ${String(currentStatus)} 不冒充当前航线风险`, visible({ ...risk, currentStatus }), false);
    }
    check(`${sourceMode} 已排除不因旧CURRENT再次显示`, visible({ ...risk, state: 'EXCLUDED' }), false);
    for (const statusCode of ['COMPLETED','CANCELLED','UNKNOWN']) check(`${sourceMode} ${statusCode} 任务不显示当前风险`, visible(risk,{ ...plan,statusCode }),false);
    check(`${sourceMode} 未开始的任务不显示`, visible(risk,{ ...plan,startAt:now+1 }),false);
    check(`${sourceMode} 开始边界纳入`, visible(risk,{ ...plan,startAt:now }),true);
    check(`${sourceMode} 结束边界退出`, visible(risk,{ ...plan,endAt:now }),false);
    check(`${sourceMode} 缺任务时段不补默认`, visible(risk,{ ...plan,startAt:null }),false);
    check(`${sourceMode} 缺计划读取权限不以旧计划ID推算`, visible(risk,null),false);
    check(`${sourceMode} 不串同名不同航线版本`, visible(risk,{ ...plan,routeVersionId:randomUUID() }),false);
    check(`${sourceMode} 不串同航线不同任务`, visible(risk,{ ...plan,planId:randomUUID() }),false);
    check(`${sourceMode} 停报到期边界退出`, visible(risk,plan,target,target.mapExpiresAt),false);
    check(`${sourceMode} 缺目标读取权限不恢复发现点`, visible(risk,plan,null),false);
    for (const patch of [{ posValid:false },{ stale:true },{ historical:true },{ statusCode:'LOST' },{ mapExpiresAt:null },{ observedAt:now+1 },{ sourceMode:'other-source' },{ targetId:randomUUID() }]) {
      check(`${sourceMode} 无当前同源依据 ${JSON.stringify(patch)}`, visible(risk,plan,{ ...target,...patch }),false);
    }
    // 当天早些时候/跨日发生本身不决定现在是否有风险；只认当前投影和有效观测。
    check(`${sourceMode} 发生时间不代替当前影响判断`, visible({ ...risk, occurredAt:now-2*86400000 }),true);
    const raw={targets:[target],risks:[risk],alarms:[]};
    const expired=S.currentMapSnapshot(raw,target.mapExpiresAt);
    check(`${sourceMode} 停报不修改原风险办理状态`,[expired.risks[0].state,raw.risks[0].currentStatus],['PENDING_VERIFICATION','CURRENT']);
  }
  // 实际页面：气球与鸟群共用当前筛选，列表、数字与地图随任务和观测到期退出。
  const vue=require('vue'); let clock=Date.now(); const intervals=[],mounts=[];
  const script=fs.readFileSync(path.resolve(__dirname,'../src/pages/SituationPage.vue'),'utf8')
    .split('<script setup>')[1].split('</script>')[0].replace(/import[\s\S]*?from ['"][^'"]+['"];?\r?\n/g,'');
  const labels=await import(pathToFileURL(path.resolve(__dirname,'../src/ui/labels.js')).href);
  const handoff=await import(pathToFileURL(path.resolve(__dirname,'../src/ui/punishmentHandoffProgress.js')).href);
  const prediction=await import(pathToFileURL(path.resolve(__dirname,'../src/services/predictionView.js')).href);
  const eoCoverage=await import(pathToFileURL(path.resolve(__dirname,'../src/pages/situation/eoCoverage.js')).href);
  const eoSelection=await import(pathToFileURL(path.resolve(__dirname,'../src/pages/situation/eoSelection.js')).href);
  const riskHelpers = await import(pathToFileURL(path.resolve(__dirname, '../src/services/riskCaseView.js')).href);
  const deps={...riskHelpers,...vue,...S,...flow,...labels,...handoff,...prediction,...eoCoverage,...eoSelection,groupRouteRisks,riskSnapshotMarkers,serverNow:()=>clock,
    currentMapSnapshot:value=>S.currentMapSnapshot(value,clock),
    usePageChrome(){},useRoute:()=>({query:{}}),authSession:vue.ref('test-session'),watch(){},onMounted:cb=>mounts.push(cb),onUnmounted(){},
    createSituationApiSource:()=>({start:()=>()=>{},loadTargetDetail:async()=>{}}),
    createSituationMarkerLayout:()=>()=>[],ResizeObserver:class{observe(){}},document:{hidden:false,addEventListener(){}},
    sessionStorage:{getItem:()=>null,setItem(){}},window:{UI:{icon:()=>''},setInterval:cb=>intervals.push(cb),
      MapView:class{setData(){} clearPinnedHit(){} draw(){} pinHit(){} }}};
  const page=new Function(...Object.keys(deps),script+'\nreturn {applySnapshot,riskGroups,riskSnapshots,activeRiskCount,alarms,selection,selectedRiskGroup};')(...Object.values(deps));
  const plan={planId:randomUUID(),routeVersionId:randomUUID(),statusCode:'EXECUTING',startAt:clock-10000,endAt:clock+10000};
  const t={id:randomUUID(),targetId:randomUUID(),sourceMode:'live',posValid:true,observedAt:clock-1000,mapExpiresAt:clock+50000};
  const risk={riskId:randomUUID(),planId:plan.planId,routeVersionId:plan.routeVersionId,targetInternalId:t.targetId,sourceMode:'live',
    riskType:'SPACE_OBJECT',state:'NOTIFIED',currentStatus:'CURRENT',occurredAt:clock-1000,spaceFact:{longitude:114.2,latitude:32.5,subtypeCode:'BALLOON'}};
  const birdPlan={...plan,planId:randomUUID(),routeVersionId:randomUUID()};
  const birdTarget={...t,id:randomUUID(),targetId:randomUUID(),sourceMode:'replay'};
  const birdRisk={...risk,riskId:randomUUID(),planId:birdPlan.planId,routeVersionId:birdPlan.routeVersionId,
    targetInternalId:birdTarget.targetId,sourceMode:'replay',simulated:true,state:'PENDING_VERIFICATION',
    spaceFact:{longitude:116.8,latitude:31.2,subtypeCode:'BIRD_FLOCK',subtypeName:'鸟群',count:25}};
  const raw={generatedAt:clock,targets:[t,birdTarget],risks:[risk,birdRisk],alarms:[{alarmId:randomUUID(),targetInternalId:t.targetId,eventState:'PENDING_VERIFICATION'}],flightPlans:[plan,birdPlan],devices:[],handoffs:[]};
  mounts.forEach(cb=>cb());page.applySnapshot(raw);
  check('当前风险总数包含目标异常、气球与鸟群',[page.activeRiskCount.value,page.alarms.value.length,page.riskGroups.value.length,page.riskSnapshots.value.length],[3,1,2,2]);
  check('气球与鸟群同时进入航线风险分组',page.riskGroups.value.map(g=>g.spaceFact.subtypeCode).sort(),['BALLOON','BIRD_FLOCK']);
  const birdMarker=page.riskSnapshots.value.find(row=>row.subtypeCode==='BIRD_FLOCK');
  check('鸟群地图使用自身风险坐标并标明模拟',[birdMarker?.anchor,birdMarker?.simulated],[[116.8,31.2],true]);
  page.applySnapshot({...raw,risks:[risk]});
  check('只有鸟类目标没有风险事实时不凭类别补造风险',page.riskGroups.value.length,1);
  page.applySnapshot({...raw,targets:[t,{...birdTarget,mapExpiresAt:clock}]});
  check('鸟群观测到期独立退出列表和地图',[page.riskGroups.value.length,page.riskSnapshots.value.length],[1,1]);
  page.applySnapshot({...raw,risks:[risk,{...birdRisk,currentStatus:'UNKNOWN'}]});
  check('鸟群后端当前依据未知时不复活旧发现点',[page.riskGroups.value.length,page.riskSnapshots.value.length],[1,1]);
  page.applySnapshot(raw);
  page.selection.value={kind:'risk-group',id:page.riskGroups.value[0].groupId};
  clock=plan.endAt+5000; intervals[0]();
  check('任务到期即使定时器延迟仍同步退出列表、地图和详情',[page.riskGroups.value.length,page.riskSnapshots.value.length,page.selection.value],[0,0,null]);
  clock=t.mapExpiresAt+5000;intervals[0]();
  check('停报到期后目标异常也从实时列表退出',page.activeRiskCount.value,0);
  check('展示退出不修改通知状态',raw.risks[0].state,'NOTIFIED');

  console.log(failed ? `\n${passed} 条通过，${failed} 条失败` : `全部通过：${passed} 条`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => { console.error(error); process.exit(1); });
