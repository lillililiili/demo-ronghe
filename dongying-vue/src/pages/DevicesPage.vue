<script setup>
import { computed, h, onMounted, reactive, ref } from 'vue';
import { NButton, NDataTable, NEmpty, NSpin, NTag } from 'naive-ui';
import UField from '@/components/form/UField.vue';
import UPagination from '@/components/UPagination.vue';
import UKpis from '@/components/UKpis.vue';
import UPanel from '@/components/UPanel.vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { canRouteAction, hasPermission } from '@/services/accessControl.js';
import { deviceApi, integrationApi } from '@/services/deviceApi.js';
import { closeModal, openModal } from '@/ui/modal.js';
import { openFormModal, optionsOf } from '@/ui/formModal.js';
import { toast } from '@/ui/nv.js';

usePageChrome('devices');
const filters = reactive({ keyword: '', type_code: null, channel: null, region: null, vendor: null,
  connectivity: null, enabled: null, sort: 'priority' });
const options = ref({ types: [], channels: [], regions: [], vendors: [] });
const sources = ref([]);
const protocols = ref([]);
const page = reactive({ items: [], page: 1, size: 10, total: 0 });
const overview = ref({ total: 0, online: 0, offline: 0, abnormal: 0, unknown: 0, alarm: 0, vendor_count: 0, model_count: 0, simulated: true });
const selectedId = ref('');
const detail = ref(null);
const protocolStatus = ref(null);
const loading = ref(false);
const detailLoading = ref(false);
const error = ref('');
const canOperate = computed(() => canRouteAction('devices', 'op'));
const canManageSources = computed(() => hasPermission('interfaces.op') || hasPermission('interfaces.auth'));
const sourceOptions = computed(() => optionsOf(sources.value.map(item => [item.source_id,
  `${item.enabled ? '已启用' : '未启用'} · ${item.name} · ${item.protocol_code || item.source_mode}`])));
const sourceBadge = computed(() => page.items.some(item => item.source_mode === 'live')
  ? (page.items.some(item => item.simulated) ? ['LIVE / MOCK', 'info'] : ['LIVE', 'success']) : ['MOCK', 'warning']);
const selected = computed(() => detail.value?.device || null);
const statusMeta = { ABNORMAL: ['异常', 'error'], OFFLINE: ['离线', 'default'], UNKNOWN: ['未知', 'warning'], ONLINE: ['在线', 'success'] };
const healthText = { GOOD: '良好', DEGRADED: '一般', BAD: '异常', UNKNOWN: '未知' };
const fmtTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const selectOptions = values => optionsOf((values || []).map(value => [value, value]));

