<script setup>
/* KPI 卡组 —— 标记逐字复刻 ui.js 的 kpis()。
   每张卡整体 v-html（value/desc 本就允许含 html，legacy 同为字符串拼接），
   卡的 class/attr 结构与旧版逐字符一致，不加包裹节点。 */
import { computed } from 'vue';

const props = defineProps({
  list: { type: Array, required: true },
  variant: { type: String, default: '' },
  density: { type: String, default: '' },
  className: { type: String, default: '' }
});

const wrapCls = computed(() => ['kpis', props.variant ? 'kpis-' + props.variant : '', props.density ? 'density-' + props.density : '', props.className || ''].filter(Boolean).join(' '));
/* 与 ui.js kpis() 完全同构：整组输出为一段 html。 */
const html = computed(() => props.list.map(k => {
  const icon = window.UI.icon;
  const click = k.attr ? ` ${k.attr} tabindex="0" role="button"` : '';
  return `<div class="kpi kpi-${k.color || 'blue'} ${k.className || ''}${k.attr ? ' is-clickable' : ''}${k.active ? ' is-active' : ''}"${click}${k.desc ? ` title="${String(k.desc).replace(/<[^>]*>/g, '').replace(/"/g, '&quot;')}"` : ''}>
    <div class="ic">${icon(k.icon || 'chart')}</div>
    <div class="tx"><div class="lb" title="${String(k.label).replace(/"/g, '&quot;')}">${k.label}</div>
      <div class="vl">${k.value}${k.unit ? `<span class="unit">${k.unit}</span>` : ''}</div>${k.caption ? `<div class="dt">${k.caption}</div>` : ''}</div></div>`;
}).join(''));
</script>

<template>
  <div :class="wrapCls" v-html="html"></div>
</template>
