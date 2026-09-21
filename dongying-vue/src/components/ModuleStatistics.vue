<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import UPanel from '@/components/UPanel.vue';

const props = defineProps({ state: { type: Object, required: true } });
defineEmits(['retry']);
const root = ref(null);
let elements = [];
let generation = 0;
function dispose() {
  elements.forEach(element => window.CH.disposeEl(element));
  elements = [];
}
function percent(value) { return props.state.total ? `${(value / props.state.total * 100).toFixed(1)}%` : '0.0%'; }
async function draw() {
  const own = ++generation;
  dispose();
  await nextTick();
  if (own !== generation || !root.value || props.state.loading || props.state.error || !props.state.total) return;
  elements = [...root.value.querySelectorAll('[data-stat-chart]')];
  elements.forEach((element, index) => {
    const group = props.state.groups[index];
    const data = group.data.map(row => ({ ...row, c: window.CH.C[row.color] }));
    const chart = group.type === 'line'
      ? window.CH.line(element, { x: data.map(row => row.name), legend: false,
        grid: { left: 32, right: 18, top: 22, bottom: 28 },
        series: [{ name: '移送数', data: data.map(row => row.value), color: window.CH.C.blue, smooth: false, label: true }] })
      : group.type === 'bar'
      ? window.CH.bar(element, { x: data.map(row => row.name), legend: false,
        grid: { left: 40, right: 18, top: 22, bottom: 38 },
        series: [{ name: '数量', data: data.map(row => row.value), width: 24, colorBy: p => data[p.dataIndex].c }] })
      : window.CH.donut(element, { data, legend: false, narrow: false, center: ['50%', '50%'], radius: ['55%', '76%'] });
    chart?.setOption({ animation: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      tooltip: { renderMode: 'richText' },
      ...(group.type !== 'donut' ? { xAxis: { axisLabel: { interval: 0, fontSize: 10,
        formatter: value => value.match(/.{1,5}/gu)?.join('\n') || value } }, yAxis: { minInterval: 1 } } : {}) });
  });
}
watch(() => [props.state.loading, props.state.error, props.state.groups], draw, { immediate: true, deep: true });
onBeforeUnmount(() => { generation += 1; dispose(); });
</script>

<template>
  <section ref="root" class="module-statistics" aria-label="模块统计" :aria-busy="state.loading">
    <div class="statistics-scope">
      <span>统计范围：当前筛选条件下的全部可见记录</span>
    </div>
    <div v-if="state.loading" class="panel statistics-message" role="status">正在读取统计数据</div>
    <div v-else-if="state.error" class="panel statistics-message" role="alert">
      <span>{{ state.error }}</span><button type="button" class="btn" @click="$emit('retry')">重试统计</button>
    </div>
    <div v-else class="statistics-grid">
      <UPanel v-for="group in state.groups" :key="group.key" :title="group.title" :sub="group.note || ''" class="statistics-panel">
        <div v-if="!state.total" class="statistics-message">当前筛选条件下暂无数据</div>
        <div v-else :class="['statistics-content', { 'statistics-donut': group.type === 'donut' }]">
          <div data-stat-chart class="statistics-chart" role="img" :aria-label="`${group.title}，共 ${group.total} 条`"></div>
          <ul v-if="group.type === 'donut'" class="statistics-legend" :class="{ 'statistics-legend-dense': group.data.length > 5 }" :aria-label="group.title">
            <li v-for="row in group.data" :key="row.name">
              <span class="statistics-swatch" :style="{ background: `var(--${row.color})` }" aria-hidden="true"></span>
              <span>{{ row.name }} <b>{{ row.value.toLocaleString() }}</b>（{{ percent(row.value) }}）</span>
            </li>
          </ul>
        </div>
      </UPanel>
    </div>
  </section>
</template>

<style scoped>
.module-statistics { flex: none; width: 100%; min-width: 0; margin-top: 10px; padding-bottom: 2px; }
.statistics-scope { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; margin-bottom: 8px; font-size: 12px; color: var(--txt-3); }
.statistics-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr) minmax(0, 1fr); gap: var(--gap); }
.statistics-panel { min-width: 0; border-color: color-mix(in srgb, var(--purple) 40%, var(--line)); }
.statistics-panel :deep(.ph) { flex-wrap: wrap; height: auto; min-height: 36px; padding: 6px 12px; }
.statistics-panel :deep(.ph h3) { white-space: normal; overflow-wrap: anywhere; }
.statistics-panel :deep(.ph h3::before) { background: var(--purple); }
.statistics-panel :deep(.pb) { overflow: visible; padding: 6px 10px; }
.statistics-content { min-height: 146px; }
.statistics-chart { height: 146px; min-width: 0; }
.statistics-donut { display: grid; grid-template-columns: minmax(90px, .65fr) minmax(0, 1.35fr); align-items: center; gap: 8px; }
.statistics-legend { display: flex; flex-direction: column; gap: 6px; list-style: none; margin: 0; padding: 4px 0; color: var(--txt-2); font-size: 12px; line-height: 1.5; }
.statistics-legend-dense { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 8px; }
.statistics-legend li { display: flex; align-items: baseline; gap: 5px; overflow-wrap: anywhere; }
.statistics-legend b { font-weight: 500; font-variant-numeric: tabular-nums; }
.statistics-swatch { flex: none; width: 12px; height: 8px; border-radius: 3px; }
.statistics-message { min-height: 146px; display: flex; align-items: center; justify-content: center; gap: 12px; padding: 16px; color: var(--txt-2); flex-wrap: wrap; }
@media (max-width: 900px) { .statistics-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
