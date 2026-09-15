<script setup>
import { computed } from 'vue';

const props = defineProps({
  plan: { type: Object, required: true }, routeVersion: { type: Object, default: null },
  routeLoading: Boolean, routeError: { type: String, default: '' }
});
const filing = computed(() => props.plan.filing || {});
function value(text) { return typeof text === 'string' && text.trim() ? text : '未提供'; }
function time(at) { return at == null || !Number.isFinite(Number(at)) ? '未提供' : new Date(Number(at)).toLocaleString('zh-CN', { hour12: false }); }
function position(lon, lat) {
  if (lon == null || lat == null || !Number.isFinite(Number(lon)) || !Number.isFinite(Number(lat))) return '';
  return `${Number(lon).toFixed(6)}, ${Number(lat).toFixed(6)}（WGS-84）`;
}
const altitude = computed(() => {
  const route = props.routeVersion;
  if (route?.min_altitude_m == null || route?.max_altitude_m == null) return '未提供';
  const datum = { AMSL: '海拔高度', AGL: '距地高度' }[route.altitude_datum] || '高度基准未提供';
  return `${route.min_altitude_m} ～ ${route.max_altitude_m} 米（${datum}）`;
});
</script>

<template>
  <section class="sect plan-filing">
    <div class="workspace-section-heading"><h4>计划信息</h4></div>
    <dl class="kv kv-surface">
      <dt>计划编号</dt><dd>{{ value(plan.plan_no) }} <span v-if="plan.source_mode === 'mock'" class="tag t-gray">模拟计划</span></dd>
      <dt>报备单位</dt><dd>{{ value(filing.operator_name) }}</dd>
      <dt>执行飞手</dt><dd>{{ value(filing.pilot_name) }}</dd>
      <dt>无人机身份</dt><dd><span class="muted">SN：</span>{{ value(plan.uav_sn) }}</dd>
      <dt>所属范围</dt><dd>{{ value(plan.owner_org_name) }} / {{ value(plan.district_name) }}</dd>
      <dt>计划来源</dt><dd>{{ value(plan.source?.source_name || plan.source?.source_code) }}</dd>
    </dl>
    <h4>起降点与时间</h4>
    <dl class="kv kv-surface">
      <dt>起飞点</dt><dd>{{ value(filing.takeoff_site_name) }}<small v-if="position(filing.takeoff_longitude, filing.takeoff_latitude)">{{ position(filing.takeoff_longitude, filing.takeoff_latitude) }}</small></dd>
      <dt>降落点</dt><dd>{{ value(filing.landing_site_name) }}<small v-if="position(filing.landing_longitude, filing.landing_latitude)">{{ position(filing.landing_longitude, filing.landing_latitude) }}</small></dd>
      <dt>时间窗口</dt><dd>{{ time(plan.start_at) }} ～ {{ time(plan.end_at) }}</dd>
    </dl>
    <h4>报备航线</h4>
    <dl class="kv kv-surface">
      <dt>航线名称</dt><dd>{{ value(plan.route?.name) }}</dd>
      <dt>航线编号</dt><dd>{{ value(plan.route?.route_no) }}</dd>
      <dt>使用版本</dt><dd>{{ plan.route?.version_no == null ? '未提供' : `v${plan.route.version_no}` }}</dd>
      <template v-if="routeLoading"><dt>航线范围</dt><dd>正在读取…</dd></template>
      <template v-else-if="routeError"><dt>航线范围</dt><dd class="muted">{{ routeError }}</dd></template>
      <template v-else>
        <dt>飞行高度</dt><dd>{{ altitude }}</dd>
        <dt>航线宽度</dt><dd>{{ routeVersion?.corridor_width_m == null ? '未提供' : `${routeVersion.corridor_width_m} 米` }}</dd>
      </template>
    </dl>
  </section>
</template>

<style scoped>
.workspace-section-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.workspace-section-heading h4 { margin: 0; }
.plan-filing > h4 { margin-top: 12px; }
.plan-filing .kv-surface { padding: 7px 0; border: 0; border-bottom: 1px solid var(--line-2); border-radius: 0; background: transparent; }
.plan-filing dd { min-width: 0; overflow-wrap: anywhere; }
.plan-filing dd small { display: block; color: var(--txt-3); font-size: 11px; line-height: 1.6; margin-top: 3px; }
.plan-filing .tag { margin-left: 4px; }
</style>
