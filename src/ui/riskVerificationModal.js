/* 飞行计划风险人工核验弹窗：工作台与“全部风险事件”共用同一实现。 */
import { openModal, closeModal } from './modal.js';

const PLAN_STATUS_RANK = { '执行中': 4, '待执行': 3, '已完成': 2, '已终止': 1, '已取消': 0 };

function contextOf(risk, givenRoute, givenPlan) {
  const M = window.MOCK;
  const route = givenRoute !== undefined
    ? givenRoute
    : risk.nearestRouteId && M.routeById ? M.routeById(risk.nearestRouteId) : null;
  if (givenPlan !== undefined) return { route, plan: givenPlan };
  const plans = route && M.plansOf ? M.plansOf(route.id).slice() : [];
  plans.sort((a, b) => (PLAN_STATUS_RANK[b.status] || 0) - (PLAN_STATUS_RANK[a.status] || 0)
    || Math.abs(new Date(a.start).getTime() - risk.ts) - Math.abs(new Date(b.start).getTime() - risk.ts));
  return { route, plan: plans[0] || null };
}

export function openRiskVerification(options = {}) {
  const risk = options.risk;
  if (!risk) return false;

  const U = window.UI;
  const { route, plan } = contextOf(risk, options.route, options.plan);
  const height = risk.altOverlap == null ? '高度不可判定' : risk.altOverlap ? '高度重叠' : '高度不重叠';

  return openModal({
    title: `人工核验 · ${risk.id}`,
    width: '610px',
    body: `<div class="warnbox">核验结论沿用飞行计划页“本航线风险”的共享状态机，不会产生第二套流程。</div>${U.kv([
      ['飞行计划', plan ? `<span class="mono">${plan.id}</span> · ${plan.status}` : '该航线暂无关联计划'],
      ['关联航线', route ? `<span class="mono">${route.id}</span> ${route.name}` : '未关联航线'],
      ['风险事件', `<span class="mono">${risk.id}</span>`],
      ['距离 / 高度', `${risk.nearestRouteKm} km · ${height}`]
    ])}`,
    footer: '<button class="btn" type="button" data-close>取消</button><button class="btn" type="button" data-act="exclude">排除风险</button><button class="btn pri" type="button" data-act="confirm">核验通过</button>',
    on: {
      exclude: () => {
        closeModal();
        if (options.onExclude) options.onExclude(risk);
      },
      confirm: () => {
        closeModal();
        if (options.onConfirm) options.onConfirm(risk);
      }
    }
  });
}
