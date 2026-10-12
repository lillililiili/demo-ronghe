<script setup>
/* 处罚交接材料里冻结的当事人、研判结论和证据链（2026-10-06）。
   part=summary 放在材料摘要里，一眼看到当事人是否明确和研判结论；part=details 放在详细材料里，列出全部研判和证据。
   旧材料没有研判时明确提示缺失，证据仍按原来的证据清单显示，不拿现在的数据补。 */
import { computed } from 'vue';
import FrozenEvidenceContent from './FrozenEvidenceContent.vue';
import { ruleReasonText } from '@/ui/legalityReviewModal.js';
import { CONCLUSION_LABEL, labelOf } from '@/ui/labels.js';
import { evidenceChainView, judgmentViews, partyView } from './handoffMaterialView.js';

const props = defineProps({
  material: { type: Object, default: null },
  part: { type: String, default: 'details' },
  // 交接详情 availability.evidence：AVAILABLE / FORBIDDEN / OMITTED_AT_SUBMISSION
  evidenceAvailability: { type: String, default: '' }
});

const party = computed(() => partyView(props.material));
const judgments = computed(() => judgmentViews(props.material, ruleReasonText));
const headline = computed(() => judgments.value?.find(item => item.basisCode === 'EVENT_ALARM') || null);
const verification = computed(() => [...(props.material?.verifications || [])]
  .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))[0] || null);
const chain = computed(() => evidenceChainView(props.material));
const legacyEvidence = computed(() => Array.isArray(props.material?.evidence) ? props.material.evidence : []);
const evidenceHidden = computed(() => props.evidenceAvailability === 'FORBIDDEN');
const evidenceOmitted = computed(() => props.material?.evidence_omitted === true || props.evidenceAvailability === 'OMITTED_AT_SUBMISSION');

function formatTime(value) {
  if (value === null || value === undefined) return '时间未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未记录' : date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}
</script>

<template>
  <div v-if="part === 'summary'" class="hmf-summary">
    <section class="hmf-alarm-reason" aria-label="告警原因">
      <span>告警原因</span>
      <strong>{{ headline?.reasons.length ? headline.reasons.join('、') : '移送材料未记录具体告警原因' }}</strong>
    </section>
    <div v-if="party" class="hmf-party" :class="{ 'is-unknown': party.unidentified }">
      <p><span class="tag" :class="party.unidentified ? 't-orange' : 't-green'">{{ party.title }}</span>
        <span v-for="line in party.lines" :key="line">{{ line }}</span></p>
      <p v-if="party.plan || party.uavSn" class="hmf-meta">
        {{ party.unidentified ? '已有线索：' : '' }}<template v-if="party.plan">报备任务 {{ party.plan }}</template><template v-if="party.plan && party.uavSn">；</template><template v-if="party.uavSn">无人机序列号 {{ party.uavSn }}</template>
      </p>
      <p v-if="party.unidentified" class="hmf-meta">处罚部门需凭无人机序列号、遥控器位置等线索继续查找当事人。</p>
    </div>
    <dl class="kv kv-surface">
      <template v-if="headline">
        <dt>移送时研判</dt><dd><span class="tag" :class="headline.tone">{{ headline.legal }}</span><span v-if="headline.review"> · {{ headline.review }}</span></dd>
        <dt>研判时间</dt><dd>{{ formatTime(headline.evaluatedAt) }}</dd>
        <template v-if="headline.unknowns.length"><dt>依据缺口</dt><dd>{{ headline.unknowns.join('、') }}</dd></template>
      </template>
      <template v-else><dt>移送时研判</dt><dd>{{ judgments ? '移送时未关联告警依据的研判' : '旧移送材料未保存研判依据' }}</dd></template>
      <template v-if="verification">
        <dt>移送前核实</dt><dd>{{ labelOf(CONCLUSION_LABEL, verification.conclusion, '结论未记录') }} · {{ formatTime(verification.created_at) }}</dd>
        <dt>核实说明</dt><dd>{{ verification.note || '未记录具体核实说明' }}</dd>
      </template>
    </dl>
  </div>

  <template v-else>
    <div v-if="material?.weather_forecast" class="pn-sub pn-wrap hmf-block">
      <h4>通知时的天气预报依据</h4>
      <p>{{ material.weather_forecast.area_name }} · {{ material.weather_forecast.summary }}</p>
      <p v-if="!material.weather_area?.polygon?.length">区域级预报，按来源区域与计划时段关联；未提供精确气象边界，不能还原某个航线点的覆盖关系。</p>
      <p>发布 {{ formatTime(material.weather_forecast.published_at) }}；有效 {{ formatTime(material.weather_forecast.valid_from) }} 至 {{ formatTime(material.weather_forecast.valid_to) }}</p>
      <p>风速 {{ material.weather_forecast.wind_speed_mps ?? '未提供' }} 米/秒；阵风 {{ material.weather_forecast.gust_mps ?? '未提供' }} 米/秒；降水概率 {{ material.weather_forecast.precipitation_probability_pct ?? '未提供' }}%</p>
      <p>规则 {{ material.weather_forecast.rule_code }} · {{ material.weather_forecast.rule_version }} · {{ material.weather_forecast.source_mode === 'live' ? '实时来源' : '模拟／回放来源' }}</p>
    </div>
    <div v-if="material?.space_fact" class="pn-sub pn-wrap hmf-block">
      <h4>通知时的空中异物依据</h4>
      <p>{{ material.space_fact.subtype_name }} · 数量 {{ material.space_fact.object_count ?? '未提供' }} · 距航线 {{ material.space_fact.distance_to_route_m ?? '未提供' }} 米</p>
      <p>观测窗口 {{ formatTime(material.space_fact.window_from) }} 至 {{ formatTime(material.space_fact.window_to) }}</p>
    </div>
    <div v-if="judgments" class="pn-sub pn-wrap hmf-block">
      <h4>移送时的研判结论</h4>
      <p v-if="!judgments.length" class="hmf-meta">移送时没有找到本事件的合法性研判</p>
      <div v-for="item in judgments" :key="item.key" class="hmf-judgment">
        <p><b>{{ item.basis }}</b> <span class="tag" :class="item.tone">{{ item.legal }}</span><span v-if="item.review"> {{ item.review }}</span></p>
        <p class="hmf-meta">
          <template v-if="item.planMatch">{{ item.planMatch }}</template><template v-if="item.plan"> · {{ item.plan }}</template>
          <template v-if="item.planMatch || item.plan"> · </template>研判时间 {{ formatTime(item.evaluatedAt) }}
        </p>
        <p v-if="item.reasons.length" class="hmf-meta">违规原因：{{ item.reasons.join('、') }}</p>
        <p v-if="item.unknowns.length" class="hmf-meta">无法判定的原因：{{ item.unknowns.join('、') }}</p>
      </div>
    </div>

    <p v-if="evidenceOmitted" class="hmf-meta">提交时未纳入证据：提交账号当时没有证据读取权限。补权限不会补进这份历史材料。</p>
    <div v-else class="pn-sub pn-wrap hmf-block">
      <h4>提交时保存的证据</h4>
      <p v-if="evidenceHidden" class="hmf-meta">当前账号没有查看证据的权限，移送时证据不显示</p>
      <template v-else-if="chain">
        <p v-if="chain.total">显示 {{ chain.total }} 项 · 按移送时保存，文件可凭 SHA-256 与证据台账逐项核对</p>
        <p v-else-if="!chain.trackUnavailable" class="hmf-meta">移送时未关联证据</p>
        <p v-if="chain.trackUnavailable" class="hmf-meta">移送时材料中暂无可识别的融合轨迹</p>
        <ul v-if="chain.total" class="hmf-chain">
          <li v-for="item in chain.items" :key="item.key">
            <p><span class="tag t-gray">{{ item.category }}</span>
              <a v-if="item.href" class="hmf-link" :href="item.href">{{ item.name }}</a><span v-else>{{ item.name }}</span>
              <span v-if="item.no" class="mono">{{ item.no }}</span><span v-if="item.points">{{ item.points }}</span></p>
            <p class="hmf-meta">{{ formatTime(item.at) }}</p>
            <FrozenEvidenceContent :item="item.record" />
            <p v-if="item.sha256" class="hmf-meta mono hmf-hash">SHA-256：{{ item.sha256 }}</p>
          </li>
        </ul>
      </template>
      <template v-else-if="legacyEvidence.length">
        <div>{{ legacyEvidence.length }} 份 · 按移送时保存</div>
        <div v-for="evidence in legacyEvidence" :key="evidence.evidence_id">
          <a class="hmf-link" :href="`#/evidence?file=${encodeURIComponent(evidence.evidence_id)}`">{{ evidence.evidence_no || '查看证据记录' }}</a>
        </div>
      </template>
      <p v-else class="hmf-meta">{{ Array.isArray(material?.evidence) ? '移送时未关联证据' : '这份历史材料未保存证据清单，无法确认当时纳入了哪些证据' }}</p>
    </div>
  </template>
