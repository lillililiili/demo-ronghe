import { renderTerrainTile } from './proceduralTerrainTile';

self.onmessage = async ({ data: { id, url } }) => {
  try {
    const buffer = await renderTerrainTile(url);
    self.postMessage({ id, buffer }, [buffer]);
  } catch (error) {
    self.postMessage({ id, error: error.message || '地图纹理生成失败' });
  }
};
