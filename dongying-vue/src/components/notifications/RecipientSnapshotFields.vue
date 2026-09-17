<script setup>
import { computed } from 'vue';
const props = defineProps({ snapshot: { type: Object, default: null }, historical: Boolean, showName: Boolean });
const channels = { NONE: '未配置', API: '系统接口', HTTP: '接口通知', SMS: '短信', VOICE: '语音电话', INTERNAL: '平台待办', MOCK: '模拟通道', SMS_SIMULATED: '模拟短信', VOICE_SIMULATED: '模拟语音' };
const channel = computed(() => channels[props.snapshot?.channel_type] || props.snapshot?.channel_type || '未记录');
</script>

<template>
  <template v-if="snapshot">
    <template v-if="showName"><dt>接收对象</dt><dd>{{ snapshot.org_name || snapshot.recipient_name || '未记录' }}</dd></template>
    <template v-if="snapshot.contact_name"><dt>联系人员</dt><dd>{{ snapshot.contact_name }}<small v-if="snapshot.contact_hint">{{ snapshot.contact_hint }}</small></dd></template>
    <dt>通知渠道</dt><dd>{{ channel }}</dd>
    <template v-if="historical"><dt>对象记录</dt><dd>保留本次通知时的接收资料<small v-if="snapshot.captured_at">记录于 {{ new Date(snapshot.captured_at).toLocaleString('zh-CN', { hour12: false }) }}</small></dd></template>
  </template>
  <template v-else-if="historical"><dt>对象记录</dt><dd>该历史记录未保存完整接收资料；不使用当前联系人补写。</dd></template>
</template>

<style scoped>
dd { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
dd small { display: block; color: var(--txt-3); font-size: 11px; line-height: 1.6; }
</style>
