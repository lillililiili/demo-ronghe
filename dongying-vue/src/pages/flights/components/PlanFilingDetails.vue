<script setup>
import { userFacingMessage } from '@/ui/labels.js';
import { computed, onUnmounted, ref, watch } from 'vue';
import { flightApi } from '@/services/flightApi.js';
import { displayPlanNo, displayRouteNo } from '@/ui/deviceNumber.js';
import { planWindowText } from '@/pages/flights/planFilters.js';

const props = defineProps({
  plan: { type: Object, required: true }, routeVersion: { type: Object, default: null },
  routeLoading: Boolean, routeError: { type: String, default: '' }
});
const filing = computed(() => props.plan.filing || {});
const subjects = ref(null), subjectsLoading = ref(false), subjectsError = ref('');
let requestVersion = 0;
async function loadSubjects() {
  const current = ++requestVersion, id = props.plan.plan_id;
  subjects.value = null; subjectsError.value = ''; subjectsLoading.value = true;
  if (!id) { subjectsLoading.value = false; return; }
  try {
    const result = await flightApi.subjects(id);
    if (current !== requestVersion) return;
    if (result?.plan_id !== id) throw new Error('关联资料与当前任务不一致，请重新读取。');
    subjects.value = result;
  } catch (error) {
    if (current === requestVersion) subjectsError.value = error.message || '单位与飞手关联信息暂时无法读取';
  } finally {
    if (current === requestVersion) subjectsLoading.value = false;
  }
}
watch(() => [props.plan.plan_id, props.plan.version], loadSubjects, { immediate: true });
onUnmounted(() => { requestVersion++; });
function value(text) { return typeof text === 'string' && text.trim() ? text : '未提供'; }
function time(at) { return at == null || !Number.isFinite(Number(at)) ? '未提供' : new Date(Number(at)).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }); }
function position(lon, lat) {
  if (lon == null || lat == null || !Number.isFinite(Number(lon)) || !Number.isFinite(Number(lat))) return '';
  return `${Number(lon).toFixed(6)}, ${Number(lat).toFixed(6)}（WGS-84）`;
}
const altitude = computed(() => {
  const route = props.routeVersion;
  const width = route?.corridor_width_m == null ? '' : ` · 宽 ${route.corridor_width_m} 米`;
  if (route?.min_altitude_m == null || route?.max_altitude_m == null) return width ? `高度未提供${width}` : '未提供';
  const datum = { AMSL: '海拔', AGL: '距地' }[route.altitude_datum] || '高度基准未提供';
  return `${route.min_altitude_m}～${route.max_altitude_m} 米（${datum}）${width}`;
});
/* 2026-10-08 用户要求信息更精简：有值的项逐行列出，没提供的项合成一行“未提供：……”。 */
const operatorName = computed(() => subjects.value?.operator_org_name || filing.value.operator_name || '');
const pilotName = computed(() => subjects.value?.pilot_name || filing.value.pilot_name || '');
const reportingName = computed(() => subjects.value?.reporting_org_name || '');
const uavSn = computed(() => (typeof props.plan.uav_sn === 'string' ? props.plan.uav_sn.trim() : ''));
const missingFields = computed(() => [
  !operatorName.value.trim() && '报备单位',
  !pilotName.value.trim() && '执行飞手',
  subjects.value && !reportingName.value.trim() && '报送单位',
  !uavSn.value && '无人机编号'
].filter(Boolean));
const sites = computed(() => {
  const from = filing.value.takeoff_site_name?.trim(), to = filing.value.landing_site_name?.trim();
  if (!from && !to) return '';
  return `${from || '未提供'} → ${to || '未提供'}`;
});
const sitesTitle = computed(() => [position(filing.value.takeoff_longitude, filing.value.takeoff_latitude), position(filing.value.landing_longitude, filing.value.landing_latitude)]
  .map((text, index) => text && `${index ? '降落点' : '起飞点'} ${text}`).filter(Boolean).join('\n'));
const routeMeta = computed(() => {
  const no = displayRouteNo(props.plan.route?.route_no) || props.plan.route?.route_no || '';
  const version = props.plan.route?.version_no == null ? '' : `v${props.plan.route.version_no}`;
  return [no, version].filter(Boolean).join(' · ');
});
</script>

