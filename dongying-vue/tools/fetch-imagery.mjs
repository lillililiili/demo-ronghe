#!/usr/bin/env node
/* 离线影像瓦片下载器。
   在有外网的机器上跑一次，把某个 XYZ/WMTS 影像源在指定范围、指定缩放级别内的瓦片
   存成静态目录 {out}/{z}/{x}/{y}.jpg，随程序部署；运行时地图直接读同源静态文件，不需要网络。
   换影像来源只需要换 --template，代码不用改。

   用法：
     node tools/fetch-imagery.mjs \
       --template "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg" \
       --bounds 117.914,36.737,119.508,38.356 --zoom 7-12 --out ../map-data/dongying-dev/imagery

   占位符 {z} {x} {y}；有的服务是 {z}/{y}/{x} 顺序，按服务文档写模板即可。 */
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]] : []).filter(Boolean));
const template = args.template;
const bounds = (args.bounds || '').split(',').map(Number);
const [zMin, zMax] = (args.zoom || '7-12').split('-').map(Number);
const out = path.resolve(args.out || 'imagery');
const concurrency = Number(args.concurrency || 6);
if (!template || bounds.length !== 4 || bounds.some(Number.isNaN)) {
  console.error('需要 --template 和 --bounds minLon,minLat,maxLon,maxLat');
  process.exit(1);
}

function tileX(lon, z) { return Math.floor((lon + 180) / 360 * 2 ** z); }
function tileY(lat, z) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z);
}

const jobs = [];
for (let z = zMin; z <= zMax; z++) {
  const x0 = tileX(bounds[0], z), x1 = tileX(bounds[2], z);
  const y0 = tileY(bounds[3], z), y1 = tileY(bounds[1], z);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push({ z, x, y });
}
console.log(`共 ${jobs.length} 张瓦片，Z${zMin}–Z${zMax}，输出到 ${out}`);

let done = 0, skipped = 0, failed = 0, bytes = 0;
async function fetchTile({ z, x, y }) {
  const file = path.join(out, String(z), String(x), `${y}.jpg`);
  if (fs.existsSync(file)) { skipped++; return; }
  const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      bytes += buf.length; done++;
      return;
    } catch (error) {
      if (attempt === 3) { failed++; console.error(`失败 ${z}/${x}/${y}: ${error.message}`); }
      else await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

let cursor = 0;
async function worker() { while (cursor < jobs.length) await fetchTile(jobs[cursor++]); }
const started = Date.now();
await Promise.all(Array.from({ length: concurrency }, worker));
console.log(`完成 ${done} 张，跳过 ${skipped} 张，失败 ${failed} 张，${(bytes / 1048576).toFixed(1)} MB，用时 ${((Date.now() - started) / 1000).toFixed(0)} 秒`);
process.exit(failed ? 2 : 0);
