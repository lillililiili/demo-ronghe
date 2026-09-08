import { h } from 'vue';
import { NButton, NEmpty, NTag } from 'naive-ui';
import { mqttApi, newIdempotencyKey } from '@/services/deviceApi.js';
import { openModal, closeModal } from '@/ui/modal.js';
import { openFormModal, optionsOf } from '@/ui/formModal.js';
import { toast } from '@/ui/nv.js';

export const MQTT_PROTOCOL = 'LINGYUN_MQTT_V8_6';
export const EO_PROTOCOL = 'EO_EDGE_MQTT_20250826';
export const isMqtt = model => model.protocol_code === MQTT_PROTOCOL;
export const isEo = model => model.protocol_code === EO_PROTOCOL;
export const isMqttTransport = model => isMqtt(model) || isEo(model);
export const sourceLabel = mode => mode === 'replay' ? '模拟回放' : '真实来源，待联调';

export function mqttFields(brokers, scopes, editing) {
  return [
    { key: 'broker_id', label: 'MQTT 连接', type: 'select', required: true, disabled: editing,
      options: optionsOf(brokers.map(b => [b.broker_id, `${b.name} · ${sourceLabel(b.source_mode)}${b.enabled ? '' : ' · 已停用'}`])),
      help: '没有可选连接时，请先通过台账上方的“MQTT 连接”配置；停用连接不会接收报文。' },
    { key: 'device_type_abbr', label: '设备类型', type: 'select', required: true, disabled: editing,
      options: optionsOf([['radar', '雷达'], ['5ga', '5G-A'], ['tdoa', 'TDOA']]) },
    { key: 'provider_code', label: '提供方编码', required: true, disabled: editing, placeholder: '协议中的 providerCode' },
    { key: 'external_device_id', label: '外部设备编号', required: true, disabled: editing, placeholder: '协议中的 deviceId，保持原值' },
    { key: 'source_mode', label: '数据来源', type: 'select', required: true, disabled: editing,
      options: optionsOf([['replay', '模拟回放'], ['live', '真实来源，待联调']]) },
    { key: 'scope_key', label: '所属组织 / 区域', type: 'select', required: true, disabled: editing,
      options: optionsOf(scopes.map(s => [`${s.org_id}/${s.district_id}`, `${s.org_name} / ${s.district_name}`])) },
    { key: 'model', label: '型号' }
  ].map(field => ({ ...field, visibleWhen: isMqtt }));
}

export function eoFields(brokers, scopes, editing) {
  return [
    { key: 'broker_id', label: 'MQTT 连接', type: 'select', required: true, disabled: editing,
      options: optionsOf(brokers.map(b => [b.broker_id, `${b.name} · ${sourceLabel(b.source_mode)}${b.enabled ? '' : ' · 已停用'}`])),
      help: '光电边端与协议 A 共用 MQTT 连接；停用连接后停止订阅上报主题。' },
    { key: 'edge_id', label: '边缘中心 ID', required: true, disabled: editing, placeholder: '协议中的 edgeId，由本平台持有' },
    { key: 'external_device_id', label: '光电设备编号', required: true, disabled: editing, placeholder: '协议中的 deviceId，保持原值' },
    { key: 'source_mode', label: '数据来源', type: 'select', required: true, disabled: editing,
      options: optionsOf([['replay', '模拟回放'], ['live', '真实来源，待联调']]) },
    { key: 'scope_key', label: '所属组织 / 区域', type: 'select', required: true, disabled: editing,
      options: optionsOf(scopes.map(s => [`${s.org_id}/${s.district_id}`, `${s.org_name} / ${s.district_name}`])) },
    { key: 'model', label: '型号' },
    { key: 'eo_unsupported', type: 'html',
      html: '<b>设备协议未提供</b><small>角度移动、home 点、辅助识别/跟踪开关在协议 C 中标为暂不支持，本平台不实现。</small>' }
  ].map(field => ({ ...field, visibleWhen: isEo }));
}

export function eoPayload(values, brokers, version) {
  const broker = brokers.find(b => b.broker_id === values.broker_id);
  const [owner_org_id, district_id] = (values.scope_key || '').split('/');
  if (!broker || broker.source_mode !== values.source_mode || broker.owner_org_id !== owner_org_id || broker.district_id !== district_id)
    throw new Error('设备的数据来源、组织区域须与所选 MQTT 连接一致。');
  return { protocol_code: EO_PROTOCOL, broker_id: broker.broker_id, edge_id: values.edge_id?.trim(),
    external_device_id: values.external_device_id?.trim(), source_mode: values.source_mode, owner_org_id, district_id,
    device_no: values.device_no?.trim(), name: values.name?.trim(), vendor: values.vendor || null, model: values.model || null, version };
}

export function mqttPayload(values, brokers, version) {
  const broker = brokers.find(b => b.broker_id === values.broker_id);
  const [owner_org_id, district_id] = (values.scope_key || '').split('/');
  if (!broker || broker.source_mode !== values.source_mode || broker.owner_org_id !== owner_org_id || broker.district_id !== district_id)
    throw new Error('设备的数据来源、组织区域须与所选 MQTT 连接一致。');
  return { protocol_code: MQTT_PROTOCOL, broker_id: broker.broker_id, provider_code: values.provider_code?.trim(),
    external_device_id: values.external_device_id?.trim(), device_type_abbr: values.device_type_abbr,
    source_mode: values.source_mode, owner_org_id, district_id, device_no: values.device_no?.trim(),
    name: values.name?.trim(), vendor: values.vendor || null, model: values.model || null, version };
}

