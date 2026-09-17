// 项目自有矢量原稿；依据用户确认的无框鲜彩图标样式制作。运行：node tools/build-business-icons.mjs
// 颜色取自 tokens.css。只生成透明 SVG，不截取预览板、不引入字体或外部资源。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const tokens = readFileSync(path.join(root, 'src/assets/css/tokens.css'), 'utf8');
const color = key => {
  const value = tokens.match(new RegExp(`--icon-${key}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  if (!value) throw new Error(`Missing icon token: ${key}`);
  return value;
};
const P = (d, fill = 'url(#body)', more = '') => `<path d="${d}" fill="${fill}" ${more}/>`;
const L = d => P(d, 'none', 'stroke="url(#edge)" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"');
const R = (x,y,w,h,r=3,fill='url(#body)') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;
const E = (x,y,rx,ry,fill='url(#body)',more='') => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}" ${more}/>`;
const light = '#c8f5ff', glass = '#21ceff';
const base = P('M22 48H42L47 59H17Z') + P('M21 51H43L45 56H19Z','url(#shine)') + R(26,43,12,9,2);
const mast = R(29,17,6,37,2) + P('M30 20V50','none','stroke="#ffffff" stroke-opacity=".7" stroke-width="1.5"');
const lens = (x,y,r) => E(x,y,r,r,'url(#edge)')+E(x,y,r-2,r-2,glass)+E(x-1,y-2,Math.max(1,r/3),Math.max(1,r/2),light);
const box = P('M7 23L20 16L56 22V50L44 57L7 51Z') + P('M7 23L44 29L56 22L20 16Z','url(#shine)') + P('M44 29L56 22V50L44 57Z','url(#edge)');
const antenna = (x,y,h) => R(x,y,3,h,1.5)+R(x,y,1,h,0,light);
const paths = {
  radar: base + P('M30 46L24 30L31 26L38 47Z') + `<g transform="rotate(-36 26 25)">${E(26,25,12,21)}${E(26,25,9,19,'url(#shine)')}${P('M18 10Q22 33 34 40','none','stroke="white" stroke-opacity=".75" stroke-width="1.5"')}${L('M26 25L40 17')}${E(41,16,3,3)}</g>` + L('M42 5Q57 7 59 23M43 13Q50 15 51 23'),
  eo: base + R(27,33,10,17) + R(9,14,46,26,9) + E(11,27,8,13) + E(51,27,10,13,'url(#shine)') + lens(15,27,7) + lens(37,26,13) + lens(53,27,7) + P('M17 15Q29 9 46 16','none','stroke="#fff3b7" stroke-width="2"'),
  tdoa: base + mast + L('M8 34L31 38L56 31M32 38V14') + R(3,20,10,20) + R(51,17,10,20) + R(27,3,10,19) + E(8,20,5,2,'url(#shine)') + E(56,17,5,2,'url(#shine)') + E(32,3,5,2,'url(#shine)') + R(28,32,9,9,2,'url(#shine)'),
  aoa: L('M31 34L12 58M33 34L51 58M32 34V60M11 29L53 29') + R(29,10,6,32) + `<g transform="rotate(-15 12 21)">${R(5,8,13,27)}${R(7,10,3,22,1,'url(#shine)')}</g>` + `<g transform="rotate(15 52 21)">${R(46,8,13,27)}${R(48,10,3,22,1,'url(#shine)')}</g>` + R(28,3,8,21) + R(25,29,15,8,2,'url(#shine)'),
  '5ga': L('M32 9L17 57H47L32 9M22 41L41 30M23 29L42 42M19 54L43 42M23 29H41M26 19H38') + R(14,56,36,5,2) + R(29,2,6,20,2) + R(25,22,14,14,3) + E(32,27,3,3,light) + L('M14 12Q3 25 14 38M19 17Q12 25 19 33M50 12Q61 25 50 38M45 17Q52 25 45 33'),
  spec: box + antenna(48,2,21) + R(12,29,27,18,2,glass) + P('M14 40L18 40L21 32L24 44L28 35L32 40H36','none','stroke="#b7ffff" stroke-width="2"') + R(47,32,6,3,1,light) + R(47,40,6,3,1,light) + R(11,52,5,5,1) + R(44,55,6,4,1),
  cm: base + R(27,35,10,14) + P('M8 17L24 9L58 15V35L42 43L8 36Z') + P('M8 17L42 23L58 15L24 9Z','url(#shine)') + P('M42 23L58 15V35L42 43Z','url(#edge)') + lens(19,27,10) + lens(34,28,6),
  dec: P('M10 36L23 30L49 36V56L36 61L10 55Z') + P('M10 36L36 42L49 36L23 30Z','url(#shine)') + antenna(19,4,31) + R(14,42,6,8,1,glass) + L('M30 46H41M30 51H41') + P('M27 28L48 13M29 29L51 30','none','stroke="url(#edge)" stroke-width="2.5" stroke-dasharray="4 3"') + P('M44 9L55 8L50 19ZM49 25L59 31L49 35Z'),
  ifr: box + antenna(13,4,19)+antenna(25,1,20)+antenna(38,6,17)+antenna(50,2,21) + [13,19,25,31,37].map(x=>R(x,31,3,18,1,'url(#edge)')).join('') + R(48,31,5,10,1,'url(#shine)'),
  cv: P('M4 32L10 23H47L58 35V52H4Z') + R(10,33,46,17,3) + R(13,27,12,10,1,glass)+R(28,27,12,10,1,glass)+P('M44 27H47L54 36H44Z',glass) + L('M27 27V48M42 29V49') + E(16,52,7,7,'url(#edge)')+E(16,52,4,4,light)+E(48,52,7,7,'url(#edge)')+E(48,52,4,4,light)+R(23,18,18,5,2)+P('M29 18L26 9L31 7L35 19Z')+`<g transform="rotate(-35 28 8)">${E(28,8,9,4,'url(#shine)')}</g>`+antenna(47,7,15),
  isrs: L('M23 59L29 32H36L43 59M26 45L40 55M37 44L26 55') + R(18,8,34,19,3) + P('M18 8L23 4H56L52 8Z','url(#shine)') + P('M52 8L56 4V24L52 27Z','url(#edge)') + R(23,11,25,12,1,glass) + R(24,29,17,15,4) + lens(34,36,6),
  dcd: R(8,17,47,33,6) + R(12,21,39,25,3,'url(#shine)') + [22,31,40].map(y=>L(`M3 ${y}H9M55 ${y}H61`)).join('') + P('M23 25H20V31L17 34L20 37V42H23M42 25H45V31L48 34L45 37V42H42','none','stroke="white" stroke-width="2.5"') + L('M30 27V32M35 27V32M30 37V41M35 37V41') + R(13,12,6,5,1)+R(44,12,6,5,1),
  bsc: base + R(27,34,10,16) + P('M7 21L45 8V44L7 35Z') + E(45,26,12,20,'url(#shine)')+E(46,26,9,17,'url(#body)')+P('M47 11Q35 25 47 41','none','stroke="url(#edge)" stroke-width="3"')+P('M10 24L32 17','none','stroke="#fff4a1" stroke-width="3"'),
  rid: R(6,34,35,23,4) + P('M6 34L12 30H45L41 34Z','url(#shine)') + antenna(11,8,26) + E(14,44,3,3,'url(#edge)') + E(24,44,3,3,'url(#edge)') + R(30,39,29,19,3,glass)+E(38,45,3,3,light)+P('M32 54Q38 45 44 54Z',light)+R(47,43,8,2,1,light)+R(47,48,8,2,1,light)+L('M28 16Q41 5 54 16M33 22Q41 16 49 22')+E(41,27,2,2),
  fusion: box + [12,19,26,33,40].map(x=>R(x,28,3,25,1,'url(#edge)')).join('') + R(47,32,6,10,1,glass) + L('M20 18L12 7M31 17V3M41 19L51 7') + E(11,6,4,4,'url(#shine)')+E(31,3,3,3)+E(52,6,4,4),
  uav: L('M29 28L14 14M35 28L50 14M29 37L14 50M35 37L50 50') + [[14,14],[50,14],[14,50],[50,50]].map(([x,y])=>`<g transform="rotate(-45 ${x} ${y})">${E(x,y,13,3,'url(#shine)')}${E(x,y,5,5,'url(#edge)')}${E(x,y,2.5,2.5,light)}</g>`).join('') + R(24,17,16,31,8,'url(#shine)') + R(28,21,8,20,4,glass)+E(32,26,2,3,light),
  bird: P('M30 22C23 18 13 23 3 13C3 24 8 31 20 34L10 33Q15 40 27 37L23 53L32 58L41 53L37 37Q49 40 54 33L44 34C56 31 61 24 61 13C51 23 41 18 34 22L35 13L32 5L29 13Z') + P('M31 21Q26 37 32 49Q38 37 33 21Z','url(#shine)') + P('M8 23L24 28M13 30L24 32M56 23L40 28M51 30L40 32M27 51L30 43M37 51L34 43','none','stroke="url(#edge)" stroke-width="1.5"'),
  balloon: E(32,24,19,22)+P('M32 4Q53 24 32 44Q41 24 32 4Z','url(#edge)')+E(24,14,5,7,'url(#shine)','transform="rotate(35 24 14)"')+P('M32 44L27 49H37Z')+P('M32 49C22 54 41 57 30 62','none','stroke="url(#edge)" stroke-width="2"'),
  kite: P('M32 3L55 25L32 48L9 25Z')+P('M32 3L9 25H32Z','url(#shine)')+P('M32 25H55L32 48Z','url(#edge)')+P('M32 4V48M10 25H54','none','stroke="#fff7b0" stroke-width="1.8"')+P('M32 47C18 55 48 51 37 62','none','stroke="url(#edge)" stroke-width="3"'),
  lantern: P('M17 9Q32 0 47 9L53 18L45 50Q32 59 19 50L11 18Z')+P('M18 11L23 47Q32 42 40 47L45 11Q32 3 18 11Z','url(#shine)')+E(32,49,13,7,'url(#body)')+E(32,49,10,5,'url(#shine)')+P('M32 40C22 51 31 54 35 50C39 47 32 45 32 40Z','#fff6a6'),
  nest: P('M4 34L29 24L60 33V51L34 62L4 51Z')+P('M4 34L34 44L60 33L29 24Z','url(#shine)')+P('M34 44V62L60 51V33Z','url(#edge)')+R(12,46,13,4,2,glass)+P('M4 34L8 16L27 5L30 10L14 28Z')+P('M7 29L11 17L26 9L24 15Z','url(#shine)')+P('M43 5L59 18L60 33L53 30L40 11Z')+P('M43 10L56 20L57 28L52 25Z','url(#shine)')+E(33,35,18,7,glass)+L('M26 33L41 38M26 38L41 33')+E(26,33,3,1.5,light)+E(41,33,3,1.5,light)+E(26,38,3,1.5,light)+E(41,38,3,1.5,light)+R(30,30,7,10,3,'url(#shine)'),
  unknown: P('M17 18C17 0 50 0 49 19C49 28 37 31 36 37H27C27 25 40 24 40 17C40 9 26 9 26 18Z')+E(31.5,49,5,5,'url(#shine)'),
  'unknown-device': box+P('M19 35C19 27 36 28 35 36C35 41 29 41 28 45H23C23 38 30 38 30 35C30 32 24 32 24 35Z',light)+E(25.5,49,2,2,light)
};
const output = path.join(root, 'public/assets/img/business');
mkdirSync(output, { recursive: true });
for (const [key, geometry] of Object.entries(paths)) {
  const ink = color(key);
  const tint = amount => '#' + ink.slice(1).match(/../g).map(v => Math.round(parseInt(v,16)*(1-amount)+255*amount).toString(16).padStart(2,'0')).join('');
  const shade = '#' + ink.slice(1).match(/../g).map(v => Math.round(parseInt(v,16)*.93).toString(16).padStart(2,'0')).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><defs><linearGradient id="body" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${tint(.08)}"/><stop offset=".45" stop-color="${ink}"/><stop offset="1" stop-color="${shade}"/></linearGradient><linearGradient id="shine" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#ffffff"/><stop offset=".22" stop-color="${ink}"/><stop offset="1" stop-color="${ink}"/></linearGradient><linearGradient id="edge" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${ink}"/><stop offset="1" stop-color="${shade}"/></linearGradient></defs><g stroke="#eaffff" stroke-width=".65" stroke-linejoin="round" paint-order="stroke fill">${geometry}</g></svg>\n`;
  writeFileSync(path.join(output, `${key}.svg`), svg);
}
console.log(`Generated ${Object.keys(paths).length} owned transparent business SVGs.`);
