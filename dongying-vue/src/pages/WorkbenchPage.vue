<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { UField } from '@/components/form/index.js';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { listWorkbenchEvents, getWorkbenchDetail } from '@/services/workbenchEvents.js';

const M = window.MOCK, U = window.UI;
usePageChrome('workbench');

const kind = ref('all');
const level = ref('all');
const visibleLimit = ref(30);
const selectedKey = ref('');
const revision = ref(0);
const mapHost = ref(null);
let map = null;

const allEvents = computed(() => { revision.value; return listWorkbenchEvents(); });
const activeEvents = computed(() => allEvents.value.filter(e => e.statusBucket !== 'completed'));
const overview = computed(() => ({
  total: activeEvents.value.length,
  high: activeEvents.value.filter(e => ['高', '高风险', '超高风险'].includes(e.level)).length,
  uav: activeEvents.value.filter(e => e.kind === 'uav').length,
  risk: activeEvents.value.filter(e => e.kind === 'risk').length,
  device: activeEvents.value.filter(e => e.kind === 'device').length
}));
const filtered = computed(() => activeEvents.value.filter(e =>
  (kind.value === 'all' || e.kind === kind.value)
  && (level.value === 'all' || e.level === level.value)
));
const visibleEvents = computed(() => filtered.value.slice(0, visibleLimit.value));
const selected = computed(() => {
  revision.value;
  return getWorkbenchDetail(selectedKey.value);
});
const currentUser = computed(() => M.currentUser || { name: '用户', roleName: '—' });
const canReadCase = computed(() => M.can('处置处罚管理', 'read'));
const canReadAuth = computed(() => M.can('反制/干扰授权', 'read'));
const levels = ['高', '中', '低'];
const levelOptions = [{ label: '全部等级', value: 'all' }, ...levels.map(value => ({ label: `${value}风险`, value }))];
const kindLabel = { uav: '无人机告警', risk: '飞行计划风险', device: '设备告警' };
const kindIcon = { uav: 'plane', risk: 'plan', device: 'device' };
const unavailableReasonByKind = {
  uav: '真实处置接口未接入，当前仅展示 Mock 演示数据。',
  risk: '真实通报接口未接入，当前仅展示 Mock 演示数据。',
  device: '真实设备控制与恢复验证接口未接入，当前仅展示 Mock 演示数据。'
};
const actionUnavailableReason = computed(() => unavailableReasonByKind[selected.value?.kind] || '真实业务接口未接入，当前仅展示 Mock 演示数据。');
const kindOptions = [
  { value: 'all', label: '全部事件' },
  { value: 'uav', label: '无人机告警' },
  { value: 'risk', label: '飞行计划风险' },
  { value: 'device', label: '设备告警' }
];

function icon(name) { return U.icon(name); }
function tagClass(v) {
  return ['高', '高风险', '超高风险'].includes(v) ? 't-red' : ['中', '中风险'].includes(v) ? 't-amber' : 't-blue';
}
function kindCount(k) { return k === 'all' ? activeEvents.value.length : activeEvents.value.filter(e => e.kind === k).length; }
function selectEvent(e) { selectedKey.value = e.key; }
function showKind(value) { kind.value = value; level.value = 'all'; }
function showHighRisk() { kind.value = 'all'; level.value = '高'; }
function loadMore() { visibleLimit.value += 30; }
function refresh() {
  const keep = selectedKey.value;
  revision.value++;
  const moved = listWorkbenchEvents().find(e => e.key === keep);
  selectedKey.value = moved && moved.statusBucket !== 'completed' ? keep : '';
}

function ensureSelection() {
  if (filtered.value.some(e => e.key === selectedKey.value)) return;
  selectedKey.value = filtered.value[0]?.key || '';
}
watch([filtered, kind, level], ensureSelection, { immediate: true });
watch([kind, level], () => { visibleLimit.value = 30; });

function destroyMap() {
  if (map) map.destroy();
  map = null;
  if (mapHost.value) mapHost.value.innerHTML = '';
}

