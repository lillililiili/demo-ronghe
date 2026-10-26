<script setup>
/* 告警详情「处置进度」里的附近航班（2026-10-26 用户确认的设计）：
   - 自动反制因附近有航班或收不到航班信息没有启动时，写明原因，转人工判断。
   - 反制中有航班飞进禁止反制范围、系统自动停止时，写明是哪架航班，并弹出提醒。
   - 每次检查附近有哪些航班、谁确认后继续的，都列在「附近航班记录」里。
   没接入航班接收机时没有记录，整块不显示。 */
import { computed, onUnmounted, ref, watch } from 'vue';
import { flightAvoidanceApi } from '@/services/flightAvoidanceApi.js';
import { toast } from '@/ui/nv.js';

const props = defineProps({ eventId: { type: String, required: true }, alarmNo: { type: String, default: '' }, interval: { type: Number, default: 5000 } });
const rows = ref([]);
let timer = null, seq = 0, seenStops = null;

const STAGE = { REQUEST: '申请反制时', DIRECT: '直接反制时', EXECUTE: '下发反制前', AUTO: '自动反制前', RUNNING: '反制中' };
const RESULT = { CLEAR: '附近没有航班', WARN: '提醒范围有航班', NO_DATA: '收不到航班信息', BLOCK: '禁止反制范围有航班' };

async function load() {
  const id = props.eventId, mine = ++seq;
  if (!id || document.hidden) return;
  try {
    const data = await flightAvoidanceApi.checks(id);
    if (mine !== seq) return;
    rows.value = Array.isArray(data) ? data : [];
    announce();
  } catch {
    // 读不到时保留上次的内容；没有权限或后台没有这项功能时整块不显示。
  }
}

/** 反制中被自动停止：打开详情后新出现的才提醒，已经看到的不再弹。 */
function announce() {
  const stops = rows.value.filter(row => row.stage === 'RUNNING' && row.result === 'BLOCK');
  if (seenStops) stops.filter(row => !seenStops.has(row.check_id)).forEach(row => {
    const first = row.aircraft?.[0];
    toast(`反制已自动停止。${props.alarmNo ? `${props.alarmNo}：` : ''}${first ? `航班 ${planeName(first)} 飞近反制设备。` : '有航班飞近反制设备。'}`, 'err');
  });
  seenStops = new Set(stops.map(row => row.check_id));
}

watch(() => props.eventId, () => {
  rows.value = []; seenStops = null;
  clearInterval(timer);
  void load();
  timer = setInterval(load, props.interval);
}, { immediate: true });
onUnmounted(() => { seq++; clearInterval(timer); });

function planeName(a) { return a.callsign || String(a.icao24 || '').toUpperCase(); }
function km(value) { const n = Number(value); return n >= 10 ? Math.round(n) : Math.round(n * 10) / 10; }
function nearest(row) { return (row.aircraft || [])[0] || null; }
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '';

const autoNotice = computed(() => {
  const row = [...rows.value].reverse().find(item => item.stage === 'AUTO');
  if (!row) return null;
  const first = nearest(row);
  return { text: row.result === 'NO_DATA' || !first ? '暂时收不到航班信息，需要人工判断是否反制。'
    : `附近有航班 ${planeName(first)}（${km(first.distance_km)} 公里），需要人工判断是否反制。` };
});

const stopNotice = computed(() => {
  const row = [...rows.value].reverse().find(item => item.stage === 'RUNNING' && item.result === 'BLOCK');
  if (!row) return null;
  const first = nearest(row);
  const next = row.countermeasure_mode === 'FORCE_LAND' ? '可以改用驱离，或等航班飞远后再反制。' : '请等航班飞远后再反制。';
  const where = !first ? '有航班飞近反制设备'
    : first.approaching ? `航班 ${planeName(first)} 正在飞近反制设备（现在 ${km(first.distance_km)} 公里）`
      : `航班 ${planeName(first)} 在禁止反制范围内（${km(first.distance_km)} 公里）`;
  return { text: `${where}，反制已自动停止。${next}` };
});

const records = computed(() => [...rows.value].reverse().map(row => ({
  id: row.check_id, time: time(row.checked_at), stage: STAGE[row.stage] || '检查', result: RESULT[row.result] || row.result,
  tone: row.result === 'BLOCK' ? 'bad' : row.result === 'CLEAR' ? 'muted' : 'warn',
  who: row.acknowledged ? `${row.actor_name || '值班人员'} 确认后继续反制` : '',
  device: row.device_name || '',
  planes: (row.aircraft || []).slice(0, 5).map(a => `${planeName(a)} ${km(a.distance_km)} 公里${a.altitude_m == null ? '' : ` · 高度 ${a.altitude_m} 米`}${a.approaching ? ' · 正在靠近' : ''}`)
})));
</script>

<template>
  <template v-if="rows.length">
    <section v-if="autoNotice" class="auto-sms-notice is-compact flight-check-notice" aria-label="自动反制">
      <details open>
        <summary class="notice-summary"><b>自动反制</b><span class="notice-result fcn-warn">未启动</span><span class="notice-toggle">详情</span></summary>
        <p>{{ autoNotice.text }}</p>
      </details>
    </section>
    <section v-if="stopNotice" class="auto-sms-notice is-compact flight-check-notice" aria-label="反制自动停止">
      <details open>
        <summary class="notice-summary"><b>反制</b><span class="notice-result fcn-bad">已自动停止</span><span class="notice-toggle">详情</span></summary>
        <p>{{ stopNotice.text }}</p>
      </details>
    </section>
    <section class="auto-sms-notice is-compact flight-check-notice" aria-label="附近航班记录">
      <details>
        <summary class="notice-summary"><b>附近航班记录</b><span class="notice-result fcn-muted">{{ records.length }} 条</span><span class="notice-toggle">详情</span></summary>
        <ol class="fcn-records">
          <li v-for="record in records" :key="record.id">
            <p><span class="fcn-time">{{ record.time }}</span>{{ record.stage }}：<b :class="`fcn-${record.tone}`">{{ record.result }}</b></p>
            <p v-if="record.planes.length" class="fcn-planes">{{ record.planes.join('；') }}</p>
            <p v-if="record.who || record.device" class="fcn-meta">{{ [record.device, record.who].filter(Boolean).join(' · ') }}</p>
          </li>
        </ol>
      </details>
    </section>
  </template>
</template>

<style scoped>
.auto-sms-notice.is-compact{padding:9px 10px;margin-top:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg-soft,rgba(4,22,40,.25));min-width:0}
.notice-summary{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;min-height:24px;list-style:none;cursor:pointer}.notice-summary::-webkit-details-marker{display:none}
.notice-summary b{font-size:12px;color:var(--txt)}.notice-result{font-size:12px;font-weight:600}
.notice-toggle{margin-left:auto;color:var(--muted);font-size:11px;text-decoration:underline;text-underline-offset:3px}summary:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}
.flight-check-notice p{font-size:12px;line-height:1.6;margin:7px 0;overflow-wrap:anywhere}
.fcn-warn{color:var(--amber,#ffc160)}.fcn-bad{color:var(--red)}.fcn-muted{color:var(--muted)}
.fcn-records{margin:6px 0 0;padding:0;list-style:none}.fcn-records li{padding:6px 0;border-top:1px solid var(--line)}.fcn-records li:first-child{border-top:0}
.fcn-records p{margin:2px 0}.fcn-time{margin-right:8px;color:var(--txt-3);font-family:var(--app-font-mono)}.fcn-planes,.fcn-meta{color:var(--txt-2);font-size:11px}
</style>
