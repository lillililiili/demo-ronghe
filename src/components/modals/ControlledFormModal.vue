<script setup>
import { computed, reactive } from 'vue';
import { NForm } from 'naive-ui';
import { toast } from '@/ui/nv.js';
import { UFieldGrid, UFormFooter } from '@/components/form/index.js';

const props = defineProps({
  fields: { type: Array, default: () => [] },
  initial: { type: Object, default: () => ({}) },
  columns: { type: Number, default: 1 },
  notice: { type: String, default: '' },
  warning: { type: String, default: '' },
  introHtml: { type: String, default: '' },
  confirmText: { type: String, default: '保存' },
  danger: Boolean,
  hideFooter: Boolean,
  onSubmit: { type: Function, required: true },
  onCancel: { type: Function, required: true },
  submitEnabled: { type: Function, default: null },
  validate: { type: Function, default: null }
});

const model = reactive({ ...props.initial });
const canSubmit = computed(() => !props.submitEnabled || !!props.submitEnabled(model));

function isEmpty(value) {
  if (value == null) return true;
  if (typeof value === 'string') return !value.trim();
  if (Array.isArray(value)) return !value.length;
  return false;
}

function submit() {
  for (const field of props.fields) {
    if (!field.required) continue;
    if (isEmpty(model[field.key])) return toast((field.label || '该项') + '为必填', 'err');
  }
  if (props.validate) {
    const msg = props.validate(model);
    if (msg) return toast(msg, 'err');
  }
  props.onSubmit({ ...model });
}
</script>

<template>
  <n-form class="controlled-form" :show-feedback="false" @submit.prevent="submit">
    <div v-if="warning" class="warnbox controlled-form__message" v-html="warning"></div>
    <div v-if="introHtml" class="controlled-form__intro" v-html="introHtml"></div>
    <UFieldGrid :fields="fields" :model="model" :columns="columns" />
    <div v-if="notice" class="info-line controlled-form__message">{{ notice }}</div>
    <UFormFooter v-if="!hideFooter" :confirm-text="confirmText" :danger="danger" :disabled="!canSubmit"
      @cancel="onCancel" @confirm="submit" />
  </n-form>
</template>
