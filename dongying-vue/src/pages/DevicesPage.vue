<script setup>
import { computed, h, onMounted, reactive, ref } from 'vue';
import { NButton, NDataTable, NEmpty, NSpin, NTag } from 'naive-ui';
import UField from '@/components/form/UField.vue';
import UPagination from '@/components/UPagination.vue';
import UKpis from '@/components/UKpis.vue';
import UPanel from '@/components/UPanel.vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { canRouteAction } from '@/services/accessControl.js';
import { deviceApi, integrationApi } from '@/services/deviceApi.js';
import { closeModal } from '@/ui/modal.js';
import { openFormModal, optionsOf } from '@/ui/formModal.js';
import { toast } from '@/ui/nv.js';

usePageChrome('devices');
const filters = reactive({ keyword: '', type_code: null, channel: null, region: null, vendor: null,
  connectivity: null, enabled: null, sort: 'priority' });
const options = ref({ types: [], channels: [], regions: [], vendors: [] });
const protocols = ref([]);
const page = reactive({ items: [], page: 1, size: 10, total: 0 });
const overview = ref({ total: 0, online: 0, offline: 0, abnormal: 0, unknown: 0, alarm: 0, vendor_count: 0, model_count: 0, simulated: false });
const selectedId = ref('');
const detail = ref(null);
const protocolStatus = ref(null);
const loading = ref(false);
const detailLoading = ref(false);
const error = ref('');
const canOperate = computed(() => canRouteAction('devices', 'op'));
const selected = computed(() => detail.value?.device || null);
const protocolOptions = computed(() => optionsOf((protocols.value || []).map(item => [item.protocol_code, `${item.name} · v${item.version}`])));
const radarField = model => model.protocol_code === 'RADAR_TCP_V3_0_0';
const countermeasureField = model => model.protocol_code === 'COUNTERMEASURE_TCP_4CH_V2_0';
function protocolLabel(code, version) {
  const item = (protocols.value || []).find(p => p.protocol_code === code);
  if (item) return item.version ? `${item.name} · v${item.version}` : item.name;
  return version ? `${code} · v${version}` : (code || '未配置');
}
const statusMeta = { ABNORMAL: ['异常', 'error'], OFFLINE: ['离线', 'default'], UNKNOWN: ['未知', 'warning'], ONLINE: ['在线', 'success'] };
const healthText = { GOOD: '良好', DEGRADED: '一般', BAD: '异常', UNKNOWN: '未知' };
const fmtTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const selectOptions = values => optionsOf((values || []).map(value => [value, value]));

const kpis = computed(() => [
  { label: '设备总数', value: overview.value.total, color: 'blue', icon: 'device' },
  { label: '在线', value: overview.value.online, color: 'green', icon: 'check' },
  { label: '异常 / 未知', value: `${overview.value.abnormal} / ${overview.value.unknown}`, color: 'red', icon: 'alert' },
  { label: '告警中设备', value: overview.value.alarm, color: 'amber', icon: 'alert' },
  { label: '供应商', value: overview.value.vendor_count, color: 'purple', icon: 'api' }
]);

function statusTag(value) {
  const meta = statusMeta[value] || [value || '未知', 'default'];
  return h(NTag, { size: 'small', type: meta[1], bordered: false }, { default: () => meta[0] });
}
const columns = [
  { title: '设备编号', key: 'device_no', width: 150, fixed: 'left' },
  { title: '设备名称', key: 'name', width: 190, ellipsis: { tooltip: true } },
  { title: '类型', key: 'device_type_name', width: 100 },
  { title: '接入通道', key: 'channel', width: 120 },
  { title: '区域', key: 'region_name', width: 110 },
  { title: '供应商', key: 'vendor', width: 140, render: row => row.vendor || '—' },
  { title: '连接', key: 'connectivity', width: 82, render: row => statusTag(row.connectivity) },
  { title: '健康', key: 'health_code', width: 76, render: row => healthText[row.health_code] || '未知' },
  { title: '最后心跳', key: 'last_heartbeat_at', width: 168, render: row => fmtTime(row.last_heartbeat_at) },
  { title: '状态', key: 'enabled', width: 84, render: row => h(NTag, { size: 'small', type: row.enabled ? 'success' : 'default', bordered: false }, { default: () => row.enabled ? '启用' : '停用' }) },
  { title: '操作', key: 'actions', width: 128, fixed: 'right', render: row => h('div', { class: 'table-actions' }, [
    h(NButton, { text: true, type: 'primary', disabled: !canOperate.value, onClick: e => { e.stopPropagation(); openDeviceForm(row); } }, { default: () => '编辑' }),
    h(NButton, { text: true, type: row.enabled ? 'error' : 'success', disabled: !canOperate.value,
      onClick: e => { e.stopPropagation(); openEnabledForm(row); } }, { default: () => row.enabled ? '停用' : '启用' })
  ]) }
];

