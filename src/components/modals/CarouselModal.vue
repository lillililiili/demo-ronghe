<!-- =============================================================================
  CarouselModal —— P4b 受控表单样板（首个真 Naive 表单弹窗）。
  legacy 锚点：app.js carouselDlg()（本项目由 src/hooks/useCarousel.js 移植调用）。
  字段清单：sec（切换间隔 10/15/30/60 秒，默认 15）
           pages（参与轮播页面多选，默认 CAROUSEL_DEFAULT 四页）
  校验：pages 至少一项，否则 toast err（与 legacy 同文案）。
  文案与布局（warnbox / 两列勾选网格 / 230px 滚动）逐字对齐 legacy body 串。
============================================================================= -->
<script setup>
import { ref } from 'vue';
import { NSelect, NCheckboxGroup, NCheckbox, NButton } from 'naive-ui';
import { ROUTES, pageTitle } from '@/config/navModel.js';
import { toast } from '@/ui/nv.js';
import { closeModal } from '@/ui/modal.js';

const props = defineProps({
  defaults: { type: Array, default: () => [] },
  onGo: { type: Function, required: true }
});

const sec = ref(15);
const pages = ref([...props.defaults]);
const all = Object.keys(ROUTES);
const secOpts = [
  { value: 10, label: '10 秒' }, { value: 15, label: '15 秒' },
  { value: 30, label: '30 秒' }, { value: 60, label: '60 秒' }
];

function go() {
  if (!pages.value.length) return toast('请至少选择一个页面', 'err');
  const p = [...pages.value], s = sec.value;
  closeModal();
  props.onGo(p, s);
}
</script>

<template>
  <div class="warnbox">用于指挥大厅无人值守展示：按设定间隔自动切换页面，随时可停止。</div>
  <div style="display:flex;align-items:center;gap:10px;margin:12px 0 6px">
    <span style="font-size:13px;color:var(--txt-2);flex:0 0 auto">切换间隔</span>
    <n-select v-model:value="sec" :options="secOpts" size="small" style="width:140px" />
  </div>
  <div style="margin:12px 0 6px;font-size:13px;color:var(--txt-2)">参与轮播的页面</div>
  <n-checkbox-group v-model:value="pages">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px;max-height:230px;overflow:auto">
      <n-checkbox v-for="k in all" :key="k" :value="k" :label="pageTitle(k)" style="margin:2px 0" />
    </div>
  </n-checkbox-group>
  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
    <n-button size="small" @click="closeModal()">取消</n-button>
    <n-button size="small" type="primary" @click="go">开始轮播</n-button>
  </div>
</template>
