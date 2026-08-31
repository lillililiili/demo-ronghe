/* 转换页（真 Vue 组件）共用的外壳职责，语义与 LegacyHost.mountPage 对齐：
   进入时清面包屑上下文 / 同步导航展开组 / 重置页脚版本号；
   卸载时按旧序清理全局图表注册表与弹窗。
   Vue patch 先卸旧再挂新（不同 key/类型），故 onUnmounted 里 disposeAll
   不会碰到下一页刚建的图表。 */
import { onMounted, onUnmounted } from 'vue';
import { groupOf } from './navModel.js';
import { useAppStore } from '../stores/app.js';

export function usePageChrome(k) {
  const store = useAppStore();
  store.crumbCtx = null;
  store.openGrp = groupOf(k) || store.openGrp;
  onMounted(() => {
    const fver = document.getElementById('fver');
    /* 2026-08-30 上游改动：页脚隐藏「(D3)」内部评审轮次标记 */
    if (fver) fver.textContent = window.MOCK.CONF.version.replace(/\s*\(D\d+\)/, '');
  });
  onUnmounted(() => {
    window.CH.disposeAll();
    window.UI.closeModal();
  });
}