async function loadList({ keepSelection = true } = {}) {
  loading.value = true;
  error.value = '';
  try {
    const data = await deviceApi.list({ ...filters, page: page.page, size: page.size });
    Object.assign(page, data);
    if (!keepSelection || !page.items.some(item => item.device_id === selectedId.value)) selectedId.value = page.items[0]?.device_id || '';
    if (selectedId.value) await loadDetail(selectedId.value); else detail.value = null;
  } catch (e) { error.value = e.message || '设备台账加载失败'; }
  finally { loading.value = false; }
}
async function refreshOverview() {
  try { overview.value = await deviceApi.overview(); }
  catch (e) { if (!error.value) error.value = e.message || '设备概览加载失败'; }
}
async function bootstrap() {
  loading.value = true; error.value = '';
  try {
    const [optionData, overviewData, protocolData] = await Promise.all([deviceApi.options(), deviceApi.overview(), integrationApi.protocols()]);
    options.value = optionData; overview.value = overviewData;
    protocols.value = protocolData;
    await loadList({ keepSelection: false });
  } catch (e) { error.value = e.message || '设备管理数据加载失败'; loading.value = false; }
}
async function loadDetail(id) {
  detailLoading.value = true;
  try {
    const [deviceDetail, status] = await Promise.all([deviceApi.detail(id), deviceApi.protocolStatus(id)]);
    detail.value = deviceDetail; protocolStatus.value = status;
  }
  catch (e) { toast(e.message || '设备详情加载失败', 'err'); detail.value = null; protocolStatus.value = null; }
  finally { detailLoading.value = false; }
}
function selectRow(row) { selectedId.value = row.device_id; loadDetail(row.device_id); }
function onPageSize(value) {
  page.size = value;
  page.page = 1;
  loadList({ keepSelection: false });
}
function resetFilters() {
  Object.assign(filters, { keyword: '', type_code: null, channel: null, region: null, vendor: null,
    connectivity: null, enabled: null, sort: 'priority' });
  page.page = 1; loadList({ keepSelection: false });
}
function formFields(editing = false) {
  return [
    { key: 'protocol_code', label: '接入协议', type: 'select', required: true, options: protocolOptions.value,
      disabled: editing, help: editing ? '更换协议需要停用后重新接入' : '选定协议后按该设备的实际 TCP 地址接入，类型和通道由协议决定' },
    { key: 'device_no', label: '设备编号', required: true, placeholder: '现场设备编号' },
    { key: 'name', label: '设备名称', required: true, placeholder: '现场设备名称' },
    { key: 'host', label: '设备地址', required: true, placeholder: '现场 IP' },
    { key: 'port', label: '端口', type: 'number', required: true, min: 1, max: 65535, placeholder: '现场端口' },
    { key: 'allowed_cidrs', label: '设备网段 CIDR', required: true, placeholder: '现场设备网段 CIDR', },
    { key: 'region_name', label: '所属区域', placeholder: '例如 东营区' },
    { key: 'vendor', label: '供应商', placeholder: '例如 设备厂商名称' },
    { key: 'radar_protocol_title', type: 'html', visibleWhen: radarField,
      html: '<b>雷达只读接入</b><small>不会开放雷达启停或寄存器写入。</small>' },
    { key: 'recognition_code_ref', label: '雷达识别码引用', visibleWhen: radarField, placeholder: '例如 env:RADAR_RECOGNITION_CODE',
      help: '识别码为 0 时可留空' },
    { key: 'rtk_enabled', label: '采集雷达 RTK', type: 'checkbox', visibleWhen: radarField },
    { key: 'coordinate_transform_enabled', label: '验证参考值后派生经纬度', type: 'checkbox', visibleWhen: radarField },
    { key: 'countermeasure_protocol_title', type: 'html', visibleWhen: countermeasureField,
      html: '<b>四通道只读查询</b><small>不发送射频或继电器动作。</small>' },
    { key: 'device_address', label: '反制设备地址', type: 'number', min: 1, max: 244, visibleWhen: countermeasureField, placeholder: '1–244' },
    { key: 'wire_encoding', label: '反制线缆编码', type: 'select', visibleWhen: countermeasureField, options: optionsOf([
      ['AUTO', 'AUTO 安全探测'], ['RAW_BYTES', '原始 8 字节'], ['ASCII_HEX_SPACED', '空格 ASCII Hex'], ['ASCII_HEX_COMPACT', '紧凑 ASCII Hex']]) },
    { key: 'poll_interval_millis', label: '反制查询周期（ms）', type: 'number', min: 1000, max: 60000, visibleWhen: countermeasureField, placeholder: '留空则 5000' }
  ];
}
function initialFor(data) {
  if (!data?.device) {
    return {
      protocol_code: null, device_no: '', name: '', host: '', port: null, allowed_cidrs: '',
      vendor: '', region_name: '',
      recognition_code_ref: '', rtk_enabled: false,
      coordinate_transform_enabled: false, device_address: null, wire_encoding: null, poll_interval_millis: null
    };
  }
  const c = data.connection || {}, p = data.protocol_configuration || {};
  return {
    protocol_code: data.protocol_code || '', device_no: data.device.device_no || '', name: data.device.name || '',
    host: c.host || '', port: c.port ?? null, allowed_cidrs: data.allowed_cidrs || '',
    vendor: data.vendor || '', region_name: data.region_name || '',
    recognition_code_ref: p.recognition_code_ref || '', rtk_enabled: !!p.rtk_enabled,
    coordinate_transform_enabled: !!p.coordinate_transform_enabled,
    device_address: p.device_address ?? null, wire_encoding: p.wire_encoding || null,
    poll_interval_millis: p.poll_interval_millis ?? null
  };
}
function connectionOf(values, existing) {
  const prev = existing?.connection || {};
  return { transport: 'TCP', host: values.host.trim(), port: values.port, data_format: 'BINARY', charset_name: 'UTF-8',
    auth_mode: 'Token', credential_ref: prev.credential_ref || null, heartbeat_interval_seconds: 30,
    report_interval_millis: 1000, timeout_millis: prev.timeout_millis || 3000, retry_count: 3,
    time_sync_mode: 'NTP', timezone_name: 'Asia/Shanghai', time_sync_interval_seconds: 60 };
}
function protocolOf(values) {
  return { login_role: 'DATA', recognition_code_ref: values.recognition_code_ref || null,
    rtk_enabled: !!values.rtk_enabled, coordinate_transform_enabled: !!values.coordinate_transform_enabled,
    device_address: values.device_address || 1, wire_encoding: values.wire_encoding || 'AUTO',
    poll_interval_millis: values.poll_interval_millis || 5000 };
}
async function openDeviceForm(row = null) {
  if (!canOperate.value) return;
  const current = row ? (row.device_id === detail.value?.device?.device_id ? detail.value : await deviceApi.detail(row.device_id)) : null;
  openFormModal({ title: row ? `编辑设备 · ${row.device_no}` : '接入设备', width: '760px', columns: 2,
    fields: formFields(!!row), initial: initialFor(current),
    validate: m => (!m.host?.trim() || !m.port) ? '设备地址和端口为必填'
      : (!m.allowed_cidrs?.trim()) ? '设备网段 CIDR 为必填' : (!row && !m.protocol_code) ? '请选择接入协议' : '',
    confirmText: row ? '保存' : '接入',
    onSubmit: async values => {
      try {
        const saved = row
          ? await deviceApi.update(row.device_id, {
            version: current.device.version, source_id: current.source_id, external_device_id: current.external_device_id,
            device_no: values.device_no.trim(), name: values.name.trim(),
            device_type_code: current.device.device_type_code, device_type_name: current.device.device_type_name,
            channel: current.device.channel, vendor: values.vendor || null, model: current.model || null,
            owner_name: current.owner_name || null, region_name: values.region_name || null, address: current.address || null,
            allowed_cidrs: values.allowed_cidrs.trim(), connection: connectionOf(values, current), protocol_configuration: protocolOf(values)
          })
          : await deviceApi.onboard({
            protocol_code: values.protocol_code, device_no: values.device_no.trim(), name: values.name.trim(),
            host: values.host.trim(), port: values.port, allowed_cidrs: values.allowed_cidrs.trim(),
            vendor: values.vendor || null,
            region_name: values.region_name || null,
            recognition_code_ref: values.recognition_code_ref || null, rtk_enabled: !!values.rtk_enabled,
            coordinate_transform_enabled: !!values.coordinate_transform_enabled,
            device_address: values.device_address || 1, wire_encoding: values.wire_encoding || 'AUTO',
            poll_interval_millis: values.poll_interval_millis || 5000
          });
        closeModal(); selectedId.value = saved.device.device_id;
        toast(row ? '设备已更新' : '设备已接入', 'ok');
        await Promise.all([loadList(), refreshOverview()]);
      } catch (e) { if (e.code === 'VERSION_CONFLICT') await loadList(); throw e; }
    } });
}
function openEnabledForm(row) {
  openFormModal({ title: `${row.enabled ? '停用' : '启用'}设备 · ${row.device_no}`, width: '520px', danger: row.enabled,
    warning: row.enabled ? '停用后会断开该设备的协议连接，并拒绝新建调测任务。' : '启用后会按网段白名单重新建立只读协议连接。',
    fields: [{ key: 'reason', label: `${row.enabled ? '停用' : '启用'}原因`, type: 'textarea', required: true, minRows: 3 }],
    initial: { reason: '' }, confirmText: `确认${row.enabled ? '停用' : '启用'}`,
    onSubmit: async values => {
      try {
        await deviceApi.setEnabled(row.device_id, { enabled: !row.enabled, version: row.version, reason: values.reason.trim() });
        closeModal(); toast(`设备已${row.enabled ? '停用' : '启用'}，审计记录已写入`, 'ok');
        await Promise.all([loadList(), refreshOverview()]);
      } catch (e) { if (e.code === 'VERSION_CONFLICT') await loadList(); throw e; }
    } });
}
onMounted(bootstrap);
</script>

