<script setup>
import { onMounted, onBeforeUnmount } from 'vue';
import ControlledFormModal from './ControlledFormModal.vue';
const props = defineProps({ form: { type: Object, required: true }, start: { type: Function, required: true }, stop: { type: Function, required: true } });
onMounted(() => props.start());
onBeforeUnmount(() => props.stop());
</script>

<template>
  <ControlledFormModal :fields="form.fields" :initial="form.initial" :warning="form.warning" :notice="form.notice"
    :intro-html="form.introHtml" :confirm-text="form.confirmText" :submit-enabled="form.submitEnabled"
    :validate="form.validate" :on-cancel="form.onCancel" :on-submit="form.onSubmit" :on-refresh="form.onRefresh" />
</template>