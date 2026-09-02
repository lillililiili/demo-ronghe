import { closeModal } from './modal.js';
import { openFormModal, optionsOf } from './formModal.js';

export function openCounterAuth(target, onAuthorized) {
  const M = window.MOCK, U = window.UI;
  const t = target;
  if (!t) return U.toast('未找到关联目标，无法发起联动反制', 'err');
  if (t.type !== '无人机') {
    return U.toast('该目标为' + (t.subtype || t.type) + '，按 §4.2 不进入反制流程，请使用空间安全风险处置', 'err');
  }
  const dev = M.devices.filter(d => d.type === '反制' && d.status === '在线').slice(0, 4);
  const zoneOk = !!t.zone;
  const lv = (t.fusedConf == null || t.srcCount == null) ? (M.liveTargets || []).find(x => x.id === t.id) : null;
  const fc = t.fusedConf != null ? t.fusedConf
    : (lv && lv.fusedConf != null) ? lv.fusedConf
      : (t.source_confidence != null ? Math.round(t.source_confidence * 100) : null);
  const srcN = t.srcCount != null ? t.srcCount : (lv && lv.srcCount != null) ? lv.srcCount : null;
  const legalRisk = M.liveTargets.filter(x => x.id !== t.id && Math.abs(x.lon - t.lon) < .08 && Math.abs(x.lat - t.lat) < .08 && x.legal === '合法');
  return openFormModal({
    title: '联动反制授权确认',
    width: '720px',
    warning: `注意：反制/干扰属受控操作。依据会议纪要 §6.3 与 §11.1，必须完成
      <b>目标确认 → 空域与范围校验 → 合法目标影响评估 → 设备状态校验 → 人工双确认</b>，
      执行过程全程留痕，支持随时停止与急停。`,
    introHtml: U.sect('① 目标确认', U.kv([
      ['目标编号', `<b class="mono">${t.id}</b>`], ['轨迹编号', t.trackId || '归档轨迹'],
      ['融合置信度', fc != null
        ? `${fc}%（${srcN != null ? srcN + ' 路来源' : '来源路数未知'}）`
        : '<span class="tag t-amber">无实时融合数据 · 以轨迹与告警证据为准</span>'],
      ['违规判定', `${t.legal} / ${t.violation || '—'}`],
      ['当前位置', `${t.lon.toFixed(4)}°E, ${t.lat.toFixed(4)}°N, 高度 ${t.alt} m`]
    ])) + U.sect('② 空域与作用范围校验', U.kv([
      ['所在空域', t.zone ? `${t.zone.name}（${t.zone.type} · ${t.zone.limitTx}）` : '未落入管制空域'],
      ['校验结果', zoneOk ? `<span class="tag t-green">通过 · 目标位于管制空域内</span>` : `<span class="tag t-amber">需人工判定 · 目标不在管制空域</span>`],
      ['作用范围', `以设备为中心 1,500 m / 扇区 60°`],
      ['合法目标影响', legalRisk.length ? `<span class="tag t-red">范围内存在 ${legalRisk.length} 个合法飞行目标，需规避</span>` : `<span class="tag t-green">范围内无合法飞行目标</span>`]
    ])),
    fields: [
      { key: 'dev', label: '反制设备', type: 'select', options: optionsOf(dev.map(d => ({ v: d.id, t: d.name + '（' + d.status + '）' }))), clearable: false },
      { key: 'mode', label: '处置方式', type: 'select', options: optionsOf(['压制迫降', '驱离返航', '链路干扰']), clearable: false },
      { key: 'sec', label: '持续时长（秒）', placeholder: '60' },
      { key: 'meta', type: 'html', html: U.kv([['授权编号', `<span class="mono">AUTH2026${M.util.p2(8)}${M.util.p3(27)}</span>`],
        ['授权单位', '东营市低空安全管理中心'], ['操作人', '管理员（当前登录）'],
        ['信号干扰联动', '反制指令下发后自动启动，收到设备回执后进入“处置”环节']]) },
      { key: 'ack1', type: 'checkbox', label: '我已核对目标身份与违规事实，确认对该目标实施反制处置' },
      { key: 'ack2', type: 'checkbox', label: '我已确认作用范围内无合法飞行目标与地面安全风险，并知悉本次操作将全程审计' }
    ],
    initial: { dev: dev[0]?.id || null, mode: '压制迫降', sec: '60', ack1: false, ack2: false },
    confirmText: '确认授权并发起联动反制',
    danger: true,
    submitEnabled: m => !!m.ack1 && !!m.ack2,
    validate: m => (!m.ack1 || !m.ack2) ? '请先完成「人工双确认」：两项均需勾选后方可下发指令' : '',
    onSubmit: () => {
      closeModal();
      if (onAuthorized) onAuthorized(t);
    }
  });
}
