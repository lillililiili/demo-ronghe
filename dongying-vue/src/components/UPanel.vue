<script setup>
/* 面板 —— 标记逐字复刻 ui.js 的 panel()。
   面板头整体用 v-html（title/sub/extra 与 legacy 同为字符串拼接，不引入
   任何额外包裹节点，保证与旧版元素数逐一对应）；body 走默认 slot。
   extra 里的控件交互由页面在根元素上做事件委托（同 legacy 的 U.on 模式）。 */
import { computed } from 'vue';

const props = defineProps({
  title: { type: [String, Boolean], default: false },
  sub: { type: String, default: '' },
  extra: { type: String, default: '' },
  panelStyle: { type: String, default: '' },
  bodyStyle: { type: String, default: '' },
  nopad: { type: Boolean, default: false },
  /* bodyHtml：直接以 html 字符串填充 .pb（不加包裹节点），供沿用 ui.js
     字符串生成器（U.table 等）的面板体使用；与默认 slot 二选一。 */
  bodyHtml: { type: String, default: '' },
  variant: { type: String, default: '' },
  density: { type: String, default: '' },
  className: { type: String, default: '' }
});
const cls = computed(() => ['panel', props.variant ? 'panel-' + props.variant : '', props.density ? 'density-' + props.density : '', props.className || ''].filter(Boolean).join(' '));
const phHtml = computed(() => `<h3>${props.title}</h3>${props.sub ? `<span class="sub">${props.sub}</span>` : ''}<span class="spacer"></span>${props.extra || ''}`);
</script>

<template>
  <section :class="cls" :style="panelStyle">
    <div class="ph" v-if="title !== false" v-html="phHtml"></div>
    <div class="pb" :class="{ nopad }" :style="bodyStyle || null" v-if="bodyHtml" v-html="bodyHtml"></div>
    <div class="pb" :class="{ nopad }" :style="bodyStyle || null" v-else><slot /></div>
  </section>
</template>
