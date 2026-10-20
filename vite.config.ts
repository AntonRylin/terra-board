import { defineConfig, type Plugin } from 'vite';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);

// The npm packages bundled into the renderer, written to dist/licenses.json for
// Settings → About. They are dev dependencies, so the packaged app has no
// node_modules copy to read them from (electron/licenses.cjs).
function bundledLicenses(): Plugin {
  const { licenseOf } = require('./electron/licenses.cjs');
  const packageRoot = (id: string) => {
    const file = id.replace(/\\/g, '/').replace(/^\0/, '').split('?')[0];
    const at = file.lastIndexOf('/node_modules/');
    if (at < 0) return null;
    const rest = file.slice(at + '/node_modules/'.length).split('/');
    const name = rest[0].startsWith('@') ? rest.slice(0, 2).join('/') : rest[0];
    return file.slice(0, at) + '/node_modules/' + name;
  };
  return {
    name: 'bundled-licenses',
    apply: 'build',
    generateBundle(_options, bundle) {
      const found = new Map<string, { name: string; version: string; license: string }>();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const id of output.moduleIds) {
          if (output.modules[id]?.renderedLength === 0) continue;
          const root = packageRoot(id);
          if (!root || found.has(root)) continue;
          const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
          found.set(root, {
            name: pkg.name,
            version: String(pkg.version || ''),
            license: licenseOf(pkg),
          });
        }
      }
      const list = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
      this.emitFile({ type: 'asset', fileName: 'licenses.json', source: JSON.stringify(list) });
    },
  };
}

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/.local-test/**', '**/Library/**', '**/release/**'] },
  },
  plugins: [
    bundledLicenses(),
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
          'searchContent',
          'createBoard',
          'createFolder',
          'updateBoard',
          'updateFolder',
          'removeFolder',
          'restoreBoard',
          'duplicateBoard',
          'patchBoard',
          'saveCamera',
          'setLastBoard',
          'importAsset',
          'removeBackground',
          'importBoard',
          'exportBoard',
          'assetLinks',
          'boardSyncs',
        ]);
        server.middlewares.use('/__local', async (req, res) => {
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1:5173');
            if (url.pathname.startsWith('/asset/')) {
              const [, , id, variant] = url.pathname.split('/');
              const a = await store.readAsset({ id, variant });
              res.setHeader('Content-Type', a.contentType);
              res.setHeader('X-Content-Type-Options', 'nosniff');
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
            if (typeof args?.bytes === 'string') args.bytes = Buffer.from(args.bytes, 'base64');
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
