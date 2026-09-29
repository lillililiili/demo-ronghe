<script setup>
import { computed } from 'vue';

const props = defineProps({ detail: { type: Object, required: true } });
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const report = computed(() => props.detail.data);
const available = key => props.detail.state === 'AVAILABLE'
  && ['AVAILABLE', 'PARTIAL'].includes(report.value?.availability?.[key]?.status);
const source = computed(() => report.value?.simulated ? '近7日 · 演示数据' : '近7日');

// 只使用完整统计聚合；地图点和告警列表的有限样本不能替代全量分布。
const regions = computed(() => {
  const rows = report.value?.regions;
  if (!available('total') || !isCount(report.value?.summary?.total) || !Array.isArray(rows)
      || rows.some(row => !row.name || !isCount(row.total))
      || rows.reduce((sum, row) => sum + row.total, 0) !== report.value.summary.total) return null;
  return [...rows].sort((a, b) => b.total - a.total);
});
const altitude = computed(() => {
  const rows = report.value?.alt_bands;
  if (!available('alt_bands') || !isCount(report.value?.alt_total) || !Array.isArray(rows)
      || rows.some(row => !row.name || !isCount(row.value))
      || rows.reduce((sum, row) => sum + row.value, 0) !== report.value.alt_total) return null;
  return rows;
});
const regionMax = computed(() => Math.max(1, ...(regions.value || []).map(row => row.total)));
const altitudeMax = computed(() => Math.max(1, ...(altitude.value || []).map(row => row.value)));
const altitudeNote = computed(() => {
  const missing = report.value?.availability?.alt_bands?.missing_count;
  return `有效海拔（米） · 缺失 ${isCount(missing) ? missing : '未知'} 个`;
});
function unavailable(key) {
  if (props.detail.state === 'LOADING') return '正在加载';
  if (props.detail.state === 'FORBIDDEN') return '无读取权限';
  if (props.detail.state !== 'AVAILABLE') return '数据暂不可用';
  if (available(key)) return '统计数据不完整，暂不可展示';
  return report.value?.availability?.[key]?.reason || '暂不可统计';
}
</script>

<template>
  <div class="bs-bottom-stats">
    <section class="panel bs-bottom-panel" aria-labelledby="bs-region-title">
      <div class="ph"><h3 id="bs-region-title">区域目标分布</h3><span class="sub">{{ source }}</span></div>
      <div class="pb bs-bottom-body">
        <div class="bs-bottom-caption"><span>按首次发现时间统计新增目标</span><span v-if="regions">单位：个</span></div>
        <div v-if="regions && report.summary.total > 0" class="bs-region-bars" aria-label="各区域新增目标数量">
          <div v-for="row in regions" :key="row.name" class="bs-region-row">
            <span class="bs-region-name">{{ row.name }}</span>
            <div class="bs-region-track" aria-hidden="true"><i :style="{ width: row.total / regionMax * 100 + '%' }"></i></div>
            <b>{{ row.total }}</b>
          </div>
        </div>
        <div v-else class="bs-bottom-empty">{{ regions ? '统计区间内无新增目标' : unavailable('total') }}</div>
      </div>
    </section>
    <section class="panel bs-bottom-panel" aria-labelledby="bs-altitude-title">
      <div class="ph"><h3 id="bs-altitude-title">目标高度分布</h3><span class="sub">{{ source }}</span></div>
      <div class="pb bs-bottom-body">
        <div class="bs-bottom-caption"><span>{{ altitude ? altitudeNote : '最新有效海拔（米）' }}</span><span v-if="altitude">单位：个</span></div>
        <div v-if="altitude && report.alt_total > 0" class="bs-altitude-bars" aria-label="目标有效海拔分档数量">
          <div v-for="row in altitude" :key="row.name" class="bs-altitude-column">
            <div class="bs-altitude-track"><div class="bs-altitude-fill" :class="{ 'is-zero': row.value === 0 }" :style="{ height: row.value / altitudeMax * 100 + '%' }"><b>{{ row.value }}</b></div></div>
            <span>{{ row.name }}</span>
          </div>
        </div>
        <div v-else class="bs-bottom-empty">{{ altitude ? (report.summary?.total === 0 ? '统计区间内无新增目标' : '暂无有效海拔数据') : unavailable('alt_bands') }}</div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.bs-bottom-stats{flex:none;height:clamp(210px,25vh,280px);display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;min-width:0}
