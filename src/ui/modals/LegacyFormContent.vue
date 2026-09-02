<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { teardownLegacyControls, upgradeLegacyControls } from '../legacyControls.js';

const props = defineProps({
  html: { type: String, default: '' },
  onClick: { type: Function, default: null },
  onReady: { type: Function, default: null }
});

const root = ref(null);

onMounted(() => nextTick(() => {
  upgradeLegacyControls(root.value);
  props.onReady?.(root.value);
}));

onBeforeUnmount(() => teardownLegacyControls(root.value));
</script>

<template>
  <div ref="root" class="legacy-form-content" v-html="html" @click="onClick"></div>
</template>
