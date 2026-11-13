import { defineConfig } from 'vite';

// `npm run dev` would otherwise resolve PlayCanvas through its "development" export: the debug
// engine, which validates every draw call and costs a large share of the frame once a firefight
// fills the scene. The game is played from the dev server, so it runs the release engine unless
// GHOULX_ENGINE_DEBUG=1 asks for the engine's own asserts and warnings. Tests keep the default.
const useReleaseEngine = !process.env.VITEST && process.env.GHOULX_ENGINE_DEBUG !== '1';

export default defineConfig({
  resolve: {
    alias: useReleaseEngine
      ? [{ find: /^playcanvas$/, replacement: 'playcanvas/build/playcanvas/src/index.js' }]
      : [],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true
  },
  build: {
    target: 'es2022'
  }
});
