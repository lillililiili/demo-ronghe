<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { airspaceApi } from '@/services/airspaceApi.js';
const props = defineProps({ airspaceId: { type: String, required: true } });
const data = ref(null), loading = ref(false), error = ref(''), page = ref(1);
let sequence = 0;
const labels = { APPLICABLE: '当前适用', SCHEDULED: '待生效', EXPIRED: '已过期', WITHDRAWN: '已停用', UNPUBLISHED: '尚未发布', AIRSPACE_INACTIVE: '空域未生效', UNKNOWN: '适用性未知', HISTORICAL: '历史关联' };
const sources = { live: '正式配置', mock: '模拟配置', replay: '回放配置' };
const current = computed(() => data.value?.current);
const tag = computed(() => current.value?.applicability === 'APPLICABLE' ? 't-green' : current.value?.applicability === 'WITHDRAWN' ? 't-red' : 't-amber');
const fields = [{ key: 'trigger_basis', label: '触发依据与时效要求' }, { key: 'action_steps', label: '处置行动说明' }, { key: 'manual_conditions', label: '人工介入与授权条件' }, { key: 'failure_handling', label: '失败、超时与未知情况处理' }];
function time(value) { return value == null ? '未记录' : new Date(value).toLocaleString('zh-CN', { hour12: false }); }
async function load() {
  const seq = ++sequence, id = props.airspaceId;
  data.value = null; error.value = ''; loading.value = true;
  try {
    const result = await airspaceApi.responsePlan(id, { page: page.value, size: 5 });
    if (seq !== sequence) return;
    if (result?.airspace_id !== id || !result.history || !Array.isArray(result.history.items)) throw new Error('预案响应不完整，请重试');
    data.value = result;
  } catch (e) {
    if (seq === sequence) error.value = e.status === 403 ? '当前账号没有查看此空域预案的权限。' : e.status === 401 ? '登录已失效，请重新登录。' : e.status === 404 ? '无法读取此空域预案，请确认空域可见且服务已更新。' : e.message || '预案读取失败，请重试。';
  } finally { if (seq === sequence) loading.value = false; }
}
function historyPage(value) { page.value = value; load(); }
watch(() => props.airspaceId, () => { page.value = 1; load(); }, { immediate: true });
onBeforeUnmount(() => { sequence += 1; });
</script>
<template>
  <section class="response-plan" aria-label="本空域处置预案" :aria-busy="loading">
    <div class="heading"><b>处置预案</b><span v-if="current" class="tag" :class="tag">{{ labels[current.applicability] || '适用性未知' }}</span><button class="btn" type="button" :disabled="loading" @click="load">刷新预案</button></div>
    <p v-if="loading" role="status">正在读取预案关联</p>
    <p v-else-if="error" class="warnbox" role="alert">{{ error }}</p>
    <template v-else-if="data">
      <template v-if="current">
        <h4>{{ current.plan.name }} · 第 {{ current.plan.revision }} 版</h4>
        <p><span class="tag t-blue">{{ sources[current.plan.source_mode] || '来源未知' }}</span></p>
        <p>{{ current.applicability_reason }}</p>
        <dl><dt>有效期</dt><dd>{{ time(current.plan.valid_from) }} 至 {{ current.plan.valid_to == null ? '长期有效' : time(current.plan.valid_to) }}</dd><dt>发布</dt><dd>{{ current.plan.published_by || '未记录' }} · {{ time(current.plan.published_at) }}</dd><dt>关联</dt><dd>{{ current.bound_by }} · {{ time(current.bound_at) }}<br>{{ current.reason }}</dd><dt>预案更新</dt><dd>{{ time(current.plan.updated_at) }}</dd></dl>
        <details :key="current.binding_id"><summary>查看预案内容与处置要求</summary><section v-for="field in fields" :key="field.key"><h4>{{ field.label }}</h4><p class="content">{{ current.plan[field.key] }}</p></section></details>
      </template>
      <p v-else>此空域尚未关联处置预案。请在后台管理端“系统管理 → 规则管理 → 原处置预案”配置、发布并关联。</p>
      <p class="note">预案提供处置说明；实际短信、电话录音通知和反制执行结果请查看对应告警事件。发布或关联预案不会触发执行。</p>
      <p class="note">查询时间：{{ time(data.checked_at) }}</p>
      <details v-if="data.history.total" :key="`${airspaceId}-history`"><summary>关联历史（{{ data.history.total }} 条）</summary>
        <article v-for="item in data.history.items" :key="item.binding_id">
          <h4>{{ item.plan.name }} · 第 {{ item.plan.revision }} 版</h4><p>{{ sources[item.plan.source_mode] || '来源未知' }} · 历史关联</p>
          <p>{{ time(item.bound_at) }} 至 {{ time(item.ended_at) }}</p><p>{{ item.bound_by }} 关联：{{ item.reason }}</p><p>{{ item.ended_by }} 解除：{{ item.end_reason }}</p>
          <details><summary>查看该版本内容</summary><section v-for="field in fields" :key="field.key"><h4>{{ field.label }}</h4><p class="content">{{ item.plan[field.key] }}</p></section></details>
        </article>
      </details>
      <div v-if="data.history.total > 5" class="heading"><button type="button" class="btn" :disabled="page <= 1" @click="historyPage(page - 1)">上一页历史</button><span>第 {{ page }} 页</span><button type="button" class="btn" :disabled="page * 5 >= data.history.total" @click="historyPage(page + 1)">下一页历史</button></div>
    </template>
  </section>
</template>
<style scoped>
.response-plan { border-top: 1px solid var(--line); padding-top: 16px; margin-top: 16px; color: var(--txt); }
.heading { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.heading b { margin-right: auto; }
h4, p, dd, summary { overflow-wrap: anywhere; white-space: normal; line-height: 1.7; }
h4 { margin: 12px 0 6px; } p { margin: 8px 0; }
dl { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 8px; margin: 12px 0; }
dd { margin: 0; } dt, .note { color: var(--txt-2); }
summary { color: var(--cyan); cursor: pointer; }
.content { white-space: pre-wrap; }
article { border-top: 1px solid var(--line); padding: 8px 0; }
</style>
