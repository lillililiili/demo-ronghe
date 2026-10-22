<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import UField from '@/components/form/UField.vue';
import UControl from '@/components/form/UControl.vue';
import UFormFooter from '@/components/form/UFormFooter.vue';
import { idempotencyKey } from '@/services/apiClient.js';
import { airspaceApi } from '@/services/airspaceApi.js';
import { beijingWallClock } from '@/services/timeFilter.js';
import { AIRSPACE_KIND_LABEL } from '@/ui/labels.js';
import AirspaceVolumeEditor from './AirspaceVolumeEditor.vue';
import { closeBoundary, openBoundary, validateVolume, editableSeaLevelBounds } from './airspaceVolume.js';

const props = defineProps({ airspaceId: { type: String, default: '' } });
const emit = defineEmits(['saved', 'cancel']);
const editing = !!props.airspaceId;
const loading = ref(true), saving = ref(false), error = ref(''), blocked = ref('');
const scopes = ref([]), detail = ref(null), latest = ref(null), pending = ref(null);
const polygons = ref([[[]]]), part = ref(0), ring = ref(0), scopeKey = ref('');
const form = reactive({ name: '', airspace_no: '', kind_code: 'PERMITTED', lower: null, upper: null,
  immediate: true, start: null, end: null, reason: '' });
let alive = true;
onUnmounted(() => { alive = false; });
const disabled = computed(() => loading.value || saving.value || !!pending.value || !!blocked.value);
const selectedScope = computed(() => scopes.value.find(item => `${item.owner_org_id}:${item.district_id}` === scopeKey.value));
const scopeOptions = computed(() => scopes.value.map(item => ({ value: `${item.owner_org_id}:${item.district_id}`,
  label: `${item.owner_org_name || item.owner_org_id} / ${item.district_name || item.district_id}` })));
const partOptions = computed(() => polygons.value.map((_, index) => ({ value: index, label: `区域 ${index + 1}` })));
const ringOptions = computed(() => (polygons.value[part.value] || []).map((_, index) => ({ value: index, label: index ? `内孔 ${index}` : '外边界' })));
const activeRing = computed(() => polygons.value[part.value]?.[ring.value] || []);
const kindOptions = Object.entries(AIRSPACE_KIND_LABEL).filter(([value]) => ['PROHIBITED', 'RESTRICTED', 'ALTITUDE_LIMIT', 'PERMITTED', 'TEMPORARY_CONTROL'].includes(value)).map(([value, label]) => ({ value, label }));
const scheduled = computed(() => latest.value && latest.value.valid_from > Date.now());
const validation = computed(() => validateVolume(polygons.value, form.lower, form.upper));
const chinaTime = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
function pickerTime(value) {
  if (value == null) return null;
  const date = new Date(value + 8 * 3600_000);
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()).getTime();
}
async function load() {
  loading.value = true; error.value = ''; blocked.value = '';
  try {
    if (editing) {
      const first = await airspaceApi.detail(props.airspaceId);
      const versions = await airspaceApi.versions(props.airspaceId, { page: 1, size: 1 });
      const current = await airspaceApi.detail(props.airspaceId);
      if (!alive) return;
      if (first.version !== current.version) throw new Error('空域刚被更新，请重新读取后编辑。');
      if (!current.editable) throw new Error('当前空域已删除、来源依据不完整或没有维护权限，请刷新资料。');
      const version = versions.items?.[0];
      if (!version) throw new Error('没有可编辑的空域版本。');
      detail.value = current; latest.value = version;
      Object.assign(form, { name: current.name, airspace_no: current.airspace_no, kind_code: version.kind_code,
        ...editableSeaLevelBounds(version),
        immediate: version.valid_from < Date.now(), start: pickerTime(Math.max(Date.now(), version.valid_from + 1000)),
        end: pickerTime(version.valid_to), reason: '' });
      polygons.value = openBoundary(version.boundary);
    } else {
      const context = await airspaceApi.managementContext();
      if (!alive) return;
      scopes.value = context.scopes || [];
      if (!scopes.value.length) blocked.value = '没有可维护的单位与区县范围，请联系管理员配置。';
      if (scopes.value.length === 1) scopeKey.value = scopeOptions.value[0].value;
      form.start = pickerTime(Date.now());
    }
  } catch (reason) { if (alive) blocked.value = reason.message || '读取空域资料失败。'; }
  finally { if (alive) loading.value = false; }
}
onMounted(load);
function updatePoint(index, value) { if (!disabled.value) activeRing.value.splice(index, 1, value); }
function appendPoint(value = [null, null]) { if (!disabled.value) activeRing.value.push(value); }
function addPart() { polygons.value.push([[]]); part.value = polygons.value.length - 1; ring.value = 0; }
function addHole() { polygons.value[part.value].push([]); ring.value = polygons.value[part.value].length - 1; }
function removeRing() {
  if (ring.value) { polygons.value[part.value].splice(ring.value, 1); ring.value = 0; }
  else if (polygons.value.length > 1) { polygons.value.splice(part.value, 1); part.value = 0; ring.value = 0; }
}
function buildBody() {
  if (!form.name.trim()) throw new Error('请填写空域名称。');
  if (!editing && !form.airspace_no.trim()) throw new Error('请填写空域编号。');
  if (form.name.trim().length > 128 || form.airspace_no.trim().length > 64) throw new Error('名称最多 128 个字，编号最多 64 个字符。');
  if (!editing && !selectedScope.value) throw new Error('请选择管理单位与所属区县。');
  if (validation.value) throw new Error(validation.value);
  if (!form.reason.trim() || form.reason.trim().length > 256) throw new Error('请填写变更原因（不超过 256 个字）。');
  const start = form.immediate ? Date.now() : form.start == null ? null : beijingWallClock(form.start);
  const end = form.end == null ? null : beijingWallClock(form.end);
  if (start == null || !Number.isFinite(start)) throw new Error('请选择生效时间。');
  if (latest.value && start <= latest.value.valid_from) throw new Error('新版本生效时间必须晚于上一版生效时间。');
  if (end != null && end <= start) throw new Error('失效时间必须晚于生效时间。');
  const body = { name: form.name.trim(), kind_code: form.kind_code, boundary: closeBoundary(polygons.value),
    min_altitude_m: form.lower, max_altitude_m: form.upper, altitude_datum: 'AMSL', valid_from: start, valid_to: end,
    change_reason: form.reason.trim() };
  if (editing) body.expected_version = detail.value.version;
  else Object.assign(body, { airspace_no: form.airspace_no.trim(), owner_org_id: selectedScope.value.owner_org_id, district_id: selectedScope.value.district_id });
  return body;
}
async function save() {
  if (loading.value || saving.value || blocked.value) return;
  error.value = '';
  try {
    if (!pending.value) pending.value = { body: buildBody(), key: idempotencyKey() };
    saving.value = true;
    const request = pending.value;
    const result = editing ? await airspaceApi.update(props.airspaceId, request.body, request.key) : await airspaceApi.create(request.body, request.key);
    if (alive) emit('saved', result);
  } catch (reason) {
    if (!alive) return;
    const uncertain = pending.value && (reason.status === 0 || reason.status >= 500);
    error.value = uncertain ? '保存结果暂不确定。可以重试同一次提交，或关闭后刷新列表核对结果；请勿另建重复空域。' : reason.message || '保存失败。';
    if (!uncertain) pending.value = null;
  } finally { if (alive) saving.value = false; }
}
</script>

