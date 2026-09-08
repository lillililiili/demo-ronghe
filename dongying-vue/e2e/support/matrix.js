/* =============================================================================
 * matrix.js —— E2E 访问矩阵的数据来源（决策 15-10）。
 *
 * 两处来源刻意分开，理由不同：
 *
 *  ① **页面清单直接 import navModel.js**（它是纯数据 + 纯函数，没有任何 import，
 *     Node 能原样读）。清单是**事实**：新增一页而忘了加用例，矩阵会自己长出来，
 *     不会出现"页面上线了但没人测过它进不进得去"。
 *
 *  ② **别名与重定向策略在这里自己写一份**，不 import services/accessControl.js。
 *     表面理由是它经 auth.js 依赖 import.meta.env，Node 里跑不起来；
 *     真正的理由是：别名是**策略主张**（"空域页由飞行计划的权限承载"），
 *     不是事实。照抄产品代码的话，谁把 airspace 从 flights 挪到别处，
 *     测试会跟着一起挪、照样全绿——而那正是需要有人确认一次的改动。
 *     这里写死，改了就红一次，逼人看一眼。
 * ========================================================================== */
import { REDIRECT, ROUTES, pageTitle } from '../../src/config/navModel.js';

/* 权限承载关系（与 services/accessControl.js 的 ROUTE_ALIAS 对应，见上文 ②）。 */
const PERMISSION_ALIAS = { overview: 'situation', risk: 'flights', airspace: 'flights' };

/* 登录与改密不进业务导航/权限矩阵（navModel.js 自注），别的都要测。 */
const NOT_A_BUSINESS_PAGE = new Set(['login', 'change-password']);

/* 大屏不走 PageHost：App.vue 直接挂 BigScreenApp，是另一套外壳，单独一条用例。 */
export const BIGSCREEN_KEY = 'bigscreen';

/** hash 里敲 key，最终会停在哪个路由键上（router/index.js 的 REDIRECT 表 + #/risk 那条）。 */
export function landingKey(key) {
  if (REDIRECT[key]) return REDIRECT[key];
  if (key === 'risk') return 'flights';   // → /flights?tab=events
  return key;
}

/** 落地后由哪个菜单键的权限决定能不能进。 */
export function permissionKey(key) {
  const landed = landingKey(key);
  return PERMISSION_ALIAS[landed] || landed;
}

/** 被拒时拒绝页标题里出现的页名：AccessDeniedPage 用的是**落地后**的 routeKey。 */
export function deniedTitle(key) {
  return pageTitle(landingKey(key));
}

/**
 * 期望可达与否**取自服务端 /auth/me 的 menu_keys**，不是在这里再抄一份角色矩阵。
 * 这样验的是"前端的判断与后端的授权是否一致"——小接线阶段最容易飘的正是这条缝。
 */
export function expectReachable(key, menuKeys) {
  if (key === 'workbench') return true;   // accessControl.js 恒放行
  return menuKeys.includes(permissionKey(key));
}

/** 待测路由：navModel 的 ROUTES 全集减去登录/改密，大屏另计。 */
export const ROUTE_KEYS = Object.keys(ROUTES)
  .filter(key => !NOT_A_BUSINESS_PAGE.has(key) && key !== BIGSCREEN_KEY);

export { pageTitle };
