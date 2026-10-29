/* 研判引擎写的判定说明（hit.message）是给开发看的：夹着空域种类代码（PROHIBITED）、空域内部编号和“参数为 DEMO 演示值”的提示。
   上屏前换成值班员看得懂的话：种类换中文、内部编号换成空域名称（查不到就去掉）、去掉演示参数提示；
   换完仍有英文代码的，改用原因代码的中文说明。纯函数，node 可直接测试。 */
import { AIRSPACE_KIND_LABEL } from './labels.js';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DATUM_TEXT = { AMSL: '海拔', AGL: '离地高度' };

/** names：空域内部编号 → 空域名称；fallback：说明不可用时显示的中文（一般是原因代码的中文）。 */
export function ruleHitText(message, { names = {}, fallback = '' } = {}) {
  let text = String(message || '').replace(/[；;，,]?\s*参数为\s*DEMO\s*演示值，?尚未确认/g, '');
  text = text.replace(/([A-Z_]+)空域/g, (all, code) => AIRSPACE_KIND_LABEL[code] || all)
    .replace(/(\d)\s*m（(AMSL|AGL)）/g, (all, digit, datum) => `${digit} 米（${DATUM_TEXT[datum]}）`)
    .replace(UUID, id => { const name = names[id] || names[id.toLowerCase()]; return name ? `「${name}」` : ''; })
    .replace(/[ \t]+/g, ' ').replace(/\s+([；，。])/g, '$1').replace(/\s*([「」])\s*/g, '$1').trim();
  if (!text || /[A-Z]{2,}|_/.test(text)) return fallback;
  return text;
}
