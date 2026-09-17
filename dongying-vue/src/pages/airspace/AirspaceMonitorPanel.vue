<script setup>
import { computed, ref, watch } from 'vue';
import UControl from '@/components/form/UControl.vue';
import UPagination from '@/components/UPagination.vue';
import { canAccessRoute } from '@/services/accessControl.js';
import { targetTypeLabel, SOURCE_MODE_LABEL, SEVERITY_LABEL, RISK_STATE_LABEL, labelOf } from '@/ui/labels.js';
import { DEMO_FRAMES, DEMO_SCENES } from './airspaceMonitorDemo.js';

const props = defineProps({ monitor: { type: Object, required: true }, selected: { type: Object, default: null } });
const emit = defineEmits(['locate']);
const page = ref(1), size = ref(10);
const options = [5, 15, 60].map(value => ({ value, label: `最近 ${value} 分钟` }));
const modes = [{ value: 'demo', label: '模拟演示' }, { value: 'live', label: '接口监测数据' }];
const scenes = [{ value: '', label: '全部重点区域' }, ...DEMO_SCENES.map(item => ({ value: item.id, label: item.label }))];
const targetIcon = window.UI.targetIcon;
const pageRows = computed(() => props.monitor.filtered.slice((page.value - 1) * size.value, page.value * size.value));
watch(() => props.monitor.filtered.map(row => row.target_id).join(','), () => { page.value = 1; });
watch(() => props.monitor.activeId, id => {
  const index = props.monitor.filtered.findIndex(row => row.target_id === id);
  if (index >= 0) page.value = Math.floor(index / size.value) + 1;
});
function time(value) { return value == null ? '未记录' : new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function openTarget(row) { window.UI?.goto?.('situation', { target: row.target_id }); }
</script>

<template>
  <section class="airspace-monitor-panel" aria-label="空域监测">
    <div class="toolbar">
      <div class="toolbar-fields">
        <div class="field"><label>数据来源</label><UControl v-model="monitor.mode" type="select" :options="modes" size="small" /></div>
        <div v-if="monitor.isDemo" class="field"><label>重点区域</label><UControl v-model="monitor.scene" type="select" :options="scenes" size="small" /></div>
        <div v-else class="field"><label>发现时间</label><UControl v-model="monitor.minutes" type="select" :options="options" size="small" /></div>
        <b>{{ selected ? selected.name : '当前区县' }}</b>
      </div>
      <div v-if="monitor.isDemo && monitor.canRead" class="demo-playback"><span>第 {{ monitor.frame + 1 }}/{{ DEMO_FRAMES }} 帧 · {{ monitor.filtered.length }} 组目标</span><button class="btn" type="button" @click="monitor.paused = !monitor.paused">{{ monitor.paused ? '播放模拟' : '暂停模拟' }}</button><button class="btn" type="button" @click="monitor.paused = true; monitor.stepDemo()">下一帧</button></div>
      <span v-else class="monitor-update">每 10 秒刷新<span v-if="monitor.updatedAt"> · 最近读取 {{ time(monitor.updatedAt) }}</span></span>
    </div>
    <div v-if="monitor.isDemo" class="monitor-note demo-note"><span class="tag t-amber">模拟数据</span> 监测无人机机巢起降点周边及空域目标；每 10 秒切换样例。距离为水平距离，高度为海拔高度，趋势对比前一帧。空域内外仅指平面位置，不代表侵入或违规判定。
      <span v-if="selected">当前按 {{ selected.name }} 的平面边界筛选；查看全部模拟场景请关闭空域详情并选择全市。</span>
    </div>
    <div v-else class="monitor-note">
      目标可能已经离开；设备覆盖数据不完整，不能仅凭这份列表判断空域安全。
      <span v-if="selected">按平面范围筛选，含边界点；是否进入管制高度、是否违规需进一步核实。</span>
      <span v-if="monitor.canRead && !monitor.error && !monitor.loading && monitor.unlocated">当前区县另有 {{ monitor.unlocated }} 个目标缺少近期有效位置，无法确定是否在所选空域内。</span>
    </div>
    <div v-if="!monitor.canRead" class="empty">没有监测目标查看权限，空域当前情况未知。</div>
    <div v-else-if="monitor.error" class="empty" role="alert">{{ monitor.error }} 当前情况未知。<button v-if="![401, 403].includes(monitor.errorStatus)" class="btn" type="button" @click="monitor.reload">重试</button></div>
    <div v-else-if="monitor.loading && !monitor.updatedAt" class="empty" role="status">正在读取监测目标…</div>
    <div v-else-if="selected && !monitor.polygons.length" class="empty">这片空域没有可用的当前边界，无法确定范围内的目标。</div>
    <div v-else-if="!monitor.filtered.length" class="empty">{{ monitor.isDemo ? '当前范围没有模拟目标，可切换全市、全部重点区域，或关闭所选空域详情。' : `最近 ${monitor.minutes} 分钟没有可显示的目标。` }}</div>
    <div v-else class="monitor-table-scroll">
      <table class="tb">
        <thead><tr><th>目标 / 类型</th><template v-if="monitor.isDemo"><th>重点区域 / 距离</th><th>高度</th><th>数量</th><th>运动趋势（10 秒）</th></template><template v-else><th>最近发现</th><th>位置情况</th><th>来源</th><th>关联风险记录</th></template><th>操作</th></tr></thead>
        <tbody><tr v-for="row in pageRows" :key="row.target_id" :class="{ on: monitor.activeId === row.target_id }">
          <td><b class="target-name"><span class="target-icon" v-html="targetIcon(row)"></span>{{ row.target_no || '未编号目标' }}</b><small>{{ targetTypeLabel(row.subtype, row.object_type_code, '未分类') }}<template v-if="row.demo"> · <span class="tag" :class="row.demo.severity === 'HIGH' ? 't-red' : 't-amber'">{{ SEVERITY_LABEL[row.demo.severity] }} · 模拟</span></template></small></td>
          <template v-if="monitor.isDemo && row.demo">
            <td><b>{{ row.demo.scene.label }} · {{ Math.round(row.demo.distance) }} 米<template v-if="row.demo.relation"> · {{ { INSIDE: '界内', OUTSIDE: '界外', BOUNDARY: '边界上' }[row.demo.relation] }}</template></b><small>{{ row.demo.scene.distanceLabel }} · 前帧 {{ Math.round(row.demo.previousDistance) }} 米</small></td>
            <td><b>{{ row.demo.altitude }} 米</b><small>海拔高度（AMSL）</small></td>
            <td><b>{{ row.demo.count }} {{ row.demo.unit }}</b><small>{{ row.demo.countDelta === 0 ? '数量不变' : `${row.demo.countDelta > 0 ? '增加' : '减少'} ${Math.abs(row.demo.countDelta)} ${row.demo.unit}` }}</small></td>
            <td><b>{{ row.demo.horizontal }} · {{ row.demo.vertical }}</b><small>水平 {{ row.demo.speed.toFixed(1) }} 米/秒 · 垂直 {{ row.demo.verticalSpeed > 0 ? '+' : '' }}{{ row.demo.verticalSpeed.toFixed(1) }} 米/秒</small></td>
          </template>
          <template v-else>
          <td>{{ time(row.last_seen_at) }}</td>
          <td>{{ !row.point ? '缺少近期有效位置' : row.relation === 'BOUNDARY' ? '位于边界，归属待核实' : '已记录近期位置' }}</td>
          <td>{{ labelOf(SOURCE_MODE_LABEL, row.source_mode, '来源未记录') }}</td>
          <td v-if="row.risk_summary">{{ labelOf(SEVERITY_LABEL, row.risk_summary.severity, '未知等级') }} · {{ labelOf(RISK_STATE_LABEL, row.risk_summary.state, '未知状态') }}<small>发生于 {{ time(row.risk_summary.occurred_at) }}，不代表当前状态</small></td>
          <td v-else>暂未查到风险记录</td>
          </template>
          <td class="monitor-actions"><button class="linkbtn" type="button" :disabled="!row.point" @click="emit('locate', row)">定位</button><button v-if="!row.demo && canAccessRoute('situation')" class="linkbtn" type="button" @click="openTarget(row)">查看目标</button></td>
        </tr></tbody>
      </table>
    </div>
    <div v-if="monitor.canRead && !monitor.error && !monitor.loading && monitor.filtered.length" class="pager"><UPagination v-model:page="page" v-model:page-size="size" :item-count="monitor.filtered.length" /></div>
  </section>
</template>

<style scoped>
.airspace-monitor-panel { display: flex; flex: 1; flex-direction: column; min-height: 0; }
.toolbar { flex: none; flex-wrap: wrap; gap: 8px; }
.toolbar-fields { flex-wrap: wrap; }
.toolbar-fields b { font-size: 13px; }
.monitor-update { margin-left: auto; font-size: 12px; color: var(--txt-3); }
.demo-playback { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-left: auto; font-size: 12px; color: var(--txt-2); }
.demo-note > .tag { display: inline-block; margin-right: 6px; }
.target-name { display: flex; align-items: center; gap: 5px; }
.target-icon { display: inline-flex; color: var(--cyan); }
.target-icon :deep(svg) { width: 17px; height: 17px; }
.monitor-note { flex: none; padding: 7px 12px; border-bottom: 1px solid var(--line); color: var(--txt-3); font-size: 12px; line-height: 1.6; }
.monitor-note span, .tb small { display: block; }
.monitor-table-scroll { flex: 1; min-height: 0; overflow: auto; }
.tb { min-width: 980px; width: 100%; }
.tb small { color: var(--txt-3); margin-top: 3px; }
.monitor-actions { white-space: nowrap; }
.linkbtn { border: 0; background: transparent; color: var(--blue); padding: 3px 0; cursor: pointer; font-size: 12.5px; text-decoration: none; }
.linkbtn + .linkbtn { margin-left: 10px; }
.linkbtn:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
.linkbtn:disabled { opacity: .45; cursor: not-allowed; }
.empty { flex: 1; }
.pager { flex: none; }
</style>
