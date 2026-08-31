/* =============================================================================
 * map.js —— 高德在线矢量底图 + Canvas 业务态势叠加层（东营）
 * 业务坐标统一保持 WGS-84，仅在高德 API 边界转换为 GCJ-02。
 * 在线底图不可用时自动降级为内置简化矢量底图，不再读取离线瓦片。
 * ========================================================================== */
(function (g) {
  'use strict';
  /* 东营全域视图范围；业务叠加层与无网降级底图共用。 */
  const B = { lon0: 118.114, lon1: 119.308, lat0: 36.937, lat1: 38.156 };
  const CENTER = [(B.lon0 + B.lon1) / 2, (B.lat0 + B.lat1) / 2];
  let amapPromise = null;

  function configValue(v) {
    if (!v || /^%VITE_[A-Z0-9_]+%$/.test(v)) return '';
    return String(v).trim();
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const old = document.querySelector(`script[data-amap-loader="${src}"]`);
      if (old) {
        old.addEventListener('load', resolve, { once: true });
        old.addEventListener('error', () => reject(new Error('高德 Loader 加载失败')), { once: true });
        return;
      }
      const s = document.createElement('script');
      s.src = src; s.async = true; s.dataset.amapLoader = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('高德 Loader 加载失败'));
      document.head.appendChild(s);
    });
  }

  function loadAMap() {
    if (amapPromise) return amapPromise;
    const raw = g.__AMAP_CONFIG__ || {};
    const cfg = {
      key: configValue(raw.key),
      securityJsCode: configValue(raw.securityJsCode),
      serviceHost: configValue(raw.serviceHost)
    };
    amapPromise = Promise.resolve().then(() => {
      if (!cfg.key) throw new Error('未配置高德 Web 端 Key');
      if (cfg.serviceHost) {
        g._AMapSecurityConfig = { serviceHost: cfg.serviceHost.replace(/\/$/, '') };
      } else if (cfg.securityJsCode) {
        g._AMapSecurityConfig = { securityJsCode: cfg.securityJsCode };
      } else {
        throw new Error('未配置高德安全密钥或安全代理');
      }
      if (g.AMap) return g.AMap;
      if (g.AMapLoader) return g.AMapLoader;
      return loadScript('https://webapi.amap.com/loader.js').then(() => g.AMapLoader);
    }).then(loaderOrMap => {
      if (g.AMap) return g.AMap;
      if (!loaderOrMap || !loaderOrMap.load) throw new Error('高德 Loader 不可用');
      return loaderOrMap.load({ key: cfg.key, version: '2.0', plugins: [] });
    });
    return amapPromise;
  }

  /* 复用同一份 Web 端 Key、安全密钥和 Loader，供顶栏天气等高德服务插件使用。 */
  g.AMapReady = loadAMap;

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
    this.box = box; this.opt = opt;
    this.data = { airspaces: [], devices: [], targets: [], alarms: [] };
    this.layers = Object.assign({ device: true, track: true, nofly: true, suit: true, limit: true, alarm: true }, opt.layers);
    this.online = false; this.amap = null; this.AMap = null;
    this.zoom = opt.zoom || 1; this.ox = 0; this.oy = 0; this.t = 0; this.hover = null; this.sel = null;
    this._pendingCenter = CENTER.slice();
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
        <div class="mb" data-z="in" role="button" aria-label="放大">${g.UI.icon('zoomIn')}</div><div class="mb" data-z="out" role="button" aria-label="缩小">${g.UI.icon('zoomOut')}</div><div class="mb" data-z="fit" role="button" aria-label="复位">${g.UI.icon('expand')}</div>
      </div>
      ${legendHtml}
      <div class="maptip"></div>
      <div class="mapscale"><span></span><div class="bar"></div></div>
      <div class="mapstatus is-loading">在线底图加载中…</div>`;
    box.__map = this;          // 便于调试与外部程序化控制
    this.baseEl = box.querySelector('.mapbase');
    this.cv = box.querySelector('.mapoverlay');
    this.ctx = this.cv.getContext('2d');
    this.tip = box.querySelector('.maptip');
    this.statusEl = box.querySelector('.mapstatus');
    this._bind();
    this._resize();
    this._initAMap();
    this._loop();
  }

  MapView.prototype._initAMap = function () {
    loadAMap().then(AMap => {
      if (this._dead || !this.box.isConnected) return;
      this.AMap = AMap;
      const center = g.GEO.wgs84ToGcj02(this._pendingCenter[0], this._pendingCenter[1]);
      this.amap = new AMap.Map(this.baseEl, {
        viewMode: '2D',
        zoom: this._levelForScale(this.zoom),
        center,
        // 标准浅色地图保留道路、建筑、水系和 POI 的完整层级。
        mapStyle: 'amap://styles/normal',
        features: ['bg', 'road', 'building', 'point'],
        resizeEnable: true,
        rotateEnable: false,
        pitchEnable: false,
        jogEnable: false,
        showLabel: true
      });
      this.online = true;
      const redraw = () => this.draw();
      const syncZoom = () => {
        const level = this.amap && this.amap.getZoom ? this.amap.getZoom() : this._levelForScale(this.zoom);
        this.zoom = Math.max(1, Math.min(12, Math.pow(2, level - this._fitLevelForWidth())));
        this.draw();
      };
      this.amap.on('mapmove', redraw);
      this.amap.on('zoomchange', syncZoom);
      this.amap.on('resize', redraw);
      this.amap.on('complete', () => {
        if (this.statusEl) { this.statusEl.className = 'mapstatus'; this.statusEl.style.display = 'none'; }
        this.draw();
      });
      this.draw();
    }).catch(err => {
      if (this._dead) return;
      this.online = false;
      if (this.statusEl) {
        this.statusEl.className = 'mapstatus is-fallback';
        this.statusEl.textContent = '在线底图不可用，已切换简化地图';
        this.statusEl.title = err && err.message ? err.message : String(err);
      }
      this.draw();
      if (g.console && console.warn) console.warn('[MapView] 高德在线底图加载失败，使用简化地图：', err);
    });
  };

  MapView.prototype._bind = function () {
    const self = this;
    this._ro = new ResizeObserver(() => self._resize());
    this._ro.observe(this.box);
    this._boxClick = e => {
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
      if (e.target.closest && e.target.closest('.maplayers,.mapstatus')) return;
      if (self.hover && self.opt.onPick) self.opt.onPick(self.hover);
    };
    this._boxMove = e => {
      const r = self.cv.getBoundingClientRect();
      self.mx = e.clientX - r.left; self.my = e.clientY - r.top;
      self._hit();
    };
    this._boxLeave = () => {
      self.hover = null; self.tip.style.display = 'none';
      if (self.baseEl) self.baseEl.style.cursor = '';
    };
    this.box.addEventListener('click', this._boxClick, true);
    this.box.addEventListener('mousemove', this._boxMove, true);
    this.box.addEventListener('mouseleave', this._boxLeave);

    let drag = null;
    this._boxDown = e => {
      if (self.online || e.button !== 0 || (e.target.closest && e.target.closest('.mapctl,.maplegend,.maplayers'))) return;
      drag = { x: e.clientX, y: e.clientY, ox: self.ox, oy: self.oy };
    };
    this._boxWheel = e => {
      if (self.online) return;
      e.preventDefault();
      self.setZoom(self.zoom * (e.deltaY < 0 ? 1.18 : 0.85));
    };
    this.box.addEventListener('mousedown', this._boxDown, true);
    this.box.addEventListener('wheel', this._boxWheel, { passive: false, capture: true });
    this._winUp = () => drag = null;
    window.addEventListener('mouseup', this._winUp);
    this._winMove = e => {
      if (!drag || self.online) return;
      self.ox = drag.ox + (e.clientX - drag.x); self.oy = drag.oy + (e.clientY - drag.y);
      self.draw();
    };
    window.addEventListener('mousemove', this._winMove);
  };

  MapView.prototype._resize = function () {
    const r = this.box.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.cv.width = Math.max(1, Math.round(r.width * dpr));
    this.cv.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.amap && this.amap.resize) this.amap.resize();
    this.draw();
  };

  MapView.prototype._fitLevelForWidth = function () {
    if (!this.w || !g.GEO) return 10;
    let z = 10, best = Infinity;
    for (let t = 8; t <= 17; t++) {
      const spanPx = g.GEO.TILE * Math.pow(2, t) * ((B.lon1 - B.lon0) / 360);
      const diff = Math.abs(spanPx - this.w);
      if (diff < best) { best = diff; z = t; }
    }
    return z;
  };

  MapView.prototype._levelForScale = function (scale) {
    return Math.max(8, Math.min(18, this._fitLevelForWidth() + Math.log2(Math.max(1, scale))));
  };

  MapView.prototype._fallbackPx = function (lon, lat) {
    const sx = this.w / (B.lon1 - B.lon0), sy = this.h / (B.lat1 - B.lat0);
    const base = Math.min(sx, sy) * this.zoom;
    const kx = Math.min(sx * this.zoom / (base || 1), 1.7);
    const cx = this.w / 2 + this.ox, cy = this.h / 2 + this.oy;
    return [cx + (lon - CENTER[0]) * base * kx, cy - (lat - CENTER[1]) * base];
  };

  /* 业务层始终传 WGS-84；仅调用高德 API 时转换为 GCJ-02。 */
  MapView.prototype.px = function (lon, lat) {
    if (this.online && this.amap && this.AMap) {
      const gcj = g.GEO.wgs84ToGcj02(lon, lat);
      const p = this.amap.lngLatToContainer(new this.AMap.LngLat(gcj[0], gcj[1]));
      if (p) return [typeof p.getX === 'function' ? p.getX() : p.x, typeof p.getY === 'function' ? p.getY() : p.y];
    }
    return this._fallbackPx(lon, lat);
  };

  MapView.prototype.unpx = function (sx, sy) {
    if (this.online && this.amap && this.AMap) {
      const p = this.amap.containerToLngLat(new this.AMap.Pixel(sx, sy));
      if (p) return g.GEO.gcj02ToWgs84(p.getLng(), p.getLat());
    }
    const kx0 = this.w / (B.lon1 - B.lon0), ky0 = this.h / (B.lat1 - B.lat0);
    const base = Math.min(kx0, ky0) * this.zoom;
    const kx = Math.min(kx0 * this.zoom / (base || 1), 1.7);
    const cx = this.w / 2 + this.ox, cy = this.h / 2 + this.oy;
    return [(sx - cx) / (base * kx || 1) + CENTER[0], CENTER[1] - (sy - cy) / (base || 1)];
  };

  MapView.prototype.setZoom = function (z) {
    this.zoom = Math.max(1, Math.min(12, z));
    if (this.online && this.amap) this.amap.setZoom(this._levelForScale(this.zoom));
    this.draw();
    return this;
  };

  MapView.prototype.centerAt = function (lon, lat, options) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return this;
    options = options || {};
    if (Number.isFinite(options.scale)) this.setZoom(options.scale);
    this._pendingCenter = [lon, lat];
    if (this.online && this.amap) {
      this.amap.setCenter(g.GEO.wgs84ToGcj02(lon, lat));
    } else {
      const q = this._fallbackPx(lon, lat);
      this.ox += this.w / 2 - q[0]; this.oy += this.h / 2 - q[1];
    }
    this.draw();
    return this;
  };

  MapView.prototype.resetView = function (scale) {
    this.zoom = Math.max(1, Math.min(12, scale == null ? 1 : scale));
    this.ox = this.oy = 0;
    this._pendingCenter = CENTER.slice();
    if (this.online && this.amap) {
      this.amap.setZoom(this._levelForScale(this.zoom));
      this.amap.setCenter(g.GEO.wgs84ToGcj02(CENTER[0], CENTER[1]));
    }
    this.draw();
    return this;
  };

  MapView.prototype.setData = function (d) { Object.assign(this.data, d); this.draw(); return this; };
  MapView.prototype.setLayer = function (k, v) { this.layers[k] = v; this.draw(); return this; };
  MapView.prototype.destroy = function () {
    this._dead = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._ro) this._ro.disconnect();
    if (this._boxClick) this.box.removeEventListener('click', this._boxClick, true);
    if (this._boxMove) this.box.removeEventListener('mousemove', this._boxMove, true);
    if (this._boxLeave) this.box.removeEventListener('mouseleave', this._boxLeave);
    if (this._boxDown) this.box.removeEventListener('mousedown', this._boxDown, true);
    if (this._boxWheel) this.box.removeEventListener('wheel', this._boxWheel, true);
    if (this._winUp) window.removeEventListener('mouseup', this._winUp);
    if (this._winMove) window.removeEventListener('mousemove', this._winMove);
    if (this.amap) { try { this.amap.destroy(); } catch (e) { } this.amap = null; }
    if (this.box && this.box.__map === this) delete this.box.__map;
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
      if (self._dead || !self.box.isConnected) return;
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

    /* 在线时底图由下层高德容器渲染；Canvas 只画业务叠加层。 */
    if (this.online && this.amap) { this._drawOverlays(c, W, H); return; }

    /* 无网/无 Key 降级底图：保持业务可操作，但不读取任何离线瓦片。 */
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
        for (let x = bb[0] - (bb[3] - bb[1]); x < bb[2]; x += 15) { c.beginPath(); c.moveTo(x, bb[1]); c.lineTo(x + (bb[3] - bb[1]), bb[3]); c.stroke(); }
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
    const s0 = this.px(118.5, 37.5), s1 = this.px(118.5 + 0.1, 37.5);
    const pxPer10km = Math.abs(s1[0] - s0[0]);
    const el = this.box.querySelector('.mapscale');
    if (el) { el.querySelector('span').textContent = '≈ 8.9 km'; el.querySelector('.bar').style.width = pxPer10km.toFixed(0) + 'px'; }
  };

  g.MapView = MapView;
})(window);
