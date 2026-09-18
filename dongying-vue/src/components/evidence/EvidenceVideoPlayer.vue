<script setup>
import { onBeforeUnmount, ref } from 'vue';
import UControl from '@/components/form/UControl.vue';

const props = defineProps({
  src: { type: String, required: true },
  canDownload: Boolean,
});
const emit = defineEmits(['error']);
const video = ref(null);
const playbackRate = ref(1);
const rateOptions = [0.5, 1, 1.5, 2].map(value => ({ value, label: `${value} 倍速` }));

function setRate(value) {
  if (!video.value) return;
  video.value.playbackRate = value;
  playbackRate.value = video.value.playbackRate;
}
function syncRate() { if (video.value) playbackRate.value = video.value.playbackRate; }
onBeforeUnmount(() => {
  if (!video.value) return;
  video.value.pause();
  video.value.removeAttribute('src');
  video.value.load();
});
</script>

<template>
  <div class="evidence-video-player">
    <video ref="video" :src="props.src" controls :controlslist="canDownload ? undefined : 'nodownload'"
      preload="metadata" playsinline aria-label="证据录像播放器"
      @ratechange="syncRate" @error="emit('error')" />
    <div class="video-footer">
      <div class="video-rate" role="group" aria-label="播放速度">
        <span>播放速度</span>
        <UControl type="select" size="small" :model-value="playbackRate" :options="rateOptions"
          aria-label="播放速度" @update:model-value="setRate" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.evidence-video-player { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
video { display: block; width: 100%; max-height: 52vh; min-height: 220px; border-radius: 8px; background: var(--canvas); }
.video-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; color: var(--txt-2); font-size: 12px; }
.video-rate { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.video-rate :deep(.n-select) { width: 110px; }
@media (max-width: 650px) { video { min-height: 160px; } }
</style>
