/* 装饰山影在独立 Worker 中生成；短期缓存只保存静态纹理，不缓存业务状态。 */
import { renderTerrainTile } from './proceduralTerrainTile';
export { elevationAt } from './proceduralTerrainTile';

const tiles = new Map();
const pending = new Map();
const CACHE_SIZE = 32;
let worker;
let workerUnavailable = false;
let sequence = 0;
let idleTimer;

function scheduleWorkerCleanup() {
  clearTimeout(idleTimer);
  if (pending.size || !worker) return;
  idleTimer = setTimeout(() => {
    worker?.terminate();
    worker = null;
  }, 30000);
}

function getWorker() {
  if (workerUnavailable || typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./proceduralTerrain.worker.js', import.meta.url), { type: 'module' });
  } catch { workerUnavailable = true; return null; }
  worker.onmessage = ({ data }) => {
    const task = pending.get(data.id);
    if (!task) return;
    pending.delete(data.id);
    if (data.error) task.reject(new Error(data.error));
    else task.resolve(data.buffer);
    scheduleWorkerCleanup();
  };
  worker.onerror = event => {
    event.preventDefault();
    worker.terminate();
    worker = null;
    workerUnavailable = true;
    for (const task of pending.values()) task.reject(new Error('地图纹理 Worker 不可用'));
    pending.clear();
    clearTimeout(idleTimer);
  };
  return worker;
}

function generateTile(url) {
  const current = getWorker();
  if (!current) return renderTerrainTile(url);
  clearTimeout(idleTimer);
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    current.postMessage({ id, url });
  }).catch(() => renderTerrainTile(url));
}

export async function proceduralDemTile(params, controller) {
  const signal = controller?.signal;
  signal?.throwIfAborted();
  const key = params.url;
  let tile = tiles.get(key);
  if (!tile) {
    tile = generateTile(key);
    tiles.set(key, tile);
    tile.catch(() => { if (tiles.get(key) === tile) tiles.delete(key); });
    if (tiles.size > CACHE_SIZE) tiles.delete(tiles.keys().next().value);
  } else {
    tiles.delete(key);
    tiles.set(key, tile);
  }
  // 单个地图取消不能取消其他地图共用的计算；取消者立即退出，结果可供下次使用。
  let abort;
  const cancelled = signal && new Promise((_, reject) => {
    abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const data = await (cancelled ? Promise.race([tile, cancelled]) : tile);
    signal?.throwIfAborted();
    // MapLibre 会转移 ArrayBuffer 给自己的 Worker；不得把缓存本体交出去导致脱离。
    return { data: data.slice(0) };
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}
