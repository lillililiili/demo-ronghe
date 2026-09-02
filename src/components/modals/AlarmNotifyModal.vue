<script setup>
import { computed, ref } from 'vue';
import { toast } from '@/ui/nv.js';
import { closeModal } from '@/ui/modal.js';
import { UField, UFormFooter } from '@/components/form/index.js';

const props = defineProps({
  alarm: { type: Object, required: true },
  channels: { type: Array, default: () => [] },
  onSent: { type: Function, required: true }
});

const M = window.MOCK, U = window.UI, CH = window.CH;
const picked = ref(props.channels.map(c => c.id));
const resultHtml = ref('');
const introHtml = U.kv([
  ['告警', `${props.alarm.type}（${U.tag(props.alarm.level, props.alarm.level === '高' ? 't-red' : 't-amber')}）`],
  ['关联目标', `<span class="mono">${props.alarm.targetId}</span>`],
  ['区域', props.alarm.district],
  ['时间', props.alarm.time]
]);
const channelOpts = computed(() => props.channels.map(c2 => ({
  value: c2.id,
  html: `${c2.name} <span style="color:var(--txt-3)"> → ${c2.target}</span> ${c2.ready ? U.tag('已联调', 't-green') : U.tag('预留接口', 't-amber')}`
})));

function send() {
  const selected = props.channels.filter(c => picked.value.includes(c.id));
  if (!selected.length) return toast('请至少选择一个渠道', 'err');
  const a = props.alarm;
  a.notifyLog = a.notifyLog || [];
  const now = M.util.fmtDT(M.CONF.demoTime);
  const lines = selected.map(c2 => {
    const ok = c2.ready;
    const result = ok ? `已送达（回执 ${'RC' + CH.seeded(c2.id + a.id)(100000, 999999)}）` : '接口预留，Demo 未真实外发';
    a.notifyLog.push({ time: now, channel: c2.name, target: c2.target, ok, result });
    return `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;padding:4px 0;border-bottom:1px solid rgba(64,158,255,.08)">
      <span>${c2.name} → ${c2.target}</span>
      <span style="color:${ok ? '#79e5a5' : '#ffd07a'}">${result}</span></div>`;
  }).join('');
  resultHtml.value = `<div style="font-size:12.5px;color:#9ec6ff;margin-bottom:4px">发送结果</div>${lines}`;
  props.onSent();
  const okN = selected.filter(c2 => c2.ready).length;
  toast(`通知已发送：${okN} 个渠道送达，${selected.length - okN} 个为预留接口未外发`, okN ? 'ok' : 'err');
}
</script>

<template>
  <div v-html="introHtml"></div>
  <div v-if="!channels.length" class="empty" style="margin-top:12px">当前无已启用的通知渠道</div>
  <UField v-else v-model="picked" type="checkboxGroup" label="选择通知渠道（仅列出已启用）" :options="channelOpts" style="margin-top:12px" />
  <div style="margin-top:10px" v-html="resultHtml"></div>
  <UFormFooter cancel-text="关闭" confirm-text="发送通知" :disabled="!channels.length" @cancel="closeModal()" @confirm="send" />
</template>
