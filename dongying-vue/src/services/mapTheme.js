// 底图主题只修改本地矢量图层的颜色，保留原几何、缩放、筛选与业务叠加层。
export function mapPalette() {
  const css = getComputedStyle(document.documentElement);
  return Object.fromEntries([
    'background', 'land', 'green', 'forest', 'wetland', 'urban', 'urban-dense', 'building', 'water', 'water-line',
    'road', 'road-major', 'road-highway', 'road-casing', 'boundary',
    'label', 'label-muted', 'halo', 'grid', 'glow', 'shade', 'highlight'
  ].map(name => [name, css.getPropertyValue(`--map-${name}`).trim()]));
}

export function applyMapTheme(style, options = {}) {
  const p = mapPalette();
  const imagery = options.imagery || null;
  // 有影像时，影像负责地表纹理，矢量色块只做半透明"染色"，否则会把影像整片盖掉。
  const tintOpacity = imagery ? 0.42 : 1;
  for (const layer of style.layers || []) {
    if (layer.type === 'background') {
      layer.paint = { ...layer.paint, 'background-color': p.background };
      continue;
    }
    if (layer.source !== 'protomaps') continue;
    const source = layer['source-layer'];
    const paint = layer.paint ||= {};
    if (layer.type === 'fill') {
      // 放大后满屏都是陆地底色，按市级定的深色会变成一片黑；Z12 起逐级提亮。
      if (source === 'earth') paint['fill-color'] = ['interpolate', ['linear'], ['zoom'], 11, p.land, 15, shade(p.land, 0.35)];
      if (source === 'landcover' || source === 'landuse') {
        paint['fill-color'] = ['match', ['get', 'kind'],
          ['park', 'forest', 'wood', 'grassland', 'grass', 'nature_reserve', 'protected_area', 'national_park', 'garden', 'cemetery', 'golf_course'], p.forest,
          ['industrial', 'commercial', 'aerodrome'], p['urban-dense'],
          ['urban_area', 'hospital', 'school', 'university', 'college'], p.urban,
          p.land];
      }
      if (source === 'landcover' || source === 'landuse') paint['fill-opacity'] = tintOpacity;
      if (source === 'buildings') { paint['fill-color'] = p.building; if (imagery) paint['fill-opacity'] = 0.6; }
      if (source === 'water') {
        // 海/湖/河分档：湖泊与近岸水体偏亮偏青，河道面用河流线色，其余（海）用深水色。
        paint['fill-color'] = ['match', ['get', 'kind'],
          'river', p['water-line'],
          ['lake', 'water', 'reservoir', 'pond', 'basin', 'canal'], shade(p.water, 0.22),
          p.water];
      }
    } else if (layer.type === 'line') {
      if (source === 'water') paint['line-color'] = p['water-line'];
      if (source === 'boundaries') paint['line-color'] = p.boundary;
      if (source === 'roads') {
        paint['line-color'] = layer.id.includes('casing') ? p['road-casing']
          : layer.id.includes('highway') ? p['road-highway']
            : layer.id.includes('major') ? p['road-major'] : p.road;
      }
    } else if (layer.type === 'symbol' && layer.layout?.['text-field']) {
      // 道路编号保留原有盾牌图标，其文字仍需适配浅色盾牌底。
      if (layer.id === 'roads_shields') continue;
      paint['text-color'] = source === 'places' ? p.label : p['label-muted'];
      paint['text-halo-color'] = p.halo;
      // 参考稿的地名带深色底框；MapLibre 没有文字背景，用宽 halo + 高不透明度顶替。市/区县更宽。
      if (source === 'places') {
        paint['text-halo-width'] = ['locality', 'region'].some(k => layer.id.includes(k)) ? 3.2 : 2;
        paint['text-halo-blur'] = 0.4;
      }
    }
  }
  injectUrbanLayers(style, p, tintOpacity);
  if (imagery) injectImagery(style, p, imagery);
  return style;
}

/* 影像底图：raster 层插在 earth 之后、所有地块色块之前。影像先去饱和提对比，再用一层半透明陆地色
   "染"成蓝调；上面的农田/城区色块按 tintOpacity 半透明叠加。影像只做到 Z12，再放大就淡出交给矢量。 */
