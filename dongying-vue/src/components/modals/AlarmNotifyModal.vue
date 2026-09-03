<script setup>
import { computed, ref } from 'vue';
import { closeModal } from '@/ui/modal.js';
import { UField, UFormFooter } from '@/components/form/index.js';

const props = defineProps({
  alarm: { type: Object, required: true },
  channels: { type: Array, default: () => [] },
  onSent: { type: Function, required: true }
});

const U = window.UI;
const picked = ref(props.channels.map(c => c.id));
const introHtml = U.kv([
  ['告警', `${props.alarm.type}（${U.tag(props.alarm.level, props.alarm.level === '高' ? 't-red' : 't-amber')}）`],
  ['关联目标', `<span class="mono">${props.alarm.targetId}</span>`],
  ['区域', props.alarm.district],
  ['时间', props.alarm.time]
]);
const channelOpts = computed(() => props.channels.map(c2 => ({
  value: c2.id,
  disabled: true,
  html: `${c2.name} <span style="color:var(--txt-3)"> → ${c2.target}</span> ${U.tag('接口未接入', 't-amber')}`
})));
</script>

<template>
  <div v-html="introHtml"></div>
  <div v-if="!channels.length" class="empty" style="margin-top:12px">当前无已启用的通知渠道</div>
  <UField v-else v-model="picked" type="checkboxGroup" label="通知渠道（仅展示）" :options="channelOpts" disabled style="margin-top:12px" />
  <div class="warnbox" role="note" style="margin-top:10px">
    真实通知接口未接入，当前不能外发通知，也不会生成送达回执或写入通知记录。
  </div>
  <UFormFooter cancel-text="关闭" confirm-text="发送通知（未接入）" :disabled="true" @cancel="closeModal()" />
</template>
