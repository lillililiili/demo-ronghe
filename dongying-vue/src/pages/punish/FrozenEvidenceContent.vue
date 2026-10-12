<script setup>
import { ref } from 'vue';
import EvidenceTrackPreview from '@/components/evidence/EvidenceTrackPreview.vue';
import EvidencePreview from '@/components/evidence/EvidencePreview.vue';
import { getEvidenceFile } from '@/services/evidenceApi.js';
import { labelOf } from '@/ui/labels.js';
import { COMMAND_TYPE_LABEL } from '@/services/evidenceLedger.js';

const props = defineProps({ item: { type: Object, required: true } });
const opened = ref(false), file = ref(null), error = ref(''), loading = ref(false);
async function open() {
  opened.value = !opened.value;
  if (!opened.value || props.item.source_kind !== 'FILE' || file.value) return;
  loading.value = true; error.value = '';
  try {
    const result = await getEvidenceFile(props.item.source_id);
    if (props.item.sha256 && result.sha256 !== props.item.sha256) throw new Error('当前文件与移送时的校验值不一致，不能作为这份材料的证据打开。');
    file.value = result;
  } catch (e) { error.value = e.message || '证据读取失败'; }
  finally { loading.value = false; }
}
const time = value => value == null ? '未记录' : new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
</script>

<template>
  <div class="frozen-evidence">
    <button class="btn sm" type="button" :aria-expanded="opened" @click="open">{{ opened ? '收起证据' : '打开这份证据' }}</button>
    <template v-if="opened">
      <p v-if="loading" role="status">正在读取原件…</p>
      <p v-else-if="error" role="alert">{{ error }}</p>
      <EvidencePreview v-else-if="file" :file="file" />
      <EvidenceTrackPreview v-else-if="item.source_kind === 'TRACK' && item.content" :snapshot="item.content" :track-layer="item.layer" />
      <div v-else-if="item.source_kind === 'COMMAND' && item.content">
        <p>{{ labelOf(COMMAND_TYPE_LABEL, item.content.command_type, '设备指令') }} · {{ item.content.device_name || item.content.device_no }} · {{ item.content.status }}</p>
        <p>{{ item.content.simulated ? '模拟设备回执' : '设备回执' }} · 下发 {{ time(item.content.issued_at) }} · 完成 {{ time(item.content.completed_at) }}</p>
        <p v-if="item.content.result_detail">{{ item.content.result_detail }}</p>
        <p v-if="!item.content.receipts?.length">移送时尚无设备回执</p>
        <p v-for="receipt in item.content.receipts" :key="receipt.receipt_id">{{ time(receipt.occurred_at) }} · {{ receipt.receipt_kind }} · {{ receipt.device_result_code || '未提供结果码' }}</p>
      </div>
      <p v-else>这份历史材料只保存了证据清单，没有冻结可打开的内容；不能用当前轨迹代替当时的证据。</p>
    </template>
  </div>
</template>

<style scoped>
.frozen-evidence { display: grid; gap: 8px; min-width: 0; }
.frozen-evidence > button { justify-self: start; }
.frozen-evidence p { overflow-wrap: anywhere; font-size: 12px; }
</style>