function injectImagery(style, p, imagery) {
  style.sources.imagery = {
    type: 'raster', tiles: [imagery.tiles], tileSize: 256,
    minzoom: imagery.minzoom, maxzoom: imagery.maxzoom, bounds: imagery.bounds, attribution: imagery.attribution
  };
  const layers = style.layers;
  const earthAt = layers.findIndex(layer => layer.id === 'earth');
  layers.splice(earthAt < 0 ? 1 : earthAt + 1, 0,
    {
      id: 'theme_imagery', type: 'raster', source: 'imagery', minzoom: 6,
      paint: {
        'raster-saturation': -0.72, 'raster-contrast': 0.22,
        'raster-brightness-min': 0.04, 'raster-brightness-max': 0.82,
        'raster-fade-duration': 0,
        'raster-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.9, imagery.maxzoom, 0.9, imagery.maxzoom + 2, 0.3]
      }
    },
    {
      id: 'theme_imagery_tint', type: 'fill', source: 'protomaps', 'source-layer': 'earth',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': p.land, 'fill-antialias': false,
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.5, imagery.maxzoom + 2, 0.75] }
    });
  // 影像自带地表起伏，山影收弱。
  const hill = layers.find(layer => layer.id === 'theme_hillshade');
  if (hill) hill.paint['hillshade-exaggeration'] = 0.22;
}

/* 微调色相：hex 按比例提亮/压暗，用于同一类地块的多档色，避免为每档单开 token。 */
function shade(hex, ratio) {
  const n = parseInt(hex.replace('#', ''), 16);
  const ch = shift => Math.max(0, Math.min(255, Math.round(((n >> shift) & 255) * (1 + ratio))));
  return `#${[16, 8, 0].map(sh => ch(sh).toString(16).padStart(2, '0')).join('')}`;
}
/* 按要素 id 取模分档，让相邻地块色调略有差别——卫星图里农田、街区本来就不是一个平色。 */
const tone = (base, steps) => ['match', ['%', ['id'], steps.length], ...steps.flatMap((r, i) => [i, shade(base, r)]), base];

/* Protomaps 自带样式只画公园/医院/学校/工业等零散地块，居住区、商业区、农田根本没有图层，
   城市在图上就是一片平的陆地色。这里补：农田（四档色拼成patchwork）、居住区（三档）、
   城区边缘光晕、水岸光晕、主干路光晕。插在 landuse 之前，原有专项地块继续盖在上面。可重复调用（按 id 去重）。 */
