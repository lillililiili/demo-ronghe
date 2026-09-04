/* =============================================================================
 * navModel.js —— 导航/路由数据模型，四张表逐字移植自 dongying-demo/assets/js/app.js。
 * 这里只有数据与纯函数，不碰 DOM；渲染在 NavSidebar/Breadcrumb/PageHost。
 * 导航的组织原则（原 app.js 注释）：甲方看到的是**业务系统**，不是技术后台。
 * ========================================================================== */

/* kids 存在即为可展开的一级模块；没有 kids 的一级模块直接就是页面。 */
export const NAV = [
  { k: 'workbench', t: '我的工作台', icon: 'home' },
  /* 「综合态势」页已按用户裁定整页删除（2026-08-28），融合感知即首页 */
  {
    t: '感知监测', icon: 'radar', kids: [
      { k: 'situation', t: '融合感知' }
    ]
  },
  {
    t: '飞行监管', icon: 'plan', kids: [
      { k: 'flights', t: '飞行计划' },
      { k: 'legality', t: '合法性研判' }
    ]
  },
  {
    t: '事件处置', icon: 'alert', kids: [
      { k: 'alarms', t: '告警事件' },
      { k: 'punish', t: '处置与处罚' }
    ]
  },
  {
    t: '分析报告', icon: 'chart', kids: [
      { k: 'stats', t: '运行统计' },
      { k: 'evidence', t: '证据管理' }
    ]
  },
  /* 用户指令（2026-09-02）：用户管理与角色管理拆分为独立菜单，
     与日志归档共同归入「系统管理」组。 */
  {
    t: '运维管理', icon: 'tool', kids: [
      { k: 'devices', t: '设备管理' },
      { k: 'monitor', t: '设备实时监测' },
      { k: 'commission', t: '设备接入调测' }
    ]
  },
  {
    t: '系统管理', icon: 'shield', kids: [
      { k: 'users', t: '用户管理' },
      { k: 'roles', t: '角色管理' },
      { k: 'archive', t: '审计日志' }
    ]
  }
];

/* 菜单外路由（原「目标事件工作台」已删，保留空数组以便后续复用）。 */
export const EXTRA = [];

/* 路由表：key → {t 页面名, p 所属一级模块, ph 该模块首页} */
export const ROUTES = (function () {
  const r = {};
  NAV.forEach(n => {
    if (n.k) { r[n.k] = { t: n.t, p: null, ph: null }; return; }
    n.kids.forEach(c => { r[c.k] = { t: c.t, p: n.t, ph: n.kids[0].k }; });
  });
  EXTRA.forEach(e => { r[e.k] = { t: e.t, p: e.parent, ph: 'alarms' }; });
  /* 别名路由（risk/airspace 并入飞行计划后保留的旧地址）：
     不在 NAV 里，但标题/面包屑必须按落点显示。 */
  r.risk = { t: '飞行计划 · 全部风险事件', p: '飞行监管', ph: 'flights' };
  r.airspace = { t: '飞行计划', p: '飞行监管', ph: 'flights' };
  r.overview = { t: '融合感知', p: '感知监测', ph: 'situation' };
  r.bigscreen = { t: '低空安全监控大屏', p: null, ph: null };
  r.login = { t: '登录', p: null, ph: null }; // 独立入口，不加入业务导航/权限矩阵
  r['change-password'] = { t: '修改密码', p: null, ph: null };
  return r;
})();

export const PAGE_THEME = {
  login: 'login', 'change-password': 'login',
  workbench: 'overview',
  bigscreen: 'overview',
  situation: 'sensing', monitor: 'sensing',
  flights: 'flight', legality: 'flight', risk: 'flight', airspace: 'flight',
  alarms: 'incident', punish: 'incident',
  stats: 'analytics', evidence: 'analytics',
  devices: 'operations', commission: 'operations', apis: 'operations',
  users: 'system', roles: 'system', archive: 'system'
};

/* 旧地址重定向：目标页已删、语义由别的页承接时，hash 直接改写到承接页。 */
export const REDIRECT = { overview: 'situation' };

export const pageTitle = k => (ROUTES[k] || { t: k }).t;

export function groupOf(k) {
  const r = ROUTES[k];
  return r && r.p ? r.p : null;
}

/* 空路径默认进入“我的工作台”；截掉 ?query。
   放这里（而不是 router/index.js）是为了避免 PageHost ↔ router 循环依赖。 */
export function routeKey(route) {
  let p = route.params.page;
  if (Array.isArray(p)) p = p[0];
  return ((p || 'workbench') + '').split('?')[0];
}
