/* =============================================================================
 * map.js —— 本地 PMTiles 矢量底图 + Canvas 业务态势叠加层（东营）
 * 两种模式统一 WGS-84 / Web Mercator；失败仅降级内置示意图。
 * ========================================================================== */
(function (g) {
  'use strict';
  /* 东营全域视图范围；业务叠加层与无网降级底图共用。 */
  const B = { lon0: 118.114, lon1: 119.308, lat0: 36.937, lat1: 38.156 };
  const CENTER = [(B.lon0 + B.lon1) / 2, (B.lat0 + B.lat1) / 2];
  const merc = (lon, lat) => {
    const s = Math.sin(Math.max(-85.051129, Math.min(85.051129, lat)) * Math.PI / 180);
    return [(lon + 180) / 360, .5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
  };
  const geographic = (x, y) => [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI];

  /* 东营地理骨架（简化矢量，仅用于 Demo 视觉参考） */
  const COAST = [[118.02, 38.13], [118.30, 38.17], [118.62, 38.10], [118.90, 38.01], [119.10, 37.87],
  [119.20, 37.72], [119.06, 37.60], [118.99, 37.42], [118.93, 37.20], [118.89, 36.98]];
  const RIVER = [[118.02, 37.28], [118.20, 37.38], [118.40, 37.50], [118.60, 37.63], [118.80, 37.72],
  [118.98, 37.77], [119.10, 37.79]];
  const ROADS = [
    [[118.28, 36.98], [118.45, 37.25], [118.56, 37.48], [118.60, 37.78], [118.66, 38.02]],
    [[118.02, 37.62], [118.35, 37.58], [118.66, 37.52], [118.98, 37.46]],
    [[118.10, 37.05], [118.42, 37.10], [118.75, 37.16], [118.95, 37.24]],
    [[118.52, 36.98], [118.58, 37.30], [118.70, 37.60], [118.86, 37.86]]
  ];
  const LABELS = [
    { n: '东营市', lon: 118.582, lat: 37.449, s: 15, c: '#2f485f' },
    { n: '河口区', lon: 118.525, lat: 37.886, s: 12, c: '#526b80' },
    { n: '利津县', lon: 118.256, lat: 37.490, s: 12, c: '#526b80' },
    { n: '垦利区', lon: 118.548, lat: 37.588, s: 12, c: '#526b80' },
    { n: '广饶县', lon: 118.407, lat: 37.053, s: 12, c: '#526b80' },
    { n: '东营港', lon: 118.960, lat: 38.085, s: 11, c: '#526b80' },
    { n: '渤海', lon: 119.12, lat: 38.05, s: 13, c: '#3e7fa6' },
    { n: '莱州湾', lon: 119.14, lat: 37.30, s: 12, c: '#3e7fa6' }
  ];

  function MapView(box, opt) {
    opt = opt || {};
    if (box.__map) box.__map.destroy();
    this.box = box; this.opt = opt;
    this.data = { airspaces: [], devices: [], targets: [], alarms: [] };
    this.layers = Object.assign({ device: true, track: true, nofly: true, suit: true, limit: true, alarm: true }, opt.layers);
    this.online = false; this.map = null;
    this.zoom = opt.zoom || 1; this.ox = 0; this.oy = 0; this.t = 0; this.hover = null; this.sel = null;
    this._pendingCenter = CENTER.slice();
    this._isDefaultView = true;
    this._defaultScale = this.zoom;
    box.classList.add('mapwrap');
    /* 图例默认折叠成「图例」小条（评审：1280 宽下图例遮挡地图过多），点标题展开。
       opt.legendOpen:true 可保持展开。文案用业务语言，技术编号（A03/A04）移入 title。 */
    const legendHtml = opt.legend === false ? '' : `<div class="maplegend${opt.legendOpen ? '' : ' collapsed'}">
        <div class="lg-hd" role="button" tabindex="0" aria-label="展开或收起图例">图例 <span class="lg-arrow">${opt.legendOpen ? '▾' : '▸'}</span></div>
        <div class="li"><span class="sw" style="border-color:#2fd06e"></span>合法目标轨迹</div>
        <div class="li"><span class="sw" style="border-color:#8ca0be"></span>不适用（异物 §4.2）</div>
        <div class="li"><span class="sw" style="border-color:#ff4d5e"></span>非法/告警目标</div>
        <div class="li" title="弥合段（A03）"><span class="sw" style="border-color:#ff8b3d;border-top-style:dotted"></span>推算补全段</div>
        <div class="li" title="预测段（A04）"><span class="sw" style="border-color:#22d3ee;border-top-style:dotted"></span>预测延伸段</div>
        <div class="li"><span style="width:14px;text-align:center;color:#22d3ee">●</span>设备点位</div>
        ${(window.MOCK && window.MOCK.AIRSPACE_TYPES ? window.MOCK.AIRSPACE_TYPES : [])
          .filter((a, i, arr) => arr.findIndex(x => x.legend === a.legend) === i)
          .map(a => `<div class="li"><span class="sw" style="border-color:${a.color}"></span>${a.legend}</div>`).join('')}
      </div>`;
    box.innerHTML = `<div class="mapbase"></div><canvas class="mapoverlay"></canvas>
      <div class="mapctl">
        <button type="button" class="mb" data-z="in" aria-label="放大">${g.UI.icon('zoomIn')}</button><button type="button" class="mb" data-z="out" aria-label="缩小">${g.UI.icon('zoomOut')}</button><button type="button" class="mb" data-z="fit" aria-label="复位">${g.UI.icon('expand')}</button>
      </div>
      ${legendHtml}
      <div class="maptip"></div>
      <div class="mapscale"><span></span><div class="bar"></div></div>
      <div class="mapstatus is-loading" role="status" aria-live="polite"><span>底图加载中…</span><button type="button" data-map-retry hidden>重试</button></div>
      <div class="mapcredit">简化示意图 · 非精确行政边界</div>`;
    box.__map = this;          // 便于调试与外部程序化控制
    this.baseEl = box.querySelector('.mapbase');
    this.cv = box.querySelector('.mapoverlay');
    this.ctx = this.cv.getContext('2d');
    this.tip = box.querySelector('.maptip');
    this.statusEl = box.querySelector('.mapstatus');
    this._bind();
    this._resize();
    this._initOffline();
    this._loop();
  }

  MapView.prototype._status = function (state, error) {
    this.box.dataset.mapState = state;
    this.baseEl.setAttribute('aria-busy', String(state === 'loading'));
    this.statusEl.hidden = state === 'ready';
    this.statusEl.className = 'mapstatus is-' + state;
    this.statusEl.querySelector('span').textContent = state === 'loading' ? '底图加载中…' : '离线地图不可用，已切换简化示意图';
    this.statusEl.querySelector('button').hidden = state !== 'fallback';
    this.statusEl.title = error ? error.message || String(error) : '';
    this.box.querySelector('.mapcredit').hidden = state === 'ready';
  };

  MapView.prototype._disposeBase = function () {
    clearTimeout(this._loadTimer);
    clearTimeout(this._failureTimer);
    if (this._loadController) this._loadController.abort();
    if (this.map) {
      const map = this.map; this.map = null;
      (this._mapEvents || []).forEach(([name, fn]) => map.off(name, fn));
      map.remove();
    }
    this._mapEvents = [];
    // 构造阶段 WebGL 失败也可能已经插入 Canvas，必须一并清理。
    if (this.baseEl) { this.baseEl.replaceChildren(); this.baseEl.classList.remove('maplibregl-map'); }
    if (this._release) { this._release(); this._release = null; }
    this.online = false;
  };

  MapView.prototype._fallback = function (error) {
    if (this._dead) return;
    if (this.map) this._syncView();
    this._disposeBase();
    this._status('fallback', error);
    this.draw();
  };

  MapView.prototype._syncView = function () {
    if (!this.map) return;
    this._pendingCenter = this.map.getCenter().toArray();
    this.zoom = Math.pow(2, this.map.getZoom() - this._fitLevelForWidth());
  };

  MapView.prototype._initOffline = function () {
    if (this._dead) return;
    this._disposeBase();
    this._status('loading');
    const controller = new AbortController();
    this._loadController = controller;
    this._loadTimer = setTimeout(() => this._fallback(new Error('地图加载超时，请检查地图包与静态服务器')), 25000);
    Promise.resolve().then(() => {
      if (!g.OfflineMap) throw new Error('本地地图加载桥接尚未就绪');
      return g.OfflineMap.prepare(controller.signal);
    }).then(runtime => {
      if (this._dead || controller.signal.aborted) { runtime.release(); return; }
      this._release = runtime.release;
      this._coverageBounds = runtime.bounds;
      this._applyDefaultView();
      const map = new runtime.maplibre.Map({
        container: this.baseEl, style: runtime.style, center: this._pendingCenter,
        zoom: this._levelForScale(this.zoom), minZoom: Math.min(7, this._fitLevelForWidth()), maxZoom: 18,
        bearing: 0, pitch: 0, dragRotate: false, pitchWithRotate: false,
        touchPitch: false, renderWorldCopies: false, attributionControl: false,
        localIdeographFontFamily: false, fadeDuration: 0,
        transformRequest: runtime.transformRequest
      });
      this.map = map;
      map.touchZoomRotate.disableRotation();
      map.addControl(new runtime.maplibre.AttributionControl({ compact: false }), 'bottom-left');
      const on = (name, fn) => { map.on(name, fn); this._mapEvents.push([name, fn]); };
      on('movestart', event => { if (event.originalEvent) this._isDefaultView = false; });
      on('move', () => { this._syncView(); this.draw(); this._hit(); });
      on('render', () => { this.draw(); });
      on('dragstart', () => { this._dragged = true; this._boxLeave(); });
      // 非展示用：拖拽结束后 250ms 内抑制误点击，必须用墙钟而非 M.now()
      on('dragend', () => { this._suppressClickUntil = Date.now() + 250; this._dragged = false; });
      on('webglcontextlost', () => this._fallback(new Error('WebGL 上下文丢失，可尝试重试')));
      on('error', event => {
        // 在事件派发完成后清理引擎，避免 remove 造成重入。
        clearTimeout(this._failureTimer);
        this._failureTimer = setTimeout(() => this._fallback(event.error || new Error('离线资源读取失败')), 0);
      });
      on('load', () => {
        clearTimeout(this._loadTimer);
        this.online = true;
        this._syncView(); this._status('ready'); this.draw();
      });
      this.draw();
    }).catch(error => {
      if (!this._dead && !controller.signal.aborted) this._fallback(error);
    });
  };

  MapView.prototype._bind = function () {
    const self = this;
    this._ro = new ResizeObserver(() => self._resize());
    this._ro.observe(this.box);
    this._boxClick = e => {
      if (e.target.closest && e.target.closest('[data-map-retry]')) { e.preventDefault(); e.stopPropagation(); self._initOffline(); return; }
      const lg = e.target.closest && e.target.closest('.lg-hd');
      if (lg) {
        e.preventDefault(); e.stopPropagation();
        const box = lg.closest('.maplegend'), closed = box.classList.toggle('collapsed');
        const ar = lg.querySelector('.lg-arrow');
        if (ar) ar.textContent = closed ? '▸' : '▾';
        return;
      }
      const z = e.target.closest && e.target.closest('[data-z]');
      if (z) {
        e.preventDefault(); e.stopPropagation();
        if (z.dataset.z === 'in') self.setZoom(self.zoom * 1.5);
        else if (z.dataset.z === 'out') self.setZoom(self.zoom / 1.5);
        else self.resetView();
        return;
      }
      if (e.target.closest && e.target.closest('.maplayers,.mapstatus,.maplibregl-control-container')) return;
      // 非展示用：对照墙钟判断拖拽后的误点击抑制窗口
      if (self._dragged || Date.now() < (self._suppressClickUntil || 0)) return;
      self._boxMove(e);
      if (self.hover && self.opt.onPick) self.opt.onPick(self.hover);
    };
    this._boxMove = e => {
      const r = self.cv.getBoundingClientRect();
      self.mx = e.clientX - r.left; self.my = e.clientY - r.top;
      if (!self._dragged) self._hit();
    };
    this._boxLeave = () => {
      self.mx = self.my = NaN;
      self.hover = null; self.tip.style.display = 'none';
      if (self.baseEl) self.baseEl.style.cursor = '';
    };
    this.box.addEventListener('click', this._boxClick, true);
    this.box.addEventListener('mousemove', this._boxMove, true);
    this.box.addEventListener('mouseleave', this._boxLeave);
    this._boxKey = e => {
      if (e.target.matches('.lg-hd') && ['Enter', ' '].includes(e.key)) { e.preventDefault(); e.target.click(); }
    };
    this.box.addEventListener('keydown', this._boxKey);

    let drag = null;
    this._boxDown = e => {
      self._dragged = false;
      if (e.button !== 0 || (e.target.closest && e.target.closest('.mapctl,.maplegend,.maplayers,.mapstatus,.maplibregl-control-container'))) return;
      drag = { x: e.clientX, y: e.clientY, center: merc(...self._pendingCenter) };
    };
    this._boxWheel = e => {
      if (self.map || e.target.closest('.mapctl,.maplegend,.maplayers,.mapstatus')) return;
      e.preventDefault();
      const r = self.cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      const before = merc(...self.unpx(x, y));
      self.setZoom(self.zoom * (e.deltaY < 0 ? 1.18 : 0.85));
      const after = merc(...self.unpx(x, y)), center = merc(...self._pendingCenter);
      self._pendingCenter = geographic(center[0] + before[0] - after[0], center[1] + before[1] - after[1]);
      self.draw(); self._boxMove(e);
    };
    this.box.addEventListener('mousedown', this._boxDown, true);
    this.box.addEventListener('wheel', this._boxWheel, { passive: false, capture: true });
    this._winUp = () => {
      // 非展示用：拖拽结束后 250ms 内抑制误点击，必须用墙钟而非 M.now()
      if (self._dragged) self._suppressClickUntil = Date.now() + 250;
      self._dragged = false; drag = null;
    };
    window.addEventListener('mouseup', this._winUp);
    this._winMove = e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 4) { self._dragged = true; self._isDefaultView = false; }
      if (self.map) return;
      const size = 512 * Math.pow(2, self._levelForScale(self.zoom));
      self._pendingCenter = geographic(drag.center[0] - dx / size, drag.center[1] - dy / size);
      self._boxLeave();
      self.draw();
    };
    window.addEventListener('mousemove', this._winMove);
  };

  MapView.prototype._resize = function () {
    if (this._dead) return;
    const r = this.box.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.cv.width = Math.max(1, Math.round(r.width * dpr));
    this.cv.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._applyDefaultView();
    if (this.map) {
      const zoom = this._levelForScale(this.zoom);
      const center = this._pendingCenter.slice();
      this.map.resize();
      this.map.jumpTo({ zoom, center });
    }
    this.draw();
  };

  MapView.prototype._fitLevelForWidth = function () {
    const a = merc(B.lon0, B.lat1), b = merc(B.lon1, B.lat0);
    return Math.log2(Math.min(Math.max(1, this.w - 40) / (b[0] - a[0]), Math.max(1, this.h - 40) / (b[1] - a[1])) / 512);
  };

  // 首屏与复位时让整个视口落在真实数据范围内；保留用户主动平移/缩放。
  MapView.prototype._applyDefaultView = function () {
    if (!this._isDefaultView) return;
    let level = this._levelForScale(this._defaultScale);
    if (this._coverageBounds && this.w > 0 && this.h > 0) {
      const [west, south, east, north] = this._coverageBounds;
      const a = merc(west, north), b = merc(east, south);
      const center = merc(...CENTER);
      // 留 4px 内边距，避免边缘抗锯齿或像素取整露出无数据背景。
      center[0] = Math.max(a[0], Math.min(b[0], center[0]));
      center[1] = Math.max(a[1], Math.min(b[1], center[1]));
      let dx = Math.min(center[0] - a[0], b[0] - center[0]);
      let dy = Math.min(center[1] - a[1], b[1] - center[1]);
      if (dx <= 0 || dy <= 0) {
        center[0] = (a[0] + b[0]) / 2; center[1] = (a[1] + b[1]) / 2;
        dx = (b[0] - a[0]) / 2; dy = (b[1] - a[1]) / 2;
      }
      level = Math.min(18, Math.max(level, Math.log2(Math.max((this.w + 8) / (2 * dx), (this.h + 8) / (2 * dy)) / 512)));
      this._pendingCenter = geographic(...center);
    }
    this.zoom = Math.pow(2, level - this._fitLevelForWidth());
  };

  MapView.prototype._levelForScale = function (scale) {
    const fit = this._fitLevelForWidth();
    return Math.max(Math.min(7, fit), Math.min(18, fit + Math.log2(Math.max(.01, Number(scale) || 1))));
  };

  MapView.prototype._fallbackPx = function (lon, lat) {
    const p = merc(lon, lat), center = merc(...this._pendingCenter);
    const size = 512 * Math.pow(2, this._levelForScale(this.zoom));
    return [this.w / 2 + (p[0] - center[0]) * size, this.h / 2 + (p[1] - center[1]) * size];
  };

  /* 对外及引擎边界均为 WGS-84，不叠加 GCJ 偏移。 */
  MapView.prototype.px = function (lon, lat) {
    if (this.map) {
      const p = this.map.project([lon, lat]);
      return [p.x, p.y];
    }
    return this._fallbackPx(lon, lat);
  };

  MapView.prototype.unpx = function (sx, sy) {
    if (this.map) return this.map.unproject([sx, sy]).toArray();
    const center = merc(...this._pendingCenter), size = 512 * Math.pow(2, this._levelForScale(this.zoom));
    return geographic(center[0] + (sx - this.w / 2) / size, center[1] + (sy - this.h / 2) / size);
  };

  MapView.prototype.setZoom = function (z) {
    this._isDefaultView = false;
    this.zoom = Math.pow(2, this._levelForScale(z) - this._fitLevelForWidth());
    if (this.map) this.map.setZoom(this._levelForScale(this.zoom));
    this.draw();
    return this;
  };

  MapView.prototype.centerAt = function (lon, lat, options) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return this;
    options = options || {};
    this._isDefaultView = false;
    if (Number.isFinite(options.scale)) this.setZoom(options.scale);
    this._pendingCenter = [lon, lat];
    if (this.map) this.map.setCenter(this._pendingCenter);
    this.draw();
    return this;
  };

  MapView.prototype.resetView = function (scale) {
    this.ox = this.oy = 0;
    this._isDefaultView = true;
    this._defaultScale = scale == null ? 1 : scale;
    this._pendingCenter = CENTER.slice();
    this._applyDefaultView();
    if (this.map) this.map.jumpTo({ center: this._pendingCenter, zoom: this._levelForScale(this.zoom) });
    this.draw();
    return this;
  };

  MapView.prototype.setData = function (d) { Object.assign(this.data, d); this.draw(); return this; };
  MapView.prototype.setLayer = function (k, v) { this.layers[k] = v; this.draw(); return this; };
  MapView.prototype.destroy = function () {
    if (this._dead) return;
    this._dead = true;
    this._disposeBase();
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    if (this._ro) this._ro.disconnect();
    if (this._boxClick) this.box.removeEventListener('click', this._boxClick, true);
    if (this._boxMove) this.box.removeEventListener('mousemove', this._boxMove, true);
    if (this._boxLeave) this.box.removeEventListener('mouseleave', this._boxLeave);
    if (this._boxDown) this.box.removeEventListener('mousedown', this._boxDown, true);
    if (this._boxWheel) this.box.removeEventListener('wheel', this._boxWheel, true);
    if (this._winUp) window.removeEventListener('mouseup', this._winUp);
    if (this._winMove) window.removeEventListener('mousemove', this._winMove);
    if (this._boxKey) this.box.removeEventListener('keydown', this._boxKey);
    if (this.box && this.box.__map === this) { delete this.box.__map; this.box.replaceChildren(); delete this.box.dataset.mapState; }
  };

  MapView.prototype._hit = function () {
    const pts = this._pickPts || [];
    let best = null, bd = 14;
    for (const p of pts) {
      const d = Math.hypot(p.x - this.mx, p.y - this.my);
      if (d < bd) { bd = d; best = p; }
    }
    this.hover = best;
    if (best) {
      this.tip.style.display = 'block';
      this.tip.innerHTML = best.tip;
      const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
      this.tip.style.left = Math.min(this.w - tw - 8, Math.max(8, best.x + 14)) + 'px';
      this.tip.style.top = Math.min(this.h - th - 8, Math.max(8, best.y - th - 10)) + 'px';
      if (this.baseEl) this.baseEl.style.cursor = 'pointer';
    } else {
      this.tip.style.display = 'none';
      if (this.baseEl) this.baseEl.style.cursor = '';
    }
  };

  MapView.prototype._loop = function () {
    const self = this;
    (function f() {
      if (self._dead) return;
      if (!self.box.isConnected) { self.destroy(); return; }
      self.t += 1; self.draw(); self._raf = requestAnimationFrame(f);
    })();
  };

  /* AOA 方位线：从上报设备射出一条带不确定扇区的射线，末端标「仅方位」。
     长度用固定像素而非真实距离 —— AOA 给不出距离，画一条有确定长度的线同样是编。 */
  MapView.prototype._drawBearing = function (c, t, P, col) {
    if (t.fromDeviceLon == null || t.azimuth == null) return;
    const o = P(t.fromDeviceLon, t.fromDeviceLat);
    const rad = (t.azimuth - 90) * Math.PI / 180;
    const L = 96, HALF = 4 * Math.PI / 180;            // 4° 测向不确定度【待确认：设备方提供】
    c.save();
    c.beginPath(); c.moveTo(o[0], o[1]);
    c.arc(o[0], o[1], L, rad - HALF, rad + HALF); c.closePath();
    c.fillStyle = col + '1c'; c.fill();
    c.beginPath(); c.moveTo(o[0], o[1]);
    c.lineTo(o[0] + Math.cos(rad) * L, o[1] + Math.sin(rad) * L);
    c.setLineDash([5, 4]); c.strokeStyle = col + 'cc'; c.lineWidth = 1.4; c.stroke();
    c.setLineDash([]);
    c.beginPath(); c.arc(o[0], o[1], 2.5, 0, 7); c.fillStyle = col; c.fill();
    if (this.sel === t.id || t.tracked) {
      c.font = '9.5px "PingFang SC"'; c.fillStyle = col; c.textAlign = 'left';
      c.fillText('仅方位 ' + t.azimuth.toFixed(0) + '°',
        o[0] + Math.cos(rad) * (L + 6), o[1] + Math.sin(rad) * (L + 6));
    }
    c.restore();
  };

  /* 空域/设备/轨迹/告警始终由业务 Canvas 绘制。 */
  MapView.prototype._drawOverlays = function (c, W, H) {
    this._paintLayers(c, W, H);
  };

  MapView.prototype.draw = function () {
    const c = this.ctx, W = this.w, H = this.h;
    if (!W) return;
    const P = (a, b) => this.px(a, b);
    c.clearRect(0, 0, W, H);

    /* 离线详细底图由 MapLibre 渲染；Canvas 只画业务叠加层。 */
    if (this.online && this.map) { this._drawOverlays(c, W, H); return; }

    /* 简化示意图：保持业务可操作，不读取任何历史图片瓦片。 */
    const gr = c.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, '#f5f1e8'); gr.addColorStop(1, '#edf2e6');
    c.fillStyle = gr; c.fillRect(0, 0, W, H);

    /* 海域 */
    c.beginPath();
    COAST.forEach((p, i) => { const q = P(p[0], p[1]); i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); });
    const e1 = P(B.lon1 + 1, B.lat0 - 1), e2 = P(B.lon1 + 1, B.lat1 + 1);
    c.lineTo(e1[0], e1[1]); c.lineTo(e2[0], e2[1]); c.closePath();
    c.fillStyle = '#b9dce8'; c.fill();
    c.strokeStyle = 'rgba(88,151,178,.62)'; c.lineWidth = 1.2; c.stroke();

    /* 经纬网 */
    c.strokeStyle = 'rgba(91,116,126,.10)'; c.lineWidth = 1;
    for (let lo = 118.0; lo <= 119.3; lo += 0.1) { const a = P(lo, B.lat0), b = P(lo, B.lat1); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
    for (let la = 37.0; la <= 38.2; la += 0.1) { const a = P(B.lon0, la), b = P(B.lon1, la); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }

    /* 道路 */
    c.strokeStyle = 'rgba(196,155,105,.62)'; c.lineWidth = 2.2;
    ROADS.forEach(r => { c.beginPath(); r.forEach((p, i) => { const q = P(p[0], p[1]); i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); }); c.stroke(); });

    /* 黄河 */
    c.strokeStyle = 'rgba(84,157,187,.72)'; c.lineWidth = 2.6; c.lineCap = 'round';
    c.beginPath(); RIVER.forEach((p, i) => { const q = P(p[0], p[1]); i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); }); c.stroke();
    c.strokeStyle = 'rgba(168,218,232,.65)'; c.lineWidth = 6; c.stroke();

    /* 地名 */
    c.textAlign = 'center'; c.textBaseline = 'middle';
    LABELS.forEach(l => {
      const q = P(l.lon, l.lat);
      c.font = `${l.s}px "PingFang SC",sans-serif`;
      c.strokeStyle = 'rgba(255,255,255,.94)'; c.lineWidth = 4; c.strokeText(l.n, q[0], q[1]);
      c.fillStyle = l.c; c.fillText(l.n, q[0], q[1]);
    });

    this._paintLayers(c, W, H);
  };

  /* 叠加层：空域 / 设备 / 轨迹 / 告警（两种底图模式共用） */
  MapView.prototype._paintLayers = function (c, W, H) {
    const P = (a, b) => this.px(a, b);
    const picks = [];

    /* 空域 */
    (this.data.airspaces || []).forEach(a => {
      // 图层归属读数据层声明，不在渲染层写第二份类型判断
      const key = (window.MOCK && window.MOCK.airspaceType) ? window.MOCK.airspaceType(a.type).layer
        : (a.type === '禁飞空域' ? 'nofly' : a.type === '适飞空域' ? 'suit' : 'limit');
      if (!this.layers[key]) return;
      // 高亮色适合暗色底图，在浅色底图上用同色相深色保持可读性。
      const ink = ({
        '#ff4d5e': '#d52d42', '#2fd06e': '#16864f', '#ffb020': '#b97600',
        '#3d8bff': '#2c66bb', '#a97bff': '#7545c7', '#8ca0be': '#5f7189'
      })[String(a.color).toLowerCase()] || a.color;
      c.beginPath();
      a.poly.forEach((p, i) => { const q = P(p[0], p[1]); i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); });
      c.closePath();
      c.fillStyle = a.color + '14'; c.fill();
      c.setLineDash([6, 4]); c.lineWidth = 1.35; c.strokeStyle = ink + 'd9'; c.stroke(); c.setLineDash([]);
      // 仅禁飞区保留稀疏纹理作为强语义，其他类型让出底图细节。
      if (key === 'nofly') {
        c.save(); c.clip();
        c.strokeStyle = ink + '1f'; c.lineWidth = .8;
        const bb = a.poly.reduce((m, p) => { const q = P(p[0], p[1]); return [Math.min(m[0], q[0]), Math.min(m[1], q[1]), Math.max(m[2], q[0]), Math.max(m[3], q[1])]; }, [1e9, 1e9, -1e9, -1e9]);
        // 街道级放大时多边形可能远大于屏幕，只绘制可见范围的纹理。
        const top = Math.max(0, bb[1]), bottom = Math.min(H, bb[3]);
        const left = Math.max(0, bb[0]), right = Math.min(W, bb[2]);
        for (let x = left - (bottom - top); x < right && bottom > top; x += 15) { c.beginPath(); c.moveTo(x, top); c.lineTo(x + (bottom - top), bottom); c.stroke(); }
        c.restore();
      }
      const ctr = P(a.center.lon, a.center.lat);
      if (this.opt.showAirspaceLabels !== false) {
        c.textAlign = 'center';
        c.font = '600 12px "PingFang SC"';
        c.strokeStyle = 'rgba(255,255,255,.94)'; c.lineWidth = 4;
        c.strokeText(a.type, ctr[0], ctr[1] - 7);
        c.fillStyle = ink; c.fillText(a.type, ctr[0], ctr[1] - 7);
        c.font = '10.5px Menlo';
        const airTx = a.id + (a.limit ? ' · ' + a.limitTx : '');
        c.strokeText(airTx, ctr[0], ctr[1] + 8);
        c.fillStyle = ink; c.fillText(airTx, ctr[0], ctr[1] + 8);
      }
      picks.push({
        x: ctr[0], y: ctr[1], kind: 'airspace', data: a,
        tip: `<b style="color:${ink}">${a.name}</b><dl class="kv" style="margin-top:6px">
          <dt>编号</dt><dd>${a.id}</dd><dt>类型</dt><dd>${a.type}</dd>
          <dt>限高</dt><dd>${a.limitTx}</dd><dt>管理单位</dt><dd>${a.unit}</dd></dl>`
      });
    });

    /* 设备点位 */
    if (this.layers.device) {
      (this.data.devices || []).slice(0, this.opt.maxDev || 90).forEach(d => {
        const q = P(d.lon, d.lat);
        if (q[0] < -20 || q[0] > W + 20 || q[1] < -20 || q[1] > H + 20) return;
        const col = d.status === '在线' ? (d.alarm ? '#d97706' : '#008fb3') : d.status === '离线' ? '#64748b' : '#dc2638';
        c.beginPath(); c.arc(q[0], q[1], 4.4, 0, 7); c.fillStyle = 'rgba(255,255,255,.9)'; c.fill();
        c.beginPath(); c.arc(q[0], q[1], 2.35, 0, 7); c.fillStyle = col; c.fill();
        c.beginPath(); c.arc(q[0], q[1], 5.2, 0, 7); c.strokeStyle = col + '70'; c.lineWidth = .9; c.stroke();
        if (d.alarm) {
          const r = 7 + (this.t % 60) / 60 * 9;
          c.beginPath(); c.arc(q[0], q[1], r, 0, 7);
          c.strokeStyle = `rgba(255,176,32,${(1 - (this.t % 60) / 60) * .7})`; c.stroke();
        }
        picks.push({
          x: q[0], y: q[1], kind: 'device', data: d,
          tip: `<b>${d.name}</b><dl class="kv" style="margin-top:6px">
            <dt>编号</dt><dd>${d.id}</dd><dt>类型</dt><dd>${d.type} / ${d.channel}</dd>
            <dt>状态</dt><dd style="color:${col}">${d.status}${d.alarm ? '（告警）' : ''}</dd>
            <dt>位置</dt><dd>${d.lon.toFixed(4)}°E, ${d.lat.toFixed(4)}°N</dd></dl>`
        });
      });
    }

    /* 目标轨迹 */
    if (this.layers.track) {
      /* 选中态可见性（用户实测"不明显"后强化）：有选中目标时其余目标整体压暗，
         对比是最强的可见性手段；选中者叠加 强脉冲 + 稳定内圈 + 四角定位括号。 */
      const selOnMap = !!this.sel && (this.data.targets || []).some(x => x.id === this.sel);
      (this.data.targets || []).forEach((t, ti) => {
        const isSel = this.sel === t.id;
        const dim = selOnMap && !isSel;
        if (dim) { c.save(); c.globalAlpha = .35; }
        // §4.2：非无人机目标不做合法性判定，'不适用' 单列中性色，不得与「合法」同色
        const col = t.legal === '非法' ? '#ff4d5e' : t.legal === '异常' ? '#ff8b3d'
          : t.legal === '待确认' ? '#ffb020' : t.legal === '不适用' ? '#8ca0be' : '#2fd06e';
        /* AOA 目标只有方位角，没有经纬度（协议 v8.6）—— 画成从设备射出的方位线。
           当点画等于凭空给了一个平台并不知道的位置。 */
        if (t.posValid === false) { this._drawBearing(c, t, P, col); if (dim) c.restore(); return; }
        const tr = t.track || [];
        if (tr.length > 1) {
          /* F0202:按点型分段绘制 —— 实测=动画虚线 / 弥合=橙色宽隙虚线(A03) / 预测=青色点线(A04) */
          const STYLE = {
            meas: { dash: [6, 4], col: col + ((t.tracked || isSel) ? 'ee' : '99'), w: (t.tracked || isSel) ? 2 : 1.3, anim: true },
            bridge: { dash: [3, 6], col: '#ff8b3d', w: 2, anim: false },
            pred: { dash: [2, 5], col: '#22d3ee', w: 1.6, anim: false }
          };
          let bridgeLabelAt = null;
          for (let i = 1; i < tr.length; i++) {
            const kind = tr[i].kind || 'meas';
            const st = STYLE[kind] || STYLE.meas;
            const a = P(tr[i - 1].lon, tr[i - 1].lat), b = P(tr[i].lon, tr[i].lat);
            c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
            c.setLineDash(st.dash); c.lineDashOffset = st.anim ? -(this.t * .6) % 10 : 0;
            c.strokeStyle = st.col; c.lineWidth = st.w; c.stroke();
            if (kind === 'bridge' && !bridgeLabelAt) bridgeLabelAt = a;
            if (kind !== 'meas' && (t.tracked || this.sel === t.id)) {
              c.setLineDash([]);
              c.beginPath(); c.arc(b[0], b[1], 2.2, 0, 7);
              c.strokeStyle = st.col; c.lineWidth = 1.2; c.stroke();   // 空心点标记非实测点
            }
          }
          c.setLineDash([]);
          if (bridgeLabelAt && (t.tracked || this.sel === t.id)) {
            c.font = '9.5px "PingFang SC"'; c.fillStyle = '#ffb083'; c.textAlign = 'left';
            c.fillText('注意：断裂-弥合', bridgeLabelAt[0] + 6, bridgeLabelAt[1] - 5);
          }
          const s = P(tr[0].lon, tr[0].lat);
          c.beginPath(); c.arc(s[0], s[1], 3, 0, 7); c.fillStyle = '#2fd06e'; c.fill();
        }
        const last = tr.length ? tr[tr.length - 1] : { lon: t.lon, lat: t.lat };
        const q = P(last.lon, last.lat);
        // 目标图标（旋翼）
        c.save(); c.translate(q[0], q[1]);
        if (isSel) {
          /* 选中标记走交互色系（合法目标青色、其余红色），与合法性色 col 分层不混用 */
          const mk = t.legal === '合法' ? '#22d3ee' : '#ff4d5e';
          const ph = (this.t % 50) / 50;
          c.beginPath(); c.arc(0, 0, 12 + ph * 14, 0, 7);   // 外圈强脉冲：粗线、透明度不落到 0
          c.strokeStyle = mk + Math.round(((1 - ph) * .8 + .2) * 255).toString(16).padStart(2, '0');
          c.lineWidth = 3; c.stroke();
          c.beginPath(); c.arc(0, 0, 9, 0, 7);              // 内圈稳定锚：脉冲最淡时仍有落点
          c.strokeStyle = mk; c.lineWidth = 2; c.stroke();
          const B = 15, L = 6;                              // 四角定位括号（雷达风格）
          c.strokeStyle = mk; c.lineWidth = 2;
          [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy]) => {
            c.beginPath();
            c.moveTo(sx * B, sy * (B - L)); c.lineTo(sx * B, sy * B); c.lineTo(sx * (B - L), sy * B);
            c.stroke();
          });
        } else if (t.tracked) {
          const r = 10 + (this.t % 50) / 50 * 12;
          c.beginPath(); c.arc(0, 0, r, 0, 7);
          c.strokeStyle = `rgba(255,77,94,${(1 - (this.t % 50) / 50) * .8})`; c.lineWidth = 1.5; c.stroke();
        }
        c.rotate((this.t * .04) % 6.283);
        c.strokeStyle = col; c.lineWidth = 1.6;
        for (let k = 0; k < 4; k++) {
          const a = k * Math.PI / 2 + Math.PI / 4;
          c.beginPath(); c.moveTo(0, 0); c.lineTo(Math.cos(a) * 6, Math.sin(a) * 6); c.stroke();
          c.beginPath(); c.arc(Math.cos(a) * 6, Math.sin(a) * 6, 2.4, 0, 7); c.stroke();
        }
        c.restore();
        c.beginPath(); c.arc(q[0], q[1], 2.4, 0, 7); c.fillStyle = col; c.fill();
        if (isSel) {
          const mk = t.legal === '合法' ? '#22d3ee' : '#ff4d5e';
          c.font = '12px Menlo'; c.textAlign = 'left';
          const tx = t.id.slice(-9), tw = c.measureText(tx).width + 10;
          c.fillStyle = 'rgba(4,10,26,.92)'; c.fillRect(q[0] + 16, q[1] - 22, tw, 17);
          c.strokeStyle = mk; c.lineWidth = 1; c.strokeRect(q[0] + 16, q[1] - 22, tw, 17);
          c.fillStyle = '#fff'; c.fillText(tx, q[0] + 21, q[1] - 9);
        } else if (this.opt.showTargetLabels !== false && (t.tracked || (this.data.targets || []).length <= 8)) {
          c.font = '10.5px Menlo'; c.textAlign = 'left';
          c.fillStyle = 'rgba(4,10,26,.8)'; c.fillRect(q[0] + 11, q[1] - 16, 62, 12);
          c.fillStyle = col; c.fillText(t.id.slice(-9), q[0] + 13, q[1] - 7);
        }
        if (dim) c.restore();
        picks.push({
          x: q[0], y: q[1], kind: 'target', data: t,
          tip: `<b style="color:${col}">${t.id}</b><dl class="kv" style="margin-top:6px">
            <dt>类型</dt><dd>${t.subtype || t.type}</dd><dt>高度</dt><dd>${t.alt} m</dd>
            <dt>速度</dt><dd>${t.speed} m/s</dd><dt>合法性</dt><dd style="color:${col}">${t.legal}${t.violation ? '（' + t.violation + '）' : ''}</dd>
            <dt>风险</dt><dd>${t.risk}</dd><dt>来源</dt><dd>${t.source}</dd></dl>`
        });
      });
    }

    /* 告警点位 */
    if (this.layers.alarm) {
      (this.data.alarms || []).slice(0, this.opt.maxAlarm || 8).forEach(a => {
        const t = (this.data.targets || []).find(x => x.id === a.targetId);
        /* 查不到区名就不画，不能落到第一个行政区 —— 那会把一条告警画在东营区，
           而它其实在哪没人知道。兜底可以降级为"显示不了"，不可以替换成另一个实体：
           前者用户看得见，后者用户看不见。 */
        const d = MOCK.DISTRICTS.find(x => x.name === a.district) || null;
        if (!t && !d) return;
        const lon = t ? t.lon : d.lon + 0.05, lat = t ? t.lat : d.lat + 0.03;
        const q = P(lon, lat);
        const col = a.level === '高' ? '#ff4d5e' : a.level === '中' ? '#ffb020' : '#3d8bff';
        const ph = (this.t % 70) / 70;
        c.beginPath(); c.arc(q[0], q[1], 5 + ph * 12, 0, 7);
        c.strokeStyle = col + Math.round((1 - ph) * 180).toString(16).padStart(2, '0'); c.lineWidth = 1.4; c.stroke();
        c.beginPath(); c.arc(q[0], q[1], 5, 0, 7); c.fillStyle = col; c.fill();
        c.fillStyle = '#fff'; c.font = 'bold 8px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText('!', q[0], q[1]);
        picks.push({
          x: q[0], y: q[1], kind: 'alarm', data: a,
          tip: `<b style="color:${col}">${a.type}</b><dl class="kv" style="margin-top:6px">
            <dt>目标</dt><dd>${a.targetId}</dd><dt>等级</dt><dd>${a.level}</dd>
            <dt>时间</dt><dd>${a.time.slice(11)}</dd><dt>状态</dt><dd>${a.status}</dd></dl>`
        });
      });
    }
    this._pickPts = picks;

    /* 比例尺 */
    const lat = this.unpx(W / 2, H / 2)[1];
    const metersPerPixel = 40075016.686 * Math.cos(lat * Math.PI / 180) / (512 * Math.pow(2, this._levelForScale(this.zoom)));
    const maxMeters = metersPerPixel * Math.min(100, W / 4);
    const unit = Math.pow(10, Math.floor(Math.log10(maxMeters)));
    const meters = [5, 2, 1].map(n => n * unit).find(n => n <= maxMeters) || unit;
    const el = this.box.querySelector('.mapscale');
    if (el) { el.querySelector('span').textContent = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`; el.querySelector('.bar').style.width = (meters / metersPerPixel).toFixed(0) + 'px'; }
  };

  g.MapView = MapView;
})(window);
