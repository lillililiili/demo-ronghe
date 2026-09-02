<script setup>
import { computed, reactive, ref } from 'vue';
import { toast } from '@/ui/nv.js';
import { closeModal } from '@/ui/modal.js';
import { optionsOf, UField, UFormFooter } from '@/components/form/index.js';

const props = defineProps({
  caseId: { type: String, default: '' },
  targetId: { type: String, default: '' },
  operator: { type: String, required: true },
  onDone: { type: Function, required: true }
});

const M = window.MOCK;
const cases = M.cases.filter(c => c.status !== '已结案');
const caseOpts = optionsOf(cases.map(c => ({ v: c.id, t: `${c.id} · ${c.violation}` })));
const unitOpts = optionsOf(['东营市公安局特警支队', '东营市公安局东营分局', '东营市公安局广饶分局']);
const devOpts = optionsOf(['公安干扰车-01', '公安干扰车-02', '便携干扰终端-03']);
const channels = Object.values(M.JAM_CH);
const channelOpts = channels.map(c => ({
  value: c.ch,
  html: `<span class="mono">ch${c.ch}</span> ${c.key}
    <span style="color:var(--txt-3);font-size:11px"> ${c.range} · ${c.powerW}W</span>
    ${c.gnss ? '<b style="color:var(--red);font-size:11px"> 卫星导航链路</b>' : ''}`
}));
const ackOpts = [
  { value: '1', label: '已取得公安机关书面/系统授权，授权编号真实有效' },
  { value: '2', label: '已评估作用范围内通信、导航与其他合法飞行影响' },
  { value: '3', label: '知悉本次操作全程录音录像并纳入审计，可随时急停' }
];

const form = reactive({
  caseId: props.caseId || cases[0]?.id || null,
  approvalNo: '',
  unit: unitOpts[0]?.value || null,
  device: devOpts[0]?.value || null,
  range: '1500 m 扇区 60°',
  seconds: '120'
});
const pickedCh = ref(channels.filter(c => !c.gnss).map(c => c.ch));
const acks = ref([]);
const targetId = computed(() => (M.cases.find(c => c.id === form.caseId) || {}).targetId || props.targetId || '');
const gnssOn = computed(() => pickedCh.value.includes(2));
const canGo = computed(() => acks.value.length >= 3);

function submit() {
  const app = (form.approvalNo || '').trim();
  if (!app) return toast('公安审批文号为必填 —— 没有文号，这条授权记录无法回答"谁批准的"', 'err');
  const sec = parseInt(form.seconds, 10);
  if (!sec || sec <= 0) return toast('执行时长须为正整数（秒）', 'err');
  const chs = [...pickedCh.value].sort((a, b) => a - b);
  if (!chs.length) return toast('至少选择一路干扰通道 —— 一路不开等于没有实施干扰', 'err');
  props.onDone({
    caseId: form.caseId,
    targetId: targetId.value,
    approvalNo: app,
    unit: form.unit,
    device: form.device,
    channels: chs,
    range: form.range.trim(),
    durationS: sec
  });
}
</script>

<template>
  <div class="warnbox">注意：信号干扰为公安受控手段。必须填写<b>审批/授权编号、联动单位、作用范围、执行时长</b>，
    执行期间支持启停与急停，全过程审计（纪要 §6.3 / §11.1）。平台不代替公安做审批。</div>
  <div class="u-field-grid is-two" style="margin-top:12px">
    <UField v-model="form.caseId" type="select" label="关联案件" :options="caseOpts" />
    <UField :model-value="targetId" label="目标编号" readonly />
    <UField v-model="form.approvalNo" label="审批编号" required placeholder="公安审批文号（必填）" />
    <UField v-model="form.unit" type="select" label="联动单位" :options="unitOpts" />
    <UField v-model="form.device" type="select" label="干扰设备" :options="devOpts" />
    <UField v-model="pickedCh" type="checkboxGroup" label="干扰通道" wide :options="channelOpts">
      <div v-if="gnssOn" class="warnbox" style="margin-top:6px;font-size:11.5px">
        <b>ch2 将干扰 GPS / GLONASS / 北斗卫星导航链路。</b>
        其法律后果与干扰遥控、图传链路不同，且影响范围不限于目标无人机。
        开启前须确认公安授权文书已明确载明卫星导航链路干扰。
      </div>
    </UField>
    <UField v-model="form.range" label="作用范围" />
    <UField v-model="form.seconds" label="执行时长(秒)" />
  </div>
  <UField v-model="acks" type="checkboxGroup" :options="ackOpts" style="margin-top:10px" />
  <div style="margin-top:8px;font-size:11.5px;color:var(--txt-3);line-height:1.8">
    提交后立即在<b>「反制与干扰授权审计」</b>生成一条授权记录（本页签），并写入平台操作审计。
    通道与频段/功率取自设备一手资料（{{ M.JAM_SOURCE }}）。
  </div>
  <UFormFooter confirm-text="提交并执行" danger :disabled="!canGo" @cancel="closeModal()" @confirm="submit" />
</template>
