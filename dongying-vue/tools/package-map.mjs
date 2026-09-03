// 把已下载的官方资源打成外置、可审计的开发地图包；不会写入 public/dist。
import { cp, mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [cli, archive, assets, originalStyle] = process.argv.slice(2);
if (!originalStyle || !path.isAbsolute(archive)) throw new Error('用法：node tools/package-map.mjs <pmtiles工具> <pmtiles绝对路径> <官方资源解压目录> <官方样式JSON>');
execFileSync(cli, ['verify', archive], { stdio: 'inherit', windowsHide: true });
const output = path.dirname(archive);
const header = JSON.parse(execFileSync(cli, ['show', archive, '--header-json'], { encoding: 'utf8', windowsHide: true }));
const metadata = JSON.parse(execFileSync(cli, ['show', archive, '--metadata'], { encoding: 'utf8', windowsHide: true }));
const style = JSON.parse(await readFile(originalStyle, 'utf8'));
style.sources = { protomaps: { type: 'vector', url: `pmtiles:///map-data/dongying-dev/${path.basename(archive)}`, attribution: '© OpenStreetMap contributors · Protomaps' } };
style.glyphs = './fonts/{fontstack}/{range}.pbf';
style.sprite = './sprites/light';
// 官方通用 PBF 的汉字范围是空文件，额外携带完整 SC 字体保证纯内网中文。
style['font-faces'] = Object.fromEntries(['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'].map(name => [name, [
  { url: './fonts/NotoSansSC-Regular.otf', 'unicode-range': ['U+2E80-9FFF', 'U+F900-FAFF', 'U+FF00-FFEF'] }
]]));
await stat(path.join(output, 'fonts/NotoSansSC-Regular.otf'));
for (const layer of style.layers) {
  const icon = layer.layout?.['icon-image'];
  if (icon && !JSON.stringify(icon).includes('"zoom"')) layer.layout['icon-image'] = ['coalesce', ['image', icon], ['image', 'townspot']];
}
await cp(path.join(assets, 'fonts'), path.join(output, 'fonts'), { recursive: true });
await mkdir(path.join(output, 'sprites'), { recursive: true });
await mkdir(path.join(output, 'sources'), { recursive: true });
for (const name of ['light.json', 'light.png', 'light@2x.json', 'light@2x.png']) {
  await cp(path.join(assets, 'sprites/v4', name), path.join(output, 'sprites', name));
}
for (const file of await readdir(path.join(assets, 'sprites'))) {
  if (/license/i.test(file)) await cp(path.join(assets, 'sprites', file), path.join(output, 'sources', file));
}
const save = (name, data) => writeFile(path.join(output, name), JSON.stringify(data, null, 2) + '\n');
await save('style.json', style);
await save('sources/header.json', header);
await save('sources/metadata.json', metadata);
await cp(originalStyle, path.join(output, 'sources/style-original.json'));
await writeFile(path.join(output, 'SOURCES.txt'), [
  '东营开发用离线地图；非生产测绘成果。坐标：WGS-84。',
  '数据：Protomaps 20260902.pmtiles / tileset 4.15.2；样式：@protomaps/basemaps 5.7.2 light，zh-Hans；图标 v4。',
  '提取范围：117.914,36.737,119.508,38.356；Z0–Z15。Z16–Z18 为已有数据放大，不增加细节。',
  '来源：https://build.protomaps.com/20260902.pmtiles',
  '官方原包 BLAKE3：0f7860f75647583b49cd22fc344298023b501892d8d8f2c8466337072d0c1062（发布清单值；未下载全球包复算）',
  '样式：https://npm-style.protomaps.dev/style.json?version=5.7.2&theme=light&tiles=https://build.protomaps.com/20260902.pmtiles&lang=zh-Hans',
  '字体/图标：https://github.com/protomaps/basemaps-assets；字体许可见 fonts/OFL.txt，图标许可见 sources。',
  '中文字体：Noto Sans SC Regular 2.004，https://github.com/notofonts/noto-cjk/tree/Sans2.004，SIL OFL；本地 OTF 字体，不依赖操作系统字体。',
  '© OpenStreetMap contributors；OSM 数据采用 ODbL：https://www.openstreetmap.org/copyright',
  'Protomaps 底图及样式：https://github.com/protomaps/basemaps（BSD-3-Clause）；数据来源还包括 Natural Earth 等，见 sources/metadata.json。',
  '全量哈希见 checksums.json；变更地图、样式或字体后必须重新生成并检查。'
].join('\n') + '\n');
const manifest = { version: 1, coordinateSystem: 'WGS84', name: '东营开发底图', dataVersion: '20260902', tilesetVersion: '4.15.2', styleVersion: '5.7.2',
  archive: `./${path.basename(archive)}`, style: './style.json', bounds: [117.914, 36.737, 119.508, 38.356], minZoom: 0, maxZoom: 15, displayMaxZoom: 18 };
await save('manifest.json', manifest);
const files = [];
async function scan(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) await scan(file);
    else if (item.name !== 'checksums.json' && (!item.name.endsWith('.pmtiles') || path.resolve(file) === path.resolve(archive))) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      files.push({ path: path.relative(output, file).split(path.sep).join('/'), bytes: (await stat(file)).size, sha256: hash.digest('hex') });
    }
  }
}
await scan(output);
await save('checksums.json', { algorithm: 'SHA-256', files });
console.log(JSON.stringify({ output, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), header }));
