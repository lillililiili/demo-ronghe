/* =============================================================================
 * bigscreen.js —— 监控大屏专版（bigscreen.html 专用）
 * 运行形态：大屏单独部署显示，业务系统在电脑上运行（客户明确要求的专版）。
 * 数据口径：与业务系统同一份 MOCK 数据集派生（闭环数字走 EVT.counts()），
 *           本文件不得出现任何硬编码统计数字。
 * ========================================================================== */
(function (g) {
  'use strict';
  const M = g.MOCK, E = g.EVT;
  const $ = id => document.getElementById(id);

  /* ---------- 时钟（与业务系统同源：演示时间基准推进） ---------- */
  function tickClock() { $('bsClk').textContent = M.nowStr(); }

  /* ---------- 顶部 KPI：今日业务闭环，实时从 EVT.counts() 派生 ----------
     卡片继承主题层 .kpi 的 page-art 贴图工艺，数字/环/标签为大屏放大形态 */
  function paintKpis() {
    const c = E.counts();
    const items = [
      { lb: '今日发现目标', v: c.found, color: '#ffd53d' },
      { lb: '今日告警', v: c.alarmed, color: 'var(--cyan)' },
      { lb: '已结案', v: c.closed, color: '#dfe9ff' },
      { lb: '待处置', v: c.pending + c.disposing, color: 'var(--red)' }
    ];
    $('bsKpis').innerHTML = items.map(k => `
      <div class="kpi" style="color:${k.color}">
        <div class="v">${k.v}</div>
        <div class="ring"></div>
        <div class="lb">${k.lb}</div>
      </div>`).join('');
  }

  /* ---------- 左列图表 ---------- */
  function paintCharts() {
    const d = M.stats.days.slice(-7);   // 大屏小面板只放近 7 日，30 天全量在业务系统统计分析页
    CH.line($('bsTrend'), {
      x: d.map(x => x.md),
      series: [
        { name: '发现目标', data: d.map(x => x.total), color: CH.C.blue, area: true },
        { name: '非法目标', data: d.map(x => x.illegal), color: CH.C.red }
      ]
    });
    CH.line($('bsAlmTrend'), {
      x: d.map(x => x.md), legend: false,
      series: [{ name: '告警次数', data: d.map(x => x.alarm), color: CH.C.amber, area: true, label: true }]
    });
    CH.bar($('bsType'), {
      x: M.stats.byType.map(x => x.name), legend: false,
      series: [{ name: '目标数', data: M.stats.byType.map(x => x.value), color: CH.C.cyan }]
    });
  }

  /* ---------- 实时视频：由地图上的无人机目标按需打开 ---------- */
  let modalVideo = null;
  function openVideo(t) {
    if (!t || t.type !== '无人机') return;
    if (modalVideo) { modalVideo.destroy(); modalVideo = null; }

    const eo = M.devices.find(dv => dv.type === '光电' && dv.status === '在线');
    const tracked = !!t.tracked;
    const statusText = tracked ? '锁定跟踪中' : '实时预览';
    const statusClass = tracked ? 'is-tracked' : '';
    UI.modal({
      title: `实时视频 · ${t.id}`,
      width: '780px',
      footer: false,
      body: `<div class="bs-video-modal">
        <div class="bs-video-meta">
          <span>${eo ? eo.name : '光电设备'} · EO 可见光 · 4K</span>
          <span class="bs-video-state ${statusClass}"><i></i>${statusText}</span>
        </div>
        <div id="bsVideoModal"></div>
        <div class="bs-video-info">
          <span>目标编号 <b class="mono">${t.id}</b></span>
          <span>目标类型 <b>${t.type}</b></span>
          <span>合法性 <b>${t.legal || '待确认'}</b></span>
          <span>风险等级 <b>${t.risk || '—'}</b></span>
        </div>
      </div>`,
      mounted: el => {
        const box = el.querySelector('#bsVideoModal');
        modalVideo = new EOVideo(box, {
          height: Math.max(300, Math.min(430, window.innerHeight * .46)),
          targetId: t.id,
          device: eo ? eo.name : undefined,
          locked: tracked
        });
      }
    });
  }

  /* ---------- 右列表格：先满额渲染，再按面板实际高度裁掉溢出行 ----------
     不做行高常量假设（.tb 与主题层都会动它），量出来多少裁多少，天然零裁切。 */
  function fitRows(tb) {
    const box = tb.closest('.pb');
    let guard = 40;
    while (guard-- && tb.rows.length > 3 && tb.offsetHeight > box.clientHeight - 4) {
      tb.deleteRow(tb.rows.length - 1);
    }
  }

  function paintDevices() {
    const tb = $('bsDevTb');
    const s = M.deviceStats;
    $('bsDevSub').textContent = `在线 ${s.online}/${s.total} · 在线率 ${s.onlineRate}%`;
    const cl = { '在线': 'var(--green)', '离线': 'var(--txt-3)', '异常': 'var(--red)' };
    /* 心跳最新的排前面：大屏关注"此刻在报数的设备" */
    const list = M.devices.slice().sort((a, b) => (a.hbMin || 99) - (b.hbMin || 99)).slice(0, 20);
    tb.innerHTML = `<tr><th style="width:34%">设备编号</th><th>设备名称</th><th style="width:20%">状态</th></tr>` +
      list.map(d => `<tr>
        <td class="mono">${d.id}</td>
        <td title="${d.name}">${d.name}</td>
        <td style="color:${cl[d.status] || 'var(--txt-2)'}">● ${d.status}</td>
      </tr>`).join('');
    fitRows(tb);
  }

  function paintTargets() {
    const tb = $('bsTgtTb');
    const score = { '高风险': 3, '中风险': 2, '低风险': 1 };
    const list = M.liveTargets.filter(t => t.type === '无人机').slice().sort((a, b) =>
      Number(!!b.tracked) - Number(!!a.tracked) || (score[b.risk] || 0) - (score[a.risk] || 0) || b.ts - a.ts
    );
    $('bsTgtSub').textContent = `实时 ${list.length} 架 · 跟踪 ${list.filter(t => t.tracked).length}`;
    const riskColor = { '高风险': 'var(--red)', '中风险': 'var(--amber)', '低风险': 'var(--green)' };
    const stateColor = { '跟踪中': 'var(--cyan)', '处置中': 'var(--amber)', '已处置': 'var(--green)' };
    tb.innerHTML = `<tr><th style="width:37%">目标编号</th><th style="width:23%">区域</th><th style="width:19%">风险</th><th>状态</th></tr>` +
      list.map(t => `<tr class="${t.tracked ? 'is-tracked' : ''}">
        <td class="mono" title="${t.id}">${t.tracked ? '<i class="bs-track-dot"></i>' : ''}${t.id}</td>
        <td title="${t.district}">${t.district}</td>
        <td style="color:${riskColor[t.risk] || 'var(--txt-2)'}">${t.risk || '—'}</td>
        <td style="color:${stateColor[t.status] || 'var(--txt-2)'}">${t.status || '实时'}</td>
      </tr>`).join('');
    fitRows(tb);
  }

  function paintAlarms() {
    const tb = $('bsAlmTb');
    const as = M.todayAlarms.slice().sort((a, b) => b.ts - a.ts);
    $('bsAlmSub').textContent = `今日 ${as.length} 条`;
    const cl = { '高': 'var(--red)', '中': 'var(--amber)', '低': 'var(--cyan)' };
    tb.innerHTML = `<tr><th style="width:24%">时间</th><th>告警类型</th><th style="width:15%">等级</th><th style="width:21%">状态</th></tr>` +
      as.slice(0, 20).map(a => `<tr>
        <td class="mono">${a.time.slice(11, 19)}</td>
        <td title="${a.detail}">${a.type}</td>
        <td style="color:${cl[a.level] || 'var(--txt-2)'}">● ${a.level}</td>
        <td>${a.status}</td>
      </tr>`).join('');
    fitRows(tb);
  }

  /* ---------- 中央地图：与综合态势同一取数口径 ---------- */
  function mountMap() {
    const box = $('bsMap');
    const map = new MapView(box, {
      zoom: 1.06,
      maxDev: 46,
      maxAlarm: 8,
      onPick: pick => {
        if (!pick || pick.kind !== 'target' || !pick.data || pick.data.type !== '无人机') return;
        map.sel = pick.data.id;
        map.draw();
        openVideo(pick.data);
      }
    });
    const hint = document.createElement('div');
    hint.className = 'bs-map-hint';
    hint.textContent = '点击地图上的无人机查看实时视频';
    box.appendChild(hint);
    map.setData({
      airspaces: M.airspaces,
      devices: M.devices.filter((d, i) => i % 4 === 0),
      targets: M.liveTargets,
      alarms: M.todayAlarms.slice(0, 8)
    });
  }

  /* ---------- 启动 ----------
     依尺寸的渲染（图表容器/视频高度/表格裁行）放 requestAnimationFrame（约定⑯），
     并在 load 后再校一次表格——首帧布局未稳时量高裁行会把行数裁少。 */
  tickClock(); setInterval(tickClock, 1000);
  paintKpis();
  requestAnimationFrame(() => {
    paintCharts();
    paintTargets();
    paintDevices();
    paintAlarms();
    mountMap();
  });
  window.addEventListener('load', () => { paintTargets(); paintDevices(); paintAlarms(); });

  /* 窗口尺寸变化（拖到大屏、全屏切换）：表格行数需重装 */
  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { paintTargets(); paintDevices(); paintAlarms(); }, 250);
  });
})(window);