export async function openMqttBrokers(canOperate, isActive = () => true) {
  try {
    const brokers = await mqttApi.list();
    if (!isActive()) return;
    openModal({ title: 'MQTT 连接', width: '760px', footer: false, render: () => h('div', { class: 'mqtt-broker-list' }, [
      h('p', '连接成功只表示报文通道可用；设备收到有效工参后才显示在线。修改配置前请先停用连接。'),
      h(NButton, { type: 'primary', disabled: !canOperate, onClick: () => editBroker(null, canOperate, isActive) }, { default: () => '新增连接' }),
      !brokers.length ? h(NEmpty, { description: '尚未配置 MQTT 连接' }) : null,
      ...brokers.map(b => h('div', { class: 'connection-card' }, [
        h('b', b.name), h('span', `${sourceLabel(b.source_mode)} · ${b.host}:${b.port}`),
        h(NTag, { size: 'small', bordered: false }, { default: () => `${b.enabled ? '启用' : '停用'} · ${b.connection_state}` }),
        b.last_error ? h('p', { role: 'alert' }, `连接失败：${b.last_error}`) : null,
        h('div', { class: 'table-actions' }, [
          h(NButton, { disabled: !canOperate || b.enabled, onClick: () => editBroker(b, canOperate, isActive) }, { default: () => '编辑' }),
          h(NButton, { disabled: !canOperate, onClick: () => toggleBroker(b, canOperate, isActive) }, { default: () => b.enabled ? '停用' : '启用' })
        ])
      ]))
    ]) });
  } catch (error) { if (isActive()) toast(error.message || 'MQTT 连接加载失败', 'err'); }
}

async function editBroker(broker, canOperate, isActive) {
  try {
    const scopes = await mqttApi.scopes();
    if (!isActive()) return;
    const key = newIdempotencyKey('mqtt-broker');
    openFormModal({ title: broker ? '编辑 MQTT 连接' : '新增 MQTT 连接', width: '760px', columns: 2,
      notice: '凭据填写 env:环境变量名，密码由后端部署环境提供。新增连接默认停用。',
      fields: [
        { key: 'name', label: '连接名称', required: true },
        { key: 'host', label: '服务器地址', required: true, placeholder: '主机名或 IP，不带协议前缀' },
        { key: 'port', label: '端口', type: 'number', required: true, min: 1, max: 65535 },
        { key: 'tls', label: '使用 TLS 加密', type: 'checkbox' },
        { key: 'source_mode', label: '数据来源', type: 'select', required: true, disabled: !!broker,
          options: optionsOf([['replay', '模拟回放'], ['live', '真实来源，待联调']]) },
        { key: 'scope_key', label: '所属组织 / 区域', type: 'select', required: true, disabled: !!broker,
          options: optionsOf(scopes.map(s => [`${s.org_id}/${s.district_id}`, `${s.org_name} / ${s.district_name}`])) },
        { key: 'username', label: '用户名', help: '真实来源必填' },
        { key: 'credential_ref', label: '密码凭据引用', placeholder: 'env:MQTT_PASSWORD', help: '真实来源必填，切勿填写密码本身' },
        { key: 'allowed_cidrs', label: '允许的服务器网段 CIDR', required: true, wide: true,
          help: '例如测试回环网段 127.0.0.1/32；回环仅限 local/test 模拟连接。' }
      ], initial: broker ? { ...broker, scope_key: `${broker.owner_org_id}/${broker.district_id}` }
        : { name: '', host: '', port: 8883, tls: true, source_mode: 'replay', scope_key: null, allowed_cidrs: '' },
      onSubmit: async values => {
        const [owner_org_id, district_id] = values.scope_key.split('/');
        const body = { name: values.name.trim(), host: values.host.trim(), port: values.port, tls: !!values.tls,
          username: values.username?.trim() || null, credential_ref: values.credential_ref?.trim() || null,
          allowed_cidrs: values.allowed_cidrs.trim(), source_mode: values.source_mode, owner_org_id, district_id, version: broker?.version };
        if (broker) await mqttApi.update(broker.broker_id, body, key); else await mqttApi.create(body, key);
        if (!isActive()) return;
        closeModal(); toast('MQTT 配置已保存，当前处于停用状态', 'ok'); await openMqttBrokers(canOperate, isActive);
      }
    });
  } catch (error) { if (isActive()) toast(error.message || '配置加载失败', 'err'); }
}

function toggleBroker(broker, canOperate, isActive) {
  const key = newIdempotencyKey('mqtt-enable');
  openFormModal({ title: `${broker.enabled ? '停用' : '启用'} MQTT 连接`,
    notice: broker.enabled ? '停用将停止该连接下所有设备的报文接收。' : '启用后，后端将按配置连接服务器并订阅已登记设备。',
    fields: [], confirmText: broker.enabled ? '确认停用' : '确认启用', onSubmit: async () => {
      await mqttApi.setEnabled(broker.broker_id, { enabled: !broker.enabled, version: broker.version }, key);
      if (!isActive()) return;
      closeModal(); await openMqttBrokers(canOperate, isActive);
    }
  });
}
