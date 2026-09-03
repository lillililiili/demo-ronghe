// 联网开发机的一次性备图工具。只代理固定官方版本的 Range 请求；运行完立即关闭。
import http from 'node:http';
import path from 'node:path';
import { access, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const [cli, output] = process.argv.slice(2);
if (!cli || !output || !path.isAbsolute(output)) throw new Error('用法：node tools/extract-map.mjs <pmtiles工具路径> <新地图包绝对路径>');
try { await access(output); throw new Error('目标文件已存在，请选择新的版本文件，不覆盖正在使用的地图包'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(path.dirname(output), { recursive: true });
const source = 'https://build.protomaps.com/20260902.pmtiles';
let retries = 0;
const server = http.createServer(async (req, res) => {
  if (req.url !== '/dongying-source.pmtiles' || !/^bytes=\d+-\d+$/.test(req.headers.range || '')) {
    res.writeHead(400).end('Only bounded Range requests are supported'); return;
  }
  const range = req.headers.range;
  const [start, end] = range.slice(6).split('-').map(Number);
  if (end - start > 64 * 1024 * 1024) { res.writeHead(413).end(); return; }
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await fetch(source, { headers: { Range: range }, signal: AbortSignal.timeout(30000) });
      if (response.status !== 206) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length !== end - start + 1) throw new Error('Incomplete range');
      res.writeHead(206, { 'Content-Range': response.headers.get('content-range'), 'Content-Length': data.length, 'Accept-Ranges': 'bytes' });
      res.end(data); return;
    } catch (error) {
      if (attempt === 7) { console.error(error.message); res.writeHead(502).end('Official source unavailable'); return; }
      retries++;
      await new Promise(resolve => setTimeout(resolve, Math.min(5000, 500 * 2 ** attempt)));
    }
  }
});
server.listen(0, '127.0.0.1', () => {
  const child = spawn(cli, ['extract', `http://127.0.0.1:${server.address().port}/dongying-source.pmtiles`, output,
    '--bbox=117.914,36.737,119.508,38.356', '--maxzoom=15', '--download-threads=2', '--overfetch=0.2'], { stdio: 'inherit', windowsHide: true });
  const finish = code => { server.close(); server.closeAllConnections(); process.exitCode = code; console.log(`Official source retries: ${retries}`); };
  child.on('error', error => { console.error(error.message); finish(1); });
  child.on('exit', code => finish(code ?? 1));
});
