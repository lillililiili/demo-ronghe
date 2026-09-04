<script setup>
import { computed, nextTick, reactive, ref } from 'vue';
import { NForm } from 'naive-ui';
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
const busy = ref(false);
const error = ref('');
const errorBox = ref(null);
const canSubmit = computed(() => !busy.value && (!props.submitEnabled || !!props.submitEnabled(model)));

function isEmpty(value) {
  if (value == null) return true;
  if (typeof value === 'string') return !value.trim();
  if (Array.isArray(value)) return !value.length;
  return false;
}

async function fail(message) {
  error.value = message;
  await nextTick();
  errorBox.value?.focus();
}

async function submit() {
  if (busy.value) return;
  error.value = '';
  for (const field of props.fields) {
    if (!field.required || (typeof field.visibleWhen === 'function' && !field.visibleWhen(model))) continue;
    if (isEmpty(model[field.key])) return fail((field.label || '该项') + '为必填');
  }
  if (props.validate) {
    const msg = props.validate(model);
    if (msg) return fail(msg);
  }
  busy.value = true;
  try { await props.onSubmit({ ...model }); }
  catch (e) { await fail(e.message || '操作失败，请重试。'); }
  finally { busy.value = false; }
}
</script>

<template>
  <n-form class="controlled-form" :show-feedback="false" @submit.prevent="submit">
    <div v-if="error" ref="errorBox" class="warnbox controlled-form__message" tabindex="-1" role="alert">{{ error }}</div>
    <div v-if="warning" class="warnbox controlled-form__message" v-html="warning"></div>
    <div v-if="introHtml" class="controlled-form__intro" v-html="introHtml"></div>
    <UFieldGrid :fields="fields" :model="model" :columns="columns" />
    <div v-if="notice" class="info-line controlled-form__message">{{ notice }}</div>
    <UFormFooter v-if="!hideFooter" :confirm-text="busy ? '正在处理…' : confirmText" :danger="danger" :disabled="!canSubmit" :loading="busy"
      @cancel="onCancel" @confirm="submit" />
  </n-form>
</template>
