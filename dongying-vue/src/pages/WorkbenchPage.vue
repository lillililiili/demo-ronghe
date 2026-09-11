<script setup>
/* 我的工作台：三类源事项的只读聚合视图。队列、计数、详情全部来自 GET /workbench/items；
   核实/核验委托共享弹窗（alarmApi/riskApi），通知、反制委托既有接口，设备重启/恢复校验委托 deviceApi。
   API 失败直接显示错误，不回退 window.MOCK。 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { UField } from '@/components/form/index.js';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { toast } from '@/ui/nv.js';
import { closeModal } from '@/ui/modal.js';
import { openFormModal } from '@/ui/formModal.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import { createHandoff, listHandoffRecipients, newHandoffIdempotencyKey } from '@/services/handoffApi.js';
import { openUavVerification } from '@/ui/uavVerificationModal.js';
import { deviceApi, newIdempotencyKey } from '@/services/deviceApi.js';
import { disposalApi } from '@/services/disposalApi.js';
import { openDisposalRequest } from '@/ui/disposalAuthModal.js';
import { openRiskVerification } from '@/ui/riskVerificationModal.js';
import { authUser } from '@/services/auth.js';
import { loadTargetPosition, loadDevicePosition, loadRouteCenterline, installCenterline, centerOf } from '@/services/positionMap.js';
import { CONCLUSION_LABEL, RISK_CONCLUSION_LABEL, DELIVERY_STATUS_LABEL, HANDOFF_BLOCKED_LABEL, HANDOFF_TYPE_LABEL, RISK_TYPE_LABEL, labelOf, verificationOrdinal, readableNo } from '@/ui/labels.js';
import {
  KINDS, kindLabel, kindIcon, AVAILABILITY_LABEL,
  listWorkbenchEvents, workbenchStats, getWorkbenchDetail, loadUavSource, loadRiskSource, openSourcePage, sourcePageLabel, splitKey, stateLabel
} from '@/services/workbenchEvents.js';

const U = window.UI;
usePageChrome('workbench');

const PAGE_SIZE = 30;
const REFRESH_MS = 15_000;

const kind = ref('all');
const level = ref('all');
const items = ref([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref('');
const stats = ref(workbenchStats(null));
const highCount = ref(null);
const summaryError = ref('');
/* 没有工作台查看权限时，队列、三个计数、15 秒轮询会一直发注定被拒的请求（15-19①）。
   服务端只认动作权限 workbench:read，它不在 /auth/me 的 permission_codes 里，
   菜单里又始终有"我的工作台"，前端事先无从判断——所以以队列这一次请求的结果为准：
   一旦被拒，本页不再发第二个请求，也停掉轮询。 */
const forbidden = ref(false);
const selectedKey = ref('');
const detail = ref(null);
const detailLoading = ref(false);
const detailError = ref('');
const acting = ref(false);
const mapHost = ref(null);
let timer = null;
let queueSeq = 0, detailSeq = 0, summarySeq = 0;
/* 同一风险的交接幂等键在“结果未知”期间保留；明确成功或明确失败后才丢弃。 */
const pendingNotifyKeys = new Map();
const pendingRebootKeys = new Map();
const pendingRecoveryKeys = new Map();
const COMMAND_DONE = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED']);
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const currentUser = computed(() => authUser.value ? { name: authUser.value.name || authUser.value.account || '用户', roleName: authUser.value.role_name || authUser.value.role_code || '—' } : { name: '用户', roleName: '—' });
const selected = computed(() => detail.value);
const levels = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const levelLabel = { CRITICAL: '紧急', HIGH: '高', MEDIUM: '中', LOW: '低' };
const levelOptions = [{ label: '全部等级', value: 'all' }, ...levels.map(value => ({ label: `${levelLabel[value]}等级`, value }))];
const kindOptions = [{ value: 'all', label: '全部事项' }, ...KINDS.map(value => ({ value, label: kindLabel[value] }))];
const availabilityNotes = computed(() => KINDS.filter(k => stats.value.availability[k] && stats.value.availability[k] !== 'AVAILABLE')
  .map(k => ({ kind: k, label: kindLabel[k], text: AVAILABILITY_LABEL[stats.value.availability[k]] || stats.value.availability[k] })));