<template>
  <div class="view device-page" id="view" :aria-busy="loading">
    <UKpis :list="kpis" variant="compact" />
    <div v-if="error" class="warnbox error-row" role="alert"><span>{{ error }}</span><NButton size="small" @click="bootstrap">重新加载</NButton></div>
    <UPanel title="设备台账" panel-style="flex:1;min-height:0" nopad>
      <div class="toolbar device-toolbar">
        <UField v-model="filters.keyword" label="关键词" placeholder="设备编号或名称" @keyup.enter="page.page=1;loadList({ keepSelection:false })" />
        <UField v-model="filters.type_code" type="select" clearable label="设备类型" :options="selectOptions(options.types)" />
        <UField v-model="filters.channel" type="select" clearable label="接入通道" :options="selectOptions(options.channels)" />
        <UField v-model="filters.region" type="select" clearable label="区域" :options="selectOptions(options.regions)" />
        <UField v-model="filters.connectivity" type="select" clearable label="连接状态" :options="optionsOf([['ONLINE','在线'],['OFFLINE','离线'],['ABNORMAL','异常'],['UNKNOWN','未知']])" />
        <div class="toolbar-actions"><NButton type="primary" @click="page.page=1;loadList({ keepSelection:false })">查询</NButton><NButton @click="resetFilters">重置</NButton><NButton type="primary" :disabled="!canOperate" @click="openDeviceForm()">接入设备</NButton></div>
      </div>
      <div class="device-layout">
        <div class="table-pane">
          <NSpin class="device-table-spin" :show="loading">
            <div v-if="page.items.length" class="naive-table-fill">
              <NDataTable :columns="columns" :data="page.items" :row-key="row => row.device_id"
                :row-props="row => ({ class: row.device_id === selectedId ? 'active-row' : '', onClick: () => selectRow(row) })"
                :scroll-x="1480" flex-height />
            </div>
            <NEmpty v-else-if="!loading && !error" description="没有符合条件的设备" class="empty-block" />
          </NSpin>
          <div class="pager-row"><span>共 {{ page.total }} 台</span>
            <UPagination v-model:page="page.page" v-model:page-size="page.size" :item-count="page.total" @update:page="() => loadList()" @update:page-size="onPageSize" />
          </div>
        </div>
        <aside class="detail-pane">
          <NSpin :show="detailLoading">
            <template v-if="selected">
              <div class="detail-title"><div><small>设备详情</small><h3>{{ selected.name }}</h3><code>{{ selected.device_no }}</code></div><NTag size="small" :type="statusMeta[selected.connectivity]?.[1] || 'default'" :bordered="false">{{ statusMeta[selected.connectivity]?.[0] || selected.connectivity || '未知' }}</NTag></div>
              <dl class="detail-grid">
                <dt>类型 / 通道</dt><dd>{{ selected.device_type_name }} / {{ selected.channel }}</dd>
                <dt>区域</dt><dd>{{ detail.region_name || '—' }}</dd>
                <dt>供应商</dt><dd>{{ detail.vendor || '—' }}</dd>
                <dt>最后心跳</dt><dd>{{ fmtTime(selected.last_heartbeat_at) }}</dd>
                <dt>接入协议</dt><dd>{{ protocolLabel(detail.protocol_code, detail.protocol_version) }}</dd>
                <dt>设备网段</dt><dd>{{ detail.allowed_cidrs || '—' }}</dd>
              </dl>
              <div v-if="detail.connection_visible" class="connection-card"><b>连接配置</b><code>{{ detail.connection?.transport || '—' }}://{{ detail.connection?.host || '—' }}:{{ detail.connection?.port || '—' }}{{ detail.connection?.path || '' }}</code></div>
              <div v-else class="info-line">当前角色无权查看连接主机、端口等敏感配置。</div>
              <div v-if="selected.source_mode==='live'" class="connection-card protocol-card"><b>协议握手状态</b><NTag size="small" :type="protocolStatus?.connection_state==='ONLINE'?'success':protocolStatus?.connection_state==='ERROR'?'error':'warning'" :bordered="false">{{ protocolStatus?.connection_state || 'DISCONNECTED' }}</NTag><small>{{ protocolStatus?.blocking_reason || '等待后端 live 连接监督器建立会话' }}</small></div>
            </template>
            <NEmpty v-else description="请选择设备" class="empty-block" />
          </NSpin>
        </aside>
      </div>
    </UPanel>
  </div>
