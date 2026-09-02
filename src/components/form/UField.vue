<script setup>
import { computed } from 'vue';
import UControl from './UControl.vue';

const props = defineProps({
  type: { type: String, default: 'text' },
  label: { type: String, default: '' },
  required: Boolean,
  help: { type: String, default: '' },
  wide: Boolean,
  variant: { type: String, default: 'form' },
  srOnly: Boolean,
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '' },
  disabled: Boolean,
  readonly: Boolean,
  clearable: Boolean,
  min: Number,
  max: Number,
  minRows: { type: Number, default: 3 },
  maxRows: { type: Number, default: 6 },
  showButton: Boolean,
  size: { type: String, default: '' },
  layout: { type: String, default: 'stack' },
  id: { type: String, default: '' },
  boxLabel: { type: String, default: '' },
  html: { type: String, default: '' }
});
const model = defineModel({ default: null });
const controlSize = computed(() => props.size || 'medium');
const hideLabel = computed(() => !props.label || props.type === 'checkbox' || props.type === 'html');
const labelClass = computed(() => props.srOnly ? 'sr-only' : '');
</script>

<template>
  <div class="u-field" :class="['is-' + variant, { 'is-wide': wide, 'is-required': required && !hideLabel }]">
    <label v-if="label && type !== 'checkbox' && type !== 'html'" :class="labelClass" :for="id || undefined">{{ label }}</label>
    <div class="u-field__control">
      <UControl v-model="model" :type="type" :options="options" :placeholder="placeholder" :disabled="disabled"
        :readonly="readonly" :clearable="clearable" :min="min" :max="max" :min-rows="minRows" :max-rows="maxRows"
        :show-button="showButton" :size="controlSize" :layout="layout" :id="id" :box-label="boxLabel || (type === 'checkbox' ? label : '')"
        :html="html" />
      <small v-if="help" class="u-field__help">{{ help }}</small>
      <slot />
    </div>
  </div>
</template>
