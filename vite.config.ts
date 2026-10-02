import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/.local-test/**', '**/Library/**', '**/release/**'] },
  },
  plugins: [
    {
      name: 'local-development-library',
      configureServer(server) {
        // This bridge is only installed in Vite development, never in the packaged app.
        const { Store } = require('./electron/store.cjs');
        const store = new Store(path.resolve('.local-test/browser-library'));
        if (!store.library().boards.length) store.createBoard({ name: 'Ideas' });
        server.httpServer?.on('close', () => store.close());
        const commands = new Set([
          'library',
          'loadBoard',
          'createBoard',
          'createFolder',
          'updateBoard',
          'updateFolder',
          'removeFolder',
          'restoreBoard',
          'duplicateBoard',
          'patchBoard',
          'setLastBoard',
          'importAsset',
          'removeBackground',
          'importBoard',
          'exportBoard',
        ]);
        server.middlewares.use('/__local', async (req, res) => {
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1:5173');
            if (url.pathname.startsWith('/asset/')) {
              const [, , id, variant] = url.pathname.split('/');
              const a = await store.readAsset({ id, variant });
              res.setHeader('Content-Type', a.contentType);
              fs.createReadStream(a.file).pipe(res);
              return;
            }
            if (req.method !== 'POST' || req.headers.origin !== 'http://127.0.0.1:5173')
              throw Error('Origin rejected');
            const chunks = [];
            let length = 0;
            for await (const chunk of req) {
              length += chunk.length;
              if (length > 360 * 1024 * 1024) throw Error('Import too large');
              chunks.push(chunk);
            }
            const { command, args } = JSON.parse(Buffer.concat(chunks).toString());
            if (!commands.has(command)) throw Error('Unknown command');
            if (args?.bytes) args.bytes = Buffer.from(args.bytes, 'base64');
            const value = await store[command](args);
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                result: command === 'exportBoard' ? Buffer.from(value).toString('base64') : value,
              }),
            );
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      },
    },
  ],
});
