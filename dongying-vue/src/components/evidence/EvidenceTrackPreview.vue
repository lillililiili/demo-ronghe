<script setup>
import { computed } from 'vue';
import TrackReplayPlayer from '@/components/replay/TrackReplayPlayer.vue';
import { prepareEvidenceTrack, trackSnapshotRows } from '@/services/evidenceTrackData.js';
import { SOURCE_MODE_LABEL, labelOf, targetTypeLabel } from '@/ui/labels.js';

const props = defineProps({
  snapshot: { type: Object, required: true },
  file: { type: Object, default: null },
  details: { type: Boolean, default: false },
  /** 同一事项关联的光电录像，按采集时刻与轨迹同步播放；不传则不显示录像窗。 */
  videos: { type: Array, default: null },
  videosLoading: Boolean,
  videoNote: { type: String, default: '' },
});
const model = computed(() => prepareEvidenceTrack(trackSnapshotRows(props.snapshot)));
const points = computed(() => model.value.points);
const sourceMode = computed(() => props.file?.source_mode || props.snapshot.source_mode);
const partial = computed(() => Number(props.snapshot.points?.total) > trackSnapshotRows(props.snapshot).length);
const sourceNote = computed(() => props.snapshot.simulated === true || props.snapshot.demo === true
  ? (props.details ? '模拟轨迹，不代表现场采集证据' : '模拟轨迹')
  : labelOf(SOURCE_MODE_LABEL, sourceMode.value, '来源未记录'));
const mapTarget = computed(() => {
  const target = props.snapshot.target;
  return { id: target?.target_no || '当前观测点', sourceMode: sourceMode.value || '',
    type: targetTypeLabel(null, target?.object_type_code, '目标'),
    subtype: targetTypeLabel(target?.subtype, target?.object_type_code, '目标') };
});
const rawText = computed(() => JSON.stringify(props.snapshot, null, 2));
</script>

<template>
  <section class="evidence-track-preview" aria-label="轨迹证据回放">
    <div class="track-summary">
      <b>轨迹回放 <span v-if="details">{{ points.length }} 点</span></b>
      <span class="tag t-gray">{{ sourceNote }}</span>
    </div>
    <p v-if="!points.length" class="track-notice" role="status">没有可用的观测位置，无法显示轨迹。</p>
    <template v-else>
      <TrackReplayPlayer :key="points.length" :points="points" :map-target="mapTarget" :videos="videos" :videos-loading="videosLoading" :video-note="videoNote"
        start-at-end :details="details" :constrain-to-coverage="false" :map-height="details ? 'clamp(280px, 46vh, 460px)' : 'clamp(240px, 40vh, 420px)'" />
      <p v-if="details" class="track-description">按原始观测点展示，不补点、不平滑；证据快照不带航线比对依据，轨迹统一按“关系未知”（黄色）显示。</p>
      <p v-if="model.timingIncomplete" class="track-notice">观测时间缺失或顺序异常，仅支持逐点查看。</p>
      <p v-else-if="points.length === 1" class="track-notice">仅有一个观测位置，无法回放。</p>
      <p v-if="model.rejected || model.breaks || partial" class="track-notice">{{ model.rejected ? `${model.rejected} 个位置无效，未绘制。` : '' }}{{ model.breaks ? `轨迹有 ${model.breaks} 处中断。` : '' }}{{ partial ? '仅包含部分轨迹。' : '' }}</p>
    </template>
    <p v-if="details && snapshot.note" class="track-description">{{ snapshot.note }}</p>
    <details v-if="details && file" class="track-original"><summary>查看轨迹原始数据</summary><pre>{{ rawText }}</pre></details>
  </section>
</template>

<style scoped>
.evidence-track-preview { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.track-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.track-summary b { font-size: 15px; }.track-summary b span { color: var(--cyan); margin-left: 8px; }
.track-notice, .track-description { font-size: 12px; line-height: 1.7; margin: 0; overflow-wrap: anywhere; }
.track-notice { color: var(--orange, #ffb020); padding: 10px; border: 1px solid var(--line); border-radius: 6px; }
.track-description { color: var(--txt-3); }
.track-original summary { cursor: pointer; font-size: 12px; color: var(--txt-2); padding: 8px 0; }
.track-original pre { max-height: 280px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 monospace; }
</style>
