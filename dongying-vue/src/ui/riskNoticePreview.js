import { handoffApi } from '@/services/handoffApi.js';
import { displayNumberReferences, displayTargetNo } from '@/ui/deviceNumber.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const time = value => value == null ? '未提供' : new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

/** 预览与提交共用服务端材料口径，不推测接收方或凭当前页面拼一份附件。 */
export async function riskNoticePreview(id, version) {
  const preview = await handoffApi.previewRisk(id, version);
  const r = preview.recipient || {}, m = preview.material || {}, f = m.weather_forecast;
  const chain = m.evidence_chain || [];
  const rows = [
    ['接收单位', r.org_name || r.recipient_name || '未提供'],
    ['接收配置', `${r.setting_id || '未提供'} · 版本 ${r.config_version ?? '未知'} · ${r.channel_type || '未配置'}`],
    ['关联计划', preview.plan_no || m.references?.plan_id || '未关联'],
    // 编号前缀只在显示时去掉（2026-10-09 用户确认），服务端材料和提交内容不变。
    ['关联目标', displayTargetNo(preview.target_no) || m.references?.target_id || '本风险未关联目标'],
    ['风险', `${displayNumberReferences(m.risk?.reason_text, [preview.target_no]) || '未提供'} · 版本 ${preview.source_version}`],
    ['核验说明', (m.verifications || []).map(v => v.note).filter(Boolean).join('；') || '尚无核验说明'],
    ['预览时间', `${time(preview.generated_at)}（北京时间）`]
  ];
  const files = chain.map(e => `<li>${esc(e.name || e.kind_code || e.category)} · ${esc(e.source_id)}${e.point_count == null ? '' : ` · ${esc(e.point_count)} 个轨迹点`}${e.sha256 ? `<br>SHA-256：${esc(e.sha256)}` : ''}</li>`).join('');
  const forecast = f ? `<p>预报快照：${esc(f.area_name)}，${esc(f.summary)}；有效期 ${esc(time(f.valid_from))} 至 ${esc(time(f.valid_to))}。原始消息 ${esc(f.message_id)}。</p>` : '';
  return { ...preview, introHtml: `<dl class="kv">${rows.map(([k,v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${r.blocked_reason ? `<p>${esc(r.blocked_reason)}</p>` : ''}<h4>将纳入的材料</h4><p>风险事实、计划关联和核验历史。</p>${forecast}${m.space_fact ? '<p>包含鸟群或异物的时空关系、数量和规则事实。</p>' : ''}${m.evidence_omitted ? '<p>本账号无证据读取权限，本次材料不会包含证据附件。</p>' : chain.length ? `<ul>${files}</ul>` : '<p>本风险当前没有关联文件或轨迹附件。</p>'}<p>提交时保存当时最新可见材料；提交后请按实际目录逐件核对。</p>` };
}