.bs-bottom-stats .bs-bottom-panel,.bs-bottom-stats .bs-bottom-panel:hover{padding:0;border:1px solid var(--bs-panel-outline);border-radius:0;background:var(--bs-panel-fill);box-shadow:inset 0 0 14px var(--glow-blue);backdrop-filter:none;clip-path:none;filter:none;overflow:hidden}
.bs-bottom-stats .bs-bottom-panel::before,.bs-bottom-stats .bs-bottom-panel::after{content:none}
.bs-bottom-stats .bs-bottom-panel>.ph{height:auto;min-height:30px;flex-wrap:wrap;padding-right:8px;overflow:visible}
.bs-bottom-stats .bs-bottom-panel>.ph h3{white-space:normal;font-size:15px}
.bs-bottom-stats .bs-bottom-panel>.ph .sub{max-width:none;margin-left:auto;white-space:normal}
.bs-bottom-stats .bs-bottom-body{padding:9px 13px 12px;gap:8px;overflow:auto}
.bs-bottom-caption{display:flex;justify-content:space-between;flex-wrap:wrap;gap:2px 8px;flex:none;font-size:11px;line-height:16px;color:var(--txt-2)}
.bs-region-bars{display:flex;flex-direction:column;justify-content:space-evenly;gap:5px;flex:1;min-height:0;overflow:auto;scrollbar-width:thin}
.bs-region-row{display:grid;grid-template-columns:minmax(70px,auto) minmax(30px,1fr) auto;gap:10px;align-items:center;flex:1 0 auto;min-height:19px;font-size:12px;line-height:18px}
.bs-region-name{width:6em;overflow-wrap:anywhere;color:var(--txt)}
.bs-region-row b{min-width:3ch;text-align:right;font:500 17px/1.2 'Bahnschrift','Consolas',sans-serif;color:var(--cyan)}
.bs-region-track{height:7px;background:var(--bs-summary-fill);border-right:1px solid var(--line)}
.bs-region-track i{display:block;height:100%;background:linear-gradient(90deg,var(--blue),var(--cyan));box-shadow:0 0 6px var(--glow-cyan)}
.bs-altitude-bars{flex:1;min-height:110px;display:flex;gap:9px;padding-top:22px;background:repeating-linear-gradient(to top,transparent 0,transparent calc(25% - 1px),var(--line-2) calc(25% - 1px),var(--line-2) 25%)}
.bs-altitude-column{flex:1;min-width:0;display:grid;grid-template-rows:minmax(50px,1fr) 32px;gap:6px;text-align:center}
.bs-altitude-track{display:flex;align-items:flex-end;justify-content:center;border-bottom:1px solid var(--line);min-height:0}
.bs-altitude-fill{position:relative;width:60%;max-width:32px;background:linear-gradient(0deg,var(--blue),var(--cyan));border-top:2px solid var(--cyan);box-shadow:0 0 9px var(--glow-cyan)}
.bs-altitude-fill.is-zero{border:0}
.bs-altitude-fill b{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);padding-bottom:4px;font:500 15px/1.2 'Bahnschrift','Consolas',sans-serif;color:var(--cyan);white-space:nowrap}
.bs-altitude-column>span{font-size:11px;line-height:15px;overflow-wrap:anywhere;color:var(--txt-2)}
.bs-bottom-empty{flex:1;display:grid;place-items:center;text-align:center;overflow-wrap:anywhere;font-size:12px;line-height:20px;color:var(--txt-3)}
@media(max-width:1400px),(max-height:820px){
  .bs-bottom-stats{gap:9px;height:210px}
  .bs-bottom-stats .bs-bottom-panel>.ph{min-height:27px}
  .bs-bottom-stats .bs-bottom-panel>.ph h3{font-size:13px}
  .bs-bottom-stats .bs-bottom-body{padding:7px 9px 8px;gap:6px}
  .bs-bottom-caption{font-size:10px;line-height:15px}
  .bs-region-row{gap:6px;font-size:11px;line-height:16px;min-height:18px}
  .bs-region-row b{font-size:15px}
  .bs-altitude-bars{gap:5px}
  .bs-altitude-column>span{font-size:10px}
}
</style>
