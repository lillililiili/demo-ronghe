import { defineStore } from 'pinia';

/* 外壳级共享状态。注意：业务数据一律不进这里 —— window.MOCK 是唯一数据源，
   reactive 代理会破坏 currentUser 的 getter 语义与全站共享引用语义。 */
export const useAppStore = defineStore('app', {
  state: () => ({
    crumbCtx: null,       // 面包屑尾部业务上下文，APP.setCrumb 写入，换页清空
    openGrp: null,        // 当前展开的一级模块标题（null=尚未初始化，跟随首个路由）
    navMini: false,       // 侧栏折叠
    bigscreen: false,     // 大屏模式
    remountKey: 0,        // APP.rerender() 自增，PageHost 监听后整页重挂
    timeStr: '',          // M.systemNowStr()，顶栏系统当前时间
    dataTimeStr: ''       // M.nowStr()，Mock 数据统计基准时间
  })
});
