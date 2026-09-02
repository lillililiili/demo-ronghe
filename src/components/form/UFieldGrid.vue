<script setup>
import UField from './UField.vue';

defineProps({
  fields: { type: Array, default: () => [] },
  model: { type: Object, required: true },
  columns: { type: Number, default: 1 },
  variant: { type: String, default: 'form' }
});

function isWide(field) {
  if (field.wide === true) return true;
  if (field.wide === false) return false;
  return ['textarea', 'checkbox', 'checkboxGroup', 'radio', 'html'].includes(field.type);
}
</script>

<template>
  <div class="u-field-grid" :class="{ 'is-two': columns === 2 }">
    <UField v-for="field in fields" :key="field.key" v-model="model[field.key]" :class="{ 'is-wide': isWide(field) }"
      :type="field.type || 'text'" :label="field.label" :required="field.required" :help="field.help"
      :wide="isWide(field)" :variant="variant" :options="field.options || []" :placeholder="field.placeholder || ''"
      :disabled="field.disabled" :readonly="field.readonly" :clearable="field.clearable === true"
      :min="field.min" :max="field.max" :min-rows="field.minRows || 3" :max-rows="field.maxRows || 6"
      :show-button="field.showButton === true" :layout="field.layout || 'stack'" :html="field.html || ''"
      :box-label="field.boxLabel || ''" />
  </div>
</template>