const URBAN_LAYER_ID = 'theme_landuse_urban';
function injectUrbanLayers(style, p, tintOpacity = 1) {
  const layers = style.layers || [];
  if (layers.some(layer => layer.id === URBAN_LAYER_ID)) return;
  let at = layers.findIndex(layer => layer['source-layer'] === 'landuse');
  if (at < 0) at = layers.findIndex(layer => layer['source-layer'] === 'water');
  if (at < 0) return;
  const urbanKinds = ['residential', 'urban_area', 'neighbourhood', 'retail'];
  const denseKinds = ['commercial', 'industrial', 'aerodrome'];
  layers.splice(at, 0,
    {
      id: 'theme_landuse_farmland', type: 'fill', source: 'protomaps', 'source-layer': 'landuse',
      filter: ['in', ['get', 'kind'], ['literal', ['farmland', 'orchard', 'vineyard', 'meadow', 'scrub', 'heath', 'grass']]],
      paint: { 'fill-color': tone(p.green, [-0.10, 0.06, -0.03, 0.14]), 'fill-antialias': false, 'fill-opacity': tintOpacity }
    },
    {
      id: 'theme_landuse_wetland', type: 'fill', source: 'protomaps', 'source-layer': 'landuse',
      filter: ['in', ['get', 'kind'], ['literal', ['wetland', 'beach', 'sand', 'mud', 'salt_pond']]],
      paint: { 'fill-color': tone(p.wetland, [0, 0.08, -0.06]), 'fill-antialias': false, 'fill-opacity': tintOpacity }
    },
    {
      id: URBAN_LAYER_ID, type: 'fill', source: 'protomaps', 'source-layer': 'landuse',
      filter: ['in', ['get', 'kind'], ['literal', urbanKinds]],
      // 放大后地块边界会显得生硬，逐级降透明度，把层次交给路网和建筑。
      paint: { 'fill-color': tone(p.urban, [0, 0.10, -0.08]), 'fill-antialias': false,
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.95 * tintOpacity, 13, 0.75 * tintOpacity, 15, 0.45 * tintOpacity] }
    },
    {
      // 城区边缘的模糊光晕：夜间卫星图"城市灯光"的来源。宽度随缩放，Z8 以下不画。
      id: 'theme_urban_glow', type: 'line', source: 'protomaps', 'source-layer': 'landuse', minzoom: 8,
      filter: ['in', ['get', 'kind'], ['literal', [...urbanKinds, ...denseKinds]]],
      paint: { 'line-color': p.glow, 'line-opacity': 0.35,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 4, 12, 10, 15, 20],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 8, 4, 12, 10, 15, 20] }
    });
  // 地块纹理：fill-pattern 贴在色块之上，Z11 起淡入。图片由 installThemeImages 在运行时用 canvas 生成。
  const patternAt = layers.findIndex(layer => layer.id === 'theme_urban_glow');
  const patternOpacity = max => ['interpolate', ['linear'], ['zoom'], 10, 0, 12, max * 0.6, 14, max];
  layers.splice(patternAt, 0,
    { id: 'theme_tex_farmland', type: 'fill', source: 'protomaps', 'source-layer': 'landuse', minzoom: 10,
      filter: ['in', ['get', 'kind'], ['literal', ['farmland', 'orchard', 'vineyard', 'meadow']]],
      paint: { 'fill-pattern': 'theme-tex-farm', 'fill-opacity': patternOpacity(0.7), 'fill-antialias': false } },
    { id: 'theme_tex_forest', type: 'fill', source: 'protomaps', 'source-layer': 'landuse', minzoom: 10,
      filter: ['in', ['get', 'kind'], ['literal', ['forest', 'wood', 'park', 'nature_reserve', 'scrub', 'wetland', 'grass', 'grassland']]],
      paint: { 'fill-pattern': 'theme-tex-forest', 'fill-opacity': patternOpacity(0.65), 'fill-antialias': false } },
    { id: 'theme_tex_urban', type: 'fill', source: 'protomaps', 'source-layer': 'landuse', minzoom: 10,
      filter: ['in', ['get', 'kind'], ['literal', [...urbanKinds, ...denseKinds]]],
      paint: { 'fill-pattern': 'theme-tex-urban', 'fill-opacity': patternOpacity(0.6), 'fill-antialias': false } });
  // 程序化山影：插在水面之前，陆地所有色块都被打光，水面盖住海上的部分。数据由 procdem 协议在本机生成。
  style.sources.procdem = { type: 'raster-dem', tiles: ['procdem://{z}/{x}/{y}'], tileSize: 256, encoding: 'terrarium', minzoom: 6, maxzoom: 14 };
  const hillAt = layers.findIndex(layer => layer.id === 'water');
  layers.splice(hillAt < 0 ? layers.length : hillAt, 0, {
    id: 'theme_hillshade', type: 'hillshade', source: 'procdem', minzoom: 7,
    paint: { 'hillshade-exaggeration': 0.38, 'hillshade-illumination-direction': 315,
      'hillshade-shadow-color': p.shade, 'hillshade-highlight-color': p.highlight, 'hillshade-accent-color': 'rgba(0,0,0,0)' }
  });
  // 水岸光晕：紧跟水面之后，海岸线和河道在深底上有一圈微光。
  const waterAt = layers.findIndex(layer => layer.id === 'water');
  if (waterAt >= 0) {
    layers.splice(waterAt + 1, 0, {
      id: 'theme_water_glow', type: 'line', source: 'protomaps', 'source-layer': 'water', minzoom: 8,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'line-color': p['water-line'], 'line-opacity': 0.3,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2, 12, 6, 15, 12],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 8, 3, 12, 8, 15, 14] }
    });
  }
  // 路网光晕：在原线层之下复制一层宽、模糊、半透明的同色线。高速/国道最强，省道次之，
  // 县乡道/匝道从 Z12 起带弱光晕（参考稿里路网密度是画面质感的一半，乡道不能全暗）。
  const GLOW = {
    highway: { color: p['road-highway'], opacity: 0.26, w: [4, 11, 20], minzoom: 8 },
    major: { color: p.glow, opacity: 0.4, w: [3, 8, 14], minzoom: 8 },
    minor: { color: p.glow, opacity: 0.25, w: [0, 4, 9], minzoom: 12 },
    link: { color: p.glow, opacity: 0.25, w: [0, 4, 9], minzoom: 13 }
  };
  const glowKind = id => id.includes('highway') ? 'highway' : id.includes('major') ? 'major' : id.includes('minor') ? 'minor' : id.includes('link') ? 'link' : null;
  for (const id of ['roads_highway', 'roads_major', 'roads_minor', 'roads_link',
    'roads_bridges_highway', 'roads_bridges_major', 'roads_bridges_minor', 'roads_bridges_link']) {
    const i = layers.findIndex(layer => layer.id === id);
    const g = GLOW[glowKind(id)];
    if (i < 0 || !g) continue;
    const base = layers[i];
    // 原层没有 layout/filter 时不能写 undefined，MapLibre 校验会整份样式拒收。
    layers.splice(i, 0, {
      id: `${id}_glow`, type: 'line', source: 'protomaps', 'source-layer': 'roads', minzoom: g.minzoom,
      ...(base.filter ? { filter: base.filter } : {}),
      layout: { 'line-cap': 'round', 'line-join': 'round', ...(base.layout || {}) },
      paint: { 'line-color': g.color, 'line-opacity': g.opacity,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, g.w[0], 12, g.w[1], 15, g.w[2]],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 8, 4, 12, 8, 15, 14] }
    });
  }
}

