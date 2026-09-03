<script setup>
/* __ui-lab —— 新旧控件同屏对照页（仅 dev 路由注册，见 router/index.js）。
   用途：P0 主题校准的验收台 —— 同一段中文文案、同一语义色，
   左列旧控件（全局样式类）右列 Naive UI，目测色板/圆角/字号/行高是否违和。 */
import { ref } from 'vue';
import { NButton, NTag, NModal, NDrawer, NDrawerContent } from 'naive-ui';
import { UField } from '@/components/form/index.js';
import PagePager from '@/components/PagePager.vue';
import { message } from '@/ui/nv.js';

const U = window.UI;
const showModal = ref(false);
const showDrawer = ref(false);
const page = ref(3);
const pageSize = ref(20);
const selVal = ref('全部');
const selOpts = ['全部', '东营区', '广饶县', '河口区'].map(x => ({ label: x, value: x }));
const iptVal = ref('');
const sample = '目标 UAV20260826047 超出空域限高，实测高度 208m，速度 18.9m/s';

const oldToast = t => U.toast(sample, t);
const oldModal = () => U.modal({
  title: '旧版弹窗对照', width: '520px',
  body: `${U.kv([['目标编号', '<span class="mono">UAV20260826047</span>'], ['判定', U.legal('非法')]])}
    <div class="info-line" style="margin-top:10px">对照台不再渲染原生表单；产品表单一律走 Naive UI。</div>`,
  footer: '<button class="btn" data-close>取消</button><button class="btn pri" data-act="ok">确定</button>',
  on: { ok: () => { U.closeModal(); U.toast('旧版确定', 'ok'); } }
});
const oldPagerHtml = U.pager({ total: 137, page: 3, size: 10 });
</script>

<template>
  <div class="view" id="view" style="padding:20px">
    <div class="warnbox" style="margin-bottom:14px">
      __ui-lab 主题校准对照台（仅 dev）：左＝旧控件（全局样式类），右＝Naive UI（theme.js 映射）。
      验收标准：色板 / 圆角 / 字号 / 行高目测无违和。</div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <!-- 按钮 -->
      <section class="panel"><div class="ph"><h3>旧 · 按钮</h3></div><div class="pb" style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn">默认</button><button class="btn pri">主要</button>
        <button class="btn warn">警告</button><button class="btn danger">危险</button>
        <button class="btn ghost">幽灵</button><button class="btn" disabled>禁用</button>
      </div></section>
      <section class="panel"><div class="ph"><h3>新 · n-button</h3></div><div class="pb" style="display:flex;gap:8px;flex-wrap:wrap">
        <n-button>默认</n-button><n-button type="primary">主要</n-button>
        <n-button type="warning">警告</n-button><n-button type="error">危险</n-button>
        <n-button quaternary>幽灵</n-button><n-button disabled>禁用</n-button>
      </div></section>

      <!-- 标签 -->
      <section class="panel"><div class="ph"><h3>旧 · 标签</h3></div><div class="pb" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span class="tag t-red">非法</span><span class="tag t-green">合法</span>
        <span class="tag t-amber">待确认</span><span class="tag t-blue">低风险</span>
        <span class="tag t-cyan">跟踪中</span><span class="tag t-gray">不适用</span>
      </div></section>
      <section class="panel"><div class="ph"><h3>新 · n-tag</h3></div><div class="pb" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <n-tag type="error" size="small">非法</n-tag><n-tag type="success" size="small">合法</n-tag>
        <n-tag type="warning" size="small">待确认</n-tag><n-tag type="primary" size="small">低风险</n-tag>
        <n-tag type="info" size="small">跟踪中</n-tag><n-tag size="small">不适用</n-tag>
      </div></section>

      <!-- 消息 -->
      <section class="panel"><div class="ph"><h3>旧 · U.toast</h3></div><div class="pb" style="display:flex;gap:8px">
        <button class="btn" @click="oldToast('ok')">ok</button>
        <button class="btn" @click="oldToast('err')">err</button>
        <button class="btn" @click="oldToast('')">默认</button>
      </div></section>
      <section class="panel"><div class="ph"><h3>新 · message</h3></div><div class="pb" style="display:flex;gap:8px">
        <n-button @click="message.success(sample)">success</n-button>
        <n-button @click="message.error(sample)">error</n-button>
        <n-button @click="message.info(sample)">info</n-button>
      </div></section>

      <!-- 分页 -->
      <section class="panel"><div class="ph"><h3>旧 · U.pager</h3></div><div class="pb" v-html="oldPagerHtml"></div></section>
      <section class="panel"><div class="ph"><h3>新 · PagePager</h3></div><div class="pb">
        <PagePager :page="page" :size="pageSize" :total="137"
          @update:page="page = $event" @update:size="pageSize = $event" />
      </div></section>

      <!-- 表单件 -->
      <section class="panel"><div class="ph"><h3>已停用 · 原生表单</h3></div><div class="pb" style="color:var(--txt-3);font-size:12.5px;line-height:1.7">
        产品表单禁止再渲染原生 input / select / textarea。请使用右侧 Naive UI 控件。
      </div></section>
      <section class="panel"><div class="ph"><h3>新 · UField</h3></div><div class="pb" style="display:flex;gap:10px;align-items:center">
        <UField variant="toolbar" label="区域" v-model="selVal" type="select" :options="selOpts" style="width:180px" />
        <UField variant="toolbar" v-model="iptVal" placeholder="请输入设备编号/名称" style="width:200px" />
      </div></section>

      <!-- 弹窗 / 抽屉 -->
      <section class="panel"><div class="ph"><h3>旧 · U.modal / drawer</h3></div><div class="pb" style="display:flex;gap:8px">
        <button class="btn" @click="oldModal">旧弹窗</button>
      </div></section>
      <section class="panel"><div class="ph"><h3>新 · n-modal / n-drawer</h3></div><div class="pb" style="display:flex;gap:8px">
        <n-button @click="showModal = true">新弹窗</n-button>
        <n-button @click="showDrawer = true">新抽屉</n-button>
      </div></section>
    </div>

    <n-modal v-model:show="showModal" preset="card" title="新版弹窗对照" style="width:520px" :z-index="100">
      <div v-html="U.kv([['目标编号', '<span class=&quot;mono&quot;>UAV20260826047</span>'], ['判定', U.legal('非法')]])"></div>
      <UField v-model="iptVal" placeholder="新版输入框" style="margin-top:10px" />
      <template #footer>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <n-button @click="showModal = false">取消</n-button>
          <n-button type="primary" @click="showModal = false; message.success('新版确定')">确定</n-button>
        </div>
      </template>
    </n-modal>
    <n-drawer v-model:show="showDrawer" :width="600" :z-index="150">
      <n-drawer-content title="新版抽屉对照" closable>与旧 .drawer（600px）宽度一致。</n-drawer-content>
    </n-drawer>
  </div>
</template>
