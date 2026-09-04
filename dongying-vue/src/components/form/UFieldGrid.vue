<script setup>
import UField from './UField.vue';

const props = defineProps({
  fields: { type: Array, default: () => [] },
  model: { type: Object, required: true },
  columns: { type: Number, default: 1 },
  variant: { type: String, default: 'form' }
});

function isWide(field) {
  if (field.wide === true) return true;
  if (field.wide === false) return false;
  return ['textarea', 'checkbox', 'checkboxGroup', 'radio', 'html', 'daterange', 'datetimerange'].includes(field.type);
}

function isVisible(field) {
  return typeof field.visibleWhen !== 'function' || field.visibleWhen(props.model);
}
</script>

<template>
  <div class="u-field-grid" :class="{ 'is-two': columns === 2 }">
    <UField v-for="field in fields" v-show="isVisible(field)" :key="field.key" v-model="model[field.key]" :class="{ 'is-wide': isWide(field) }"
      :type="field.type || 'text'" :label="field.label" :required="field.required" :help="field.help"
      :wide="isWide(field)" :variant="variant" :options="field.options || []" :placeholder="field.placeholder || ''"
      :start-placeholder="field.startPlaceholder || ''" :end-placeholder="field.endPlaceholder || ''"
      :default-time="field.defaultTime"
      :disabled="field.disabled" :readonly="field.readonly" :clearable="field.clearable === true"
      :min="field.min" :max="field.max" :min-rows="field.minRows || 3" :max-rows="field.maxRows || 6"
      :show-button="field.showButton === true" :layout="field.layout || 'stack'" :html="field.html || ''"
      :box-label="field.boxLabel || ''" :input-props="field.inputProps || {}" />
  </div>
</template>
