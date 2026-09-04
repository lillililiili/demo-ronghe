<script setup>
import { computed, ref } from 'vue';
import {
  NCheckbox, NCheckboxGroup, NConfigProvider, NDatePicker, NInput, NInputNumber,
  NRadio, NRadioGroup, NSelect, dateZhCN, zhCN
} from 'naive-ui';
import { SELECT_DROPDOWN, selectMenuProps } from './selectProps.js';

const DATE_TYPES = new Set([
  'date', 'datetime', 'daterange', 'datetimerange',
  'month', 'year', 'quarter', 'week',
  'monthrange', 'yearrange', 'quarterrange'
]);

const props = defineProps({
  type: { type: String, default: 'text' },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '' },
  startPlaceholder: { type: String, default: '' },
  endPlaceholder: { type: String, default: '' },
  defaultTime: { type: [String, Array, Function], default: undefined },
  disabled: Boolean,
  readonly: Boolean,
  clearable: Boolean,
  min: Number,
  max: Number,
  minRows: { type: Number, default: 3 },
  maxRows: { type: Number, default: 6 },
  showButton: Boolean,
  size: { type: String, default: 'medium' },
  layout: { type: String, default: 'stack' },
  id: { type: String, default: '' },
  boxLabel: { type: String, default: '' },
  html: { type: String, default: '' },
  inputProps: { type: Object, default: () => ({}) },
  status: { type: String, default: undefined }
});
const model = defineModel({ default: null });
const menuProps = computed(() => selectMenuProps(props.options));
const isDatePicker = computed(() => DATE_TYPES.has(props.type));
const input = ref(null);
defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <div v-if="type === 'html'" class="u-control u-control--html" v-html="html"></div>
  <n-select v-else-if="type === 'select'" :id="id || undefined" v-model:value="model" :options="options"
    :placeholder="placeholder || '请选择'" :disabled="disabled" :clearable="clearable" :size="size"
    :consistent-menu-width="SELECT_DROPDOWN.consistentMenuWidth" :menu-props="menuProps" />
  <n-input-number v-else-if="type === 'number'" :id="id || undefined" v-model:value="model" :min="min" :max="max"
    :placeholder="placeholder" :disabled="disabled" :show-button="showButton" :size="size" style="width:100%" />
  <n-radio-group v-else-if="type === 'radio'" :id="id || undefined" v-model:value="model" class="u-control-stack">
    <n-radio v-for="opt in options" :key="String(opt.value)" :value="opt.value" :disabled="opt.disabled">
      <span v-if="opt.html" v-html="opt.html"></span>
      <span v-else>{{ opt.label }}</span>
    </n-radio>
  </n-radio-group>
  <n-checkbox-group v-else-if="type === 'checkboxGroup'" :id="id || undefined" v-model:value="model">
    <div :class="layout === 'grid' ? 'u-control-grid' : 'u-control-stack'">
      <n-checkbox v-for="opt in options" :key="String(opt.value)" :value="opt.value" :disabled="opt.disabled">
        <span v-if="opt.html" v-html="opt.html"></span>
        <template v-else>{{ opt.label }}</template>
      </n-checkbox>
    </div>
  </n-checkbox-group>
  <n-checkbox v-else-if="type === 'checkbox'" :id="id || undefined" v-model:checked="model" :disabled="disabled" :size="size">
    {{ boxLabel }}
  </n-checkbox>
  <n-config-provider v-else-if="isDatePicker" :locale="zhCN" :date-locale="dateZhCN" style="display:contents">
    <n-date-picker ref="input" :id="id || undefined" v-model:value="model" :type="type"
      :placeholder="placeholder || undefined" :start-placeholder="startPlaceholder || undefined"
      :end-placeholder="endPlaceholder || undefined" :default-time="defaultTime" :disabled="disabled"
      :clearable="clearable" :size="size" :status="status" style="width:100%" />
  </n-config-provider>
  <n-input v-else ref="input" v-model:value="model" :type="['textarea', 'password'].includes(type) ? type : 'text'"
    :input-props="{ ...inputProps, id: id || inputProps.id }" :status="status"
    :placeholder="placeholder" :disabled="disabled" :readonly="readonly" :clearable="clearable" :size="size"
    :autosize="type === 'textarea' ? { minRows, maxRows } : false">
    <template v-if="$slots.prefix" #prefix><slot name="prefix" /></template>
    <template v-if="$slots.suffix" #suffix><slot name="suffix" /></template>
  </n-input>
</template>
