<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { UFormFooter } from '@/components/form/index.js';
import TrackReplayPlayer from '@/components/replay/TrackReplayPlayer.vue';
import { hasPermission } from '@/services/accessControl.js';
import { listEvidenceFiles } from '@/services/evidenceApi.js';
import { closeModal } from '@/ui/modal.js';

const U = window.UI;
const props = defineProps({
  mapTarget: { type: Object, required: true },
  points: { type: Array, required: true },
  /** 用于查找关联到该目标的光电录像；没有目标 ID 时不查。 */
  targetId: { type: String, default: '' },
  alarmMark: { type: Object, default: null },
  alarmText: { type: String, default: '' }
});

const videos = ref(null);
const videosLoading = ref(false);
const videoNote = ref('');
let disposed = false;

/* 只读已入库并关联到这个目标的光电录像（光电跟踪时保存的录像会自动关联目标）。 */
async function loadVideos() {
  if (!props.targetId) { videoNote.value = '没有关联目标，无法查找录像'; return; }
  if (!hasPermission('evidence:read')) { videoNote.value = '当前账号没有查看录像的权限'; return; }
  videosLoading.value = true;
  try {
    const page = await listEvidenceFiles({ kind_code: 'EO_VIDEO', subject_kind: 'TARGET', subject_id: props.targetId, size: 50 });
    if (disposed) return;
    videos.value = (page?.items || []).map(item => ({
      id: item.evidence_id, no: item.evidence_no, capturedAt: item.captured_at ?? item.stored_at, status: item.status
    }));
  } catch {
    if (!disposed) videoNote.value = '录像列表读取失败，可到证据管理查看';
  } finally {
    if (!disposed) videosLoading.value = false;
  }
}

function close() { closeModal(); }
onMounted(loadVideos);
onBeforeUnmount(() => { disposed = true; });
</script>

<template>
  <div class="track-replay">
    <TrackReplayPlayer :points="points" :map-target="mapTarget" :videos="videos" :videos-loading="videosLoading"
      :video-note="videoNote" :marks="alarmMark ? [alarmMark] : []" autoplay />
    <div v-if="alarmText" class="track-replay-alarm-note">
      <span class="inline-icon" v-html="U.icon('flag')"></span>
      告警时刻落在本段轨迹内：{{ alarmText }}（时间轴红点、地图红圈）
    </div>
    <div class="track-replay-note"><b v-if="['mock', 'replay'].includes(mapTarget.sourceMode)">模拟／回放来源。</b>按原始观测点回放，断点保留，预测与推算点另作标记；录像按采集时刻与轨迹对齐。</div>
    <UFormFooter hide-cancel confirm-text="关闭" @confirm="close" />
  </div>
</template>

<style scoped>
.track-replay { display: flex; flex-direction: column; min-width: 0; }
.track-replay-alarm-note {
  display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 11.5px; color: #ff8b95;
}
.track-replay-note { margin-top: 6px; font-size: 11.5px; line-height: 1.6; color: var(--txt-3); }
.track-replay :deep(.u-form-footer) { margin-top: 12px; }
</style>
