<script setup>
/* 面包屑：首页 › 一级模块 › 当前页 › [业务上下文]，右侧三段 cinfo。
   结构逐字对应旧 renderCrumb() 输出。
   #fver 的换页重置不在这里做：旧版 route() 的次序是 mount → renderCrumb，
   即重置发生在页面 mount 之后（devices.mount 里 paintFooter 的写入会被盖掉，
   只有页内数据源动作后页脚才显示模式后缀）—— 该时序由 PageHost 在 mount 后
   命令式复刻，Vue 端对 fver 的文本绑定是常量、不会再 patch。 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { ROUTES, routeKey } from './navModel.js';
import { useAppStore } from '../stores/app.js';

const route = useRoute();
const store = useAppStore();
const cur = computed(() => routeKey(route));

const cbsHtml = computed(() => {
  const k = cur.value, r = ROUTES[k] || { t: k };
  const parts = [`<a href="#/situation">首页</a>`];
  if (r.p) parts.push(`<a href="#/${r.ph}">${r.p}</a>`);
  if (!(k === 'situation')) parts.push(`<span class="c on">${r.t}</span>`);
  else parts[0] = `<span class="c on">融合感知</span>`;
  if (store.crumbCtx) parts.push(`<span class="c ctx">${store.crumbCtx}</span>`);
  return parts.join('<b>›</b>');
});
const ver = window.MOCK.CONF.version;
/* 2026-08-30 上游改动：页脚隐藏「(D3)」内部评审轮次标记，完整版本挪进 title */
const verShown = ver.replace(/\s*\(D\d+\)/, '');
</script>

<template>
  <div class="crumb" id="crumb">
    <div class="cbs" v-html="cbsHtml"></div>
    <span class="spacer"></span>
    <span class="cinfo">数据统计时间 <b id="ftm">{{ store.timeStr }}</b></span>
    <span class="cinfo" title="平台坐标与高度基准（技术口径）：WGS-84 坐标系 · 椭球高">WGS-84 · 椭球高</span>
    <span class="cinfo" id="fver" :title="`${ver}（D 编号为内部评审轮次标记）`">{{ verShown }}</span>
  </div>
</template>
