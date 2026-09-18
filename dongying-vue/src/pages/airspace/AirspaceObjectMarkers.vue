<script setup>
defineProps({ markers: { type: Array, default: () => [] } });
defineEmits(['select']);
const targetIcon = window.UI.targetIcon;
const statusIcon = window.UI.icon('warning');
</script>
<template>
  <div class="airspace-object-markers">
    <button v-for="marker in markers" :key="`${marker.kind}:${marker.id}`" class="object-marker" :class="{ active: marker.active }" type="button"
      :style="{ left: `${marker.x}px`, top: `${marker.y}px`, color: marker.color }" :aria-label="`定位${marker.title}`" :aria-pressed="marker.active" @click.stop="$emit('select', marker)">
      <span class="object-symbol" :class="{ 'map-alarm-active': marker.activeRisk }"><span v-html="targetIcon(marker)"></span></span><span class="object-risk-state" aria-hidden="true" v-html="statusIcon"></span>
      <span class="object-label" :class="{ leftward: marker.leftward }"><b>{{ marker.title }}</b><span>{{ marker.note }}</span></span>
    </button>
  </div>
</template>
<style scoped>
.airspace-object-markers { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 3; }
.object-marker { position: absolute; width: 30px; height: 30px; transform: translate(-50%, -50%); padding: 0; border: 0; background: transparent; pointer-events: auto; cursor: pointer; font: inherit; }
.object-marker.active { z-index: 2; }
.object-symbol { display: grid; place-items: center; width: 30px; height: 30px; box-sizing: border-box; background:transparent;border:0;box-shadow:none; }
.object-symbol :deep(svg) { width:22px;height:22px; }.object-symbol span { display: flex; }
.object-risk-state{position:absolute;right:0;bottom:0;display:flex}.object-risk-state :deep(svg){width:10px;height:10px;fill:none;stroke:currentColor;stroke-width:2}
.object-label { position: absolute; left: 38px; top: -3px; min-width: 94px; background: rgba(13,31,47,.88); border-left: 2px solid currentColor; border-radius: 4px; padding: 5px 8px; display: grid; gap: 2px; text-align: left; font-size: 11px; white-space: nowrap; }
.object-marker:not(.active):not(:hover):not(:focus-visible) .object-label { display: none; }
.object-label b { color: var(--txt-1); }.object-label > span { font-size: 10px; color: var(--txt-2); }.object-label.leftward { left: auto; right: 38px; }
.object-marker:focus-visible { outline: 2px solid var(--cyan); outline-offset: 4px; }
.object-marker.active .object-symbol { border-bottom:3px solid var(--blue); }
</style>