const kpis = computed(() => [
  { label: '设备总数', value: overview.value.total, color: 'blue', icon: 'device', desc: '台账与监测同源' },
  { label: '在线', value: overview.value.online, color: 'green', icon: 'check', desc: `离线 ${overview.value.offline}` },
  { label: '异常 / 未知', value: `${overview.value.abnormal} / ${overview.value.unknown}`, color: 'red', icon: 'alert', desc: '未知状态不折算为正常' },
  { label: '告警中设备', value: overview.value.alarm, color: 'amber', icon: 'alert', desc: '以最新设备状态为准' },
  { label: '供应商', value: overview.value.vendor_count, color: 'purple', icon: 'api', desc: `型号 ${overview.value.model_count}` }
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
  { title: '供应商 / 型号', key: 'vendor', width: 180, render: row => h('div', [h('div', row.vendor || '—'), h('small', { class: 'muted' }, row.model || '—')]) },
  { title: '连接', key: 'connectivity', width: 82, render: row => statusTag(row.connectivity) },
  { title: '健康', key: 'health_code', width: 76, render: row => healthText[row.health_code] || '未知' },
  { title: '最后心跳', key: 'last_heartbeat_at', width: 168, render: row => fmtTime(row.last_heartbeat_at) },
  { title: '状态', key: 'enabled', width: 78, render: row => h(NTag, { size: 'small', type: row.enabled ? 'success' : 'default', bordered: false }, { default: () => row.enabled ? '启用' : '停用' }) },
  { title: '操作', key: 'actions', width: 178, fixed: 'right', render: row => h('div', { class: 'table-actions' }, [
    h(NButton, { text: true, type: 'info', onClick: e => { e.stopPropagation(); selectRow(row); } }, { default: () => '查看' }),
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
    try { sources.value = (await integrationApi.sources({ page: 1, size: 100 })).items; } catch { sources.value = []; }
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
function selectedProtocol(model) {
  return sources.value.find(item => item.source_id === model.source_id)?.protocol_code || '';
}
const radarField = model => selectedProtocol(model) === 'RADAR_TCP_V3_0_0';
const countermeasureField = model => selectedProtocol(model) === 'COUNTERMEASURE_TCP_4CH_V2_0';
function formFields() {
  return [
    { key: 'source_id', label: '接入来源', type: 'select', clearable: true, options: sourceOptions.value,
      help: 'live 来源决定协议；不选择时按当前开发模式创建设备' },
    { key: 'external_device_id', label: '来源设备 ID', help: '选择来源时必填，与来源 ID 成对保存' },
    { key: 'device_no', label: '设备编号', required: true, placeholder: '例如 DEV-RADAR-001' },
    { key: 'name', label: '设备名称', required: true },
    { key: 'device_type_code', label: '类型代码', required: true, placeholder: 'radar' },
    { key: 'device_type_name', label: '设备类型', required: true },
    { key: 'channel', label: '接入通道', required: true },
    { key: 'vendor', label: '供应商' }, { key: 'model', label: '型号' },
    { key: 'owner_name', label: '产权单位' }, { key: 'region_name', label: '所属区域' },
    { key: 'address', label: '安装位置', wide: true },
    { key: 'longitude', label: 'WGS-84 经度', type: 'number' }, { key: 'latitude', label: 'WGS-84 纬度', type: 'number' },
    { key: 'altitude_m', label: '高度（m）', type: 'number' },
    { key: 'altitude_datum', label: '高度基准', type: 'select', options: optionsOf([['AMSL', 'AMSL'], ['AGL', 'AGL']]) },
    { key: 'firmware_version', label: '固件版本' },
    { key: 'transport', label: '传输方式', type: 'select', required: true, options: optionsOf([['TCP', 'TCP']]) },
    { key: 'host', label: '连接主机', required: true, placeholder: '雷达资料默认 192.168.8.168；反制资料默认 192.168.0.7（仅提示）' },
    { key: 'port', label: '端口', type: 'number', required: true, min: 1, max: 65535,
      help: '雷达资料默认 5001；反制资料默认 10006（仅提示，不自动连接）' },
    { key: 'path', label: '接口路径' }, { key: 'data_format', label: '数据格式' },
    { key: 'credential_ref', label: '连接凭据引用', placeholder: '例如 env:DEVICE_SECRET' },
    { key: 'timeout_millis', label: '超时（ms）', type: 'number', min: 100 }, { key: 'retry_count', label: '重试次数', type: 'number', min: 0, max: 20 }
    ,{ key: 'radar_protocol_title', type: 'html', visibleWhen: radarField,
      html: '<b>雷达 TCP v3.0.0 配置</b><small>只读接入；不会开放雷达启停或寄存器写入。</small>' }
    ,{ key: 'login_role', label: '雷达登录权限', type: 'select', visibleWhen: radarField,
      options: optionsOf([['DATA', 'DATA（0x5）']]), help: '雷达协议固定为数据权限' }
    ,{ key: 'recognition_code_ref', label: '雷达识别码引用', visibleWhen: radarField, placeholder: 'env:RADAR_RECOGNITION_CODE' }
    ,{ key: 'rtk_enabled', label: '采集雷达 RTK', type: 'checkbox', visibleWhen: radarField }
    ,{ key: 'coordinate_transform_enabled', label: '验证参考值后派生经纬度', type: 'checkbox', visibleWhen: radarField }
    ,{ key: 'countermeasure_protocol_title', type: 'html', visibleWhen: countermeasureField,
      html: '<b>固定式四通道控制器 v2.0 配置</b><small>只查询继电器状态；不会发送射频或继电器动作指令。</small>' }
    ,{ key: 'device_address', label: '反制设备地址', type: 'number', min: 1, max: 244,
      visibleWhen: countermeasureField, help: '广播地址 245 被禁止' }
    ,{ key: 'wire_encoding', label: '反制线缆编码', type: 'select', visibleWhen: countermeasureField, options: optionsOf([
      ['AUTO', 'AUTO 安全探测'], ['RAW_BYTES', '原始 8 字节'], ['ASCII_HEX_SPACED', '空格 ASCII Hex'], ['ASCII_HEX_COMPACT', '紧凑 ASCII Hex']]) }
    ,{ key: 'poll_interval_millis', label: '反制查询周期（ms）', type: 'number', min: 1000, max: 60000,
      visibleWhen: countermeasureField }
  ];
}
function initialFor(data) {
  const d = data || {}, c = d.connection || {}, p = d.protocol_configuration || {};
  return { source_id: d.source_id || null, external_device_id: d.external_device_id || '',
    device_no: d.device?.device_no || '', name: d.device?.name || '', device_type_code: d.device?.device_type_code || '',
    device_type_name: d.device?.device_type_name || '', channel: d.device?.channel || '', vendor: d.vendor || '', model: d.model || '',
    owner_name: d.owner_name || '', region_name: d.region_name || '', address: d.address || '', longitude: d.longitude ?? null,
    latitude: d.latitude ?? null, altitude_m: d.altitude_m ?? null, altitude_datum: d.altitude_datum || 'AMSL',
    firmware_version: d.firmware_version || '', transport: c.transport || 'TCP', host: c.host || '', port: c.port ?? null,
    path: c.path || '', data_format: c.data_format || 'BINARY', credential_ref: c.credential_ref || '', timeout_millis: c.timeout_millis || 3000, retry_count: c.retry_count ?? 3,
    login_role: p.login_role || 'DATA', recognition_code_ref: p.recognition_code_ref || '', rtk_enabled: p.rtk_enabled ?? false,
    coordinate_transform_enabled: p.coordinate_transform_enabled ?? false, device_address: p.device_address || 1,
    wire_encoding: p.wire_encoding || 'AUTO', poll_interval_millis: p.poll_interval_millis || 5000 };
}
function payload(values, version) {
  return { ...(version == null ? {} : { version }), source_id: values.source_id || null,
    external_device_id: values.source_id ? values.external_device_id?.trim() || null : null,
    device_no: values.device_no.trim(), name: values.name.trim(),
    device_type_code: values.device_type_code.trim(), device_type_name: values.device_type_name.trim(), channel: values.channel.trim(),
    vendor: values.vendor || null, model: values.model || null, owner_name: values.owner_name || null, region_name: values.region_name || null,
    address: values.address || null, longitude: values.longitude, latitude: values.latitude, coordinate_system: 'WGS-84',
    altitude_m: values.altitude_m, altitude_datum: values.altitude_datum || null, firmware_version: values.firmware_version || null,
    connection: { transport: values.transport, host: values.host.trim(), port: values.port, path: values.path || null,
      data_format: values.data_format || 'JSON', charset_name: 'UTF-8', auth_mode: 'Token', credential_ref: values.credential_ref || null, heartbeat_interval_seconds: 30,
      report_interval_millis: 1000, timeout_millis: values.timeout_millis || 3000, retry_count: values.retry_count ?? 3,
      time_sync_mode: 'NTP', timezone_name: 'Asia/Shanghai', time_sync_interval_seconds: 60 },
    protocol_configuration: { login_role: values.login_role || 'DATA', recognition_code_ref: values.recognition_code_ref || null,
      rtk_enabled: !!values.rtk_enabled, coordinate_transform_enabled: !!values.coordinate_transform_enabled,
      device_address: values.device_address || 1, wire_encoding: values.wire_encoding || 'AUTO',
      poll_interval_millis: values.poll_interval_millis || 5000 } };
}
async function openDeviceForm(row = null) {
  if (!canOperate.value) return;
  const current = row ? (row.device_id === detail.value?.device?.device_id ? detail.value : await deviceApi.detail(row.device_id)) : null;
  openFormModal({ title: row ? `编辑设备 · ${row.device_no}` : '新增设备', width: '860px', columns: 2,
    notice: '坐标按 WGS-84 原值保存；凭据仅保存引用，本页面不接收明文密钥。', fields: formFields(), initial: initialFor(current),
    validate: m => (!m.host?.trim() || !m.port) ? '连接主机和端口为必填'
      : (!!m.source_id !== !!m.external_device_id?.trim()) ? '选择接入来源后必须填写来源设备 ID' : '',
    onSubmit: async values => {
      try {
        const saved = row ? await deviceApi.update(row.device_id, payload(values, current.device.version)) : await deviceApi.create(payload(values));
        closeModal(); selectedId.value = saved.device.device_id; toast(row ? '设备台账已更新' : '设备已创建', 'ok');
        await Promise.all([loadList(), refreshOverview()]);
      } catch (e) { if (e.code === 'VERSION_CONFLICT') await loadList(); throw e; }
    } });
}
async function reloadSources() { sources.value = (await integrationApi.sources({ page: 1, size: 100 })).items; }
function openSourceForm(source = null) {
  if (!canManageSources.value) return;
  openFormModal({ title: source ? `编辑来源 · ${source.source_code}` : '新增 live 接入来源', width: '680px', columns: 2,
    notice: '来源创建后默认停用。请先绑定设备、配置实际地址和 CIDR 白名单，再通过接口显式启用。',
    fields: [
      { key: 'source_code', label: '来源编码', required: true, placeholder: '例如 DY-T02-01' },
      { key: 'name', label: '来源名称', required: true },
      { key: 'protocol_code', label: '协议', type: 'select', required: true,
        options: optionsOf(protocols.value.map(item => [item.protocol_code, `${item.name} · v${item.version}`])) },
      { key: 'allowed_cidrs', label: '设备网络 CIDR', required: true, placeholder: '例如 192.168.8.0/24' },
      { key: 'credential_ref', label: '来源凭据引用', placeholder: 'env:SOURCE_CREDENTIAL' }
    ], initial: { source_code: source?.source_code || '', name: source?.name || '',
      protocol_code: source?.protocol_code || protocols.value[0]?.protocol_code || '',
      allowed_cidrs: source?.allowed_cidrs || '', credential_ref: source?.credential_ref || '' },
    onSubmit: async values => {
      const saved = source ? await integrationApi.updateSource(source.source_id, { ...values, version: source.version })
        : await integrationApi.createSource(values);
      await reloadSources(); closeModal(); toast(`来源 ${saved.source_code} 已${source ? '更新' : '创建并保持停用'}`, 'ok');
    } });
}
function openSourceToggle(source) {
  openFormModal({ title: `${source.enabled ? '停用' : '启用'}来源 · ${source.source_code}`, width: '540px', danger: source.enabled,
    warning: source.enabled ? '停用后连接监督器会释放该来源下设备的连接租约。' : '启用前会校验协议适配器、设备连接配置、协议配置和 CIDR 白名单。',
    fields: [{ key: 'reason', label: '操作原因', type: 'textarea', required: true, minRows: 3 }], initial: { reason: '' },
    onSubmit: async values => { await integrationApi.setSourceEnabled(source.source_id,
      { enabled: !source.enabled, version: source.version, reason: values.reason.trim() });
      await reloadSources(); closeModal(); toast(`来源已${source.enabled ? '停用' : '启用'}`, 'ok'); } });
}
function openSourceManager() {
  if (!canManageSources.value) return;
  const columns = [
    { title: '来源', key: 'name', width: 190, render: row => h('div', [h('b', row.name), h('small', { class: 'muted source-code' }, row.source_code)]) },
    { title: '协议', key: 'protocol_code', width: 250, ellipsis: { tooltip: true } },
    { title: '设备', key: 'device_count', width: 70 },
    { title: '状态', key: 'enabled', width: 85, render: row => h(NTag, { size: 'small', type: row.enabled ? 'success' : 'default', bordered: false }, { default: () => row.enabled ? '已启用' : '未启用' }) },
    { title: '操作', key: 'actions', width: 140, render: row => h('div', { class: 'table-actions' }, [
      h(NButton, { text: true, type: 'primary', onClick: () => openSourceForm(row) }, { default: () => '编辑' }),
      h(NButton, { text: true, type: row.enabled ? 'error' : 'success', onClick: () => openSourceToggle(row) }, { default: () => row.enabled ? '停用' : '启用' })
    ]) }
  ];
  openModal({ title: 'live 接入来源', width: '920px', footer: false, render: () => h('div', { class: 'source-manager' }, [
    h('div', { class: 'source-manager-head' }, [h('p', '来源默认停用；启用不会绕过 CIDR 与配置校验。'), h(NButton, { type: 'primary', onClick: () => openSourceForm() }, { default: () => '新增来源' })]),
    h(NDataTable, { columns, data: sources.value.filter(item => item.source_mode === 'live'),
      rowKey: row => row.source_id, scrollX: 760, maxHeight: 440 }),
    h('div', { class: 'u-form-footer' }, [h(NButton, { onClick: closeModal }, { default: () => '关闭' })])
  ]) });
}
function openEnabledForm(row) {
  openFormModal({ title: `${row.enabled ? '停用' : '启用'}设备 · ${row.device_no}`, width: '520px', danger: row.enabled,
    warning: row.enabled ? '停用后将拒绝重启和新建调测任务，历史记录不会删除。' : '',
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
    <div class="source-banner"><NTag :type="sourceBadge[1]" :bordered="false">{{ sourceBadge[0] }}</NTag><span>设备按来源独立路由协议；live 未握手时不会回退为模拟成功。</span></div>
    <UKpis :list="kpis" variant="compact" />
    <div v-if="error" class="warnbox error-row" role="alert"><span>{{ error }}</span><NButton size="small" @click="bootstrap">重新加载</NButton></div>
    <UPanel title="设备台账" sub="服务端分页、筛选与排序" panel-style="flex:1;min-height:0" nopad>
      <div class="toolbar device-toolbar">
        <UField v-model="filters.keyword" label="关键词" placeholder="设备编号或名称" @keyup.enter="page.page=1;loadList({ keepSelection:false })" />
        <UField v-model="filters.type_code" type="select" clearable label="设备类型" :options="selectOptions(options.types)" />
        <UField v-model="filters.channel" type="select" clearable label="接入通道" :options="selectOptions(options.channels)" />
        <UField v-model="filters.region" type="select" clearable label="区域" :options="selectOptions(options.regions)" />
        <UField v-model="filters.connectivity" type="select" clearable label="连接状态" :options="optionsOf([['ONLINE','在线'],['OFFLINE','离线'],['ABNORMAL','异常'],['UNKNOWN','未知']])" />
        <div class="toolbar-actions"><NButton type="primary" @click="page.page=1;loadList({ keepSelection:false })">查询</NButton><NButton @click="resetFilters">重置</NButton><NButton type="primary" :disabled="!canOperate" @click="openDeviceForm()">新增设备</NButton><NButton :disabled="!canManageSources" @click="openSourceManager">接入来源</NButton><NButton disabled title="文件接口待后续切片">导入 / 导出（待后续）</NButton></div>
      </div>
      <div class="device-layout">
        <div class="table-pane">
          <NSpin :show="loading">
            <NDataTable v-if="page.items.length" :columns="columns" :data="page.items" :row-key="row => row.device_id"
              :row-props="row => ({ class: row.device_id === selectedId ? 'active-row' : '', onClick: () => selectRow(row) })"
              :scroll-x="1420" :max-height="460" />
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
                <dt>区域 / 地址</dt><dd>{{ detail.region_name || '—' }} / {{ detail.address || '—' }}</dd>
                <dt>供应商 / 型号</dt><dd>{{ detail.vendor || '—' }} / {{ detail.model || '—' }}</dd>
                <dt>坐标</dt><dd>{{ detail.longitude ?? '—' }}, {{ detail.latitude ?? '—' }} · {{ detail.coordinate_system || '未声明' }}</dd>
                <dt>高度</dt><dd>{{ detail.altitude_m ?? '—' }} m · {{ detail.altitude_datum || '未声明' }}</dd>
                <dt>最后心跳</dt><dd>{{ fmtTime(selected.last_heartbeat_at) }}</dd>
                <dt>来源模式</dt><dd><NTag size="small" :type="selected.source_mode==='live'?'success':'warning'" :bordered="false">{{ selected.source_mode?.toUpperCase() }}</NTag> {{ detail.source_name || '未绑定来源' }}</dd>
                <dt>接入协议</dt><dd>{{ detail.protocol_code || '未配置' }}<template v-if="detail.protocol_version"> · v{{ detail.protocol_version }}</template></dd>
              </dl>
              <div v-if="detail.connection_visible" class="connection-card"><b>连接配置</b><code>{{ detail.connection?.transport || '—' }}://{{ detail.connection?.host || '—' }}:{{ detail.connection?.port || '—' }}{{ detail.connection?.path || '' }}</code><small>敏感字段仅向设备维护角色显示；不返回明文密钥。</small></div>
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
.device-page { gap:12px; min-width:0; }.source-banner{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid color-mix(in srgb,var(--amber) 36%,transparent);border-radius:6px;background:color-mix(in srgb,var(--amber) 8%,transparent);color:var(--txt-2)}.error-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.device-toolbar{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr)) auto;align-items:end;padding:12px;border-bottom:1px solid var(--line-1)}.device-toolbar :deep(.u-field){min-width:0}.toolbar-actions{display:flex;gap:7px;flex-wrap:wrap;align-items:center}.device-layout{display:grid;grid-template-columns:minmax(0,1fr) 350px;flex:1;min-height:0;overflow:hidden}.table-pane{display:flex;flex-direction:column;min-width:0;min-height:0;border-right:1px solid var(--line-1);overflow:hidden}.table-pane>:deep(.n-spin-container){flex:1;min-height:0}.table-pane :deep(.n-data-table-tr){cursor:pointer}.table-pane :deep(.active-row td){background:color-mix(in srgb,var(--blue) 13%,transparent)!important}.table-actions{display:flex;gap:10px}.muted{color:var(--txt-3)}.pager-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;color:var(--txt-3);border-top:1px solid var(--line-1)}.detail-pane{min-width:0;padding:16px;overflow:auto;background:color-mix(in srgb,var(--panel) 82%,transparent)}.detail-title{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;padding-bottom:14px;border-bottom:1px solid var(--line-1)}.detail-title h3{margin:3px 0 6px;font-size:18px}.detail-title small,.detail-title code{color:var(--txt-3)}.detail-grid{display:grid;grid-template-columns:100px minmax(0,1fr);gap:0;margin:12px 0;font-size:13px}.detail-grid dt,.detail-grid dd{margin:0;padding:9px 0;border-bottom:1px solid var(--line-1);overflow-wrap:anywhere}.detail-grid dt{color:var(--txt-3)}.connection-card{display:grid;gap:9px;margin-top:14px;padding:12px;border:1px solid var(--line-2);border-radius:6px;background:var(--surface-2)}.connection-card code{overflow-wrap:anywhere;color:var(--cyan)}.connection-card small{color:var(--txt-3);line-height:1.5}.empty-block{padding:64px 12px}:global(.source-manager){display:grid;gap:14px}:global(.source-manager-head){display:flex;align-items:center;justify-content:space-between;gap:12px}:global(.source-manager-head p){margin:0;color:var(--txt-2)}:global(.source-code){display:block;margin-top:4px}@media(max-width:1360px){.device-toolbar{grid-template-columns:repeat(3,minmax(140px,1fr))}.device-layout{grid-template-columns:minmax(0,1fr) 320px}.toolbar-actions{grid-column:1/-1}}@media(max-width:980px){.device-layout{grid-template-columns:1fr;overflow:auto}.detail-pane{border-top:1px solid var(--line-1)}}
</style>
