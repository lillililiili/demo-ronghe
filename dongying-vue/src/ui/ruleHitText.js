/* 研判引擎写的判定说明（hit.message）是给开发看的：夹着空域种类代码（PROHIBITED）、高度基准代码（AMSL/AGL）、
   空域和任务的内部编号、“参数为 DEMO 演示值”的提示，长度单位写成 m。
   上屏前换成值班员看得懂的话：代码换中文、单位统一为“米”、内部编号换成空域名称/任务编号（查不到就去掉）、
   去掉演示参数提示；换完仍有英文代码的，改用原因代码的中文说明。纯函数，node 可直接测试。 */
import { AIRSPACE_KIND_LABEL } from './labels.js';

// 内部编号：服务端的 UUID，或本地演示数据的 seed-… 主键。
const INTERNAL_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|seed-[A-Za-z0-9-]*[A-Za-z0-9]/gi;
const DATUM_TEXT = { AMSL: '海拔', AGL: '离地高度' };

/** names：空域内部编号 → 空域名称；plans：任务内部编号 → 任务编号；fallback：说明不可用时显示的中文（一般是原因代码的中文）。 */
export function ruleHitText(message, { names = {}, plans = {}, fallback = '' } = {}) {
  let text = String(message || '').replace(/[；;，,]?\s*参数为\s*DEMO\s*演示值，?尚未确认/g, '');
  text = text.replace(/([A-Z_]+)空域/g, (all, code) => AIRSPACE_KIND_LABEL[code] || all)
    .replace(/AGL\s*与\s*AMSL\s*不互比/g, '离地高度与海拔不能直接比较')
    .replace(/缺少\s*(AMSL|AGL)\s*基准高度/g, (all, datum) => `缺少${({ AMSL: '海拔高度', AGL: '离地高度' })[datum]}`)
    .replace(/（(AMSL|AGL)）/g, (all, datum) => `（${DATUM_TEXT[datum]}）`)
    .replace(/(\d)\s*m(?![A-Za-z])/g, '$1 米')
    .replace(INTERNAL_ID, id => {
      const plan = plans[id];
      if (plan) return ` ${plan} `;
      const name = names[id] || names[id.toLowerCase()];
      return name ? `「${name}」` : '';
    })
    .replace(/[ \t]+/g, ' ').replace(/\s+([；，。、])/g, '$1').replace(/\s*([「」])\s*/g, '$1').replace(/空域\s+的/g, '空域的').trim();
  if (!text || /[A-Z]{2,}|_/.test(text.replace(/\s\S*\d\S*\s?/g, ' '))) return fallback;
  return text;
}
