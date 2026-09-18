/* 程序化高程瓦片（装饰用）。
   东营是黄河三角洲平原，真实 DEM 画出来没有起伏；大屏要的"山感"只能是假地形。
   这里按世界坐标取分形噪声生成 Terrarium 编码的高程瓦片，走 MapLibre 自带 hillshade 图层渲染，
   山影随地图平移缩放、瓦片之间无缝。全部在本机算，没有任何网络请求。
   注意：这不是地形数据，图层透明度必须压低到只读成"质感"，不能让值班员以为这里真有山。 */
const TILE = 256;

function hash(ix, iy) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = t => t * t * (3 - 2 * t);
function valueNoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(x - ix), fy = smooth(y - iy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(x, y, octaves) {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < octaves; o++) { sum += valueNoise(x * f, y * f) * amp; norm += amp; amp *= 0.5; f *= 2.1; }
  return sum / norm;
}
/* u,v 是 0–1 的世界坐标（Web Mercator 瓦片空间）。F 决定山体尺度：2600 ≈ 15 公里一道起伏。 */
export function elevationAt(u, v) {
  const F = 2600;
  const base = fbm(u * F, v * F, 4);
  const ridge = 1 - Math.abs(fbm(u * F * 0.55 + 17.3, v * F * 0.55 + 41.7, 3) * 2 - 1);
  // 细起伏：尺度约 1 公里、幅度小，市级视图看不出来，放大到乡镇级后山影仍有质感。
  const micro = fbm(u * F * 14 + 3.1, v * F * 14 + 9.7, 2);
  return (base - 0.5) * 900 + (ridge - 0.5) * 700 + (micro - 0.5) * 90;
}

function encode(canvas, z, x, y) {
  const n = 2 ** z;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(TILE, TILE);
  const d = img.data;
  for (let j = 0; j < TILE; j++) {
    for (let i = 0; i < TILE; i++) {
      // Terrarium：高程 = R*256 + G + B/256 - 32768
      const e = elevationAt((x + i / TILE) / n, (y + j / TILE) / n) + 32768;
      const whole = Math.floor(e);
      const k = (j * TILE + i) * 4;
      d[k] = whole >> 8; d[k + 1] = whole & 255; d[k + 2] = Math.floor((e - whole) * 256); d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/* maplibre.addProtocol('procdem', proceduralDemTile)；地址形如 procdem://z/x/y。
   永不抛错：生成失败就给一张平地瓦片，否则 map.js 会把整张底图降级成示意图。 */
export async function proceduralDemTile(params) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILE;
  const m = /^procdem:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url || '');
  try {
    if (m) encode(canvas, Number(m[1]), Number(m[2]), Number(m[3]));
    else { const ctx = canvas.getContext('2d'); ctx.fillStyle = 'rgb(128,0,0)'; ctx.fillRect(0, 0, TILE, TILE); }
  } catch { /* 留平地 */ }
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  return { data: await blob.arrayBuffer() };
}
