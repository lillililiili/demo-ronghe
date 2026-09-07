import { defineStore } from 'pinia';

/* 外壳级共享状态。业务数据不进这里。 */
export const useAppStore = defineStore('app', {
  state: () => ({
    crumbCtx: null,       // 面包屑尾部业务上下文，APP.setCrumb 写入，换页清空
    openGrp: null,        // 当前展开的一级模块标题（null=尚未初始化，跟随首个路由）
    navMini: false,       // 侧栏折叠
    bigscreen: false,     // 大屏模式
    remountKey: 0,        // APP.rerender() 自增，PageHost 监听后整页重挂
    accessRevision: 0,    // 当前用户、菜单或操作权限变化时自增，驱动外壳重新判权
    timeStr: ''           // 顶栏本地墙钟
  })
});
