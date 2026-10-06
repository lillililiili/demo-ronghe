// 按后台上传校验（MapPackageValidator）的同一口径核对随仓库提供的离线地图包：
// 根目录须有 manifest.json 与 checksums.json，除 checksums.json 外每个文件都登记且字节数、SHA-256 一致。
// 用法：node tools/check-map-package.cjs [地图包目录 ...]；不带参数时检查 ../map-data 下的全部地图包。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

function walk(dir, root = dir, out = new Map()) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) walk(file, root, out);
    else if (item.isFile()) {
      const name = path.relative(root, file).split(path.sep).join('/');
      if (name !== 'checksums.json') out.set(name, file);
    }
  }
  return out;
}

function problemsOf(root) {
  const problems = [];
  for (const name of ['manifest.json', 'checksums.json']) {
    if (!fs.existsSync(path.join(root, name))) problems.push(`缺少 ${name}`);
  }
  if (problems.length) return problems;
  const checksums = JSON.parse(fs.readFileSync(path.join(root, 'checksums.json'), 'utf8'));
  if (String(checksums.algorithm).toUpperCase() !== 'SHA-256') problems.push('checksums.json 仅支持 SHA-256');
  if (!Array.isArray(checksums.files) || !checksums.files.length) return [...problems, 'checksums.json 缺少 files'];
  const actual = walk(root);
  const seen = new Set();
  for (const item of checksums.files) {
    const name = String(item.path || '').replace(/^\.\//, '');
    if (seen.has(name.toLowerCase())) { problems.push(`重复登记：${name}`); continue; }
    seen.add(name.toLowerCase());
    const file = actual.get(name);
    if (!file) { problems.push(`登记了不存在的文件：${name}`); continue; }
    actual.delete(name);
    const bytes = fs.statSync(file).size;
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (bytes !== item.bytes || sha256 !== String(item.sha256).toLowerCase()) {
      problems.push(`文件校验失败：${name}（登记 ${item.bytes} 字节 ${item.sha256}，实际 ${bytes} 字节 ${sha256}）`);
    }
  }
  for (const name of actual.keys()) problems.push(`未登记校验和的文件：${name}`);
  return problems;
}

const mapData = path.join(__dirname, '../../map-data');
const packages = process.argv.length > 2
  ? process.argv.slice(2).map(dir => path.resolve(dir))
  : fs.readdirSync(mapData, { withFileTypes: true })
    .filter(item => item.isDirectory() && fs.existsSync(path.join(mapData, item.name, 'manifest.json')))
    .map(item => path.join(mapData, item.name));
assert.ok(packages.length > 0, '没有找到地图包');
for (const root of packages) {
  const problems = problemsOf(root);
  assert.deepEqual(problems, [], `${root}：\n${problems.join('\n')}\n修改包内文件后须重新生成 checksums.json`);
  console.log(`地图包校验和一致：${path.basename(root)}`);
}
