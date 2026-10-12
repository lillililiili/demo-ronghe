<script setup>
import { ref, onBeforeUnmount } from 'vue';
import { handoffApi } from '@/services/handoffApi.js';
import HandoffMaterialFacts from './HandoffMaterialFacts.vue';
const props = defineProps({ handoffId: { type: String, required: true } });
const opened = ref(false), detail = ref(null), loading = ref(false), error = ref('');
let generation = 0;
async function open() {
  opened.value = !opened.value;
  if (!opened.value) return;
  const request = ++generation;
  loading.value = true; detail.value = null; error.value = '';
  try { const result = await handoffApi.getHandoff(props.handoffId); if (generation === request) detail.value = result; }
  catch (e) { if (generation === request) error.value = e.message || '通知材料读取失败'; }
  finally { if (generation === request) loading.value = false; }
}
function accessChanged() { generation++; detail.value = null; loading.value = false; error.value = '登录或权限已变化，请重新打开材料'; }
window.addEventListener('auth-access-change', accessChanged);
onBeforeUnmount(() => { generation++; window.removeEventListener('auth-access-change', accessChanged); });
</script>
<template>
  <div class="handoff-material-panel">
    <button class="btn sm" type="button" :aria-expanded="opened" @click="open">{{ opened ? '收起通知材料' : '打开对应通知材料' }}</button>
    <template v-if="opened">
      <p v-if="loading" role="status">正在读取提交时的材料…</p>
      <p v-else-if="error" role="alert">{{ error }}</p>
      <p v-else-if="detail?.availability?.material !== 'AVAILABLE'">当前账号无法查看这份材料</p>
      <HandoffMaterialFacts v-else :material="detail.material" :evidence-availability="detail.availability?.evidence || ''" />
    </template>
  </div>
</template>
<style scoped>
.handoff-material-panel { display: grid; gap: 10px; min-width: 0; margin: 8px 0; }
.handoff-material-panel > button { justify-self: start; }
</style>
