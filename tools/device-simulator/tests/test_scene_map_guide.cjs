const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Guide = require('../web/scene-map-guide.js');
const ZoneRings = require('../web/zone-rings.js');

function guide(shift = 0, variant = 'avoid') {
  return {title: '场景路线导读', compactPaths: true,
    markers: [
      {id: `start-${shift}`, role: 'start', label: '① 起点', point: [100 + shift, 180]},
      {id: `action-${shift}`, role: variant === 'avoid' ? 'turn' : 'entry',
        label: variant === 'avoid' ? '② 转向避开' : '② 进入禁飞区', point: [340 + shift, 180]},
      {id: `end-${shift}`, role: 'end', label: variant === 'avoid' ? '③ 区外终点' : '③ 区内停留',
        point: [variant === 'avoid' ? 240 + shift : 460 + shift, variant === 'avoid' ? 80 : 180]}
    ], directions: [{from: [180 + shift, 180], to: [260 + shift, 180]},
      {from: [340 + shift, 180], to: [variant === 'avoid' ? 280 + shift : 420 + shift, variant === 'avoid' ? 120 : 180]}]
  };
}
const count = (text, pattern) => (text.match(pattern) || []).length;
const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test('explicit guide roles render at projected coordinates without changing scene data or relying on object IDs', () => {
  for (const [shift, variant] of [[0, 'avoid'], [70, 'enter']]) {
    const raw = guide(shift, variant), before = JSON.stringify(raw);
    const project = ([x, y]) => [x * 1.2, y + 20];
    const result = Guide.layout(raw, project, {width: 900, height: 400});
    assert.equal(result.markers.length, 3); assert.equal(result.directions.length, 2);
    assert.deepEqual(result.markers.map(row => row.anchor), raw.markers.map(row => project(row.point)));
    assert.equal(result.directions[0].angle, 0);
    assert.equal(result.directions[1].angle < -90, variant === 'avoid');
    const svg = Guide.render(raw, project, {width: 900, height: 400});
    for (const marker of raw.markers) assert.ok(svg.includes(marker.label));
    assert.equal(count(svg, /class="scene-guide-marker /g), 3);
    assert.equal(count(svg, /class="scene-guide-direction"/g), 2);
    assert.match(svg, /场景预设/); assert.match(svg, /pointer-events="none"/);
    assert.doesNotMatch(svg, /data-action=|data-id=|data-device|flow-9/);
    assert.equal(JSON.stringify(raw), before);
  }
});

test('unknown or malformed guide data is ignored and label text is escaped', () => {
  for (const value of [null, undefined, false, 'guide', [], {}, {compactPaths: true}, {markers: 'invalid'},
    {markers: [{id: 'bad', role: 'automatic-counter', label: 'not allowed', point: [1, 2]}]},
    {markers: [{id: 'bad', role: 'start', label: 'bad point', point: [null, 2]}]},
    {markers: [{id: 'bad', role: 'start', label: 'bad point', point: ['1', 2]}]},
    {markers: [{id: 'bad', role: 'start', label: 'bad point', point: [Infinity, 2]}]},
    {directions: [{from: [10, 10], to: [10, 10]}]}]) {
    assert.equal(Guide.normalize(value), null);
    assert.equal(Guide.render(value, p => p), '');
  }
  const raw = guide(); raw.title = '<title onload="bad">'; raw.markers[0].label = '<img src=x onerror=bad>';
  raw.markers.push({id: 'bad', role: 'unknown', label: '跳过', point: [200, 200]});
  const svg = Guide.render(raw, p => p);
  assert.match(svg, /&lt;img/); assert.match(svg, /&lt;title onload=&quot;bad&quot;&gt;/);
  assert.doesNotMatch(svg, /<img|<title onload=|跳过/);
  const projectionFailure = p => p[0] === 100 ? [NaN, p[1]] : [p[0], p[1]];
  assert.equal(Guide.layout(guide(), projectionFailure).markers.length, 2);
  assert.equal(Guide.render(guide(), () => { throw Error('projection unavailable'); }), '');
});

test('guide labels avoid nearby device and target boxes, stay within the viewport, and do not move their actual points', () => {
  for (const shift of [0, 75]) {
    const raw = guide(shift), first = raw.markers[0].point;
    const obstacle = {x: first[0] - 82, y: first[1] - 32, width: 164, height: 88};
    const result = Guide.layout(raw, p => p, {width: 740, height: 320, obstacles: [obstacle]});
    assert.equal(intersects(result.markers[0].box, obstacle), false);
    assert.deepEqual(result.markers[0].anchor, first);
    for (const marker of result.markers) {
      assert.ok(marker.box.x >= 0 && marker.box.x + marker.box.width <= 740);
      assert.ok(marker.box.y >= 0 && marker.box.y + marker.box.height <= 320);
    }
    for (let i = 0; i < result.markers.length; i++) for (let j = i + 1; j < result.markers.length; j++) {
      assert.equal(intersects(result.markers[i].box, result.markers[j].box), false);
    }
  }
  const edge = {markers: [{id: 'edge', role: 'end', label: '一个很长的场景终点说明用于验证窄地图不会让文字横向溢出', point: [175, 70]}]};
  const result = Guide.layout(edge, p => p, {width: 180, height: 100});
  assert.ok(result.markers[0].box.x + result.markers[0].box.width <= 180);
  assert.match(result.markers[0].text, /…$/);
  assert.equal(Guide.layout(edge, ([x, y]) => [x + 5000, y], {width: 180, height: 100}).markers.length, 0,
    '离开视野的标记不能把旧标签贴在地图边缘');
});

test('annotations are bounded, short or duplicate directions add no crowding, and invalid metadata never enables compact mode', () => {
  const raw = guide(); raw.markers = Array.from({length: 30}, (_, i) => ({...raw.markers[0], id: `many-${i}`}));
  raw.directions = Array.from({length: 30}, (_, i) => ({from: [100, 100], to: [200 + i, 100]}));
  const normalized = Guide.normalize(raw);
  assert.equal(normalized.markers.length, 8); assert.equal(normalized.directions.length, 8);
  normalized.markers[0].point[0] = -1; assert.equal(raw.markers[0].point[0], 100);
  assert.equal(Guide.layout({directions: [{from: [100, 100], to: [105, 100]}]}, p => p).directions.length, 0);
  assert.equal(Guide.normalize({compactPaths: true, arbitrary: 'metadata'}), null);
  assert.equal(Guide.normalize({...guide(), compactPaths: 'true'}).compactPaths, false);
});

function renderScene(scene, withDraw = false, overlay = null) {
  const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
  const start = source.indexOf('function renderMap(){'), end = source.indexOf("window.addEventListener('simulator-map:render'", start);
  const elements = {'#map-layers': {innerHTML: ''}, '#draw-layer': {innerHTML: ''}, '#map': {viewBox: {baseVal: {width: 1000, height: 650}}}};
  if(overlay){
    elements['#map-hint']={hidden: overlay.hidden, getBoundingClientRect: () => overlay.rect};
    elements['#map'].getScreenCTM=()=>({inverse:()=>overlay.inverse});
    elements['#map'].createSVGPoint=()=>({x:0,y:0,matrixTransform(matrix){return {x:matrix.a*this.x+matrix.c*this.y+matrix.e,y:matrix.b*this.x+matrix.d*this.y+matrix.f};}});
  }
  let guideLayout = null, guideObstacles = [];
  const context = vm.createContext({state: scene, weatherPreview: [], draw: withDraw ? {mode: 'target', points: [[50, 50], [100, 100]]} : null,
    window: {SimulatorMap: {ready: true, project: p => [...p]}, SceneMapGuide: {...Guide, render: (value, project, viewport) => {
      guideLayout=Guide.layout(value,project,viewport);guideObstacles=viewport.obstacles;return Guide.render(value,project,viewport);
    }}, ZoneRings},
    $: selector => elements[selector], airportLayer: () => '', label: (x, y, label) => `<text>${label}</text>`,
    esc: value => String(value),
    activeTarget: () => null, position: target => target.path[0], siteMarker: () => '<g data-testid="site-marker"/>',
    targetIcon: () => 'uav', marker: (kind, id) => `<g data-testid="live-target" data-id="${id}"/>`
  });
  vm.runInContext(source.slice(source.indexOf('function labelBounds('), source.indexOf('function marker(')), context);
  vm.runInContext(source.slice(start, end), context); context.renderMap();
  return {svg: elements['#map-layers'].innerHTML, drawing: elements['#draw-layer'].innerHTML, guideLayout, guideObstacles};
}

test('real map renderer keeps complete route geometry and live markers while explicit compact guides remove dense waypoint dots', () => {
  for (const shift of [0, 40]) {
    const points = Array.from({length: 80}, (_, i) => [60 + shift + i * 5, 180]);
    const scene = {sites: [{id: `site-${shift}`, name: '接收设备组', x: 400, y: 330, devices: [{kind: 'radar'}]}],
      plans: [{id: `plan-${shift}`, name: '配套任务', points}], zones: [],
      targets: [{id: `target-${shift}`, name: '模拟飞行目标', kind: 'uav', path: points}]};
    const before = JSON.stringify(scene), ordinary = renderScene(scene, true);
    assert.equal(count(ordinary.svg, /<circle /g), 160);
    assert.equal(count(ordinary.svg, /class="map-geometry"/g), 2);
    scene.mapGuide = guide(shift);
    const guided = renderScene(scene, true);
    assert.equal(count(guided.svg, /<circle /g), 3);
    assert.equal(count(guided.svg, /class="map-geometry"/g), 2);
    assert.equal(count(guided.svg, /class="scene-guide-direction"/g), 2);
    const fullPath = points.map(point => point.join(',')).join(' ');
    assert.equal(count(guided.svg, new RegExp(`points="${fullPath}"`, 'g')), 2);
    assert.match(guided.svg, /data-testid="site-marker"/); assert.match(guided.svg, /data-testid="live-target"/);
    assert.equal(guided.drawing, ordinary.drawing, '导读不改变用户正在绘制的点');
    delete scene.mapGuide;
    assert.equal(JSON.stringify(scene), before);
    scene.mapGuide = {compactPaths: true, markers: [{role: 'unknown'}]};
    assert.equal(count(renderScene(scene).svg, /<circle /g), 160, '非法导读不隐藏普通场景的节点');
  }
});

test('browser helper loads before the map renderer and CSS is included without changing the shared basemap bundle', () => {
  const index = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  assert.ok(index.indexOf('src="scene-map-guide.js?') >= 0);
  assert.ok(index.indexOf('src="scene-map-guide.js?') < index.indexOf('src="app.js?'));
  assert.ok(index.includes('href="scene-map-guide.css?'));
  const context = vm.createContext({window: {}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/scene-map-guide.js'), 'utf8'), context);
  assert.equal(typeof context.window.SceneMapGuide.render, 'function');
});

test('real map guide avoids existing plan and airspace labels plus a fixed hint transformed from screen to SVG coordinates', () => {
  for(const [shift,scale,left,top] of [[0,1,200,300],[60,1.5,80,180]]){
    const hint={x:20+shift,y:12,width:200,height:34};
    const scene={sites:[],targets:[],
      plans:[{id:`route-${shift}`,name:'当前配套任务航线',points:[[200+shift,200],[350+shift,200]]}],
      zones:[{id:`airspace-${shift}`,name:'当前测试空域',points:[[500+shift,219],[600+shift,219],[600+shift,400],[500+shift,400]]}],
      mapGuide:{markers:[
        {id:'end',role:'end',label:'③ 区外终点',point:[100+shift,44]},
        {id:'turn',role:'turn',label:'② 转向避开',point:[350+shift,200]},
        {id:'entry',role:'entry',label:'边界位置',point:[620+shift,300]}
      ]}
    };
    const overlay={rect:{left:left+hint.x*scale,top:top+hint.y*scale,right:left+(hint.x+hint.width)*scale,
      bottom:top+(hint.y+hint.height)*scale,width:hint.width*scale,height:hint.height*scale},
      inverse:{a:1/scale,b:0,c:0,d:1/scale,e:-left/scale,f:-top/scale}};
    const before=JSON.stringify(scene), result=renderScene(scene,false,overlay);
    assert.equal(result.guideObstacles.length,3);
    assert.ok(result.guideObstacles.some(box=>Math.abs(box.x-(hint.x-5))<.001&&Math.abs(box.width-(hint.width+10))<.001));
    for(const marker of result.guideLayout.markers)for(const obstacle of result.guideObstacles){
      assert.equal(intersects(marker.box,obstacle),false,`${marker.label} must avoid existing map text`);
    }
    assert.deepEqual(result.guideLayout.markers.map(marker=>marker.anchor),scene.mapGuide.markers.map(marker=>marker.point));
    assert.equal(JSON.stringify(scene),before);
    assert.equal(renderScene(scene,false,{...overlay,hidden:true}).guideObstacles.length,2,'hidden hint adds no stale obstacle');
  }
});

test('compact guided scenes place airspace names inside the top of their bounds while ordinary scenes keep the original label position', () => {
  for(const shift of [0,110]){
    const zone={id:`area-${shift}`,name:'禁飞区',points:[[610+shift,100],[810+shift,100],[810+shift,400],[610+shift,400]]};
    const mapGuide={compactPaths:true,markers:[{id:'inside',role:'entry',label:'进入区域',point:[710+shift,160]}]};
    const scene={sites:[],targets:[],plans:[],zones:[zone],mapGuide};
    const before=JSON.stringify(scene), result=renderScene(scene), box=result.guideObstacles[0];
    assert.equal(box.x+box.width/2,710+shift,'区域名称在包围盒水平中线');
    assert.ok(box.y>=100&&box.y<125,'区域名称放在顶部内侧');
    assert.ok(box.x>=610+shift&&box.x+box.width<=810+shift);
    assert.ok(box.y+box.height<=400);
    assert.equal(intersects(result.guideLayout.markers[0].box,box),false,'区域名称仍参与导读避让');
    assert.equal(JSON.stringify(scene),before);
    const ordinary=renderScene({...scene,mapGuide:{...mapGuide,compactPaths:false}});
    const originalBox=ordinary.guideObstacles[0];
    assert.equal(originalBox.x+originalBox.width/2,zone.points[1][0]+20);
    assert.equal(originalBox.y+5,zone.points[1][1]+35);
    assert.equal(renderScene({...scene,mapGuide:undefined}).svg.includes(`translate(${zone.points[1][0]+20},${zone.points[1][1]+35})`),true);
  }
});

test('editing a guided draft clears both route and stage claims immediately without changing the edited facts', () => {
  const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
  const dirtyFunction = source.slice(source.indexOf('function dirty('), source.indexOf('function field('));
  const changes = [
    scene => { scene.targets[0].path = [[110, 200], [420, 160]]; },
    scene => { scene.targets[0].speed = 18; },
    scene => { scene.zones[0].points = [[400, 100], [600, 100], [600, 300], [400, 300]]; },
    scene => { scene.duration = 7; }
  ];
  for (const [index, change] of changes.entries()) {
    const state = {mapGuide: guide(index * 20), sceneGuide: {title: '原场景', phases: [{at: 0, label: '原阶段'}]},
      duration: 5, targets: [{id: `target-${index}`, path: [[100, 180], [340, 180]], speed: 10}],
      zones: [{id: `zone-${index}`, points: [[500, 100], [700, 100], [700, 400]]}]};
    const oldGuide = state.mapGuide, guideBefore = JSON.stringify(oldGuide), effects = [], status = {};
    change(state);
    const editedFacts = JSON.stringify({duration: state.duration, targets: state.targets, zones: state.zones});
    const context = vm.createContext({state, showRunPositions: true, draftUnsaved: false,
      $: () => status, window: {FlowPicker: {clear: () => effects.push('release-preset')}},
      renderMap: () => { assert.equal(state.mapGuide, undefined); assert.equal(state.sceneGuide, undefined); effects.push('redraw'); }
    });
    vm.runInContext(dirtyFunction, context); context.dirty();
    assert.equal(Object.hasOwn(state, 'mapGuide'), false); assert.equal(Object.hasOwn(state, 'sceneGuide'), false);
    assert.deepEqual(effects, ['release-preset', 'redraw']);
    assert.equal(context.showRunPositions, false); assert.equal(context.draftUnsaved, true);
    assert.match(status.textContent, /未保存修改/);
    assert.equal(JSON.stringify({duration: state.duration, targets: state.targets, zones: state.zones}), editedFacts);
    assert.equal(JSON.stringify(oldGuide), guideBefore, '撤下草稿引用不改写原场景导读');
    context.dirty(); assert.equal(effects.length, 2, '普通后续修改不重复撤销固定流程或触发额外地图刷新');
  }
});

test('loading an unchanged preset retains its authored map and stage guides and does not call draft-edit invalidation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../web/flow-picker.js'), 'utf8');
  const loadFunction = source.slice(source.indexOf('  function load(flow)'), source.indexOf('  function clear()', source.indexOf('  function load(flow)')));
  for (const variant of ['avoid', 'enter']) {
    const scene = {sites: [{id: `site-${variant}`}], mapGuide: guide(0, variant), sceneGuide: {title: `scene-${variant}`}};
    const before = JSON.stringify(scene), element = {}, effects = [];
    const context = vm.createContext({structuredClone, state: {}, selected: {}, progress: 10, showRunPositions: true,
      displayedBatch: null, liveState: {batch: 'earlier-run'}, draftUnsaved: true, current: null, lastRuntime: null,
      running: () => false, stop() {}, syncSceneFields() {}, cancelDraw() {}, render: () => effects.push('render'),
      dirty: () => { throw Error('载入预设不应冒充用户修改'); },
      scenePoints: () => [], window: {SimulatorMap: {fit() {}}}, document: {querySelector: () => element},
      persist() {}, renderBanner() {}, closeDialog() {}, toast() {}
    });
    vm.runInContext(loadFunction, context);
    context.load({flow: 9, variant, title: '通用流程样例', scene, guide: {}});
    assert.deepEqual(context.state.mapGuide, scene.mapGuide); assert.deepEqual(context.state.sceneGuide, scene.sceneGuide);
    assert.notEqual(context.state, scene); assert.equal(context.draftUnsaved, false);
    assert.deepEqual(effects, ['render']); assert.equal(JSON.stringify(scene), before);
  }
});