</template>

<style scoped>
.device-page { display:flex; flex-direction:column; gap:12px; min-width:0; min-height:0; overflow:hidden; flex:1; }
.device-page :deep(.kpis) { margin-bottom:12px; }
.device-page :deep(.kpi .dt) { display:none; }
.error-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.device-toolbar{flex:none;display:grid;grid-template-columns:repeat(5,minmax(120px,1fr)) auto;align-items:end;padding:12px;border-bottom:1px solid var(--line-1)}.device-toolbar :deep(.u-field){min-width:0}.toolbar-actions{display:flex;gap:7px;flex-wrap:wrap;align-items:center}.device-layout{display:grid;grid-template-columns:minmax(0,1fr) 350px;flex:1;min-height:0;overflow:hidden}.table-pane{display:flex;flex-direction:column;min-width:0;min-height:0;border-right:1px solid var(--line-1);overflow:hidden}.device-table-spin{display:flex;flex:1;min-height:0;flex-direction:column}.device-table-spin :deep(.n-spin-container),.device-table-spin :deep(.n-spin-content){display:flex;flex:1;min-height:0;flex-direction:column;overflow:hidden}.table-pane :deep(.n-data-table-tr){cursor:pointer}.table-pane :deep(.active-row .n-data-table-td){background:color-mix(in srgb,var(--blue) 18%,var(--surface-1))!important}.table-actions{display:flex;flex-wrap:nowrap;gap:10px;white-space:nowrap}.muted{color:var(--txt-3)}.pager-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;color:var(--txt-3);border-top:1px solid var(--line-1)}.detail-pane{min-width:0;padding:16px;overflow:auto;background:color-mix(in srgb,var(--panel) 82%,transparent)}.detail-title{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;padding-bottom:14px;border-bottom:1px solid var(--line-1)}.detail-title h3{margin:3px 0 6px;font-size:18px}.detail-title small,.detail-title code{color:var(--txt-3)}.detail-grid{display:grid;grid-template-columns:100px minmax(0,1fr);gap:0;margin:12px 0;font-size:13px}.detail-grid dt,.detail-grid dd{margin:0;padding:9px 0;border-bottom:1px solid var(--line-1);overflow-wrap:anywhere}.detail-grid dt{color:var(--txt-3)}.connection-card{display:grid;gap:9px;margin-top:14px;padding:12px;border:1px solid var(--line-2);border-radius:6px;background:var(--surface-2)}.connection-card code{overflow-wrap:anywhere;color:var(--cyan)}.connection-card small{color:var(--txt-3);line-height:1.5}.empty-block{padding:64px 12px}@media(max-width:1360px){.device-toolbar{grid-template-columns:repeat(3,minmax(140px,1fr))}.device-layout{grid-template-columns:minmax(0,1fr) 320px}.toolbar-actions{grid-column:1/-1}}@media(max-width:980px){.device-layout{grid-template-columns:1fr;overflow:auto}.detail-pane{border-top:1px solid var(--line-1)}}
</style>
