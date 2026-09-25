/* =============================================================================
 * map.js —— 本地 PMTiles 矢量底图 + Canvas 业务态势叠加层（东营）
 * 两种模式统一 WGS-84 / Web Mercator；失败仅降级内置示意图。
 * ========================================================================== */
(function (g) {
  'use strict';
  const html = value => String(value == null ? '—' : value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
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
    this.data = { airspaces: [], devices: [], targets: [], alarms: [], flightPlans: [], risks: [] };
    this.layers = Object.assign({ coverage: true, device: true, track: true, flightPlan: true, nofly: true, suit: true, limit: true, alarm: true }, opt.layers);
    this.online = false; this.map = null;
    this.maxZoom = Number.isFinite(opt.maxZoom) ? Math.max(12, Math.min(24, Number(opt.maxZoom))) : 18;
    this.zoom = opt.zoom || 1; this.ox = 0; this.oy = 0; this.t = 0; this.hover = null; this.sel = null; this.planSel = null;
    this._pendingCenter = CENTER.slice();
    this._activeCityCode = '370500';
    this._activeCityName = '东营市';
    this._clearBusinessOverlays = false;
    this._isDefaultView = true;
    this._defaultScale = this.zoom;
    box.classList.add('mapwrap');
    /* 图例默认折叠成「图例」小条（评审：1280 宽下图例遮挡地图过多），点标题展开。
       opt.legendOpen:true 可保持展开。文案用业务语言，技术编号（A03/A04）移入 title。 */
    const legendHtml = opt.legend === false ? '' : `<div class="maplegend${opt.legendOpen ? '' : ' collapsed'}">
        <div class="lg-hd" role="button" tabindex="0" aria-label="展开或收起图例">图例 <span class="lg-arrow">${opt.legendOpen ? '▾' : '▸'}</span></div>
        <div class="li"><span class="sw" style="border-color:#2fd06e"></span>符合航线的已飞轨迹</div>
        <div class="li"><span class="sw" style="border-color:#ff4d5e"></span>偏离航线的已飞轨迹</div>
        <div class="li"><span class="sw" style="border-color:#8ca0a8;border-top-style:dashed"></span>计划航线（未飞部分灰色）</div>
        <div class="li"><span class="sw" style="border-color:#ffb020"></span>航线关系未知</div>
        <div class="li" title="弥合段（A03）"><span class="sw" style="border-color:#ff8b3d;border-top-style:dotted"></span>推算补全段</div>
        <div class="li" title="预测段（A04）"><span class="sw" style="border-color:#22d3ee;border-top-style:dotted"></span>预测延伸段</div>
        <div class="li"><span style="width:14px;text-align:center;color:#22d3ee">●</span>设备点位</div>
        <div data-legend-airspaces></div>
      </div>`;
    box.innerHTML = `<div class="mapbase"></div><canvas class="mapoverlay"></canvas>
      <div class="mapctl">
        <button type="button" class="mb" data-z="in" aria-label="放大">${g.UI.icon('zoomIn')}</button><button type="button" class="mb" data-z="out" aria-label="缩小">${g.UI.icon('zoomOut')}</button><button type="button" class="mb" data-z="fit" aria-label="复位">${g.UI.icon('expand')}</button>
      </div>
      <button type="button" class="mb map-refocus" data-z="refocus" title="回到本页数据所在的位置">${g.UI.icon('location')} 重新定位</button>
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
    if (opt.interactiveTip) {
      this.tip.classList.add('is-interactive');
      this.tip.setAttribute('role', 'dialog');
      this.tip.setAttribute('aria-label', '目标详情');
    }
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

  MapView.prototype._isTransientMapError = function (error) {
    if (!error) return true;
    if (error.name === 'AbortError' || error.code === 20) return true;
    const status = Number(error.status);
    if (status === 404 || status === 204 || status === 416) return true;
    const message = String(error.message || error);
    return /abort|AbortError|The user aborted|cancelled|canceled/i.test(message);
  };

  MapView.prototype._disposeBase = function () {
    clearTimeout(this._loadTimer);
    clearTimeout(this._failureTimer);
    clearTimeout(this._glLostTimer);
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
      this._applyRuntimePolicy(runtime.runtime || {});
      // 构造后立刻 fitTo 时覆盖范围还是内置东营框；包头真正的 bounds 更宽。
      // 航线若落在框外、包内，必须在建引擎前按真实覆盖重算，否则 load 只会跳到被夹紧的空视野。
      if (this._focus && this._focus.kind === 'fit') this.fitTo(this._focus.coordinates, this._focus.padding);
      else this._applyDefaultView();
      const coverage = this._coverageBounds;
      if (this.opt.outsideColor) {
        const background = (runtime.style.layers || []).find(layer => layer.type === 'background');
        if (background) {
          background.paint = Object.assign({}, background.paint, { 'background-color': this.opt.outsideColor });
        }
      }
      const map = new runtime.maplibre.Map({
        container: this.baseEl, style: runtime.style, center: this._pendingCenter,
        zoom: this._levelForScale(this.zoom), minZoom: this._minLevel(), maxZoom: this.maxZoom,
        /* 地图包只覆盖有限区域。始终约束相机并以“覆盖视口”计算最低缩放，
           宁可裁掉少量边缘，也不能让任何业务页面露出包外空白。 */
        maxBounds: coverage ? [[coverage[0], coverage[1]], [coverage[2], coverage[3]]] : undefined,
        bearing: 0, pitch: 0, dragRotate: false, pitchWithRotate: false,
        touchPitch: false, renderWorldCopies: false, attributionControl: false,
        // 汉字优先由浏览器本地字体栅格化，避免首屏重复下载 8 MiB 的 SC 字体文件。
        // 拉丁字符仍继续使用地图包内 PBF 字形，离线部署不会产生外网请求。
        localIdeographFontFamily: 'Microsoft YaHei, PingFang SC, sans-serif', fadeDuration: 0,
        transformRequest: runtime.transformRequest
      });
      this.map = map;
      // 主题在运行时生成地块纹理图片；必须在样式加载完成前挂上 styleimagemissing。
      if (typeof runtime.decorate === 'function') runtime.decorate(map);
      this._applyCameraLimits();
      map.touchZoomRotate.disableRotation();
      map.addControl(new runtime.maplibre.AttributionControl({ compact: false }), 'bottom-left');
      const on = (name, fn) => { map.on(name, fn); this._mapEvents.push([name, fn]); };
      on('movestart', event => { if (event.originalEvent) this._isDefaultView = false; });
      on('move', () => { this._syncView(); this.draw(); this._hit(); });
      on('render', () => { this.draw(); });
      on('dragstart', () => { this._dragged = true; this._boxLeave(); });
      // 非展示用：拖拽结束后 250ms 内抑制误点击，必须用墙钟而非 M.now()
      on('dragend', () => { this._suppressClickUntil = Date.now() + 250; this._dragged = false; });
      on('webglcontextlost', () => {
        // 浏览器通常会立刻恢复上下文；等几秒再降级，避免一次丢上下文就把底图拆掉。
        clearTimeout(this._glLostTimer);
        this._glLostTimer = setTimeout(() => {
          if (!this._dead && this.map === map) this._fallback(new Error('WebGL 上下文丢失，可尝试重试'));
        }, 3000);
      });
      on('webglcontextrestored', () => clearTimeout(this._glLostTimer));
      on('error', event => {
        // 缩放会取消上一档瓦片请求，汉字标注还会去拉空的官方 PBF 字形——这些都是单块资源失败。
        // 地图已经出来之后不能因此拆掉整张底图；只有首屏还没 load 的致命错误才降级示意图。
        const error = event.error || new Error('离线资源读取失败');
        if (this._dead || this.map !== map) return;
        if (this._isTransientMapError(error) || this.online) return;
        clearTimeout(this._failureTimer);
        this._failureTimer = setTimeout(() => {
          if (!this._dead && this.map === map && !this.online) this._fallback(error);
        }, 0);
      });
      on('load', () => {
        clearTimeout(this._loadTimer);
        this.online = true;
        this._applyCameraLimits();
        map.resize();
        if (this._pendingFit && this.w > 0 && this.h > 0) {
          const f = this._pendingFit; this._pendingFit = null;
          this.fitTo(f.coordinates, f.padding);
        } else if (this._focus && this._focus.kind === 'fit') {
          this.fitTo(this._focus.coordinates, this._focus.padding);
        } else if (!this._isDefaultView) {
          map.jumpTo({ center: this._pendingCenter, zoom: this._levelForScale(this.zoom) });
        }
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
        else self.refocus();
        return;
      }
      if (e.target.closest && e.target.closest('.maplayers,.mapstatus,.maplibregl-control-container,.maptip')) return;
      // 非展示用：对照墙钟判断拖拽后的误点击抑制窗口
      if (self._dragged || Date.now() < (self._suppressClickUntil || 0)) return;
      self._boxMove(e);
      if (self.hover && self.opt.onPick) self.opt.onPick(self.hover);
      else if (!self.hover && typeof self.opt.onEmptyPick === 'function') self.opt.onEmptyPick();
    };
    this._boxMove = e => {
      if (e.target.closest && e.target.closest('.maptip')) {
        self._tipHovering = true;
        return;
      }
      self._tipHovering = false;
      const r = self.cv.getBoundingClientRect();
      self.mx = e.clientX - r.left; self.my = e.clientY - r.top;
      if (!self._dragged) self._hit();
    };
    this._boxLeave = () => {
      self.mx = self.my = NaN;
      self.hover = null;
      self._tipHovering = false;
      if (self.baseEl) self.baseEl.style.cursor = '';
      if (self._pinnedKey || self.opt.pinSelTip) self._hit();
      else self._hideTip(true);
    };
    this.box.addEventListener('click', this._boxClick, true);
    this.box.addEventListener('mousemove', this._boxMove, true);
    this.box.addEventListener('mouseleave', this._boxLeave);
    this._boxKey = e => {
      if (e.target.matches('.lg-hd') && ['Enter', ' '].includes(e.key)) { e.preventDefault(); e.target.click(); }
    };
    this.box.addEventListener('keydown', this._boxKey);

    this._tipClick = e => {
      e.stopPropagation();
      const btn = e.target.closest('[data-tip-act]');
      if (!btn || typeof self.opt.onTipAction !== 'function') return;
      const hit = (self._pickPts || []).find(p => self._tipKey(p) === self._tipKeyShown) || self.hover;
      self.opt.onTipAction(btn.dataset.tipAct, hit);
    };
    this._tipEnter = () => {
      self._tipHovering = true;
      clearTimeout(self._tipHideTimer);
      self._tipHideTimer = null;
    };
    this._tipLeave = () => {
      self._tipHovering = false;
      self._hit();
    };
    this.tip.addEventListener('click', this._tipClick);
    this.tip.addEventListener('mouseenter', this._tipEnter);
    this.tip.addEventListener('mouseleave', this._tipLeave);

    let drag = null;
    this._boxDown = e => {
      self._dragged = false;
      if (e.button !== 0 || (e.target.closest && e.target.closest('.mapctl,.maplegend,.maplayers,.mapstatus,.maplibregl-control-container,.maptip'))) return;
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
      self._pendingCenter = self._clampCenter(self._pendingCenter[0], self._pendingCenter[1], self._levelForScale(self.zoom));
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
      self._pendingCenter = self._clampCenter(self._pendingCenter[0], self._pendingCenter[1], self._levelForScale(self.zoom));
      self._boxLeave();
      self.draw();
    };
    window.addEventListener('mousemove', this._winMove);
    this._runtimeChange = event => {
      if (self._dead) return;
      self._applyRuntimePolicy({
        cityCode: event.detail?.city_code,
        cityName: event.detail?.city_name,
        clearBusinessOverlays: Boolean(event.detail?.clear_business_overlays)
      });
      self._coverageBounds = null;
      self._focus = null;
      self.resetView();
      self._initOffline();
    };
    window.addEventListener('offline-map:change', this._runtimeChange);
  };

  MapView.prototype._applyRuntimePolicy = function (runtime) {
    const wasHidden = this._clearBusinessOverlays;
    const shouldHide = Boolean(runtime.clearBusinessOverlays);
    this._activeCityCode = runtime.cityCode || this._activeCityCode || '370500';
    this._activeCityName = runtime.cityName || this._activeCityName || '东营市';
    this._clearBusinessOverlays = shouldHide;
    if (shouldHide && !wasHidden) {
      this._heldBusinessData = this.data;
      this.data = { airspaces: [], devices: [], targets: [], alarms: [] };
      this.sel = this.hover = null;
      this._pinnedKey = '';
      this._hideTip(true);
      this._paintAirspaceLegend();
    } else if (!shouldHide && wasHidden) {
      this.data = this._heldBusinessData || { airspaces: [], devices: [], targets: [], alarms: [] };
      this._heldBusinessData = null;
      this._paintAirspaceLegend();
    }
  };

  MapView.prototype._resize = function () {
    if (this._dead) return;
    const r = this.box.getBoundingClientRect();
    const maxDpr = Number.isFinite(Number(this.opt.maxDpr)) ? Math.max(1, Number(this.opt.maxDpr)) : Infinity;
    const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
    this.w = r.width; this.h = r.height;
    this.cv.width = Math.max(1, Math.round(r.width * dpr));
    this.cv.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._applyDefaultView();
    if (this.map) {
      this.map.resize();
      this._applyCameraLimits();
    }
    if (this._pendingFit && this.w > 0 && this.h > 0) {
      const f = this._pendingFit; this._pendingFit = null;
      this.fitTo(f.coordinates, f.padding);
      return;
    }
    if (this.map) {
      const zoom = this._levelForScale(this.zoom);
      this._pendingCenter = this._clampCenter(this._pendingCenter[0], this._pendingCenter[1], zoom);
      this.zoom = Math.pow(2, zoom - this._fitLevelForWidth());
      this.map.jumpTo({ zoom, center: this._pendingCenter });
    }
    this.draw();
  };

  MapView.prototype._fitLevelForWidth = function () {
    const [west, south, east, north] = this._viewBounds();
    const a = merc(west, north), b = merc(east, south);
    return Math.log2(Math.min(Math.max(1, this.w - 40) / (b[0] - a[0]), Math.max(1, this.h - 40) / (b[1] - a[1])) / 512);
  };

  MapView.prototype._viewBounds = function () {
    return this._coverageBounds || [B.lon0, B.lat0, B.lon1, B.lat1];
  };

  // 视口必须被数据覆盖：取较长边撑满，并多算 8px，避免边缘露底。
  MapView.prototype._minLevel = function () {
    if (this.w <= 0 || this.h <= 0) return Math.min(7, this._fitLevelForWidth());
    const [west, south, east, north] = this._viewBounds();
    const a = merc(west, north), b = merc(east, south);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (dx <= 0 || dy <= 0) return Math.min(7, this._fitLevelForWidth());
    return Math.min(18, Math.log2(Math.max((this.w + 8) / dx, (this.h + 8) / dy) / 512));
  };

  MapView.prototype._clampCenter = function (lon, lat, level) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || this.w <= 0 || this.h <= 0) return [lon, lat];
    const [west, south, east, north] = this._viewBounds();
    const a = merc(west, north), b = merc(east, south);
    const size = 512 * Math.pow(2, level);
    const hx = this.w / (2 * size), hy = this.h / (2 * size);
    const c = merc(lon, lat);
    const minX = a[0] + hx, maxX = b[0] - hx;
    const minY = a[1] + hy, maxY = b[1] - hy;
    c[0] = minX < maxX ? Math.max(minX, Math.min(maxX, c[0])) : (a[0] + b[0]) / 2;
    c[1] = minY < maxY ? Math.max(minY, Math.min(maxY, c[1])) : (a[1] + b[1]) / 2;
    return geographic(c[0], c[1]);
  };

  MapView.prototype._applyCameraLimits = function () {
    if (!this.map) return;
    this.map.setMinZoom(this._minLevel());
    this.map.setMaxZoom(this.maxZoom);
  };

  // 首屏与复位落到数据范围内；缩小/平移也不能超出覆盖范围。
  MapView.prototype._applyDefaultView = function () {
    if (!this._isDefaultView) return;
    const bounds = this._viewBounds();
    const center = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
    const level = this._levelForScale(this._defaultScale);
    this._pendingCenter = this._clampCenter(center[0], center[1], level);
    this.zoom = Math.pow(2, level - this._fitLevelForWidth());
  };

  MapView.prototype._levelForScale = function (scale) {
    const fit = this._fitLevelForWidth();
    return Math.max(this._minLevel(), Math.min(this.maxZoom, fit + Math.log2(Math.max(.01, Number(scale) || 1))));
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
    const level = this._levelForScale(z);
    this.zoom = Math.pow(2, level - this._fitLevelForWidth());
    this._pendingCenter = this._clampCenter(this._pendingCenter[0], this._pendingCenter[1], level);
    if (this.map) this.map.setZoom(level);
    this.draw();
    return this;
  };

  /* 把视口对准一组 [lon, lat] 点：缩放到这些点占视口的 (1 - 2*padding)，中心取包围盒中心。
     容器尚无尺寸时记下来，等首次 _resize 再套用；级别仍受覆盖范围的最小级别约束。 */
  MapView.prototype.fitTo = function (coordinates, padding) {
    const pts = (coordinates || []).filter(p => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]));
    if (!pts.length) return this;
    padding = Number.isFinite(padding) ? padding : 0.25;
    this._focus = { kind: 'fit', coordinates: pts, padding };
    if (this.w <= 0 || this.h <= 0) { this._pendingFit = { coordinates: pts, padding }; return this; }
    const xs = pts.map(p => merc(p[0], p[1]));
    const minX = Math.min(...xs.map(p => p[0])), maxX = Math.max(...xs.map(p => p[0]));
    const minY = Math.min(...xs.map(p => p[1])), maxY = Math.max(...xs.map(p => p[1]));
    const usableW = Math.max(1, this.w * (1 - 2 * padding)), usableH = Math.max(1, this.h * (1 - 2 * padding));
    const dx = Math.max(maxX - minX, 1e-7), dy = Math.max(maxY - minY, 1e-7);
    let level = Math.log2(Math.min(usableW / dx, usableH / dy) / 512);
    level = Math.max(this._minLevel(), Math.min(this.maxZoom, level));
    this._isDefaultView = false;
    this.zoom = Math.pow(2, level - this._fitLevelForWidth());
    const center = geographic((minX + maxX) / 2, (minY + maxY) / 2);
    this._pendingCenter = this._clampCenter(center[0], center[1], level);
    if (this.map) this.map.jumpTo({ center: this._pendingCenter, zoom: level });
    this.draw();
    return this;
  };

  MapView.prototype.centerAt = function (lon, lat, options) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return this;
    options = options || {};
    this._isDefaultView = false;
    if (Number.isFinite(options.scale)) this.setZoom(options.scale);
    const offset = Array.isArray(options.offset) ? options.offset : [0, 0];
    if (!options._replay) this._focus = { kind: 'center', lon, lat, scale: this.zoom, offset };
    const level = this._levelForScale(this.zoom);
    const point = merc(lon, lat), size = 512 * Math.pow(2, level);
    const center = geographic(point[0] - offset[0] / size, point[1] - offset[1] / size);
    this._pendingCenter = this._clampCenter(center[0], center[1], level);
    if (this.map) this.map.setCenter(this._pendingCenter);
    this.draw();
    return this;
  };

  /* 「重新定位」：回到本页数据所在的位置——上一次 fitTo 的包围盒或 centerAt 的中心；没有数据焦点时回默认视图。 */
  MapView.prototype.refocus = function () {
    const focus = this._focus;
    if (!focus) return this.resetView();
    if (focus.kind === 'fit') return this.fitTo(focus.coordinates, focus.padding);
    return this.centerAt(focus.lon, focus.lat, { scale: focus.scale, offset: focus.offset, _replay: true });
  };
  MapView.prototype.resetView = function (scale) {
    this.ox = this.oy = 0;
    this._isDefaultView = true;
    this._defaultScale = scale == null ? 1 : scale;
    const bounds = this._viewBounds();
    this._pendingCenter = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
    this._applyDefaultView();
    if (this.map) this.map.jumpTo({ center: this._pendingCenter, zoom: this._levelForScale(this.zoom) });
    this.draw();
    return this;
  };

  /* 已经告警过的空域 id：draw() 逐帧执行，不去重会把控制台刷满。 */
  const warnedMissingLayer = new Set();


  MapView.prototype.setData = function (d) {
    if (this._clearBusinessOverlays) {
      this._heldBusinessData = Object.assign(this._heldBusinessData || { airspaces: [], devices: [], targets: [], alarms: [], flightPlans: [], risks: [] }, d);
      return this;
    }
    Object.assign(this.data, d); this._paintAirspaceLegend(); this.draw(); return this;
  };
  /* 图例里的空域行由**当前数据**推导（阶段 12 去 mock.js）：图上画了哪几类就列哪几类，
     没有空域就整行不显示——留一个空条目比不显示更糟，那会让人以为图例坏了。 */
  MapView.prototype._paintAirspaceLegend = function () {
    const slot = this.box && this.box.querySelector('[data-legend-airspaces]');
    if (!slot) return;
    const seen = new Map();
    (this.data.airspaces || []).forEach(a => { if (a && a.type && !seen.has(a.type)) seen.set(a.type, a.color); });
    slot.innerHTML = [...seen].map(([type, color]) =>
      `<div class="li"><span class="sw" style="border-color:${color}"></span>${type}</div>`).join('');
    slot.style.display = seen.size ? '' : 'none';
  };
  MapView.prototype.setLayer = function (k, v) { this.layers[k] = v; this.draw(); return this; };
  /* 融合感知页可从 Canvas 外的等价键盘入口固定设备或目标气泡。 */
  MapView.prototype.pinHit = function (kind, id) {
    this._pinnedKey = kind && id ? kind + ':' + id : '';
    this.mx = this.my = NaN;
    this._hit();
    return this;
  };
  MapView.prototype.clearPinnedHit = function () {
    this._pinnedKey = '';
    this._tipHovering = false;
    this._hideTip(true);
    return this;
  };
  MapView.prototype.setPaused = function (paused) {
    this._paused = !!paused;
    if (this._paused && this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    } else if (!this._paused) {
      this._loop();
      this.draw();
    }
    return this;
  };
  /* 米→像素：用当前纬度上 1° 经度的像素长度换算，粗略但足够画精度圈；不用于任何判定。 */
  MapView.prototype._metersToPx = function (meters, lat) {
    const a = this.px(0, lat), b = this.px(1, lat);
    const pxPerDegLon = Math.abs(b[0] - a[0]);
    const metersPerDegLon = 111320 * Math.cos((Number(lat) || 0) * Math.PI / 180);
    return metersPerDegLon > 0 ? meters / metersPerDegLon * pxPerDegLon : 0;
  };
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
    if (this._runtimeChange) window.removeEventListener('offline-map:change', this._runtimeChange);
    if (this._boxKey) this.box.removeEventListener('keydown', this._boxKey);
    clearTimeout(this._tipHideTimer);
    if (this.tip) {
      if (this._tipClick) this.tip.removeEventListener('click', this._tipClick);
      if (this._tipEnter) this.tip.removeEventListener('mouseenter', this._tipEnter);
      if (this._tipLeave) this.tip.removeEventListener('mouseleave', this._tipLeave);
    }
    if (this.box && this.box.__map === this) { delete this.box.__map; this.box.replaceChildren(); delete this.box.dataset.mapState; }
  };

  MapView.prototype._tipKey = function (hit) {
    if (!hit) return '';
    const id = hit.data && (hit.data.id || hit.data.name);
    return hit.kind + ':' + (id || '');
  };

  MapView.prototype._placeTip = function (x, y) {
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight, gap = 14;
    let left = x + gap, side = 'right';
    let top = y - th / 2;
    if (left + tw > this.w - 8) { left = x - tw - gap; side = 'left'; }
    this.tip.style.left = Math.min(this.w - tw - 8, Math.max(8, left)) + 'px';
    this.tip.style.top = Math.min(this.h - th - 8, Math.max(8, top)) + 'px';
    this.tip.dataset.side = side;
  };

  MapView.prototype._hideTip = function (immediate) {
    const hide = () => {
      if (this._dead || this._tipHovering) return;
      this.tip.style.display = 'none';
      this._tipKeyShown = '';
      this._tipDataShown = null;
      this._tipAt = null;
    };
    if (immediate) {
      clearTimeout(this._tipHideTimer);
      this._tipHideTimer = null;
      hide();
      return;
    }
    if (this.opt.interactiveTip) {
      if (!this._tipHideTimer) {
        this._tipHideTimer = setTimeout(() => {
          this._tipHideTimer = null;
          hide();
        }, 180);
      }
      return;
    }
    hide();
  };

  MapView.prototype._showTip = function (hit) {
    const key = this._tipKey(hit);
    if (this.opt.interactiveTip) this.tip.setAttribute('aria-label', hit.kind === 'device' ? '设备详情' : hit.kind === 'target' ? '目标详情' : hit.kind === 'plan' ? '计划详情' : '地图详情');
    if (this._tipKeyShown !== key || this._tipDataShown !== hit.data) {
      this._tipKeyShown = key;
      this._tipDataShown = hit.data;
      this._tipAt = null;
      let html = hit.tip;
      if (typeof this.opt.renderTip === 'function') {
        const custom = this.opt.renderTip(hit);
        if (custom != null) html = custom;
      }
      this.tip.innerHTML = html;
      this.tip.classList.toggle('is-track', hit.kind === 'target' && typeof this.opt.renderTip === 'function');
      this.tip.classList.toggle('is-device', hit.kind === 'device' && typeof this.opt.renderTip === 'function');
      this.tip.classList.toggle('is-plan', hit.kind === 'plan' && typeof this.opt.renderTip === 'function');
    }
    this.tip.style.display = 'block';
    if (this._tipAt && Math.abs(this._tipAt[0] - hit.x) < 0.5 && Math.abs(this._tipAt[1] - hit.y) < 0.5) return;
    this._tipAt = [hit.x, hit.y];
    this._placeTip(hit.x, hit.y);
  };

  MapView.prototype._hit = function () {
    if (this._dead || !this.tip) return;
    const pts = this._pickPts || [];
    let best = null;
    if (this._tipHovering && this._tipKeyShown) {
      best = pts.find(p => this._tipKey(p) === this._tipKeyShown) || null;
    } else if (Number.isFinite(this.mx) && Number.isFinite(this.my)) {
      let bd = 14;
      for (const p of pts) {
        const d = p.segments ? p.segments.reduce((nearest, segment) => {
          const ax = segment[0][0], ay = segment[0][1], bx = segment[1][0], by = segment[1][1];
          const dx = bx - ax, dy = by - ay;
          const lengthSquared = dx * dx + dy * dy;
          const ratio = lengthSquared ? Math.max(0, Math.min(1, ((this.mx - ax) * dx + (this.my - ay) * dy) / lengthSquared)) : 0;
          return Math.min(nearest, Math.hypot(this.mx - (ax + dx * ratio), this.my - (ay + dy * ratio)));
        }, Infinity) : Math.hypot(p.x - this.mx, p.y - this.my);
        if (d < bd) { bd = d; best = p; }
      }
    }
    this.hover = (this._tipHovering && best) ? best
      : (Number.isFinite(this.mx) && Number.isFinite(this.my) ? best : null);

    let shown = this.hover;
    if (!shown && this._pinnedKey) {
      shown = pts.find(p => this._tipKey(p) === this._pinnedKey) || null;
    }
    if (!shown && this.opt.pinSelTip && this.sel) {
      shown = pts.find(p => p.kind === 'target' && p.data && p.data.id === this.sel) || null;
    }

    if (shown) {
      clearTimeout(this._tipHideTimer);
      this._tipHideTimer = null;
      this._showTip(shown);
      if (this.baseEl) this.baseEl.style.cursor = this.hover ? 'pointer' : '';
    } else {
      this._hideTip(!this.opt.interactiveTip);
      if (this.baseEl) this.baseEl.style.cursor = '';
    }
  };

  MapView.prototype._loop = function () {
    if (this._raf || this._dead || this._paused) return;
    const self = this;
    const f = function () {
      self._raf = null;
      if (self._dead || self._paused) return;
      if (!self.box.isConnected) { self.destroy(); return; }
      self.t += 1;
      self.draw();
      self._raf = requestAnimationFrame(f);
    };
    this._raf = requestAnimationFrame(f);
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

  MapView.prototype._still = function () {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  };

  MapView.prototype._phase = function (period) {
    return this._still() ? 0 : (this.t % period) / period;
  };

  MapView.prototype._targetAnchor = function (target) {
    if (Number.isFinite(target?.lon) && Number.isFinite(target?.lat)) {
      return { lon: Number(target.lon), lat: Number(target.lat) };
    }
    const track = target && target.track || [];
    return track.length ? track[track.length - 1] : null;
  };

  const SENSOR_COLORS = { RADAR: '#2dcfd0', EO: '#8e7dff', FIVE_G_A: '#4b9cff', TDOA: '#f1a43a' };

  MapView.prototype._sensorColor = function (device) {
    return device.color || SENSOR_COLORS[device.typeCode] || '#2dcfd0';
  };

  MapView.prototype._drawDeviceCoverage = function (c, device, P) {
    const coverage = device.coverage || {};
    if (coverage.status === 'unknown') return;
    const radiusM = coverage.kind === 'sector' ? Number(coverage.rangeM) : Number(coverage.radiusM);
    if (!Number.isFinite(radiusM) || radiusM <= 0) return;
    const origin = P(device.lon, device.lat);
    const radius = this._metersToPx(radiusM, device.lat);
    if (!Number.isFinite(radius) || radius <= 0) return;
    const unavailable = coverage.status === 'unavailable' || device.status !== '在线';
    const abnormal = device.statusCode === 'ABNORMAL' || device.status === '异常';
    const color = unavailable ? (abnormal ? '#f1a43a' : '#94a3b8') : this._sensorColor(device);
    const start = coverage.kind === 'sector' ? (Number(coverage.azimuthDeg) - Number(coverage.fovDeg) / 2 - 90) * Math.PI / 180 : 0;
    const end = coverage.kind === 'sector' ? (Number(coverage.azimuthDeg) + Number(coverage.fovDeg) / 2 - 90) * Math.PI / 180 : Math.PI * 2;
    c.save();
    c.beginPath();
    if (coverage.kind === 'sector') { c.moveTo(origin[0], origin[1]); c.arc(origin[0], origin[1], radius, start, end); c.closePath(); }
    else c.arc(origin[0], origin[1], radius, 0, Math.PI * 2);
    c.fillStyle = unavailable ? (abnormal ? 'rgba(241,164,58,.045)' : 'rgba(100,116,139,.055)') : color + '12';
    c.fill();
    c.setLineDash(unavailable ? [8, 7] : [4, 5]);
    c.lineDashOffset = unavailable || this._still() ? 0 : -(this.t * .18) % 9;
    c.strokeStyle = unavailable ? (abnormal ? 'rgba(241,164,58,.72)' : 'rgba(148,163,184,.72)') : color + '9c';
    c.lineWidth = unavailable ? 1.35 : 1.15; c.stroke(); c.setLineDash([]);

    if (!unavailable && !this._still()) {
      if (device.typeCode === 'RADAR') {
        const angle = this._phase(180) * Math.PI * 2 - Math.PI / 2;
        const gradient = c.createRadialGradient(origin[0], origin[1], 0, origin[0], origin[1], radius);
        gradient.addColorStop(0, color + '3d'); gradient.addColorStop(1, color + '02');
        c.beginPath(); c.moveTo(origin[0], origin[1]); c.arc(origin[0], origin[1], radius, angle - .32, angle); c.closePath();
        c.fillStyle = gradient; c.fill();
        c.beginPath(); c.moveTo(origin[0], origin[1]); c.lineTo(origin[0] + Math.cos(angle) * radius, origin[1] + Math.sin(angle) * radius);
        c.strokeStyle = color + 'b8'; c.lineWidth = 1.3; c.stroke();
      } else if (device.typeCode === 'EO') {
        const sweep = start + (end - start) * (.08 + .84 * (Math.sin(this.t / 34) + 1) / 2);
        c.beginPath(); c.moveTo(origin[0], origin[1]); c.lineTo(origin[0] + Math.cos(sweep) * radius, origin[1] + Math.sin(sweep) * radius);
        c.strokeStyle = color + 'c4'; c.lineWidth = 1.5; c.stroke();
      } else if (device.typeCode === 'FIVE_G_A') {
        for (let i = 0; i < 3; i++) {
          const wave = (this._phase(120) + i / 3) % 1;
          c.beginPath(); c.arc(origin[0], origin[1], Math.max(8, radius * wave), 0, Math.PI * 2);
          c.strokeStyle = color + Math.round((1 - wave) * 92).toString(16).padStart(2, '0'); c.lineWidth = 1.2; c.stroke();
        }
      } else if (device.typeCode === 'TDOA') {
        for (let i = 0; i < 3; i++) {
          const wave = (this._phase(150) + i / 3) % 1;
          c.beginPath(); c.arc(origin[0], origin[1], Math.max(7, radius * wave), 0, Math.PI * 2);
          c.strokeStyle = color + Math.round((1 - wave) * 84).toString(16).padStart(2, '0'); c.lineWidth = 1; c.stroke();
        }
      }
    }
    c.restore();
  };

  // 类型始终由彩色主体表达；状态角标不覆盖主体，历史记录不闪烁。
  let markerColors;
  function markerPalette() {
    if (!markerColors) { const css = getComputedStyle(document.documentElement); const token = name => css.getPropertyValue('--' + name).trim();
      markerColors = { online:token('green'), offline:token('gray'), fault:token('red'), stale:token('amber'), unknown:token('purple'), history:token('amber'), selected:token('blue'), alarm:token('icon-alarm') }; }
    return markerColors;
  }
  // 固定像素、沿图形透明轮廓的报警红光，不代表探测或风险范围。
  function applyAlarmGlow(c, item) {
    g.UI.applyAlarmGlow(c, item);
  }
  function drawMarkerState(c, state, x, y) {
    c.save(); c.translate(x,y); c.scale(.8,.8); c.lineWidth = 2; c.lineCap = 'round'; c.lineJoin = 'round';
    const colors = markerPalette();
    c.strokeStyle = colors[state] || colors.unknown;
    c.beginPath();
    if (state === 'online') { c.moveTo(-4,0); c.lineTo(-1,3); c.lineTo(5,-4); }
    else if (state === 'offline') { c.moveTo(-3,-3); c.lineTo(3,3); c.moveTo(3,-3); c.lineTo(-3,3); }
    else if (state === 'fault') { c.moveTo(0,-5); c.lineTo(5,4); c.lineTo(-5,4); c.closePath(); c.moveTo(0,-1); c.lineTo(0,1); }
    else if (state === 'stale' || state === 'history') { c.arc(0,0,4,0,Math.PI*2); c.moveTo(0,-2); c.lineTo(0,0); c.lineTo(2,1); }
    else { c.moveTo(-3,-3); c.bezierCurveTo(-3,-7,5,-6,3,-2); c.lineTo(0,0); c.moveTo(0,3); c.lineTo(0,3.2); }
    c.stroke(); c.restore();
  }
  MapView.prototype._drawFusionDevice = function (c, device, q) {
    const state = device.stale === true || device.freshness === 'STALE' || device.statusCode === 'STALE' ? 'stale'
      : device.statusCode === 'ABNORMAL' || device.status === '异常' ? 'fault'
      : device.statusCode === 'OFFLINE' || device.status === '离线' ? 'offline'
      : device.statusCode === 'ONLINE' || device.status === '在线' ? 'online' : 'unknown';
    const key = g.UI.deviceMeta(device).key;
    const scale = Number.isFinite(Number(this.opt.sensorIconScale)) ? Math.max(.65, Math.min(1.25, Number(this.opt.sensorIconScale))) : 1;
    c.save(); c.translate(q[0],q[1]);
    applyAlarmGlow(c, device);
    g.UI.drawBusinessIcon(c, key === 'unknown' ? 'unknown-device' : key, 0, 0, 24 * scale);
    c.shadowBlur = 0; c.shadowColor = 'transparent';
    drawMarkerState(c, state, 10 * scale, 10 * scale);
    if ((device.alarm || device.hasAlarm) && state !== 'fault') drawMarkerState(c, 'history', -10 * scale, 10 * scale);
    if (this._pinnedKey === 'device:' + device.id) { c.beginPath(); c.moveTo(-8,16 * scale); c.lineTo(8,16 * scale); c.strokeStyle = markerPalette().selected; c.lineWidth = 3; c.stroke(); }
    c.restore();
  };

  // 各业务页共用的计划线绘制：屏幕坐标仅做投影，不平滑、补点或改变航线几何。
  MapView.strokePlannedRoute = function (c, pts, options = {}) {
    if (!c || !Array.isArray(pts) || pts.length < 2
      || pts.some(p => !Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return;
    const color = '#8ca0a8'; // 计划几何不代表已飞，状态和风险不得把计划线染成红绿。
    const { dash = [7, 5], selected = false, risk = false,
      terminals = true, vertices = false, arrows = true, label = '', width = 0, height = 0 } = options;
    const path = () => {
      c.beginPath();
      pts.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]));
    };
    c.save(); c.lineJoin = 'round'; c.lineCap = 'round'; c.lineDashOffset = 0;
    // 细衬线只提高底图上的对比；宽度为像素，不表示航线走廊或风险影响范围。
    path(); c.setLineDash([]); c.strokeStyle = 'rgba(255,255,255,.8)';
    c.lineWidth = selected ? 4 : 3.5; c.stroke();
    path(); c.setLineDash(dash); c.strokeStyle = color; c.lineWidth = selected ? 2.4 : 1.8; c.stroke();
    c.setLineDash([]);
    let lastArrow = null;
    if (arrows) for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      const x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2;
      if (len < 100 || (lastArrow && Math.hypot(x - lastArrow[0], y - lastArrow[1]) < 100)) continue;
      if (width && height && (x < 0 || x > width || y < 0 || y > height)) continue;
      const ux = dx / len, uy = dy / len;
      c.beginPath(); c.moveTo(x - ux * 4 - uy * 3, y - uy * 4 + ux * 3);
      c.lineTo(x + ux * 3, y + uy * 3); c.lineTo(x - ux * 4 + uy * 3, y - uy * 4 - ux * 3);
      c.strokeStyle = color; c.lineWidth = 1.5; c.stroke(); lastArrow = [x, y];
    }
    if (vertices) {
      let last = pts[0];
      for (const p of pts.slice(1, -1)) {
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 24) continue;
        c.beginPath(); c.arc(p[0], p[1], 2.5, 0, Math.PI * 2);
        c.fillStyle = '#fff'; c.fill(); c.strokeStyle = color; c.lineWidth = 1.2; c.stroke(); last = p;
      }
    }
    if (terminals) {
      const first = pts[0], last = pts[pts.length - 1];
      const samePlace = first[0] === last[0] && first[1] === last[1];
      const close = Math.hypot(first[0] - last[0], first[1] - last[1]) < 40;
      const ends = samePlace ? [[first, '起 / 终', 1]] : [[first, '起', -1], [last, '终', close ? 1 : -1]];
      for (const [p, text, side] of ends) {
        c.beginPath(); c.arc(p[0], p[1], 4, 0, Math.PI * 2);
        c.fillStyle = '#fff'; c.fill(); c.strokeStyle = color; c.lineWidth = 1.6; c.stroke();
        c.font = '600 10px "PingFang SC",sans-serif'; c.textAlign = 'left'; c.textBaseline = 'middle';
        c.lineWidth = 3; c.strokeStyle = 'rgba(255,255,255,.94)';
        c.strokeText(text, p[0] + 7, p[1] + side * 11); c.fillStyle = '#294b60'; c.fillText(text, p[0] + 7, p[1] + side * 11);
      }
    }
    if (label) drawRouteLabel(c, pts[Math.floor(pts.length / 2)], label, width, height, risk);
    c.restore();
  };

  function drawRouteLabel(c, at, text, width, height, risk) {
    c.font = '500 11px "PingFang SC",sans-serif';
    const limit = Math.max(40, Math.min(230, width ? width - 28 : 230)), lines = [];
    let line = '';
    for (const char of String(text)) {
      if (line && c.measureText(line + char).width > limit) { lines.push(line); line = ''; }
      line += char;
    }
    if (line) lines.push(line);
    const w = Math.max(...lines.map(row => c.measureText(row).width)) + 12, h = lines.length * 16 + 8;
    const x = width ? Math.max(6, Math.min(width - w - 6, at[0] - w / 2)) : at[0] - w / 2;
    const y = height ? Math.max(6, Math.min(height - h - 6, at[1] - h - 12)) : at[1] - h - 12;
    c.fillStyle = risk ? 'rgba(92,28,36,.92)' : 'rgba(16,38,53,.9)'; c.fillRect(x, y, w, h);
    c.fillStyle = '#e8f3fa'; c.textAlign = 'left'; c.textBaseline = 'top';
    lines.forEach((row, i) => c.fillText(row, x + 6, y + 4 + i * 16));
  }

  const TRACK_COLORS = { WITHIN: '#2fd06e', OUTSIDE: '#ff4d5e', UNKNOWN: '#ffb020', BOUNDARY: '#ffb020' };
  const trackPointValid = p => p && Number.isFinite(p.lon) && Number.isFinite(p.lat)
    && Math.abs(p.lon) <= 180 && Math.abs(p.lat) <= 90;
  const trackTime = p => p.t ?? p.observed_at;
  MapView.trackContinuous = function (a, b) {
    return trackPointValid(a) && trackPointValid(b) && !b.break_before
      && !!a.track_id && a.track_id === b.track_id
      && Number.isFinite(a.point_seq) && b.point_seq === a.point_seq + 1
      && Number.isFinite(trackTime(a)) && Number.isFinite(trackTime(b)) && trackTime(b) > trackTime(a);
  };
  MapView.strokeObservedTrack = function (c, project, points, { hot = true, neutralColor = null } = {}) {
    c.save();
    let previous = null;
    for (const point of points || []) {
      if (!trackPointValid(point)) { previous = null; continue; }
      const kind = point.kind || 'meas';
      const color = kind === 'bridge' ? '#ff8b3d' : kind === 'pred' ? '#22d3ee'
        : neutralColor || TRACK_COLORS[point.corridor_relation] || TRACK_COLORS.UNKNOWN;
      const [x, y] = project(point.lon, point.lat);
      // 预测、弥合不可接成实测线；类型转换处保留缺口。
      if (MapView.trackContinuous(previous, point) && (previous.kind || 'meas') === kind) {
        const relations = [previous.corridor_relation, point.corridor_relation];
        const relation = relations.every(value => value === 'WITHIN') ? 'WITHIN'
          : relations.includes('OUTSIDE') ? 'OUTSIDE' : 'UNKNOWN';
        const [px, py] = project(previous.lon, previous.lat);
        c.beginPath(); c.moveTo(px, py); c.lineTo(x, y);
        c.setLineDash(kind === 'bridge' ? [3, 6] : kind === 'pred' ? [2, 5] : []);
        c.lineDashOffset = 0; c.lineWidth = hot ? 2.2 : 1.5;
        c.strokeStyle = kind === 'meas' ? neutralColor || TRACK_COLORS[relation] : color;
        c.stroke();
      }
      c.setLineDash([]); c.beginPath(); c.arc(x, y, hot ? 2 : 1.5, 0, Math.PI * 2);
      c.fillStyle = color; c.fill();
      previous = point;
    }
    c.restore();
  };

  const PLAN_STYLE = {
    PENDING: { alpha: .9 }, APPROVED: { alpha: .9 },
    EXECUTING: { alpha: 1 }, COMPLETED: { alpha: .72 }
  };

  MapView.prototype._drawFlightPlans = function (c, P, picks) {
    (this.data.flightPlans || []).forEach(plan => {
      const coordinates = Array.isArray(plan.coordinates) ? plan.coordinates : [];
      if (coordinates.length < 2) return;
      const pts = coordinates.map(point => P(Number(point[0]), Number(point[1])));
      if (pts.some(point => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) return;
      const style = PLAN_STYLE[plan.statusCode];
      if (!style) return;
      const activeRisk = Number(plan.activeRiskCount) > 0;
      const selected = this.planSel === plan.id;
      const middle = pts[Math.floor(pts.length / 2)];
      const label = `${plan.planNo || plan.id} · ${plan.statusLabel || plan.statusCode}${activeRisk ? ` · ${plan.activeRiskCount}条风险` : ''}`;
      c.save(); c.globalAlpha = style.alpha;
      MapView.strokePlannedRoute(c, pts, { ...style, selected, risk: activeRisk,
        terminals: selected, vertices: selected, arrows: selected, label: selected ? label : '', width: this.w, height: this.h });
      c.restore();
      picks.push({
        x: middle[0], y: middle[1], kind: 'plan', data: plan,
        segments: pts.slice(1).map((point, index) => [pts[index], point]),
        tip: `<b>${html(plan.planNo || plan.id)}</b><dl class="kv"><dt>状态</dt><dd>${html(plan.statusLabel || plan.statusCode)}</dd><dt>风险</dt><dd>${activeRisk ? html(plan.activeRiskCount) + '条当前风险' : '无当前风险'}</dd></dl>`
      });
    });
  };

  MapView.prototype._drawTrackArrow = function (c, a, b, col) {
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    if (len < 100) return;
    const ux = dx / len, uy = dy / len;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, s = 5.5;
    c.beginPath();
    c.moveTo(mx - ux * 2 - uy * s * .55, my - uy * 2 + ux * s * .55);
    c.lineTo(mx + ux * s, my + uy * s);
    c.lineTo(mx - ux * 2 + uy * s * .55, my - uy * 2 - ux * s * .55);
    c.strokeStyle = col; c.lineWidth = 1.35; c.lineJoin = 'round'; c.stroke();
  };

  const TARGET_COLORS = { bird: '#72d6ff', balloon: '#b38cff', kite: '#ff9b55', lantern: '#f8c65b', unknown: '#94a3b8' };

  MapView.prototype._drawTarget = function (c, t, q, col, isSel) {
    c.save();
    applyAlarmGlow(c, t);
    g.UI.drawBusinessIcon(c, g.UI.targetIconKey(t), q[0], q[1], isSel ? 26 : 22, t.heading);
    c.shadowBlur = 0; c.shadowColor = 'transparent';
    if (t.activeRisk) drawMarkerState(c, 'fault', q[0]+10, q[1]+10);
    if (t.stale === true || t.freshness === 'STALE') drawMarkerState(c, 'stale', q[0]-10, q[1]+10);
    if (isSel) { c.beginPath(); c.moveTo(q[0]-9,q[1]+17); c.lineTo(q[0]+9,q[1]+17); c.strokeStyle = markerPalette().selected; c.lineWidth = 3; c.stroke(); }
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

    /* 离线详细底图真正加载完成前继续显示简化地图，避免露出 MapLibre 的灰色初始化画布。 */
    if (this.online && this.map) { this._drawOverlays(c, W, H); return; }

    /* 简化示意图：保持业务可操作，不读取任何历史图片瓦片。 */
    const palette = this._basePalette ||= g.OfflineMap.palette();
    const gr = c.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, palette.land); gr.addColorStop(1, palette.background);
    c.fillStyle = gr; c.fillRect(0, 0, W, H);

    if (this._activeCityCode === '370500') {
    /* 海域 */
    c.beginPath();
    COAST.forEach((p, i) => { const q = P(p[0], p[1]); i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); });
    const e1 = P(B.lon1 + 1, B.lat0 - 1), e2 = P(B.lon1 + 1, B.lat1 + 1);
    c.lineTo(e1[0], e1[1]); c.lineTo(e2[0], e2[1]); c.closePath();
    c.fillStyle = palette.water; c.fill();
    c.strokeStyle = palette['water-line']; c.lineWidth = 1.2; c.stroke();

    /* 经纬网 */
    c.strokeStyle = palette.grid; c.lineWidth = 1;
    for (let lo = 118.0; lo <= 119.3; lo += 0.1) { const a = P(lo, B.lat0), b = P(lo, B.lat1); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
    for (let la = 37.0; la <= 38.2; la += 0.1) { const a = P(B.lon0, la), b = P(B.lon1, la); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }

    /* 道路 */
    c.strokeStyle = palette['road-major']; c.lineWidth = 2.2;
    ROADS.forEach(r => { c.beginPath(); r.forEach((p, i) => { const q = P(p[0], p[1]); i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); }); c.stroke(); });

    /* 黄河 */
    c.strokeStyle = palette.water; c.lineWidth = 6; c.lineCap = 'round';
    c.beginPath(); RIVER.forEach((p, i) => { const q = P(p[0], p[1]); i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); }); c.stroke();
    c.strokeStyle = palette['water-line']; c.lineWidth = 2.6; c.stroke();

    /* 地名 */
    c.textAlign = 'center'; c.textBaseline = 'middle';
    LABELS.forEach(l => {
      const q = P(l.lon, l.lat);
      c.font = `${l.s}px "PingFang SC",sans-serif`;
      c.strokeStyle = palette.halo; c.lineWidth = 4; c.strokeText(l.n, q[0], q[1]);
      c.fillStyle = palette.label; c.fillText(l.n, q[0], q[1]);
    });
    } else {
      /* 其他城市的包不可用时只显示其覆盖范围网格，避免误画东营海岸与地名。 */
      const bounds = this._viewBounds();
      c.strokeStyle = palette.grid; c.lineWidth = 1;
      for (let i = 0; i <= 8; i++) {
        const lon = bounds[0] + (bounds[2] - bounds[0]) * i / 8;
        const lat = bounds[1] + (bounds[3] - bounds[1]) * i / 8;
        let a = P(lon, bounds[1]), b = P(lon, bounds[3]);
        c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
        a = P(bounds[0], lat); b = P(bounds[2], lat);
        c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
      }
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = '15px "PingFang SC",sans-serif'; c.fillStyle = palette.label;
      c.fillText(this._activeCityName || '当前城市', W / 2, H / 2);
    }

    this._paintLayers(c, W, H);
  };

  /* 叠加层：空域 / 设备 / 轨迹 / 告警（两种底图模式共用） */
  MapView.prototype._paintLayers = function (c, W, H) {
    const P = (a, b) => this.px(a, b);
    const picks = [];
    let selectedMarker = null;

    /* 四源覆盖只在融合感知开关下启用，避免改变告警页、飞行页等共享地图。 */
    if (this.opt.fusionProfile && this.layers.coverage) {
      (this.data.devices || []).slice(0, this.opt.maxDev || 90).forEach(device => {
        this._drawDeviceCoverage(c, device, P);
      });
    }

    /* 空域 */
    (this.data.airspaces || []).forEach(a => {
      /* 图层归属只认数据层声明的 layer，不再按 type 猜（审查第 3 轮 P2-1）。
         原来的回落把「临时管制区」归进 limit，而数据层把它归在 nofly——同一片空域，
         勾掉「禁飞」它不消失、勾掉「限制」它才消失，使用者无从理解。
         漏传 layer 的空域一律不画并告警一次（按 id 去重：draw() 每帧都跑，不去重会刷屏）。 */
      const key = a.layer;
      if (!key) {
        if (!warnedMissingLayer.has(a.id)) {
          warnedMissingLayer.add(a.id);
          console.warn('[MapView] 空域缺少 layer 字段，已跳过绘制：', a.id || a.name || a);
        }
        return;
      }
      if (!this.layers[key]) return;
      // 高亮色适合暗色底图，在浅色底图上用同色相深色保持可读性。
      const ink = ({
        '#ff4d5e': '#d52d42', '#2fd06e': '#16864f', '#ffb020': '#b97600',
        '#3d8bff': '#2c66bb', '#a97bff': '#7545c7', '#8ca0be': '#5f7189'
      })[String(a.color).toLowerCase()] || a.color;
      /* 一片空域的全部环（决策 16-3）：rings 的第 0 环是外环，其余是孔洞。
         环都收在一条路径里，由 even-odd 规则挖出孔洞——孔洞不是"少画一块"，
         它是禁飞区里合法可飞的那一块，画满了就是把能飞的地方说成不能飞。 */
      const rings = (Array.isArray(a.rings) ? a.rings : []).filter(ring => Array.isArray(ring) && ring.length);
      if (!rings.length) return;
      c.beginPath();
      rings.forEach(ring => {
        ring.forEach((p, i) => { const q = P(p[0], p[1]); i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); });
        c.closePath();
      });
      const areaStyle = ({
        PROHIBITED: { dash: [8, 4], fill: '1f', width: 1.8, hatch: true },
        TEMPORARY_CONTROL: { dash: [3, 4], fill: '16', width: 1.6 },
        ALTITUDE_LIMIT: { dash: [10, 4, 2, 4], fill: '16', width: 1.55 },
        RESTRICTED: { dash: [6, 4], fill: '14', width: 1.55 },
        PERMITTED: { dash: [], fill: '12', width: 1.5 }
      })[a.kindCode] || { dash: [6, 4], fill: '14', width: 1.35, hatch: key === 'nofly' };
      c.fillStyle = a.color + areaStyle.fill; c.fill('evenodd');
      c.setLineDash(areaStyle.dash); c.lineWidth = areaStyle.width; c.strokeStyle = ink + 'e6'; c.stroke(); c.setLineDash([]);
      // 仅禁飞空域保留稀疏纹理作为强语义，其他类型让出底图细节。
      if (areaStyle.hatch) {
        c.save(); c.clip('evenodd');
        c.strokeStyle = ink + '1f'; c.lineWidth = .8;
        const bb = rings.reduce((m, ring) => ring.reduce((n, p) => { const q = P(p[0], p[1]); return [Math.min(n[0], q[0]), Math.min(n[1], q[1]), Math.max(n[2], q[0]), Math.max(n[3], q[1])]; }, m), [1e9, 1e9, -1e9, -1e9]);
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

    /* 融合感知计划航线：仅专用模式启用，避免改变其他地图。 */
    if (this.opt.fusionProfile && this.layers.flightPlan) this._drawFlightPlans(c, P, picks);

    // 只错开屏幕图形；位置、覆盖范围、感知关联线与轨迹仍使用原始坐标。
    const selectedDevice = this.opt.fusionProfile && this.layers.device
      ? (this.data.devices || []).slice(0, this.opt.maxDev || 90).find(d => this._pinnedKey === 'device:' + d.id) : null;
    const selectedTarget = this.opt.fusionProfile && this.layers.track
      ? (this.data.targets || []).find(t => this._pinnedKey === 'target:' + t.id && t.posValid !== false
        && (!t.layerKey || this.layers[t.layerKey] !== false)) : null;
    const selectedAnchor = selectedDevice || (selectedTarget && this._targetAnchor(selectedTarget));
    const occupiedIcons = selectedAnchor ? [P(selectedAnchor.lon, selectedAnchor.lat)] : [];
    const iconPoint = (anchor, selected) => {
      // 当前选中图标固定在真实投影点，周围图标为它让位。
      if (selected) return anchor;
      if (anchor[0] < 0 || anchor[0] > W || anchor[1] < 0 || anchor[1] > H) return anchor;
      const free = p => p[0] >= 18 && p[0] <= W-18 && p[1] >= 18 && p[1] <= H-18
        && occupiedIcons.every(q => Math.hypot(p[0]-q[0],p[1]-q[1]) >= 40);
      let point = anchor;
      if (!free(point)) search: for (const radius of [40,60,80]) {
        for (let i=0;i<8;i++) { const a=i*Math.PI/4, candidate=[anchor[0]+radius*Math.cos(a),anchor[1]+radius*Math.sin(a)];
          if (free(candidate)) { point=candidate; break search; } }
      }
      occupiedIcons.push(point);
      if (point !== anchor) { c.save(); c.beginPath(); c.moveTo(...anchor); c.lineTo(...point); c.strokeStyle=markerPalette().offline; c.globalAlpha=.7; c.lineWidth=1; c.stroke(); c.restore(); }
      return point;
    };
    /* 设备点位 */
    if (this.layers.device) {
      (this.data.devices || []).slice(0, this.opt.maxDev || 90).forEach(d => {
        const anchor = P(d.lon, d.lat);
        if (anchor[0] < -20 || anchor[0] > W + 20 || anchor[1] < -20 || anchor[1] > H + 20) return;
        const isSelected = selectedDevice === d;
        const q = iconPoint(anchor, isSelected);
        const col = d.status === '在线' ? (this.opt.fusionProfile ? this._sensorColor(d) : (d.alarm ? '#d97706' : '#008fb3')) : d.status === '离线' ? '#64748b' : '#f1a43a';
        if (isSelected) selectedMarker = { q, draw: () => this._drawFusionDevice(c, d, q) };
        else this._drawFusionDevice(c, d, q);
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
      /* 保留其他目标的既有弱化效果，融合感知选中图标最后绘制。 */
      const selOnMap = !!this.sel && (this.data.targets || []).some(x => x.id === this.sel);
      (this.data.targets || []).forEach((t, ti) => {
        // 阶段 8：目标可声明所属图层（如 raw-track 原始轨迹层），未声明即 track；未知图层键默认可见。
        if (t.layerKey && t.layerKey !== 'track' && this.layers[t.layerKey] === false) return;
        const isSel = this.sel === t.id;
        const dim = selOnMap && !isSel;
        if (dim) { c.save(); c.globalAlpha = .35; }
        // §4.2：非无人机目标不做合法性判定，'不适用' 单列中性色，不得与「合法」同色
        const targetClassColor = TARGET_COLORS[t.iconKind] || TARGET_COLORS.unknown;
        const col = t.objectTypeCode && t.objectTypeCode !== 'UAV' ? targetClassColor
          : t.legal === '非法' ? '#ff4d5e' : t.legal === '异常' ? '#ff8b3d'
            : t.legal === '待确认' ? '#ffb020' : t.legal === '不适用' ? '#8ca0be' : '#2fd06e';
        /* AOA 目标只有方位角，没有经纬度（协议 v8.6）—— 画成从设备射出的方位线。
           当点画等于凭空给了一个平台并不知道的位置。 */
        if (t.posValid === false) { this._drawBearing(c, t, P, col); if (dim) c.restore(); return; }
        MapView.strokeObservedTrack(c, P, t.track || [], {
          hot: t.tracked || isSel,
          // 非无人机保持类别色；无人机轨迹只读取逐点走廊关系，不借目标合法性染色。
          neutralColor: t.objectTypeCode && t.objectTypeCode !== 'UAV' ? targetClassColor : null
        });
        /* 锚点：目标自身的最新可信坐标优先于轨迹末点——轨迹可能只到上一帧，而 latest_state 才是当前位置；
           两者都没有时不画（不用 (0,0) 或旧点冒充）。 */
        const anchor = this._targetAnchor(t);
        if (!anchor) { if (dim) c.restore(); return; }
        const q = P(anchor.lon, anchor.lat);
        /* 阶段 8：融合精度圈（米→像素按当前比例尺），只在选中且 accuracyM 为有限正数时画，不臆造精度。 */
        if (isSel && Number.isFinite(Number(t.accuracyM)) && Number(t.accuracyM) > 0) {
          const r = this._metersToPx(Number(t.accuracyM), anchor.lat);
          if (r > 2) {
            c.save(); c.beginPath(); c.arc(q[0], q[1], r, 0, 7);
            c.strokeStyle = col + '99'; c.setLineDash([4, 4]); c.lineWidth = 1.2; c.stroke();
            c.fillStyle = col + '14'; c.fill(); c.setLineDash([]); c.restore();
          }
        }
        const displayPoint = iconPoint(q, selectedTarget === t);
        if (selectedTarget === t) selectedMarker = { q: displayPoint, draw: () => this._drawTarget(c, t, displayPoint, col, isSel) };
        else this._drawTarget(c, t, displayPoint, col, isSel);
        if (dim) c.restore();
        const altitudeTx = t.alt == null ? '—' : html(t.alt) + ' m AMSL';
        const speedTx = t.speed == null ? '—' : html(t.speed) + ' m/s';
        picks.push({
          x: displayPoint[0], y: displayPoint[1], kind: 'target', data: t,
          tip: `<div class="maptip-uav"><b style="color:${col}">${html(t.id)}</b>
            <div class="maptip-uav-meta">${html(t.subtype || t.type)}</div>
            <div class="maptip-uav-tags">${html(t.legal)}${t.violation ? ' · ' + html(t.violation) : ''} · ${html(t.risk)}</div></div>`
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
        /* 阶段 12 去掉 mock.js 后前端不再有行政区坐标表，因此只画能定位到目标的告警。
           这与上面那条原则一致：兜底可以降级为"显示不了"，不可以替换成另一个实体。 */
        if (!t) return;
        const lon = t.lon, lat = t.lat;
        const q = P(lon, lat);
        const col = a.level === '高' ? '#ff4d5e' : a.level === '中' ? '#ffb020' : '#3d8bff';
        c.save();
        applyAlarmGlow(c, { ...a, stale: t.stale, freshness: t.freshness });
        c.beginPath(); c.moveTo(q[0],q[1]-9); c.lineTo(q[0]+9,q[1]+7); c.lineTo(q[0]-9,q[1]+7); c.closePath();
        c.fillStyle = markerPalette().alarm; c.fill();
        c.shadowBlur = 0; c.strokeStyle = '#fff'; c.lineWidth = 1.4; c.stroke();
        c.beginPath(); c.moveTo(q[0],q[1]-3); c.lineTo(q[0],q[1]+1); c.moveTo(q[0],q[1]+4); c.lineTo(q[0],q[1]+4.2);
        c.lineWidth = 2; c.lineCap = 'round'; c.stroke(); c.restore();
        picks.push({
          x: q[0], y: q[1], kind: 'alarm', data: a,
          tip: `<b style="color:${col}">${a.type}</b><dl class="kv" style="margin-top:6px">
            <dt>目标</dt><dd>${a.targetId}</dd><dt>等级</dt><dd>${a.level}</dd>
            <dt>时间</dt><dd>${a.time.slice(11)}</dd><dt>状态</dt><dd>${a.status}</dd></dl>`
        });
      });
    }
    if (selectedMarker) {
      const { q, draw } = selectedMarker;
      c.save();
      c.translate(q[0], q[1]); c.scale(1.25, 1.25); c.translate(-q[0], -q[1]);
      draw();
      c.restore();
      // 静态焦点角标与异常红光分开，不改变设备类别色或告警状态。
      c.save(); c.translate(q[0], q[1]); c.setLineDash([]);
      c.beginPath();
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        c.moveTo(sx * 15, sy * 27); c.lineTo(sx * 27, sy * 27); c.lineTo(sx * 27, sy * 15);
      }
      c.strokeStyle = '#071b38'; c.lineWidth = 6; c.stroke();
      c.strokeStyle = '#b6f5ff'; c.lineWidth = 2.5; c.stroke();
      c.font = '600 12px "PingFang SC",sans-serif'; c.textAlign = 'center';
      c.strokeStyle = '#071b38'; c.lineWidth = 4; c.strokeText('已选中', 0, 45);
      c.fillStyle = '#b6f5ff'; c.fillText('已选中', 0, 45);
      c.restore();
    }
    this._pickPts = picks;
    if (this.opt.pinSelTip || (this.opt.interactiveTip && this.tip && this.tip.style.display !== 'none')) this._hit();

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