<template>
  <div class="airspace-editor-form">
    <p v-if="loading" role="status">正在读取空域资料…</p>
    <div v-else-if="blocked" class="warnbox" role="alert">{{ blocked }} <button class="btn ghost" type="button" @click="load">重新读取</button></div>
    <template v-else>
      <div class="editor-summary">{{ editing ? '编辑后保存为新版本，原版本留存。' : '创建本地空域。' }} 经纬度采用 WGS84，所有高度均为海拔米值。</div>
      <p v-if="detail?.management_source === 'UPSTREAM'" class="editor-hint">此空域由上级下发，本次修改保存在本平台，原下发来源及历史版本保留。</p>
      <p v-if="latest && latest.altitude_datum !== 'AMSL'" class="editor-hint">{{ latest.altitude_datum === 'AGL' ? '原版本采用离地高度' : '原版本未提供明确的海拔高度' }}，请重新填写有依据的海拔上下限，不自动换算原高度。</p>
      <div class="editor-layout">
        <div class="editor-scene">
          <AirspaceVolumeEditor :polygons="polygons" :lower="form.lower" :upper="form.upper" :part="part" :ring="ring" :disabled="disabled"
            @point="updatePoint" @append="appendPoint" @lower="form.lower = $event" @upper="form.upper = $event" />
          <div class="editor-altitudes">
            <UField id="airspace-min-altitude" v-model="form.lower" type="number" label="海拔下限（米）" required :disabled="disabled" />
            <UField id="airspace-max-altitude" v-model="form.upper" type="number" label="海拔上限（米）" required :disabled="disabled" />
          </div>
          <div class="editor-grid">
            <UField id="airspace-name" v-model="form.name" label="空域名称" required :disabled="disabled" />
            <UField id="airspace-no" v-model="form.airspace_no" label="空域编号" required :disabled="disabled || editing" />
            <UField id="airspace-kind" v-model="form.kind_code" type="select" label="空域种类" :options="kindOptions" required :disabled="disabled" />
            <UField v-if="!editing" id="airspace-scope" v-model="scopeKey" type="select" label="管理单位 / 所属区县" :options="scopeOptions" required :disabled="disabled" filterable />
            <p v-else class="editor-scope">管理单位：{{ detail.owner_org_name }}<br>所属区县：{{ detail.district_name }}</p>
            <UField id="airspace-immediate" v-model="form.immediate" type="checkbox" label="保存后立即生效" :disabled="disabled || !!scheduled" />
            <UField v-if="!form.immediate" id="airspace-start" v-model="form.start" type="datetime" label="生效时间（北京时间）" required :disabled="disabled" />
            <UField id="airspace-end" v-model="form.end" type="datetime" label="失效时间（北京时间）" help="不填为长期有效" clearable :disabled="disabled" />
          </div>
          <p v-if="scheduled" class="editor-hint">已有待生效版本，新版本须晚于 {{ chinaTime(latest.valid_from) }} 生效。</p>
          <UField id="airspace-change-reason" v-model="form.reason" type="textarea" label="变更原因" required :min-rows="2" :disabled="disabled" />
        </div>
        <section class="editor-boundary" aria-label="空域边界坐标">
          <div class="boundary-heading"><b>边界经纬度</b><span>首尾自动闭合</span></div>
          <div class="boundary-selectors">
            <UControl :model-value="part" type="select" aria-label="选择区域" :options="partOptions" :disabled="disabled" @update:model-value="part = $event; ring = 0" />
            <UControl v-model="ring" type="select" aria-label="选择边界" :options="ringOptions" :disabled="disabled" />
          </div>
          <div class="boundary-tools">
            <button class="btn ghost" type="button" :disabled="disabled" @click="addPart">添加区域</button>
            <button class="btn ghost" type="button" :disabled="disabled" @click="addHole">添加内孔</button>
            <button v-if="ring || polygons.length > 1" class="btn ghost" type="button" :disabled="disabled" @click="removeRing">移除此{{ ring ? '内孔' : '区域' }}</button>
          </div>
          <p v-if="!activeRing.length" class="editor-hint">添加至少三个边界点。填好首个点后，也可在三维视图中描点。</p>
          <ol class="coordinate-list">
            <li v-for="(point, index) in activeRing" :key="`${part}-${ring}-${index}`">
              <div class="coordinate-title"><b>边界点 {{ index + 1 }}</b><button class="linkbtn" type="button" :aria-label="`移除边界点 ${index + 1}`" :disabled="disabled" @click="activeRing.splice(index, 1)">移除</button></div>
              <div class="coordinate-pair">
                <UField :id="`longitude-${index}`" v-model="point[0]" type="number" :label="`经度 ${index + 1}`" :min="-180" :max="180" :disabled="disabled" size="small" />
                <UField :id="`latitude-${index}`" v-model="point[1]" type="number" :label="`纬度 ${index + 1}`" :min="-90" :max="90" :disabled="disabled" size="small" />
              </div>
            </li>
          </ol>
          <button class="btn" type="button" :disabled="disabled" @click="appendPoint()">添加边界点</button>
          <p v-if="validation" class="editor-hint">{{ validation }}</p>
        </section>
      </div>
    </template>
    <p v-if="error" class="warnbox" role="alert">{{ error }}</p>
    <UFormFooter :loading="saving" :disabled="loading || !!blocked" :confirm-text="pending && !saving ? '重试本次保存' : '保存空域'" @confirm="save" @cancel="emit('cancel')" />
  </div>
