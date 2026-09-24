// Run from dongying-vue using its existing Vite and map dependencies.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(root, '../../dongying-vue');
const { build } = await import(path.join(frontend, 'node_modules/vite/dist/node/index.js'));
await build({
  configFile: false, root: frontend, publicDir: false, base: '/map-runtime/',
  resolve: { alias: {
    'maplibre-gl': path.join(frontend, 'node_modules/maplibre-gl'),
    pmtiles: path.join(frontend, 'node_modules/pmtiles')
  } },
  build: {
    outDir: path.join(root, 'web/map-runtime'), emptyOutDir: true,
    rollupOptions: { input: path.join(root, 'map-entry.js'), output: {
      entryFileNames: 'map.js', chunkFileNames: 'assets/[name]-[hash].js',
      assetFileNames: asset => asset.names?.some(name => name.endsWith('.css')) ? 'map.css' : 'assets/[name]-[hash][extname]'
    } }
  }
});
