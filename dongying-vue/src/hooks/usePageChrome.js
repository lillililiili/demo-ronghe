/* 转换页（真 Vue 组件）共用的外壳职责，语义与 LegacyHost.mountPage 对齐：
   进入时清面包屑上下文 / 同步导航展开组；
   卸载时按旧序清理全局图表注册表与弹窗。
   Vue patch 先卸旧再挂新（不同 key/类型），故 onUnmounted 里 disposeAll
   不会碰到下一页刚建的图表。 */
import { onUnmounted } from 'vue';
import { groupOf } from '@/config/navModel.js';
import { useAppStore } from '@/stores/app.js';
import { closeModal } from '@/ui/modal.js';

export function usePageChrome(k) {
  const store = useAppStore();
  store.crumbCtx = null;
  store.openGrp = groupOf(k) || store.openGrp;
  onUnmounted(() => {
    window.CH.disposeAll();
    closeModal();          // 桥接层 closeModal 内部也会收掉 legacy 的 U.modal
  });
}
