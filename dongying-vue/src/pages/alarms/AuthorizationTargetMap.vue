<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { targetApi } from '@/services/targetApi.js';
import { coordOf } from '@/services/positionMap.js';
import { measuredMapPoints } from '@/services/trackPoints.js';
import { SOURCE_MODE_LABEL, labelOf, targetTypeLabel } from '@/ui/labels.js';
import { hasPermission } from '@/services/accessControl.js';

const props = defineProps({ targetId: { type: String, default: '' }, unavailableReason: { type: String, default: '' } });
const host = ref(null), loading = ref(false), error = ref(''), target = ref(null), points = ref([]), trackError = ref(''), trackMode = ref('');
const reason = computed(() => props.unavailableReason || (!props.targetId ? '未提供可读取的关联目标' : '') || (!hasPermission('target:read') ? '当前账号没有目标读取权限' : ''));
const observedAt = computed(() => target.value?.latest_state?.observed_at || points.value.at(-1)?.t);
const formatTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12:false }) : '未提供';
let map, generation = 0, alive = true;
function destroyMap() { map?.destroy(); map = null; }
function locate() {
  if (!map) return;
  const state = target.value?.latest_state;
  const anchor = coordOf(state?.location, state?.field_issues, 'location') || points.value.at(-1);
  if (!anchor) return;
  map._resize();
  if (points.value.length > 1) map.fitTo([...points.value.map(p => [p.lon, p.lat]), [anchor.lon, anchor.lat]], .18);
  else map.centerAt(anchor.lon, anchor.lat);
}
async function load() {
  const token = ++generation, id = props.targetId;
  destroyMap(); target.value = null; points.value = []; error.value = ''; trackError.value = ''; trackMode.value = ''; loading.value = false;
  if (reason.value) return;
  loading.value = true;
  const current = () => alive && token === generation && id === props.targetId;
  try {
    const result = await targetApi.detail(id);
    if (!current()) return;
    if (result?.target_id !== id) throw new Error('目标信息不一致，已停止显示');
    target.value = result;
    try {
      const tracks = await targetApi.tracks(id, { page:1, size:1 });
      if (!current()) return;
      const track = tracks?.items?.[0];
      if (track) {
        const data = await targetApi.pointsAll(track.track_id);
        if (!current()) return;
        points.value = measuredMapPoints(data?.items || []);
        trackMode.value = track.source_mode || '';
      }
    } catch (e) { if (current()) trackError.value = e.message || '轨迹读取失败'; }
    if (!current()) return;
    const state = result.latest_state;
    const anchor = coordOf(state?.location, state?.field_issues, 'location') || points.value.at(-1);
    if (!anchor) throw new Error('没有可信位置，暂时无法定位');
    await nextTick();
    if (!current() || !host.value) return;
    map = new window.MapView(host.value, { legend:false, layers:{ device:false, alarm:false, flightPlan:false } });
    const item = { id:result.target_no || id, targetId:id, lon:anchor.lon, lat:anchor.lat,
      objectTypeCode:result.object_type_code, subtypeCode:result.subtype,
      type:targetTypeLabel(null, result.object_type_code, '目标'), subtype:targetTypeLabel(result.subtype, result.object_type_code, '目标'),
      sourceMode:result.source_mode, statusCode:result.status_code || result.track_status?.status || '',
      freshness:result.freshness || '', stale:result.stale === true,
      alt:state?.altitude_amsl_m ?? null, speed:state?.speed_mps ?? null, heading:state?.heading_deg ?? 0,
      legal:'—', risk:'—', tracked:true, track:points.value };
    map.sel = item.id; map.setData({ targets:[item], devices:[], alarms:[], airspaces:[] }); locate();
  } catch (e) { if (current()) { destroyMap(); error.value = e.message || '目标位置读取失败'; } }
  finally { if (current()) loading.value = false; }
}
watch([() => props.targetId, reason], load, { immediate:true });
onUnmounted(() => { alive = false; ++generation; destroyMap(); });
</script>

<template>
  <section class="authorization-target-map" aria-label="关联目标定位与轨迹">
    <header><strong>目标位置与轨迹</strong><div><button type="button" class="btn" :disabled="loading || !!reason" @click="load">刷新</button><button type="button" class="btn" :disabled="loading || !!reason || !!error" @click="locate">定位</button></div></header>
    <p v-if="reason" class="map-note" role="status">{{ reason }}</p>
    <p v-else-if="error" class="map-note warning" role="alert">{{ error }}</p>
    <p v-if="loading" class="map-note" role="status">正在读取目标位置与轨迹</p>
    <div v-show="!reason && !error" ref="host" class="map-canvas"></div>
    <div v-if="target" class="map-facts">
      <span>{{ target.target_no || '目标编号未提供' }} · {{ labelOf(SOURCE_MODE_LABEL, trackMode || target.source_mode, '来源未知') }}</span>
      <span>末次观测 {{ formatTime(observedAt) }}</span>
      <span v-if="target.stale === true" class="warning">观测已失效，图示位置不代表当前实时位置</span>
      <span v-if="trackError" class="warning">轨迹读取失败：{{ trackError }}</span>
      <span v-else>{{ points.length > 1 ? '已读取轨迹；黄色段表示航线关系未知' : points.length === 1 ? '仅有一个轨迹点，不能连成航迹' : '暂无可显示的轨迹' }}</span>
    </div>
  </section>
</template>

<style scoped>
.authorization-target-map { display:flex; flex-direction:column; flex:1 0 235px; min-width:0; border:1px solid var(--line); border-radius:var(--r); background:var(--surface-1); }
header { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 12px; flex-wrap:wrap; } header strong { font-size:14px; } header > div { display:flex; gap:6px; }
.btn { height:auto; min-height:32px; white-space:normal; }
.map-canvas { position:relative; flex:1; min-height:120px; }
.map-note { padding:8px 12px; margin:0; color:var(--txt-2); font-size:13px; line-height:1.6; overflow-wrap:anywhere; }
.map-facts { display:flex; flex-direction:column; gap:4px; padding:10px 12px; font-size:12px; line-height:1.5; color:var(--txt-2); overflow-wrap:anywhere; }
.warning { color:var(--amber); }
</style>
