<script setup>
/* LegacyHost —— 未转换页面的宿主，逐字移植旧 app.js route() 的挂载/清理次序：
   CH.disposeAll() → 上页 destroy() → UI.closeModal() → cloneNode 换 #view 容器
   → innerHTML = render() → mount(view)。
   刻意不用 :key 组件重建而是常驻组件内命令式管理 #view —— 清理次序由代码
   顺序保证，不依赖 Vue patch 的卸载/挂载先后。外层 display:contents 让 .view
   仍是 .main 的 flex 子项（.view{flex:1} 依赖）。 */
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { ROUTES, groupOf, routeKey } from '@/config/navModel.js';
import { useAppStore } from '@/stores/app.js';

const route = useRoute();
const store = useAppStore();
const host = ref(null);
let current = null;

/* 「页面模块未加载」诊断页，文案逐字保留（原 app.js:164-173）：
   这里没有回落到总览 —— 静默回落会让人以为这个页面就长成总览的样子。 */
function unloadedTpl(k) {
  const U = window.UI;
  return `<div class="panel" style="margin-top:12px"><div class="pb" style="padding:28px">
    <div class="inline-icon" style="font-size:15px;color:#ffb083;margin-bottom:10px">${U.icon('warning')} 页面模块未加载：<span class="mono">${k}</span></div>
    <div style="font-size:13px;color:var(--txt-2);line-height:1.8">
      导航中存在该页面，但 <span class="mono">window.PAGES.${k}</span> 未定义。<br>
      常见原因：<span class="mono">index.html</span> 缺少对应的 script 标签，或该模块在加载时抛出了异常
      （此时控制台会有报错，且该报错通常出现在<b>它自己的文件</b>里）。<br>
      <b style="color:#ffb083">这里没有回落到总览</b> —— 静默回落会让人以为这个页面就长成总览的样子。
    </div></div></div>`;
}

function cleanup() {
  window.CH.disposeAll();
  if (current && current.destroy) { try { current.destroy(); } catch (e) { } }
  window.UI.closeModal();
  current = null;
}

function mountPage() {
  if (!host.value) return;
  const k = routeKey(route);
  const PAGES = window.PAGES || {};
  const known = !!ROUTES[k];
  const page = PAGES[k] || (known ? { render: () => unloadedTpl(k) } : PAGES.situation);
  store.crumbCtx = null;
  store.openGrp = groupOf(k) || store.openGrp;
  cleanup();
  /* 用全新的容器节点替换旧容器：页面通过事件委托绑在容器上的监听器随之销毁。 */
  const old = host.value.querySelector('#view');
  const view = old.cloneNode(false);
  old.parentNode.replaceChild(view, old);
  view.scrollTop = 0;
  view.innerHTML = page.render();
  current = page;
  if (page.mount) page.mount(view);
}

onMounted(() => {
  const view = document.createElement('div');
  view.className = 'view';
  view.id = 'view';
  host.value.appendChild(view);
  mountPage();
});
watch(() => [routeKey(route), store.remountKey], mountPage);
onBeforeUnmount(cleanup);
</script>

<template>
  <div ref="host" style="display:contents"></div>
</template>