/* 运行时生成地块纹理并注册到地图。样式里引用了 theme-tex-* 图片名；MapLibre 找不到时触发
   styleimagemissing，这里用 canvas 画一张 128px（pixelRatio 2 → 64 css px）无缝平铺纹理交给它。
   纹理全部半透明，只叠在色块之上加"颗粒"，不改变颜色阶梯。 */
export function installThemeImages(map) {
  map.on('styleimagemissing', event => {
    const kind = /^theme-tex-(\w+)$/.exec(event.id)?.[1];
    if (!kind || map.hasImage(event.id)) return;
    const image = makeTexture(kind);
    if (image) map.addImage(event.id, image, { pixelRatio: 2 });
  });
}

function makeTexture(kind) {
  // 256px 画布按 pixelRatio 2 贴上去是 128 个 CSS 像素一循环；再小就能看出重复。
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  let seed = kind === 'farm' ? 11 : kind === 'urban' ? 23 : 37;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  // 无缝：每个图元在 ±size 的九宫格位置各画一次，越界部分自然接到对面。
  const wrap = (x, y, draw) => { for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) draw(x + dx, y + dy); };
  if (kind === 'farm') {
    // 田垄：斜向细条纹，亮暗交替；再叠几条更暗的田埂线做地块边。
    ctx.save(); ctx.translate(size / 2, size / 2); ctx.rotate(-Math.PI / 7); ctx.translate(-size, -size);
    for (let y = 0; y < size * 2; y += 4) {
      ctx.fillStyle = 'rgba(170,215,230,.08)'; ctx.fillRect(0, y, size * 2, 1);
      ctx.fillStyle = 'rgba(0,12,24,.2)'; ctx.fillRect(0, y + 2, size * 2, 1);
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(0,10,20,.22)'; ctx.lineWidth = 1.5;
    for (let i = 0; i < 6; i++) { const x = Math.floor(rand() * size); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 8, size); ctx.stroke(); }
  } else if (kind === 'urban') {
    // 城区：密集的亮暗颗粒，像屋顶和街巷的反光。
    for (let i = 0; i < 2000; i++) {
      const x = rand() * size, y = rand() * size, r = 0.6 + rand() * 1.4;
      const light = rand() < 0.55;
      ctx.fillStyle = light ? 'rgba(200,225,255,.14)' : 'rgba(0,10,26,.28)';
      wrap(x, y, (px, py) => { ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill(); });
    }
  } else if (kind === 'forest') {
    // 林地/湿地：团块状明暗，像树冠和水洼。
    for (let i = 0; i < 260; i++) {
      const x = rand() * size, y = rand() * size, r = 2 + rand() * 5;
      ctx.fillStyle = rand() < 0.4 ? 'rgba(90,170,150,.1)' : 'rgba(0,20,20,.24)';
      wrap(x, y, (px, py) => { ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill(); });
    }
  } else return null;
  return ctx.getImageData(0, 0, size, size);
}
