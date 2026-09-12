import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// The client is built to dist/client and served by the Node server over HTTPS.
// There is no Vite dev server in the loop: phones need one origin, one
// certificate and one WebSocket host, and proxying all three through Vite
// buys nothing. `vite build --watch` in `npm run dev` rebuilds on save.
export default defineConfig({
  root: resolve(__dirname, 'client'),
  publicDir: resolve(__dirname, 'client/public'),
  build: {
    outDir: resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'client/index.html'),
        monitor: resolve(__dirname, 'client/monitor.html'),
<<<<<<< HEAD
        wall: resolve(__dirname, 'client/wall.html'),
=======
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
      },
    },
  },
});
