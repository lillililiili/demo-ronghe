// Export the same vector data to cacheable XYZ files for a static deployment.
// Usage: node tools/export-map-xyz.mjs <validated package directory> <new output directory>
import { readFile, mkdir, writeFile, cp, readdir } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { PMTiles, tileIdToZxy } from 'pmtiles';

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) throw new Error('Usage: export-map-xyz.mjs <source package> <new output directory>');
const sourcePath = resolve(sourceArg), outputPath = resolve(outputArg);
if (outputPath === sourcePath || outputPath.startsWith(sourcePath + sep)) throw new Error('Output must be a new directory outside the source package');
execFileSync(process.execPath, [fileURLToPath(new URL('./check-map-package.cjs', import.meta.url)), sourcePath], { stdio: 'inherit' });
const manifest = JSON.parse(await readFile(join(sourcePath, 'manifest.json'), 'utf8'));
const archivePath = resolve(sourcePath, manifest.archive);
if (!archivePath.startsWith(sourcePath + sep)) throw new Error('Archive must be inside the package');
const bytes = await readFile(archivePath);
const source = {
  getKey: () => archivePath,
  getBytes: async (offset, length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || offset >= bytes.length) throw new Error('Invalid archive range');
    return { data: bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + Math.min(offset + length, bytes.length)) };
  }
};
const archive = new PMTiles(source), header = await archive.getHeader();
if (header.tileType !== 1 || header.maxZoom < 15) throw new Error('Expected Z0-Z15 vector archive');
// A new directory is required: never overwrite a deployed map package.
await mkdir(outputPath);
for (const item of await readdir(sourcePath)) {
  await cp(join(sourcePath, item), join(outputPath, item), { recursive: true, force: false, errorOnExist: true });
}
await mkdir(join(outputPath, 'xyz'));
let tiles = 0;
async function exportDirectory(offset, length, depth = 0) {
  if (depth > 3) throw new Error('Unexpected directory nesting');
  const entries = await archive.cache.getDirectory(source, offset, length, header);
  for (const entry of entries) {
    if (!entry.runLength) {
      await exportDirectory(header.leafDirectoryOffset + entry.offset, entry.length, depth + 1);
      continue;
    }
    const raw = await source.getBytes(header.tileDataOffset + entry.offset, entry.length);
    const data = Buffer.from(await archive.decompress(raw.data, header.tileCompression));
    const compressed = gzipSync(data);
    for (let i = 0; i < entry.runLength; i++) {
      const [z, x, y] = tileIdToZxy(entry.tileId + i);
      const dir = join(outputPath, 'xyz', String(z), String(x));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${y}.pbf`), data, { flag: 'wx' });
      await writeFile(join(dir, `${y}.pbf.gz`), compressed, { flag: 'wx' });
      tiles++;
    }
  }
}
await exportDirectory(header.rootDirectoryOffset, header.rootDirectoryLength);
if (tiles !== header.numAddressedTiles) throw new Error(`Tile count mismatch: ${tiles} / ${header.numAddressedTiles}`);
manifest.vectorTiles = './xyz/{z}/{x}/{y}.pbf';
await writeFile(join(outputPath, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const files = [];
async function checksumDirectory(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, item.name);
    if (item.isDirectory()) await checksumDirectory(file);
    else if (item.isFile() && file !== join(outputPath, 'checksums.json')) {
      const data = await readFile(file);
      files.push({ path: relative(outputPath, file).split(sep).join('/'), bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    }
  }
}
await checksumDirectory(outputPath);
await writeFile(join(outputPath, 'checksums.json'), JSON.stringify({ algorithm: 'SHA-256', files }, null, 2) + '\n');
execFileSync(process.execPath, [fileURLToPath(new URL('./check-map-package.cjs', import.meta.url)), outputPath], { stdio: 'inherit' });
console.log(JSON.stringify({ outputPath, tiles, archiveSha256: createHash('sha256').update(bytes).digest('hex') }));
