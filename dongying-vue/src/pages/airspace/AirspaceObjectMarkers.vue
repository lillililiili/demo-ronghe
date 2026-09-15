<script setup>
defineProps({ markers: { type: Array, default: () => [] } });
defineEmits(['select']);
const birdIcon = window.UI.icon('bird');
</script>
<template>
  <div class="airspace-object-markers">
    <button v-for="marker in markers" :key="`${marker.kind}:${marker.id}`" class="object-marker" :class="{ active: marker.active }" type="button"
      :style="{ left: `${marker.x}px`, top: `${marker.y}px`, color: marker.color }" :aria-label="`定位${marker.title}`" :aria-pressed="marker.active" @click.stop="$emit('select', marker)">
      <span class="object-symbol"><span v-if="marker.bird" v-html="birdIcon"></span><span v-else class="object-dot"></span></span>
      <span class="object-label" :class="{ leftward: marker.leftward }"><b>{{ marker.title }}</b><span>{{ marker.note }}</span></span>
    </button>
  </div>
</template>
<style scoped>
.airspace-object-markers { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 3; }
.object-marker { position: absolute; width: 30px; height: 30px; transform: translate(-50%, -50%); padding: 0; border: 0; background: transparent; pointer-events: auto; cursor: pointer; font: inherit; }
.object-marker.active { z-index: 2; }
.object-symbol { display: grid; place-items: center; width: 30px; height: 30px; box-sizing: border-box; background: var(--surface-1); border: 2px solid currentColor; border-radius: 50%; box-shadow: 0 0 0 5px color-mix(in srgb, currentColor 12%, transparent); }
.object-symbol :deep(svg) { width: 19px; height: 19px; }.object-symbol span { display: flex; }
.object-dot { width: 7px; height: 7px; background: currentColor; border-radius: 50%; }
.object-label { position: absolute; left: 38px; top: -3px; min-width: 94px; background: rgba(13,31,47,.88); border-left: 2px solid currentColor; border-radius: 4px; padding: 5px 8px; display: grid; gap: 2px; text-align: left; font-size: 11px; white-space: nowrap; }
.object-marker:not(.active):not(:hover):not(:focus-visible) .object-label { display: none; }
.object-label b { color: var(--txt-1); }.object-label > span { font-size: 10px; color: var(--txt-2); }.object-label.leftward { left: auto; right: 38px; }
.object-marker:focus-visible { outline: 2px solid var(--cyan); outline-offset: 4px; }
.object-marker.active .object-symbol { box-shadow: 0 0 0 7px color-mix(in srgb, currentColor 25%, transparent); }
</style>