function installRiskMapLayer(view, detail) {
  const route = detail.route, risk = detail.risk;
  if (!route || !(route.waypoints || []).length) return;
  const draw0 = view.draw.bind(view);
  view.draw = function () {
    draw0();
    const c = this.ctx, wp = route.waypoints || [];
    if (wp.length < 2) return;
    const half = (route.widthM / 2 + (route.widthTolM || 0)) / 1000;
    const left = [], right = [];
    wp.forEach((w, i) => {
      const a = wp[Math.max(0, i - 1)], b = wp[Math.min(wp.length - 1, i + 1)];
      const dx = (b.lon - a.lon) * 88.5, dy = (b.lat - a.lat) * 111;
      const len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
      left.push([w.lon + nx * half / 88.5, w.lat + ny * half / 111]);
      right.push([w.lon - nx * half / 88.5, w.lat - ny * half / 111]);
    });
    const corridor = left.concat(right.reverse()).map(p => this.px(p[0], p[1]));
    c.beginPath(); corridor.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath();
    c.fillStyle = '#22d3ee22'; c.fill();
    c.setLineDash([5, 4]); c.strokeStyle = '#22d3eeaa'; c.lineWidth = 1; c.stroke(); c.setLineDash([]);
    c.beginPath(); wp.forEach((w, i) => { const p = this.px(w.lon, w.lat); i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]); });
    c.strokeStyle = '#22d3ee'; c.lineWidth = 2.2; c.stroke();
    wp.forEach(w => { const p = this.px(w.lon, w.lat); c.beginPath(); c.arc(p[0], p[1], 3, 0, Math.PI * 2); c.fillStyle = '#22d3ee'; c.fill(); });

    const mid = this.px(wp[wp.length >> 1].lon, wp[wp.length >> 1].lat);
    const routeText = `${route.id} ${route.name}`;
    c.font = '600 11px "PingFang SC",sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    const tw = c.measureText(routeText).width + 14;
    c.fillStyle = 'rgba(4,18,30,.9)'; c.fillRect(mid[0] - tw / 2, mid[1] - 21, tw, 18);
    c.strokeStyle = 'rgba(34,211,238,.75)'; c.lineWidth = 1; c.strokeRect(mid[0] - tw / 2, mid[1] - 21, tw, 18);
    c.fillStyle = '#8ff3ff'; c.fillText(routeText, mid[0], mid[1] - 12);

    const p = this.px(risk.lon, risk.lat), col = risk.level === '高' ? '#ff4d5e' : risk.level === '中' ? '#ffb020' : '#3d8bff';
    const pulse = 8 + Math.sin(this.t / 8) * 2;
    c.beginPath(); c.arc(p[0], p[1], pulse, 0, Math.PI * 2); c.strokeStyle = col + '88'; c.lineWidth = 2; c.stroke();
    c.beginPath(); c.arc(p[0], p[1], 4.5, 0, Math.PI * 2); c.fillStyle = col; c.fill();
    c.font = '600 10.5px ui-monospace,Menlo,monospace'; c.textAlign = 'left';
    const eventText = `${risk.id} · ${risk.level}风险`;
    const ew = c.measureText(eventText).width + 12;
    c.fillStyle = 'rgba(4,18,30,.9)'; c.fillRect(p[0] + 11, p[1] - 9, ew, 18);
    c.fillStyle = '#fff'; c.fillText(eventText, p[0] + 17, p[1]);
  };
}

async function mountMap() {
  destroyMap();
  await nextTick();
  const d = selected.value;
  if (!mapHost.value || !d) return;
  map = new window.MapView(mapHost.value, { zoom: 2.4, maxDev: 5, maxAlarm: 2, legend: false });
  if (d.kind === 'uav') {
    const t = d.ctx.target;
    map.sel = t.id;
    map.setData({ airspaces: M.airspaces, devices: [], targets: [t], alarms: d.ctx.alarm ? [d.ctx.alarm] : [] });
    map.centerAt(t.lon, t.lat, { scale: 3.2 });
  } else if (d.kind === 'risk') {
    const r = d.risk;
    installRiskMapLayer(map, d);
    map.setData({ airspaces: M.airspaces.filter(a => a.status === '生效中'), devices: [], targets: [], alarms: [] });
    const wp = d.route?.waypoints || [];
    const mid = wp.length ? wp[wp.length >> 1] : r;
    map.centerAt((mid.lon + r.lon) / 2, (mid.lat + r.lat) / 2, { scale: 3.2 });
  } else {
    const dvc = d.device;
    map.sel = dvc.id;
    map.setData({ airspaces: [], devices: [dvc], targets: [], alarms: [] });
    map.centerAt(dvc.lon, dvc.lat, { scale: 3.2 });
  }
}
watch([selectedKey, revision], mountMap, { flush: 'post' });

