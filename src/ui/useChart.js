/* 转换页图表助手：延迟到 onMounted 后初始化（容器已入文档有布局），
   直接调 window.CH 工厂 —— 主题、ResizeObserver、donut 0 宽重试全部沿用
   legacy 实现。实例进的是 CH 全局注册表，由 usePageChrome 的 onUnmounted
   统一 disposeAll（次序与 legacy 一致）。 */
import { onMounted } from 'vue';

export function useCharts(fn) {
  onMounted(() => { fn(window.CH); });
}
