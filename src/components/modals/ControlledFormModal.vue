<script setup>
import { reactive } from 'vue';
import { NButton, NForm, NFormItem, NInput, NSelect } from 'naive-ui';

const props = defineProps({
  fields: { type: Array, default: () => [] },
  initial: { type: Object, default: () => ({}) },
  columns: { type: Number, default: 1 },
  notice: { type: String, default: '' },
  warning: { type: String, default: '' },
  confirmText: { type: String, default: '保存' },
  danger: Boolean,
  onSubmit: { type: Function, required: true },
  onCancel: { type: Function, required: true }
});

const model = reactive({ ...props.initial });

function submit() {
  props.onSubmit({ ...model });
}
</script>

<template>
  <n-form class="controlled-form" :show-feedback="false" @submit.prevent="submit">
    <div v-if="warning" class="warnbox controlled-form__message">{{ warning }}</div>
    <div class="controlled-form__grid" :class="{ 'is-two': columns === 2 }">
      <n-form-item v-for="field in fields" :key="field.key" :label="field.label" :required="field.required" :class="{ 'is-wide': field.wide }">
        <n-select v-if="field.type === 'select'" v-model:value="model[field.key]" :options="field.options || []"
          :placeholder="field.placeholder || '请选择'" :disabled="field.disabled" :clearable="field.clearable !== false" />
        <n-input v-else v-model:value="model[field.key]" :type="field.type === 'textarea' ? 'textarea' : 'text'"
          :placeholder="field.placeholder || ''" :disabled="field.disabled" :readonly="field.readonly"
          :autosize="field.type === 'textarea' ? { minRows: field.minRows || 3, maxRows: field.maxRows || 6 } : false" />
        <small v-if="field.help" class="controlled-form__help">{{ field.help }}</small>
      </n-form-item>
    </div>
    <div v-if="notice" class="info-line controlled-form__message">{{ notice }}</div>
    <footer class="controlled-form__footer">
      <n-button @click="onCancel">取消</n-button>
      <n-button :type="danger ? 'error' : 'primary'" @click="submit">{{ confirmText }}</n-button>
    </footer>
  </n-form>
</template>