</template>

<style scoped>
.hmf-summary { display: grid; gap: 4px; margin-top: 6px; }
.hmf-alarm-reason { min-width:0; margin-bottom:8px; padding:12px 14px; border:1px solid color-mix(in srgb, var(--amber) 40%, var(--line)); border-left:4px solid var(--amber); border-radius:var(--r); background:color-mix(in srgb, var(--amber) 8%, var(--panel)); }
.hmf-alarm-reason > span { display:block; margin-bottom:5px; color:var(--amber); font-size:12px; font-weight:700; line-height:1.5; }
.hmf-alarm-reason > strong { display:block; color:var(--txt); font-size:16px; font-weight:700; line-height:1.65; white-space:normal; overflow-wrap:anywhere; }
.hmf-party { display: grid; gap: 2px; padding: 6px 8px; border: 1px solid color-mix(in srgb, var(--green) 30%, var(--line)); border-radius: 6px; }
.hmf-party.is-unknown { border-color: color-mix(in srgb, var(--orange) 45%, var(--line)); background: color-mix(in srgb, var(--orange) 6%, var(--surface-1)); }
.hmf-summary p, .hmf-block p { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 0; line-height: 1.6; overflow-wrap: anywhere; }
.hmf-summary .tag, .hmf-block .tag { white-space: normal; height: auto; }
.hmf-meta { color: var(--txt-2); font-size: 12px; }
.hmf-block { display: grid; gap: 6px; }
.hmf-judgment { display: grid; gap: 2px; padding-left: 8px; border-left: 2px solid var(--line); }
.hmf-chain { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.hmf-chain li { display: grid; gap: 2px; padding-left: 8px; border-left: 2px solid var(--line); }
.hmf-hash { word-break: break-all; }
.hmf-link { color: var(--cyan); text-decoration: underline; overflow-wrap: anywhere; }
.hmf-link:hover { color: var(--txt); }
.hmf-link:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; }
</style>