<template>
  <section class="sect plan-filing">
    <div class="filing-col">
    <div class="workspace-section-heading"><h4>任务信息</h4></div>
    <dl class="kv kv-surface plan-info-card">
      <dt>任务编号</dt><dd :title="plan.plan_no">{{ displayPlanNo(plan.plan_no) || value(plan.plan_no) }} <span v-if="plan.source_mode === 'mock'" class="tag t-amber">模拟任务</span></dd>
      <template v-if="operatorName.trim()"><dt>报备单位</dt><dd>
        <span>{{ operatorName }}</span>
        <small v-if="subjects?.operator_org_id && filing.operator_name && subjects.operator_org_name !== filing.operator_name">申报时名称：{{ filing.operator_name }}</small>
        <small v-if="subjects && !subjects.operator_org_id">单位档案待关联</small>
      </dd></template>
      <template v-if="pilotName.trim()"><dt>执行飞手</dt><dd>
        {{ pilotName }}
        <small v-if="subjects?.pilot_contact_id && filing.pilot_name && subjects.pilot_name !== filing.pilot_name">申报时姓名：{{ filing.pilot_name }}</small>
        <small v-if="subjects?.pilot_contact_hint">{{ subjects.pilot_contact_hint }}</small>
        <small v-if="subjects && !subjects.pilot_contact_id">飞手档案待关联</small>
      </dd></template>
      <template v-if="reportingName.trim()"><dt>报送单位</dt><dd>{{ reportingName }}</dd></template>
      <template v-if="uavSn"><dt>无人机编号</dt><dd>{{ uavSn }}</dd></template>
      <template v-if="missingFields.length"><dt>未提供</dt><dd class="muted">{{ missingFields.join('、') }}</dd></template>
    </dl>
    <p v-if="subjectsLoading" class="subjects-note" role="status">正在读取单位与飞手关联</p>
    <p v-else-if="subjectsError" class="subjects-note" role="alert">关联信息暂时无法读取：{{ subjectsError }} <button class="btn ghost" type="button" @click="loadSubjects">重试关联信息</button></p>
    <details class="subjects-details">
      <summary>更多信息</summary>
      <dl class="kv kv-surface">
        <dt>所属范围</dt><dd>{{ value(plan.owner_org_name) }} / {{ value(plan.district_name) }}</dd>
        <dt>任务来源</dt><dd>{{ value(plan.source?.source_name || plan.source?.source_code) }}</dd>
        <template v-if="subjects?.feedback_recipient">
          <dt>任务反馈对象</dt><dd>{{ subjects.feedback_recipient.org_name || subjects.feedback_recipient.recipient_name || '尚未配置' }}</dd>
          <template v-if="subjects.feedback_recipient.contact_name"><dt>联系人员</dt><dd>{{ subjects.feedback_recipient.contact_name }}<small v-if="subjects.feedback_recipient.contact_hint">{{ subjects.feedback_recipient.contact_hint }}</small></dd></template>
          <dt>通知准备情况</dt><dd>{{ userFacingMessage(subjects.feedback_recipient.blocked_reason) || (subjects.feedback_recipient.configured ? '接收配置已就绪，发送前会再次校验' : '接收配置尚未就绪，请联系管理员核对接收单位和通知渠道。') }}</dd>
        </template>
        <template v-else-if="subjects"><dt>任务反馈对象</dt><dd>尚未配置</dd></template>
      </dl>
      <p v-if="subjects">报备单位、报送单位和飞手档案由后台维护；申报时名称保留在本任务中。 <button class="btn ghost" type="button" @click="loadSubjects">刷新关联信息</button></p>
    </details>
    </div>
    <div class="filing-col">
    <h4 class="route-heading">时间与航线</h4>
    <dl class="kv kv-surface">
      <dt>时间</dt><dd :title="`${time(plan.start_at)} 至 ${time(plan.end_at)}`">{{ planWindowText(plan) }}</dd>
      <template v-if="sites"><dt>起降点</dt><dd :title="sitesTitle">{{ sites }}</dd></template>
      <dt>航线</dt><dd><span class="route-name">{{ value(plan.route?.name) }}</span><span v-if="routeMeta" class="muted">（{{ routeMeta }}）</span></dd>
      <template v-if="routeLoading"><dt>高度宽度</dt><dd>正在读取</dd></template>
      <template v-else-if="routeError"><dt>高度宽度</dt><dd class="muted">{{ routeError }}</dd></template>
      <template v-else><dt>高度宽度</dt><dd>{{ altitude }}</dd></template>
    </dl>
    </div>
  </section>
</template>

<style scoped>
.workspace-section-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.workspace-section-heading h4 { margin: 0; }
.plan-filing h4 { --section-color: var(--blue); border-left: 3px solid var(--section-color); padding-left: 8px; color: var(--txt); font-size: 13px; line-height: 1.6; }
.plan-filing h4::before { display: none; }
.plan-filing .route-heading { --section-color: var(--purple); }
.plan-filing .filing-col > h4 { margin-top: 12px; }
/* 详情栏够宽时（见 FlightsPage 的 flight-detail 容器）左栏任务信息、右栏时间与航线，减少上下滚动。 */
@container flight-detail (min-width: 560px) {
  .plan-filing .filing-col > h4:first-child, .plan-filing .filing-col > .workspace-section-heading:first-child h4 { margin-top: 0; }
  .plan-filing .filing-col > .kv-surface:last-child { border-bottom: 0; }
  .plan-filing .filing-col { margin-bottom: 10px; }
}
.plan-filing .kv-surface { padding: 7px 0; border: 0; border-bottom: 1px solid var(--line-2); border-radius: 0; background: transparent; }
.plan-filing .plan-info-card {
  padding: 10px 11px;
  border: 1px solid color-mix(in srgb, var(--blue) 20%, var(--line-2));
  border-radius: 7px;
  background: color-mix(in srgb, var(--blue) 5%, var(--panel-2));
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--blue) 7%, transparent);
}
.plan-filing dd { min-width: 0; overflow-wrap: anywhere; }
.plan-filing dd small { display: block; color: var(--txt-3); font-size: 11px; line-height: 1.6; margin-top: 3px; }
.plan-filing .tag { margin: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
.plan-filing .route-name { color: var(--purple); }
.subjects-note, .subjects-details { margin: 8px 0; font-size: 12px; line-height: 1.7; color: var(--txt-3); overflow-wrap: anywhere; }
.subjects-details summary { cursor: pointer; color: var(--txt-2); }
.subjects-details p { margin: 7px 0; }
.subjects-details .kv-surface { margin-top: 6px; }
.subjects-note .btn, .subjects-details .btn { white-space: normal; }
</style>
