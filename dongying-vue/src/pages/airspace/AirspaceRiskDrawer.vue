<script setup>
import { nextTick, ref, watch } from 'vue';
import { canAccessRoute } from '@/services/accessControl.js';
import AirspaceRiskEventDetail from './AirspaceRiskEventDetail.vue';
import { RISK_TYPE_LABEL, RISK_STATE_LABEL, SEVERITY_LABEL,
  SOURCE_MODE_LABEL, targetTypeLabel, labelOf } from '@/ui/labels.js';

const props = defineProps({ row: { type: Object, default: null } });
const emit = defineEmits(['updated']);
const show = defineModel('show', { type: Boolean, default: false });
const heading = ref(null);
const monitorIcon = window.UI.icon('radar');
const detailBody = ref(null);
watch(() => props.row?.key, () => detailBody.value?.scrollTo({ top: 0 }));
let opener = null;
watch(show, async visible => {
  if (visible) {
    opener = document.activeElement;
    await nextTick();
    heading.value?.focus({ preventScroll: true });
  } else if (opener?.isConnected) {
    opener.focus({ preventScroll: true });
  }
});
const stateLabels = { ...RISK_STATE_LABEL, DEMO: '模拟监测', UNRECORDED: '未记录风险' };
function time(value) { return value == null ? '未记录' : new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function title(row) { return row.risk?.risk_no || row.target?.target_no || '未编号'; }
function typeLabel(row) { return row.target ? targetTypeLabel(row.target.subtype, row.target.object_type_code, '未分类')
  : labelOf(RISK_TYPE_LABEL, row.type, '未分类'); }
function pointText(point) { return point ? `${point[0]}, ${point[1]}（经度、纬度）` : '位置未记录，无法定位'; }
function isMock(row) { return !!row.target?.demo || row.risk?.source_mode === 'mock' || row.target?.source_mode === 'mock'; }
function openTarget(row) { window.UI?.goto?.('situation', { target: row.target.target_id }); }
</script>

<template>
  <aside v-if="show && row" class="risk-map-detail" aria-labelledby="airspace-risk-detail-title" @keydown.esc.stop="show = false">
    <header class="detail-head">
      <h3 id="airspace-risk-detail-title" ref="heading" tabindex="-1">风险详情与处理</h3>
      <button type="button" class="detail-close" aria-label="关闭详情" @click="show = false">×</button>
    </header>
      <AirspaceRiskEventDetail v-if="row.risk" :key="row.risk.risk_id" :risk-id="row.risk.risk_id" @updated="emit('updated', $event)" />
      <section v-else ref="detailBody" class="risk-detail" aria-label="空域记录详情">
        <div class="detail-hero detail-hero-micro"><div class="detail-hero-inner">
          <div class="detail-hero-icon" v-html="monitorIcon"></div>
          <div class="detail-hero-copy"><div class="detail-hero-eyebrow">{{ row.target?.demo ? '模拟观测' : '监测目标' }}</div><div class="detail-hero-title">{{ typeLabel(row) }}</div><div class="detail-hero-id detail-id">{{ title(row) }}</div></div>
          <div class="detail-hero-side"><div class="detail-hero-tags"><span class="tag t-amber">{{ labelOf(stateLabels, row.state, '状态未记录') }}</span></div></div>
        </div></div>
        <section class="sect"><h4>监测信息</h4><dl class="kv kv-surface">
          <dt>类型 / 状态</dt><dd>{{ typeLabel(row) }} · {{ labelOf(stateLabels, row.state, '状态未记录') }}<template v-if="isMock(row)"> · 模拟数据</template></dd>
          <dt>等级</dt><dd>{{ labelOf(SEVERITY_LABEL, row.severity, '未判定') }}</dd>
          <template v-if="row.target">
            <template v-if="row.target.demo">
              <dt>重点区域 / 距离</dt><dd>{{ row.target.demo.scene.label }} · {{ row.target.demo.scene.distanceLabel }} {{ Math.round(row.target.demo.distance) }} 米<template v-if="row.target.demo.relation"> · {{ { INSIDE: '界内', OUTSIDE: '界外', BOUNDARY: '边界上' }[row.target.demo.relation] }}</template></dd>
              <dt>前帧距离</dt><dd>{{ Math.round(row.target.demo.previousDistance) }} 米</dd>
              <dt>高度 / 数量</dt><dd>海拔 {{ row.target.demo.altitude }} 米 · {{ row.target.demo.count }} {{ row.target.demo.unit }}<br>{{ row.target.demo.countDelta === 0 ? '数量不变' : `${row.target.demo.countDelta > 0 ? '增加' : '减少'} ${Math.abs(row.target.demo.countDelta)} ${row.target.demo.unit}` }}</dd>
              <dt>运动趋势（10秒）</dt><dd>{{ row.target.demo.horizontal }} · {{ row.target.demo.vertical }}<br>水平 {{ row.target.demo.speed.toFixed(1) }} 米/秒 · 垂直 {{ row.target.demo.verticalSpeed > 0 ? '+' : '' }}{{ row.target.demo.verticalSpeed.toFixed(1) }} 米/秒</dd>
            </template>
            <dt>最近监测</dt><dd>{{ time(row.target.last_seen_at) }} · {{ pointText(row.target.point) }}</dd>
            <dt>监测来源</dt><dd>{{ labelOf(SOURCE_MODE_LABEL, row.target.source_mode, '未记录') }}</dd>
            <dt v-if="row.target.risk_summary">风险摘要时间</dt><dd v-if="row.target.risk_summary">{{ time(row.target.risk_summary.occurred_at) }}，不代表目标当前状态。</dd>
            <dt v-if="!row.risk">记录情况</dt><dd v-if="!row.risk">{{ row.target.demo ? '模拟观测，不生成业务风险记录。' : row.target.risk_summary ? '仅有风险摘要，完整记录未在本次读取结果中。' : '暂未查到关联风险记录，是否存在风险需进一步核实。' }}</dd>
          </template>
        </dl></section>
      </section>
    <footer v-if="row.target && !row.target.demo && canAccessRoute('situation')" class="detail-footer">
      <button class="btn ghost" type="button" @click="openTarget(row)">查看目标</button>
    </footer>
  </aside>
</template>

<style scoped>
.risk-map-detail { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.detail-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.detail-head h3 { margin: 0; font-size: 14px; }
.detail-close { display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 4px; background: transparent; color: var(--txt-2); font-size: 22px; cursor: pointer; }
.detail-close:hover { background: var(--surface-1); color: var(--txt); }
.detail-close:focus-visible, .detail-head h3:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }
.risk-detail { flex: 1; min-height: 0; overflow: auto; padding: 12px 14px; }
.detail-footer { display: flex; flex-wrap: wrap; gap: 6px; flex: none; padding: 8px 14px; border-top: 1px solid var(--line); }
.detail-id { margin: 0 0 12px; color: var(--cyan); font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.risk-detail dl { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px 12px; margin: 0; font-size: 13px; line-height: 1.7; }
.risk-detail dt { color: var(--txt-2); }
.risk-detail dd { margin: 0; color: var(--txt); white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 480px) {
  .risk-detail dl { grid-template-columns: 92px minmax(0, 1fr); gap: 12px; }
}
</style>
