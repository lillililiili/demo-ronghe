/** Build a standalone, read-only screenshot gallery. No backend or credentials are copied. */
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) throw new Error('Usage: node tools/build-preview-gallery.mjs <capture-directory> <output-directory>');
const source = resolve(sourceArg);
const output = resolve(outputArg);
if (source === output) throw new Error('Capture and output directories must differ.');
const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shortHash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 12);
const assetPath = page => `images/${page.id}.${page.imageHash}.png`;
const ids = new Set();
for (const page of manifest.pages) {
  if (!/^[a-z][a-z0-9-]*$/.test(page.id) || ids.has(page.id)) throw new Error('Invalid or duplicate page ID');
  ids.add(page.id);
}
for (const page of manifest.pages) {
  if (page.parent && !ids.has(page.parent)) throw new Error('Unknown parent: ' + page.parent);
  const bytes = await readFile(join(source, 'images', page.id + '.png'));
  if (bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('Invalid PNG: ' + page.id);
  page.width = bytes.readUInt32BE(16);
  page.height = bytes.readUInt32BE(20);
  page.imageHash = shortHash(bytes);
  page.captureDate = page.captureDate || manifest.date;
  if (page.width < 1280 || page.height < 720) throw new Error('Desktop capture is too small: ' + page.id);
}
await mkdir(join(output, 'images'), {recursive:true});
await mkdir(join(output, 'pages'), {recursive:true});
for (const page of manifest.pages) await copyFile(join(source, 'images', page.id + '.png'), join(output, assetPath(page)));
const cssBytes = await readFile(new URL('./preview-gallery/gallery.css', import.meta.url));
const jsBytes = await readFile(new URL('./preview-gallery/gallery.js', import.meta.url));
const cssVersion = shortHash(cssBytes);
const jsVersion = shortHash(jsBytes);
const groups = [...new Set(manifest.pages.map(p => p.group))];
const number = page => String(manifest.pages.indexOf(page) + 1).padStart(2, '0');
const find = id => manifest.pages.find(p => p.id === id);
const isRetained = page => page.captureStatus === 'retained' || page.captureDate !== manifest.date;
const retainedPages = manifest.pages.filter(isRetained);
const updateSummary = `本轮更新 ${manifest.pages.length - retainedPages.length} 项，保留旧图 ${retainedPages.length} 项。`;
const retainedList = retainedPages.length ? `<p><strong>本轮未更新页面</strong><br>${retainedPages.map(p => `<a href="pages/${p.id}.html">${escape(p.title)}</a> · 原采集日期：${escape(p.captureDate)} · ${escape(p.updateNote || '本轮未重新采集，保留原画面。')}`).join('<br>')}</p>` : '';
function shell(title, content, prefix = './') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="description" content="东营无人机平台当前开发页面预览，按模块浏览真实界面截图。"><title>${escape(title)} · 东营平台页面预览</title><link rel="stylesheet" href="${prefix}gallery.css?v=${cssVersion}"><script src="${prefix}gallery.js?v=${jsVersion}" defer></script></head><body>
  <a class="skip" href="#main">跳至主要内容</a><aside class="sidebar"><a class="brand" href="${prefix}index.html">DONGYING<span>无人机融合感知平台</span></a><p class="edition">前台与后台 · 当前开发预览</p><nav aria-label="模块导航"><a href="${prefix}index.html" data-group="全部">全部页面 <span>${manifest.pages.length}</span></a>${groups.map(g=>`<a href="${prefix}index.html#group=${encodeURIComponent(g)}" data-group="${escape(g)}">${escape(g)}<span>${manifest.pages.filter(p=>p.group===g).length}</span></a>`).join('')}</nav><div class="side-note"><strong>当前页面实拍</strong><p>电脑端原比例画面<br>页面与所属入口关联</p><a href="${prefix}说明.html">查看预览说明</a></div></aside>
  <div class="workspace"><header><a href="${prefix}index.html">业务页面库</a><div>当前预览版 <time>${escape(manifest.date)}</time><a href="${prefix}说明.html">预览说明</a></div></header><main id="main">${content}</main><footer>东营无人机平台 · 开发环境页面快照 · 数据来源及实现边界见各页说明</footer></div></body></html>`;
}
const cards = manifest.pages.map(p=>`<article class="card" data-system="${escape(p.system)}" data-category="${escape(p.group)}" data-search="${escape(p.title+' '+p.group+' '+p.entry+' '+number(p))}"><div class="card-meta"><span>${number(p)} / ${escape(p.system)} / ${escape(p.group)}</span><span class="badge">${escape(p.kind)}</span></div><a class="picture" href="pages/${p.id}.html" aria-label="查看${escape(p.title)}"><img src="${assetPath(p)}" alt="${escape(p.title)}页面截图" width="${p.width}" height="${p.height}" loading="lazy"></a><a class="card-title" href="pages/${p.id}.html">${escape(p.title)}</a><p>${escape(p.entry)}</p><p>采集日期：${escape(p.captureDate)}${isRetained(p) ? ' · 保留旧图' : ''}</p><div class="card-bottom"><span>${p.width} × ${p.height}</span><span>查看画面</span></div></article>`).join('');
await writeFile(join(output,'index.html'),shell('当前开发页面一览',`<section class="hero"><div class="eyebrow">DONGYING / WEB / CURRENT BUILD</div><span class="date-pill">预览更新 · ${escape(manifest.date)}</span><h1>当前开发页面，一览即见</h1><p>按业务模块整理当前无人机平台与管理后台，查看实际页面、关键页签与所属入口。</p><p>保留现有深蓝界面、地图和业务状态；点击画面查看清晰原图与页面说明。</p><p>${updateSummary}各页按实际采集日期标注。</p>${retainedList}<div class="metrics"><div><strong>${manifest.pages.length}</strong>页面 / 状态</div><div><strong>${groups.length}</strong>展示分组</div><div><strong>2</strong>前台 / 后台</div><div><strong>18</strong>业务模块</div></div></section>
<nav class="system-switch" aria-label="系统选择">${['全部系统','业务前台','管理后台'].map(system=>`<button data-system-filter="${system}" aria-pressed="${system==='全部系统'}">${system}<span>${system==='全部系统'?manifest.pages.length:manifest.pages.filter(p=>p.system===system).length}</span></button>`).join('')}</nav><div class="toolbar"><div class="filters" aria-label="页面分类">${['全部',...groups].map(g=>`<button data-filter="${escape(g)}" aria-pressed="${g==='全部'}">${escape(g)}</button>`).join('')}</div><div class="tools"><label class="search"><span class="sr-only">搜索页面或入口</span><input id="search" type="search" placeholder="搜索页面、入口或编号"></label><button id="relations-toggle" aria-pressed="false">页面关系</button></div></div><div class="result-line"><span id="result-count" role="status">全部 · ${manifest.pages.length} 个展示项</span><span>点击画面查看原图</span></div><section id="relations" hidden><h2>页面与入口关系</h2>${manifest.pages.filter(p=>!p.parent).map(p=>`<div class="relation-row"><a href="pages/${p.id}.html">${escape(p.title)}</a><div>${manifest.pages.filter(c=>c.parent===p.id).map(c=>`<a href="pages/${c.id}.html">${escape(c.title)}</a>`).join('') || '<span>独立页面</span>'}</div></div>`).join('')}</section><div id="cards" class="cards">${cards}</div><p id="empty" class="empty" hidden>没有匹配的页面，请调整关键词或分类。</p>`));
for (const p of manifest.pages) {
  const parent = p.parent && find(p.parent);
  const children = manifest.pages.filter(c=>c.parent===p.id);
  const index = manifest.pages.indexOf(p);
  const previous = manifest.pages[index-1], next = manifest.pages[index+1];
  const link = item => `<a class="relation-link" href="${item.id}.html"><span>${number(item)}</span>${escape(item.title)}</a>`;
  const captureDisclosure = [
    `采集日期：${escape(p.captureDate)}。`,
    p.captureDate !== manifest.date ? `此截图保留自 ${escape(p.captureDate)}，不是本轮 ${escape(manifest.date)} 更新。` : '',
    p.captureStatus ? `采集状态：${escape(p.captureStatus)}。` : '',
    p.updateNote ? escape(p.updateNote) : '',
    '保留采集时状态，不代表持续在线或最新业务结果。'
  ].filter(Boolean).join('');
  await writeFile(join(output,'pages',p.id+'.html'),shell(p.title,`<nav class="breadcrumbs" aria-label="页面路径"><a href="../index.html">全部页面</a><span>/</span>${parent?`<a href="${parent.id}.html">${escape(parent.title)}</a><span>/</span>`:''}<span>${escape(p.title)}</span></nav><div class="page-heading"><div class="eyebrow">PAGE ${number(p)} / ${escape(p.group)}</div><h1>${escape(p.title)}</h1><p>${escape(p.entry)}</p></div><div class="detail-layout"><section class="image-panel"><div class="image-tools"><button id="actual-size" aria-pressed="false">原始尺寸</button><a href="../${assetPath(p)}" target="_blank" rel="noopener">新窗口看图</a><span>${p.width} × ${p.height}</span></div><div class="image-scroll"><img id="detail-image" src="../${assetPath(p)}" alt="${escape(p.title)}实际页面画面" width="${p.width}" height="${p.height}"></div><p class="capture-note">电脑端当前视口快照 · 可切换原始尺寸查看文字</p></section><aside class="detail-notes"><section><h2>页面关系</h2><h3>所属入口</h3>${parent?link(parent):'<p>业务系统独立入口</p>'}${children.length?`<h3>子页面 / 页签 / 详情</h3>${children.map(link).join('')}`:''}</section><section><h2>当前页面说明</h2><p>${escape(p.description)}</p><code>${escape(p.route)}</code></section><section><h2>画面与数据来源</h2><p>${escape(p.source)}</p><p>${captureDisclosure}</p><p>仅展示当前视口；独立滚动区的下方内容、未展开弹层未全部收录。</p><a class="download" href="../${assetPath(p)}" download="${escape(p.title)}.png">下载页面图片</a></section></aside></div><nav class="pager" aria-label="相邻页面">${previous?`<a href="${previous.id}.html">上一页 · ${escape(previous.title)}</a>`:'<span></span>'}<a href="../index.html#group=${encodeURIComponent(p.group)}">回到${escape(p.group)}</a>${next?`<a href="${next.id}.html">下一页 · ${escape(next.title)}</a>`:'<span></span>'}</nav>`,'../'));
}
await writeFile(join(output,'说明.html'),shell('预览说明',`<article class="readme"><div class="eyebrow">ABOUT THIS PREVIEW</div><h1>预览说明</h1><p>本预览于 ${escape(manifest.date)} 更新，共 ${manifest.pages.length} 个页面或状态。${updateSummary}本轮采集依据本地工作区实际渲染，工作区版本 ${escape(manifest.revision)}；保留画面以各页原采集日期为准。</p>${retainedList}<h2>怎样浏览</h2><p>首页可按模块筛选、搜索名称或入口；点击卡片进入独立详情。详情页支持原始尺寸、下载图片、返回所属页面和切换相邻页面。</p><h2>包含哪些内容</h2><p>包含登录、融合感知、数据大屏、飞行计划、全部风险事件、合法性研判、空域管理、告警事件、反制授权与执行、移送与处罚、运行统计、证据管理；后台包含设备管理、实时监测、接入调测、地图管理、报表管理、用户与单位、通知对象配置、规则管理、角色管理及审计日志。</p><h2>截图边界</h2><p>截图为电脑端当前视口，各图标注原始像素尺寸；不把未展开的弹层或独立滚动区称为已完整采集。数据来自本地开发环境，包括模拟、回放与统计样本；以各页说明及画面标识为准，不作为真实运行、真实违法或真实设备执行证明。</p><h2>公开展示范围</h2><p>站点仅包含静态页面和截图，不包含账号密码、登录会话、数据库或业务 API。画面内按钮仅为截图内容，不能执行通知、反制、审批或处罚。</p><h2>更新时间</h2><p>这是本次采集的固定快照。业务系统后续修改后，需要重新采集和发布预览。</p><a class="download" href="index.html">返回页面总览</a></article>`));
await writeFile(join(output,'gallery.css'),cssBytes);
await writeFile(join(output,'gallery.js'),jsBytes);
console.log(`Generated ${manifest.pages.length} pages in ${output}`);