function icon(name) { return U.icon(name); }
function tagClass(e) { return e?.levelTag || 't-gray'; }
function countText(value) { return value == null ? '—' : String(value); }
function kindCount(k) { return k === 'all' ? countText(stats.value.total) : countText(stats.value.byKind[k]); }
function fmt(ms) {
  if (ms == null || ms === '') return '—';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function dateShort(ms) { return fmt(ms).replace(/^\d{4}-/, ''); }
function messageOf(e, fallback) {
  if (!e) return fallback;
  if (e.status === 401) return '登录已失效，请重新登录';
  if (e.status === 403) return '当前账号没有工作台读取权限';
  if (e.status === 404) return '事项不存在或已不在当前数据范围内';
  return e.message || fallback;
}
function queueQuery(p, size) {
  return { kind: kind.value === 'all' ? undefined : kind.value, severity: level.value === 'all' ? undefined : level.value, page: p, size };
}

/* ---------- 队列 ---------- */
async function loadQueue({ append = false, silent = false } = {}) {
  if (forbidden.value) return;
  const my = ++queueSeq;
  const nextPage = append ? page.value + 1 : 1;
  // 静默刷新时一次取回已展开的全部条数（上限 100），避免分页状态漂移。
  const size = append || !silent ? PAGE_SIZE : Math.min(100, Math.max(PAGE_SIZE, items.value.length));
  if (append) loadingMore.value = true; else if (!silent) loading.value = true;
  try {
    const data = await listWorkbenchEvents(queueQuery(nextPage, size));
    if (my !== queueSeq) return;
    items.value = append ? items.value.concat(data.items) : data.items;
    total.value = data.total;
    page.value = append ? nextPage : 1;
    error.value = '';
    ensureSelection();
  } catch (e) {
    if (my !== queueSeq) return;
    if (e.status === 403) { forbidden.value = true; error.value = '当前账号没有工作台查看权限，无法查看事项队列。'; }
    else error.value = messageOf(e, '读取工作台队列失败');
    if (!append && !silent) { items.value = []; total.value = 0; selectedKey.value = ''; }
  } finally {
    if (my === queueSeq) { loading.value = false; loadingMore.value = false; }
  }
}

/* 摘要：总计数/可用性 + 高等级事项数（HIGH 与 CRITICAL 两次 size=1 请求的 total）。 */
async function loadSummary() {
  if (forbidden.value) return;
  const my = ++summarySeq;
  try {
    const [all, high, critical] = await Promise.all([
      listWorkbenchEvents({ size: 1 }), listWorkbenchEvents({ severity: 'HIGH', size: 1 }), listWorkbenchEvents({ severity: 'CRITICAL', size: 1 })
    ]);
    if (my !== summarySeq) return;
    stats.value = workbenchStats(all);
    highCount.value = high.total + critical.total;
    summaryError.value = '';
  } catch (e) {
    if (my !== summarySeq) return;
    summaryError.value = messageOf(e, '读取工作台计数失败');
  }
}

async function loadDetail(key, { silent = false } = {}) {
  const my = ++detailSeq;
  const parts = splitKey(key);
  if (!parts) { detail.value = null; detailError.value = ''; destroyPositionMap(); return null; }
  if (!silent) detailLoading.value = true;
  try {
    const data = await getWorkbenchDetail(parts.kind, parts.sourceId);
    if (my !== detailSeq) return null;
    detail.value = data;
    detailError.value = '';
    if (!silent) renderPositionMap(data);
    return data;
  } catch (e) {
    if (my !== detailSeq) return null;
    if (!silent) detail.value = null;
    detailError.value = messageOf(e, '读取事项详情失败');
    return null;
  } finally {
    if (my === detailSeq) detailLoading.value = false;
  }
}

function ensureSelection() {
  if (items.value.some(e => e.key === selectedKey.value)) return;
  selectedKey.value = items.value[0]?.key || '';
}
watch(selectedKey, key => { loadDetail(key); });
watch([kind, level], () => { loadQueue(); });

function selectEvent(e) { selectedKey.value = e.key; }
function showKind(value) { kind.value = value; level.value = 'all'; }
function showHighRisk() { kind.value = 'all'; level.value = 'HIGH'; }
function loadMore() { if (!loadingMore.value) loadQueue({ append: true }); }

/* 源动作成功或结果未知后：刷新当前事项、队列与计数。 */
async function refreshAll() {
  await Promise.all([loadSummary(), loadQueue({ silent: true }), selectedKey.value ? loadDetail(selectedKey.value, { silent: true }) : Promise.resolve()]);
}
function refresh() { return refreshAll(); }

/* ---------- 事项位置（决策 15-54）：坐标从源对象读，不从工作台接口猜 ----------
   无人机告警 → 告警关联目标的最新位置与轨迹；飞行风险 → 风险关联的航线版本中心线 + 关联目标（若有）；
   设备告警 → 设备台账坐标。取不到就把原因写在面板里，不画 (0,0)。 */
let positionMap = null;
let mapSeq = 0;
const mapNote = ref('');
function destroyPositionMap() {
  if (positionMap) { try { positionMap.destroy(); } catch { /* 已卸载 */ } }
  positionMap = null;
}
function linkParamOf(link, key) {
  const q = typeof link === 'string' ? link.indexOf('?') : -1;
  return q < 0 ? null : new URLSearchParams(link.slice(q + 1)).get(key);
}
async function renderPositionMap(data) {
  const my = ++mapSeq;
  destroyPositionMap();
  mapNote.value = '正在读取位置…';
  const summary = data?.summary;
  if (!summary) { mapNote.value = ''; return; }
  let targets = [], devices = [], alarms = [], centerline = null, center = null, note = '';
  try {
    if (data.kind === 'UAV_EVENT') {
      const { alarm } = await loadUavSource(summary.sourceId);
      if (!alarm?.target_id) note = '告警没有关联目标或无目标读取权限，无法定位';
      else {
        const loaded = await loadTargetPosition(alarm.target_id);
        if (!loaded.mapTarget) note = `关联目标 ${loaded.target?.target_no || alarm.target_id} 坐标未知或不可信，不以 (0,0) 补位`;
        else {
          targets = [loaded.mapTarget];
          alarms = [{ id: alarm.alarm_id, targetId: loaded.mapTarget.id, type: summary.title, level: summary.level, time: fmt(summary.receivedAt), status: summary.sourceStatus }];
          center = [loaded.anchor.lon, loaded.anchor.lat];
        }
      }
    } else if (data.kind === 'RISK') {
      const risk = await loadRiskSource(summary.sourceId);
      if (risk?.route_version_id) { try { centerline = await loadRouteCenterline(risk.route_version_id); } catch { centerline = null; } }
      if (risk?.target_id) {
        try {
          const loaded = await loadTargetPosition(risk.target_id);
          if (loaded.mapTarget) { targets = [loaded.mapTarget]; center = [loaded.anchor.lon, loaded.anchor.lat]; }
        } catch { /* 目标读不到只影响标记，航线仍画 */ }
      }
      if (!center && centerline) center = centerOf(centerline);
      if (!center) note = '风险未关联航线版本或目标，或无相应读取权限，无可信坐标';
    } else {
      const deviceId = linkParamOf(summary.links?.source, 'device_id') || summary.sourceId;
      const loaded = await loadDevicePosition(deviceId);
      if (!loaded.mapDevice) note = '设备台账没有坐标，无法定位';
      else { devices = [loaded.mapDevice]; center = [loaded.mapDevice.lon, loaded.mapDevice.lat]; }
    }
  } catch (e) {
    note = messageOf(e, '读取位置失败');
  }
  if (my !== mapSeq) return;
  if (note) { mapNote.value = note; return; }
  mapNote.value = '';
  await nextTick();
  if (my !== mapSeq || !mapHost.value) return;
  positionMap = new window.MapView(mapHost.value, { zoom: 3, maxDev: 5, maxAlarm: 2, legend: false, layers: { device: devices.length > 0, track: targets.length > 0, alarm: alarms.length > 0 } });
  installCenterline(positionMap, centerline);
  positionMap.setData({ airspaces: [], devices, targets, alarms });
  if (targets.length) positionMap.sel = targets[0].id;
  if (center) positionMap.centerAt(center[0], center[1]);
}

/* ---------- 动作：核实/核验/通知/反制委托源模块；设备异常走 incident 重启与恢复校验 ---------- */
async function runUavAction() {
  const d = selected.value, td = d?.summary.todo;
  if (!d || d.kind !== 'UAV_EVENT' || !td || acting.value) return;
  if (!td.allowed) return toast(td.blocker || '当前动作不可执行', 'err');
  acting.value = true;
  try {
    const eventId = d.summary.sourceId;
    // 阶段 13：已核实事件的下一步是发起联动反制申请，走与告警页同一个授权弹窗。
    if (td.kind === 'countermeasure') {
      let policy = null;
      try { policy = await disposalApi.policies(); } catch { policy = null; }
      openDisposalRequest({
        actionType: 'COUNTERMEASURE',
        subjectKind: 'UAV_EVENT',
        subjectId: eventId,
        subjectText: d.summary.title || eventId,
        policy,
        refresh: async () => { await refreshAll(); return null; }
      });
      return;
    }
    if (td.kind === 'punish') {
      acting.value = false;
      return openUavPunishModal(d);
    }
    const { event, alarm } = await loadUavSource(eventId);
    openUavVerification({
      event, alarm,
      refresh: async () => {
        let latest = null;
        try { latest = (await loadUavSource(eventId)).event; } catch { latest = null; }
        await refreshAll();
        return latest;
      }
    });
  } catch (e) {
    toast(messageOf(e, '读取无人机事件失败，无法打开核实'), 'err');
  } finally { acting.value = false; }
}
async function runRiskPrimary() {
  const d = selected.value, td = d?.summary.todo;
  if (!d || d.kind !== 'RISK' || !td || acting.value) return;
  if (!td.allowed) return toast(td.blocker || '当前动作不可执行', 'err');
  acting.value = true;
  try {
    const riskId = d.summary.sourceId;
    const risk = await loadRiskSource(riskId);
    if (td.kind === 'notify') return openNotifyModal(risk, d.summary);
    openRiskVerification({
      risk,
      refresh: async () => {
        let latest = null;
        try { latest = await loadRiskSource(riskId); } catch { latest = null; }
        await refreshAll();
        return latest;
      }
    });
  } catch (e) {
    toast(messageOf(e, '读取飞行风险失败，无法打开核验'), 'err');
  } finally { acting.value = false; }
}
async function openUavPunishModal(d) {
  const eventId = d.summary.sourceId;
  let recipients = [];
  try {
    const page = await listHandoffRecipients('UAV_PUNISHMENT');
    recipients = page?.items || [];
  } catch (e) {
    return toast(messageOf(e, '读取处罚接收方失败'), 'err');
  }
  const options = recipients.map(r => ({ label: r.display_name, value: r.recipient_id }));
  if (!pendingNotifyKeys.has('punish:' + eventId)) pendingNotifyKeys.set('punish:' + eventId, newHandoffIdempotencyKey());
  openFormModal({
    title: '提交处罚交接',
    width: '560px',
    warning: '移送后由处罚部门在处罚页立案；提交成功只表示材料入库，不表示已发送或已立案。',
    notice: d.summary.title || eventId,
    fields: options.length
      ? [{ key: 'recipient_id', label: '接收方', type: 'select', required: true, options, placeholder: '选择处罚接收方' }]
      : [{ key: 'unconfigured', type: 'html', html: '<div class="warnbox">接收方未配置：处罚交接接收方目录为空，无法提交。</div>' }],
    initial: { recipient_id: options.length === 1 ? options[0].value : '' },
    confirmText: '提交移送',
    submitEnabled: m => options.length > 0 && !!m.recipient_id,
    onSubmit: async ({ recipient_id }) => {
      const key = pendingNotifyKeys.get('punish:' + eventId);
      try {
        await createHandoff({
          source_kind: 'UAV_EVENT', source_id: eventId, handoff_type: 'UAV_PUNISHMENT',
          recipient_id, expected_version: Number(d.summary.version)
        }, key);
        pendingNotifyKeys.delete('punish:' + eventId);
        closeModal();
        toast('已移送，可到处罚页立案', 'ok');
        await refreshAll();
      } catch (e) {
        throw new Error(messageOf(e, '提交处罚交接失败'));
      }
    }
  });
}

/* 通知上级 = 提交 RISK_NOTICE 交接：接收方来自服务端目录；提交成功风险变为“已通知”，可信确认回执后变为“已回执”。 */
async function openNotifyModal(risk, summary) {
  const riskId = risk.risk_id;
  // 风险详情接口的动作词典只有 VERIFY，NOTIFY 只出现在工作台事项里；放行依据取工作台 allowed_actions 或回读状态仍为待通知，
  // 交接权限由 createHandoff 的 403 裁决。expected_version 仍取回读的最新版本。
  const notifiable = (summary?.allowedActions || []).includes('NOTIFY') || risk.state === 'PENDING_NOTIFICATION';
  if (!notifiable) return toast('当前风险不可通知：状态已变化', 'err');
  let recipients = [];
  try { recipients = ((await listHandoffRecipients('RISK_NOTICE')) || {}).items || []; }
  catch (e) { return toast(messageOf(e, '读取接收方目录失败'), 'err'); }
  const options = recipients.map(r => ({ label: r.display_name, value: r.recipient_id }));
  if (!pendingNotifyKeys.has(riskId)) pendingNotifyKeys.set(riskId, newHandoffIdempotencyKey());
  openFormModal({
    title: '通知上级 · 提交交接',
    width: '560px',
    warning: '提交后由通知渠道投递并回执，送达与回执以投递记录为准；不表示处罚办结，提交成功后为已通知，收到确认回执后为已回执。',
    notice: [readableNo(risk.source_risk_id, risk.risk_id) ? `风险 ${readableNo(risk.source_risk_id, risk.risk_id)}` : '风险事件', labelOf(RISK_TYPE_LABEL, risk.risk_type, ''), Number(risk.version) > 0 ? `已第${Number(risk.version)}次核验` : '尚未核验'].filter(Boolean).join(' · '),
    fields: options.length
      ? [{ key: 'recipient_id', label: '接收方', type: 'select', required: true, options, placeholder: '选择逻辑接收部门' }]
      : [{ key: 'unconfigured', type: 'html', html: '<div class="warnbox">接收方未配置：交接接收方目录为空，无法提交；不会以默认部门补值。</div>' }],
    initial: { recipient_id: options.length === 1 ? options[0].value : '' },
    confirmText: '提交交接',
    submitEnabled: m => options.length > 0 && !!m.recipient_id,
    onSubmit: async ({ recipient_id }) => {
      const key = pendingNotifyKeys.get(riskId);
      try {
        const result = await createHandoff({ source_kind: 'RISK', source_id: riskId, handoff_type: 'RISK_NOTICE', recipient_id, expected_version: Number(risk.version) }, key);
        pendingNotifyKeys.delete(riskId);
        closeModal();
        toast(`${result?.delivery_status === 'DELIVERED' ? '已提交并送达' + (result?.receipt_status === 'ACKNOWLEDGED' ? '，接收方已回执' : '') : '已提交，尚未发送：交接材料已入库（待投递）'}。<a href="#/punish">前往处置与处罚页查看</a>`, 'ok');
        await refreshAll();
      } catch (e) {
        if (e && e.code === 'HANDOFF_ALREADY_EXISTS') {
          pendingNotifyKeys.delete(riskId);
          closeModal();
          toast('该风险已存在同类型、同接收方的交接，未重复提交。可在处置与处罚页查看。', 'err');
          await refreshAll();
          return;
        }
        if (isUncertainOutcome(e)) {
          // 409 重放/版本冲突、超时、断网：服务端可能已落库。保留原键，回读事项与计数，不换键重试、不提示成功。
          await refreshAll();
          throw new Error(`提交结果未确认，请刷新核对：${messageOf(e, '未返回明确结果')}`);
        }
        pendingNotifyKeys.delete(riskId);
        pendingNotifyKeys.set(riskId, newHandoffIdempotencyKey());
        throw new Error(messageOf(e, '提交交接失败'));
      }
    }
  });
}
async function waitCommand(commandId) {
  let last = null;
  for (let i = 0; i < 20; i++) {
    last = await deviceApi.command(commandId);
    if (last && COMMAND_DONE.has(last.status)) return last;
    await new Promise(resolve => window.setTimeout(resolve, 400));
  }
  return last;
}
function runDeviceAction() {
  const d = selected.value, td = d?.summary.todo;
  if (!d || d.kind !== 'DEVICE_INCIDENT' || !td || acting.value) return;
  if (!td.allowed) return toast(td.blocker || '当前动作不可执行', 'err');
  if (td.kind === 'device-verify') return runDeviceRecovery(d);
  return openDeviceReboot(d);
}
async function runDeviceRecovery(d) {
  const incidentId = d.summary.sourceId;
  if (!pendingRecoveryKeys.has(incidentId)) pendingRecoveryKeys.set(incidentId, newIdempotencyKey('incident-recovery'));
  acting.value = true;
  try {
    const result = await deviceApi.checkIncidentRecovery(incidentId, pendingRecoveryKeys.get(incidentId));
    pendingRecoveryKeys.delete(incidentId);
    if (result.result === 'PASS') toast('恢复校验通过，异常已关闭', 'ok');
    else if (result.result === 'UNKNOWN') toast(`设备状态未知，未关闭异常${result.reason ? '：' + result.reason : ''}`, 'err');
    else toast(`恢复校验未通过，异常仍待验证${result.reason ? '：' + result.reason : ''}`, 'err');
    await refreshAll();
  } catch (e) {
    if (isUncertainOutcome(e)) {
      await refreshAll();
      toast(`校验结果未确认，请刷新核对：${messageOf(e, '未返回明确结果')}`, 'err');
    } else toast(messageOf(e, '恢复校验失败'), 'err');
  } finally { acting.value = false; }
}
function openDeviceReboot(d) {
  const incidentId = d.summary.sourceId;
  if (!pendingRebootKeys.has(incidentId)) pendingRebootKeys.set(incidentId, newIdempotencyKey('incident-reboot'));
  openFormModal({
    title: '远程重启 · 设备异常',
    width: '560px',
    warning: '提交后等待适配器回执。模拟回执不代表真实设备已重启；协议未声明重启能力或设备离线时会失败，异常保持待处理。',
    notice: [d.summary.title, d.summary.sourceNo].filter(Boolean).join(' · '),
    fields: [{ key: 'reason', label: '重启原因', type: 'textarea', required: true, minRows: 3, maxlength: 500, placeholder: '说明为何对该异常下发重启' }],
    confirmText: '下发重启',
    submitEnabled: m => String(m.reason || '').trim().length >= 2,
    onSubmit: async ({ reason }) => {
      const key = pendingRebootKeys.get(incidentId);
      try {
        const command = await deviceApi.rebootIncident(incidentId, String(reason || '').trim(), key);
        closeModal();
        toast('重启指令已受理，等待回执', 'ok');
        acting.value = true;
        try {
          const done = await waitCommand(command.command_id);
          if (done?.status === 'SUCCEEDED') toast('重启回执已收到，请进行恢复校验', 'ok');
          else if (done?.status) toast(`重启未成功（${done.status}），可重新下发`, 'err');
          else toast('尚未收到回执，请稍后刷新核对', 'err');
        } finally { acting.value = false; }
        pendingRebootKeys.delete(incidentId);
        await refreshAll();
      } catch (e) {
        if (isUncertainOutcome(e)) {
          await refreshAll();
          throw new Error(`提交结果未确认，请刷新核对：${messageOf(e, '未返回明确结果')}`);
        }
        pendingRebootKeys.delete(incidentId);
        pendingRebootKeys.set(incidentId, newIdempotencyKey('incident-reboot'));
        throw new Error(messageOf(e, '下发重启失败'));
      }
    }
  });
}
function primaryAction() {
  const d = selected.value;
  if (!d) return;
  if (d.kind === 'UAV_EVENT') return runUavAction();
  if (d.kind === 'RISK') return runRiskPrimary();
  return runDeviceAction();
}
function openSource() {
  if (!openSourcePage(selected.value?.summary)) toast('该事项没有可用的站内跳转链接', 'err');
}

/* 时间线只留一行摘要（标题 + 时间 + 状态变化）；完整字段在上方"记录"面板逐条展示，不重复。
   枚举一律经共享字典翻译；版本号显示为"第 N 次核实"；可选字段无值时不拼接。 */
function conclusionLabel(kindValue, code) {
  return labelOf(kindValue === 'RISK' ? RISK_CONCLUSION_LABEL : CONCLUSION_LABEL, code, '核实');
}
function timelineTitle(t, kindValue) {
  if (t.entry_type === 'VERIFICATION') return `${verificationOrdinal(t.version) || '核实'} · 结论：${conclusionLabel(kindValue, t.conclusion)}`;
  if (t.entry_type === 'HANDOFF') return `交接已提交 · ${labelOf(DELIVERY_STATUS_LABEL, t.delivery_status)}`;
  if (t.entry_type === 'DEVICE_INCIDENT_DETECTED') return '设备异常检出';
  if (t.entry_type === 'DEVICE_INCIDENT_CLOSED') return '设备异常关闭';
  return t.entry_type;
}
function timelineMeta(t, kindValue) {
  if (t.entry_type === 'VERIFICATION') return `${fmt(t.at)} · 状态：${stateLabel(kindValue, t.previous_state)} → ${stateLabel(kindValue, t.resulting_state)}`;
  if (t.entry_type === 'HANDOFF') {
    const parts = [fmt(t.at), `接收方 ${t.recipient_name || '—'}`];
    const basis = verificationOrdinal(t.source_version, '依据');
    if (basis) parts.push(basis);
    if (t.blocked_reason) parts.push(labelOf(HANDOFF_BLOCKED_LABEL, t.blocked_reason));
    return parts.join(' · ');
  }
  const parts = [fmt(t.at)];
  if (t.stage) parts.push(stateLabel('DEVICE_INCIDENT', t.stage));
  if (t.reason) parts.push(t.reason);
  return parts.join(' · ');
}
const verifications = computed(() => (selected.value?.timeline || []).filter(t => t.entry_type === 'VERIFICATION'));
const handoffs = computed(() => (selected.value?.timeline || []).filter(t => t.entry_type === 'HANDOFF'));

/* ---------- 生命周期：路由进入重新 GET；15 秒刷新摘要与当前事项；切换账号清空旧数据 ---------- */
function resetAll() {
  queueSeq++; detailSeq++; summarySeq++;
  items.value = []; total.value = 0; page.value = 1; selectedKey.value = ''; detail.value = null;
  error.value = ''; detailError.value = ''; summaryError.value = ''; stats.value = workbenchStats(null); highCount.value = null;
  forbidden.value = false;
}
async function enter() {
  resetAll();
  if (!authUser.value) return;
  // 先拉队列，确认这个账号读得到工作台，再去拉三个计数；读不到就一个都不发。
  await loadQueue();
  loadSummary();
}
function tick() {
  if (!authUser.value || forbidden.value) return;
  loadSummary();
  loadQueue({ silent: true });
  if (selectedKey.value) loadDetail(selectedKey.value, { silent: true });
}
const accessChanged = () => { enter(); };
onMounted(() => {
  window.addEventListener('auth-access-change', accessChanged);
  timer = window.setInterval(tick, REFRESH_MS);
  enter();
});
onUnmounted(() => {
  window.removeEventListener('auth-access-change', accessChanged);
  if (timer) window.clearInterval(timer);
  timer = null;
  resetAll();
  destroyPositionMap();
});
</script>

<template>
  <div class="view workbench-view" id="view">
    <div class="workbench-page">
      <header class="wb-hero">
        <div>
          <div class="wb-eyebrow"><span v-html="icon('home')"></span> 我的工作台</div>
          <h1>{{ currentUser.name }}，这是您当前需要关注的事项</h1>
          <p>按等级、接收时间统一排序；每个事项只呈现一个明确的下一步。<span v-if="stats.asOf" class="wb-asof">数据时刻 {{ fmt(stats.asOf) }}</span></p>
        </div>
        <div class="wb-user-chip">
          <span class="wb-user-avatar" v-html="icon('user')"></span>
          <span><b>{{ currentUser.name }}</b><small>{{ currentUser.roleName }}</small></span>
        </div>
      </header>

      <div class="wb-kpis">
        <button class="wb-kpi is-cyan" :class="{ active: kind === 'all' && level === 'all' }" :aria-pressed="kind === 'all' && level === 'all'" @click="showKind('all')">
          <span v-html="icon('clipboard')"></span><em>全部事项</em><b>{{ countText(stats.total) }}</b>
        </button>
        <button class="wb-kpi is-red" :class="{ active: kind === 'all' && level === 'HIGH' }" :aria-pressed="kind === 'all' && level === 'HIGH'" @click="showHighRisk">
          <span v-html="icon('warning')"></span><em>高等级事项</em><b>{{ countText(highCount) }}</b>
        </button>
        <button class="wb-kpi is-blue" :class="{ active: kind === 'UAV_EVENT' && level === 'all' }" :aria-pressed="kind === 'UAV_EVENT' && level === 'all'" @click="showKind('UAV_EVENT')">
          <span v-html="icon('plane')"></span><em>无人机告警</em><b>{{ kindCount('UAV_EVENT') }}</b>
        </button>
        <button class="wb-kpi is-purple" :class="{ active: kind === 'RISK' && level === 'all' }" :aria-pressed="kind === 'RISK' && level === 'all'" @click="showKind('RISK')">
          <span v-html="icon('plan')"></span><em>飞行计划风险</em><b>{{ kindCount('RISK') }}</b>
        </button>
        <button class="wb-kpi is-amber" :class="{ active: kind === 'DEVICE_INCIDENT' && level === 'all' }" :aria-pressed="kind === 'DEVICE_INCIDENT' && level === 'all'" @click="showKind('DEVICE_INCIDENT')">
          <span v-html="icon('device')"></span><em>设备告警</em><b>{{ kindCount('DEVICE_INCIDENT') }}</b>
        </button>
      </div>

      <div v-if="summaryError" class="warnbox wb-inline-error">{{ summaryError }}</div>
      <div v-if="availabilityNotes.length" class="wb-availability">
        <span v-for="n in availabilityNotes" :key="n.kind" class="tag t-gray">{{ n.label }}：{{ n.text }}</span>
      </div>

      <div class="wb-layout">
        <aside class="panel wb-event-panel">
          <div class="ph"><h3>当前事项</h3><span class="sub">{{ items.length }} / {{ total }} 件</span></div>
          <div class="wb-kind-tabs" aria-label="事项类型筛选">
            <button v-for="o in kindOptions" :key="o.value" :class="{ on: kind === o.value }" :aria-pressed="kind === o.value" @click="showKind(o.value)">
              <span>{{ o.label }}</span><b>{{ kindCount(o.value) }}</b>
            </button>
          </div>
          <div class="wb-filters">
            <UField variant="toolbar" label="风险等级" sr-only v-model="level" type="select" :options="levelOptions" />
            <span class="wb-sort-note"><span v-html="icon('trend')"></span> 等级 · 接收时间</span>
          </div>
          <div class="wb-event-list">
            <div v-if="forbidden" class="empty wb-empty">{{ error }}</div>
            <div v-else-if="error" class="empty wb-empty wb-error">{{ error }}<br><button class="btn" type="button" @click="loadQueue()">重试</button></div>
            <div v-else-if="loading && !items.length" class="empty wb-empty">正在读取工作台队列…</div>
            <button v-for="e in items" :key="e.key" class="wb-event-card" :class="{ on: selectedKey === e.key }" @click="selectEvent(e)">
              <span class="wb-event-icon" v-html="icon(kindIcon[e.kind])"></span>
              <span class="wb-event-copy">
                <span class="wb-event-top"><em>{{ e.kindLabel }}</em><span><i class="wb-source-state">{{ e.sourceStatus }}</i><i class="tag" :class="tagClass(e)">{{ e.level }}</i></span></span>
                <b>{{ e.title }}</b><small v-if="e.sourceNo" class="mono" :title="e.sourceId">{{ e.sourceNo }}</small>
                <span class="wb-event-meta"><i>{{ e.sourceModeLabel }}</i><i>{{ dateShort(e.receivedAt) }}</i></span>
                <span class="wb-event-next">下一步：{{ e.todo?.action || '无需处理' }}</span>
              </span>
            </button>
            <button v-if="!error && items.length < total" class="wb-load-more" type="button" :disabled="loadingMore" @click="loadMore">{{ loadingMore ? '加载中…' : `继续加载 ${Math.min(PAGE_SIZE, total - items.length)} 件` }}</button>
            <div v-if="!error && !loading && !items.length" class="empty wb-empty">当前筛选条件下没有事项<br><small>可切换事项类型或等级；无权限或未配置的类别不会出现在队列中</small></div>
          </div>
        </aside>

        <main v-if="selected" class="wb-workspace">
          <section class="panel wb-title-panel">
            <div class="wb-title-main">
              <span class="wb-title-icon" v-html="icon(kindIcon[selected.kind])"></span>
              <div><small>{{ kindLabel[selected.kind] }}</small><h2>{{ selected.summary.title }}</h2>
                <p v-if="selected.summary.sourceNo" class="mono" :title="selected.summary.sourceId">{{ selected.summary.sourceNo }}</p></div>
            </div>
            <div class="wb-title-tags"><span class="tag" :class="tagClass(selected.summary)">{{ selected.summary.level }}</span><span class="tag t-cyan">{{ selected.summary.sourceStatus }}</span></div>
            <div v-if="selected.summary.todo" class="wb-title-next">
              <span><small>下一步</small><b>{{ selected.summary.todo.action }}</b></span>
              <button class="btn pri" type="button" :disabled="!selected.summary.todo.allowed || acting" :title="selected.summary.todo.blocker || ''" @click="primaryAction">{{ selected.summary.todo.action }}</button>
            </div>
            <div class="wb-title-facts"><span><small>接收时间</small><b>{{ fmt(selected.summary.receivedAt) }}</b></span><span><small>发生时间</small><b>{{ selected.summary.occurredAt == null ? '未知' : fmt(selected.summary.occurredAt) }}</b></span></div>
          </section>

          <div v-if="detailError" class="warnbox wb-inline-error">{{ detailError }}</div>

          <section class="panel wb-task-panel">
            <div class="ph"><h3>当前任务</h3><span class="sub">系统只给出一个明确主动作</span></div>
            <div v-if="selected.summary.todo" class="wb-task">
              <span class="wb-task-state" v-html="icon(selected.kind === 'DEVICE_INCIDENT' ? 'tool' : 'bolt')"></span>
              <div><small>下一步</small><h3>{{ selected.summary.todo.action }}</h3><p>{{ selected.summary.todo.hint }}</p>
                <span>责任模块：<b>{{ selected.summary.module }}</b></span><span v-if="selected.summary.todo.blocker" class="wb-blocker">{{ selected.summary.todo.blocker }}</span></div>
            </div>
            <div v-else class="wb-complete"><span v-html="icon('check')"></span><div><b>当前事项无待办动作</b><small>{{ selected.summary.blockedLabel || '可在下方查看核实历史与时间线。' }}</small></div></div>
          </section>

          <section class="wb-flow-card panel">
            <div class="ph"><h3>{{ selected.kind === 'RISK' ? '飞行计划风险流程' : selected.kind === 'UAV_EVENT' ? '无人机事件处置流程' : '设备异常处置流程' }}</h3><span class="sub">{{ selected.kind === 'DEVICE_INCIDENT' ? '按异常类型与核验结果展示；心跳恢复不代表执行过重启' : '按当前业务状态展示' }}</span></div>
            <div class="wb-flow" :style="{ '--wb-flow-count': selected.steps.length }">
              <div v-for="(s,i) in selected.steps" :key="s.n" :class="['wb-flow-step',{done:s.done,active:s.act}]">
                <span>{{ s.done ? '✓' : i + 1 }}</span><b>{{ s.n }}</b><small>{{ s.done ? (s.t || '已完成') : s.t ? s.t : s.act ? '当前环节' : '待处理' }}</small>
              </div>
            </div>
          </section>

          <div class="wb-work-grid">
            <section class="panel wb-conclusion">
              <div class="ph"><h3>{{ selected.kind === 'UAV_EVENT' ? '事件摘要' : selected.kind === 'RISK' ? '风险判据' : '设备异常' }}</h3></div>
              <div class="wb-kv-grid">
                <span><small>类型 / 等级</small><b>{{ selected.summary.title }}</b></span>
                <span><small>当前状态</small><b>{{ selected.summary.sourceStatus }}</b></span>
                <span><small>来源模式</small><b>{{ selected.summary.sourceModeLabel || '—' }}</b></span>
                <span><small>最近更新</small><b>{{ selected.summary.updatedAt == null ? '—' : fmt(selected.summary.updatedAt) }}</b></span>
                <p class="wb-advice">{{ selected.summary.summary }}</p>
              </div>
            </section>

            <section class="panel wb-map-panel"><div class="ph"><h3>事项位置</h3><span class="sub">{{ selected.kind === 'UAV_EVENT' ? '关联目标最新位置与实测轨迹' : selected.kind === 'RISK' ? '关联航线中心线与目标位置' : '设备台账坐标' }}</span></div>
              <div class="wb-map" :class="{ 'wb-map-unavailable': !!mapNote }">
                <div v-if="mapNote" class="empty">{{ mapNote }}<br><small>可到{{ sourcePageLabel[selected.kind] }}页查看更多</small></div>
                <div v-else ref="mapHost" class="wb-map-host"></div>
              </div>
            </section>
          </div>

          <section class="panel wb-relations">
            <div class="ph"><h3>事项关系</h3><span class="sub">只展示已授权返回的引用与站内跳转</span></div>
            <div class="wb-relation-line">
              <span><small>事项类型</small><b>{{ kindLabel[selected.kind] }}</b></span><i>→</i>
              <span><small>源编号</small><b class="mono" :title="selected.summary.sourceId">{{ selected.summary.sourceNo || '—' }}</b></span><i>→</i>
              <span v-if="selected.kind === 'RISK'"><small>交接记录</small><b>{{ selected.availability.handoffs === 'AVAILABLE' ? `${handoffs.length} 条` : selected.availability.handoffs === 'FORBIDDEN' ? '无读取权限' : '—' }}</b></span>
              <span v-else-if="selected.kind === 'UAV_EVENT'"><small>核实记录</small><b>{{ verifications.length }} 条</b></span>
              <span v-else><small>动作</small><b>{{ selected.summary.todo?.allowed ? selected.summary.todo.action : (selected.summary.blockedLabel || selected.summary.todo?.blocker || '—') }}</b></span><i>→</i>
              <span><small>原始记录所在页</small><button class="btn" type="button" :disabled="!selected.summary.links?.source" @click="openSource">打开{{ sourcePageLabel[selected.kind] }}页</button></span>
            </div>
          </section>

          <div class="wb-bottom-grid">
            <section class="panel wb-records">
              <div class="ph"><h3>{{ selected.kind === 'RISK' ? '交接与核验记录' : selected.kind === 'UAV_EVENT' ? '核实记录' : '设备异常事实' }}</h3></div>
              <div class="wb-record-list">
                <template v-if="selected.kind === 'RISK'">
                  <div v-if="selected.availability.handoffs === 'FORBIDDEN'" class="empty">交接记录需要 handoff:read 权限</div>
                  <div v-for="h in handoffs" :key="h.handoff_id" class="wb-record-row"><span v-html="icon('mail')"></span><b :title="h.recipient_id">{{ h.recipient_name || '—' }}</b><small>{{ fmt(h.at) }} · {{ labelOf(HANDOFF_TYPE_LABEL, h.handoff_type) }}<template v-if="verificationOrdinal(h.source_version)"> · {{ verificationOrdinal(h.source_version, '依据') }}</template></small><em>{{ labelOf(DELIVERY_STATUS_LABEL, h.delivery_status) }}</em></div>
                  <div v-for="v in verifications" :key="'v' + v.version" class="wb-record-row"><span v-html="icon('clipboard')"></span><b>结论：{{ labelOf(RISK_CONCLUSION_LABEL, v.conclusion) }}</b><small>{{ fmt(v.at) }} · 核验人 <span :title="v.actor_id">{{ v.actor_name || '—' }}</span><template v-if="v.note"> · 备注：{{ v.note }}</template></small><em>{{ verificationOrdinal(v.version) }}</em></div>
                  <div v-if="!handoffs.length && !verifications.length && selected.availability.handoffs !== 'FORBIDDEN'" class="empty">暂无交接或核验记录</div>
                </template>
                <template v-else-if="selected.kind === 'UAV_EVENT'">
                  <div v-for="v in verifications" :key="'v' + v.version" class="wb-record-row"><span v-html="icon('clipboard')"></span><b>结论：{{ labelOf(CONCLUSION_LABEL, v.conclusion) }}</b><small>{{ fmt(v.at) }} · 核实人 <span :title="v.actor_id">{{ v.actor_name || '—' }}</span><template v-if="v.note"> · 备注：{{ v.note }}</template></small><em>{{ verificationOrdinal(v.version) }}</em></div>
                  <div v-if="!verifications.length" class="empty">暂无核实记录</div>
                </template>
                <template v-else>
                  <div v-for="t in selected.timeline" :key="t.entry_type + t.at" class="wb-record-row"><span v-html="icon('tool')"></span><b>{{ timelineTitle(t, selected.kind) }}</b><small>{{ t.device_no }} · {{ t.device_name }}<template v-if="t.reason"> · {{ t.reason }}</template></small><em>{{ stateLabel('DEVICE_INCIDENT', t.stage) }}</em></div>
                  <div v-if="!selected.timeline.length" class="empty wb-record-empty">
                    <span class="wb-record-empty-icon" v-html="icon('tool')"></span>
                    <b>暂无设备事实</b>
                    <small>检出与关闭事实会显示在这里；进行中的重启请看当前任务</small>
                  </div>
                </template>
              </div>
            </section>
            <section class="panel wb-timeline">
              <div class="ph"><h3>事项时间线</h3><span class="sub">有范围的核实历史、交接与设备事实</span></div>
              <div class="wb-timeline-list">
                <div v-for="t in selected.timeline" :key="t.entry_type + t.at + (t.version || t.handoff_id || '')"><i></i><span><b>{{ timelineTitle(t, selected.kind) }}</b><small>{{ timelineMeta(t, selected.kind) }}</small></span></div>
                <div v-if="!selected.timeline.length" class="empty">暂无时间线记录</div>
              </div>
            </section>
          </div>
        </main>
        <main v-else class="panel wb-no-selection">
          <div v-if="detailLoading" class="empty">正在读取事项详情…</div>
          <div v-else-if="detailError" class="empty wb-error">{{ detailError }}<br><button class="btn" type="button" @click="loadDetail(selectedKey)">重试</button></div>
          <div v-else class="empty">请选择左侧事项查看工作区</div>
        </main>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workbench-page .wb-asof { margin-left: 10px; color: var(--txt-3); font-size: 12px; }
.workbench-page .wb-inline-error { margin: 10px 0 0; }
.workbench-page .wb-availability { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.workbench-page .wb-map-unavailable { display: grid; place-items: center; }
.workbench-page .wb-error .btn { margin-top: 8px; }
</style>