function fmt(v) { return v == null || v === '' ? '—' : v; }
function dateShort(v) { return String(v || '—').replace(/^\d{4}-/, ''); }

const deviceChanged = () => refresh();
const eventAdvanced = () => refresh();
onMounted(() => {
  window.addEventListener('device:changed', deviceChanged);
  window.addEventListener('evt:advance', eventAdvanced);
  mountMap();
});
onUnmounted(() => {
  window.removeEventListener('device:changed', deviceChanged);
  window.removeEventListener('evt:advance', eventAdvanced);
  destroyMap();
});
</script>

<template>
  <div class="view workbench-view" id="view">
    <div class="workbench-page">
      <header class="wb-hero">
        <div>
          <div class="wb-eyebrow"><span v-html="icon('home')"></span> 我的工作台</div>
          <h1>{{ currentUser.name }}，这是您当前需要关注的事件</h1>
          <p>系统按风险等级、可操作性和发生时间统一排序；每个事件只呈现一个明确的下一步。</p>
        </div>
        <div class="wb-user-chip">
          <span class="wb-user-avatar" v-html="icon('user')"></span>
          <span><b>{{ currentUser.name }}</b><small>{{ currentUser.roleName }}</small></span>
        </div>
      </header>

      <div class="wb-kpis">
        <button class="wb-kpi is-cyan" :class="{ active: kind === 'all' && level === 'all' }" :aria-pressed="kind === 'all' && level === 'all'" @click="showKind('all')">
          <span v-html="icon('clipboard')"></span><em>当前事件</em><b>{{ overview.total }}</b><small>尚未闭环的统一事件队列</small>
        </button>
        <button class="wb-kpi is-red" :class="{ active: kind === 'all' && level === '高' }" :aria-pressed="kind === 'all' && level === '高'" @click="showHighRisk">
          <span v-html="icon('warning')"></span><em>高风险事件</em><b>{{ overview.high }}</b><small>优先关注高风险事件</small>
        </button>
        <button class="wb-kpi is-blue" :class="{ active: kind === 'uav' && level === 'all' }" :aria-pressed="kind === 'uav' && level === 'all'" @click="showKind('uav')">
          <span v-html="icon('plane')"></span><em>无人机告警</em><b>{{ overview.uav }}</b><small>核实、联动反制与信号干扰</small>
        </button>
        <button class="wb-kpi is-purple" :class="{ active: kind === 'risk' && level === 'all' }" :aria-pressed="kind === 'risk' && level === 'all'" @click="showKind('risk')">
          <span v-html="icon('plan')"></span><em>飞行计划风险</em><b>{{ overview.risk }}</b><small>核验航线风险并通知上级</small>
        </button>
        <button class="wb-kpi is-amber" :class="{ active: kind === 'device' && level === 'all' }" :aria-pressed="kind === 'device' && level === 'all'" @click="showKind('device')">
          <span v-html="icon('device')"></span><em>设备告警</em><b>{{ overview.device }}</b><small>设备恢复与结果验证</small>
        </button>
      </div>

      <div class="wb-layout">
        <aside class="panel wb-event-panel">
          <div class="ph"><h3>当前事件</h3><span class="sub">{{ filtered.length }} / {{ activeEvents.length }} 件</span></div>
          <div class="wb-kind-tabs" aria-label="事件类型筛选">
            <button v-for="o in kindOptions" :key="o.value" :class="{ on: kind === o.value }" :aria-pressed="kind === o.value" @click="showKind(o.value)">
              <span>{{ o.label }}</span><b>{{ kindCount(o.value) }}</b>
            </button>
          </div>
          <div class="wb-filters">
            <UField variant="toolbar" label="风险等级" sr-only v-model="level" type="select" :options="levelOptions" />
            <span class="wb-sort-note"><span v-html="icon('trend')"></span> 优先级排序</span>
          </div>
          <div class="wb-event-list">
            <button v-for="e in visibleEvents" :key="e.key" class="wb-event-card" :class="{ on: selectedKey === e.key }" @click="selectEvent(e)">
              <span class="wb-event-icon" v-html="icon(kindIcon[e.kind])"></span>
              <span class="wb-event-copy">
                <span class="wb-event-top"><em>{{ e.kindLabel }}</em><span><i class="wb-source-state">{{ e.sourceStatus }}</i><i class="tag" :class="tagClass(e.level)">{{ e.level }}</i></span></span>
                <b>{{ e.title }}</b><small class="mono">{{ e.sourceId }}</small>
                <span class="wb-event-meta"><i>{{ e.district }}</i><i>{{ dateShort(e.occurredAt) }}</i></span>
                <span v-if="e.todo" class="wb-event-next">下一步：{{ e.todo.action }}</span>
                <span v-else class="wb-event-next">当前无待办动作</span>
              </span>
            </button>
            <button v-if="visibleEvents.length < filtered.length" class="wb-load-more" @click="loadMore">继续加载 {{ Math.min(30, filtered.length - visibleEvents.length) }} 件</button>
            <div v-if="!filtered.length" class="empty wb-empty">当前筛选条件下没有事件<br><small>可切换事件类型或风险等级</small></div>
          </div>
        </aside>

        <main v-if="selected" class="wb-workspace">
          <section class="panel wb-title-panel">
            <div class="wb-title-main">
              <span class="wb-title-icon" v-html="icon(kindIcon[selected.kind])"></span>
              <div><small>{{ kindLabel[selected.kind] }}</small><h2>{{ selected.summary.title }}</h2>
                <p class="mono">{{ selected.summary.sourceId }}</p></div>
            </div>
            <div class="wb-title-tags"><span class="tag" :class="tagClass(selected.summary.level)">{{ selected.summary.level }}</span><span class="tag t-cyan">{{ selected.summary.sourceStatus }}</span></div>
            <div v-if="selected.summary.todo" class="wb-title-next">
              <span><small>下一步</small><b>{{ selected.summary.todo.action }}</b></span>
              <button class="btn pri" disabled aria-describedby="wb-action-unavailable">{{ selected.summary.todo.action }}</button>
              <span id="wb-action-unavailable" class="wb-blocker" role="note">{{ actionUnavailableReason }}</span>
            </div>
            <div class="wb-title-facts"><span><small>发生区域</small><b>{{ selected.summary.district }}</b></span><span><small>发生时间</small><b>{{ selected.summary.occurredAt }}</b></span></div>
          </section>

          <section class="panel wb-task-panel">
            <div class="ph"><h3>当前任务</h3><span class="sub">系统只给出一个明确主动作</span></div>
            <div v-if="selected.summary.todo" class="wb-task">
              <span class="wb-task-state" v-html="icon(selected.kind === 'device' ? 'tool' : 'bolt')"></span>
              <div><small>下一步</small><h3>{{ selected.summary.todo.action }}</h3><p>{{ selected.summary.todo.hint }}</p>
                <span>责任模块：<b>{{ selected.summary.todo.module }}</b></span><span v-if="selected.summary.todo.blocker" class="wb-blocker">{{ selected.summary.todo.blocker }}</span></div>
            </div>
            <div v-else class="wb-task"><span class="wb-task-state" v-html="icon('clipboard')"></span><div><small>只读状态</small><h3>当前无待办动作</h3><p>事件源未提供下一步待办，工作台仅展示现有只读详情。</p></div></div>
          </section>

          <section v-if="selected.kind === 'uav' || selected.kind === 'risk'" class="wb-flow-card panel">
            <div class="ph"><h3>{{ selected.kind === 'risk' ? '飞行计划风险流程' : '事件处置流程' }}</h3><span class="sub">{{ selected.kind === 'risk' ? '复用飞行计划页风险状态机' : '严格复用五环节' }}</span></div>
            <div class="wb-flow" :style="{ '--wb-flow-count': selected.steps.length }">
              <div v-for="(s,i) in selected.steps" :key="s.n" :class="['wb-flow-step',{done:s.done,active:s.act}]">
                <span>{{ s.done ? '✓' : i + 1 }}</span><b>{{ s.n }}</b><small>{{ s.done ? (s.t || '已完成') : s.act ? '当前环节' : '待处理' }}</small>
              </div>
            </div>
          </section>

          <div class="wb-work-grid">
            <section class="panel wb-conclusion">
              <div class="ph"><h3>{{ selected.kind === 'uav' ? '系统结论' : selected.kind === 'risk' ? '风险判据' : '设备状态' }}</h3></div>
              <div v-if="selected.kind === 'uav'" class="wb-kv-grid">
                <span><small>目标类型</small><b>{{ selected.ctx.target.subtype || selected.ctx.target.type }}</b></span>
                <span><small>合法性</small><b>{{ selected.ctx.target.legal }}</b></span>
                <span><small>违规事实</small><b>{{ selected.ctx.target.violation || '—' }}</b></span>
                <span><small>融合置信度</small><b>{{ selected.ctx.target.fusedConf }}%</b></span>
              </div>
              <div v-else-if="selected.kind === 'risk'" class="wb-kv-grid">
                <span><small>风险目标 / 距航线</small><b>{{ selected.risk.subtype || selected.risk.type }} · {{ fmt(selected.risk.nearestRouteKm) }} km</b></span>
                <span><small>关联飞行计划</small><b>{{ selected.plan ? `${selected.plan.id} · ${selected.plan.status}` : '暂无关联计划' }}</b></span>
                <span><small>关联航线</small><b>{{ selected.route ? `${selected.route.id} ${selected.route.name}` : '未关联航线' }}</b></span>
                <span><small>高度 / 时段</small><b>{{ selected.risk.altOverlap == null ? '不可判定' : selected.risk.altOverlap ? '重叠' : '不重叠' }} / {{ selected.risk.inWindow ? '窗口内' : '窗口外' }}</b></span>
                <p class="wb-advice">{{ selected.risk.advice }}</p>
              </div>
              <div v-else class="wb-kv-grid wb-device-grid">
                <span class="wb-device-name">
                  <span class="wb-device-label"><small>设备名称</small><em :class="selected.device.status === '在线' ? 'is-ok' : 'is-alert'">{{ selected.device.status }}</em></span>
                  <b :title="selected.device.name">{{ selected.device.name }}</b>
                </span>
                <span class="wb-device-health" :class="selected.device.health === '正常' ? 'is-ok' : 'is-alert'">
                  <small>健康状态</small><b><i></i>{{ selected.device.health }}</b>
                </span>
                <span class="wb-device-heartbeat">
                  <small>最后心跳</small><b class="mono" :title="selected.device.hb">{{ selected.device.hb }}</b>
                </span>
                <span class="wb-device-stage">
                  <small>当前阶段</small><b>{{ selected.incident.stage }}</b>
                </span>
                <span class="wb-device-metric">
                  <small>链路时延</small><b><strong>{{ fmt(selected.device.latency) }}</strong><i v-if="selected.device.latency != null">ms</i></b>
                </span>
                <span class="wb-device-metric">
                  <small>丢包率</small><b><strong>{{ fmt(selected.device.loss) }}</strong><i v-if="selected.device.loss != null">%</i></b>
                </span>
              </div>
            </section>

            <section class="panel wb-map-panel"><div class="ph"><h3>{{ selected.kind === 'risk' ? '风险事件与关联航线' : '事件位置' }}</h3><span class="sub">{{ selected.kind === 'risk' && selected.route ? selected.route.name : 'WGS-84' }}</span></div><div ref="mapHost" class="wb-map"></div></section>
          </div>

          <section v-if="selected.kind === 'uav'" class="panel wb-relations">
            <div class="ph"><h3>事件关系</h3><span class="sub">目标、告警、处置记录、授权、证据同源聚合</span></div>
            <div class="wb-relation-line">
              <span><small>目标</small><b class="mono">{{ selected.ctx.id }}</b></span><i>→</i>
              <span><small>告警</small><b class="mono">{{ selected.ctx.alarm?.id || '—' }}</b></span><i>→</i>
              <span v-if="canReadCase"><small>处置记录</small><b class="mono">{{ selected.ctx.kase?.id || '尚未生成处置记录' }}</b></span><span v-else class="is-hidden">处置记录无读取权限</span><i>→</i>
              <span v-if="canReadAuth"><small>授权记录</small><b>{{ selected.ctx.auth.length }} 条</b></span><span v-else class="is-hidden">授权信息无读取权限</span><i>→</i>
              <span><small>证据</small><b>{{ selected.ctx.evidence.length }} 份</b></span>
            </div>
          </section>
          <section v-else-if="selected.kind === 'risk'" class="panel wb-relations">
            <div class="ph"><h3>计划风险关系</h3><span class="sub">飞行计划页与工作台读取同一航线和风险事件</span></div>
            <div class="wb-relation-line">
              <span><small>飞行计划</small><b class="mono">{{ selected.plan?.id || '暂无关联计划' }}</b></span><i>→</i>
              <span><small>关联航线</small><b class="mono">{{ selected.route?.id || '—' }}</b><small>{{ selected.route?.name || '未关联航线' }}</small></span><i>→</i>
              <span><small>风险事件</small><b class="mono">{{ selected.risk.id }}</b></span><i>→</i>
              <span><small>通报记录</small><b>{{ selected.notices.length }} 条</b></span><i>→</i>
              <span><small>流转记录</small><b>{{ selected.disposals.length }} 条</b></span>
            </div>
          </section>

          <div class="wb-bottom-grid">
            <section class="panel wb-records">
              <div class="ph"><h3>{{ selected.kind === 'uav' ? '证据材料' : selected.kind === 'risk' ? '计划风险通报与核验记录' : '控制记录' }}</h3></div>
              <div v-if="selected.kind === 'uav'" class="wb-record-list">
                <div v-for="f in selected.ctx.evidence.slice(0,5)" :key="f.id" class="wb-record-row"><span v-html="icon('file')"></span><b>{{ f.kind }}</b><small>{{ f.name }}</small><em>{{ f.verifyState }}</em></div>
                <div v-if="!selected.ctx.evidence.length" class="empty">暂无证据材料</div>
              </div>
              <div v-else-if="selected.kind === 'risk'" class="wb-record-list">
                <div v-for="n in selected.notices.slice(0,4)" :key="n.id" class="wb-record-row"><span v-html="icon('mail')"></span><b>{{ n.channelName }}</b><small>{{ n.to }} · {{ n.at }}</small><em>{{ n.ackStatus }}</em></div>
                <div v-for="r in selected.disposals.slice(0,3)" :key="r.id" class="wb-record-row"><span v-html="icon('clipboard')"></span><b>{{ r.act }}</b><small>{{ r.by }} · {{ r.time }}</small><em>{{ r.result }}</em></div>
                <div v-if="!selected.notices.length && !selected.disposals.length" class="empty">暂无通报或核验记录</div>
              </div>
              <div v-else class="wb-record-list">
                <div v-for="r in (selected.device.controlLogs || []).slice(0,5)" :key="r.taskId" class="wb-record-row"><span v-html="icon('tool')"></span><b>{{ r.action }}</b><small>{{ r.reason }} · {{ r.at }}</small><em>{{ r.ack }}</em></div>
                <div v-if="!(selected.device.controlLogs || []).length" class="empty wb-record-empty">
                  <span class="wb-record-empty-icon" v-html="icon('tool')"></span>
                  <b>暂无控制记录</b>
                  <small>真实设备控制接口未接入，暂无控制记录</small>
                </div>
              </div>
            </section>
            <section class="panel wb-timeline">
              <div class="ph"><h3>事件时间线</h3><span class="sub">复用操作审计</span></div>
              <div class="wb-timeline-list">
                <div v-for="a in selected.timeline" :key="a.id"><i></i><span><b>{{ a.action }}</b><small>{{ a.time }} · {{ a.user }} · {{ a.result }}</small></span></div>
                <div v-if="!selected.timeline.length" class="empty">暂无审计记录</div>
              </div>
            </section>
          </div>
        </main>
        <main v-else class="panel wb-no-selection"><div class="empty">请选择左侧事件查看工作区</div></main>
      </div>
    </div>
  </div>
</template>