</template>

<style scoped>
.airspace-editor-form { min-width: 0; }
.editor-summary { margin-bottom: 12px; color: var(--txt-2); font-size: 13px; line-height: 1.7; }
.editor-layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
.editor-scene { min-width: 0; }
.editor-grid, .editor-altitudes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
.editor-altitudes { padding: 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel-2); }
.editor-grid { margin-bottom: 14px; }
.editor-scope, .editor-hint { margin: 0; color: var(--txt-2); font-size: 12px; line-height: 1.8; }
.editor-boundary { border: 1px solid var(--line); border-radius: 6px; padding: 12px; display: flex; gap: 12px; flex-direction: column; min-width: 0; }
.boundary-heading, .coordinate-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.boundary-heading span { font-size: 12px; color: var(--txt-3); }
.boundary-selectors { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.boundary-tools { display: flex; gap: 6px; flex-wrap: wrap; }
.boundary-tools .btn { padding: 5px 8px; font-size: 12px; }
.coordinate-list { list-style: none; margin: 0; padding: 0; max-height: 490px; overflow-y: auto; display: grid; gap: 12px; }
.coordinate-list li { padding-bottom: 10px; border-bottom: 1px solid var(--line); }
.coordinate-title { font-size: 12px; margin-bottom: 8px; }
.coordinate-pair { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 8px; }
.warnbox { margin-top: 12px; }
@media (max-width: 900px) { .editor-layout { grid-template-columns: minmax(0,1fr); } .coordinate-list { max-height: 340px; } }
@media (max-width: 480px) { .editor-grid, .editor-altitudes { grid-template-columns: minmax(0,1fr); } }
</style>
