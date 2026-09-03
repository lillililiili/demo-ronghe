<script setup>
import { NButton } from 'naive-ui';

defineProps({
  cancelText: { type: String, default: '取消' },
  confirmText: { type: String, default: '确定' },
  danger: Boolean,
  disabled: Boolean,
  hideCancel: Boolean,
  loading: Boolean,
  submit: Boolean,
  size: { type: String, default: 'medium' }
});
defineEmits(['cancel', 'confirm']);
</script>

<template>
  <footer class="u-form-footer">
    <slot name="before" />
    <n-button v-if="!hideCancel" :size="size" @click="$emit('cancel')">{{ cancelText }}</n-button>
    <n-button :size="size" :type="danger ? 'error' : 'primary'" :disabled="disabled || loading" :loading="loading"
      :attr-type="submit ? 'submit' : 'button'" @click="!submit && $emit('confirm')">{{ confirmText }}</n-button>
  </footer>
</template>
