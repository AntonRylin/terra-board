import { defineConfig, type Plugin } from 'vite';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

// The npm packages bundled into the renderer, written to dist/licenses.json for
// Settings → About. They are dev dependencies, so the packaged app has no
// node_modules copy to read them from (electron/licenses.cjs).
function bundledLicenses(): Plugin {
  const { bundledPackages } = require('./electron/licenses.cjs');
  return {
    name: 'bundled-licenses',
    apply: 'build',
    generateBundle(_options, bundle) {
      const root = fileURLToPath(new URL('.', import.meta.url));
      // Code chunks, plus files bundled as they are (fonts arrive through CSS,
      // named relative to the project).
      const ids = Object.values(bundle).flatMap((output) =>
        output.type === 'chunk'
          ? output.moduleIds.filter((id) => output.modules[id]?.renderedLength !== 0)
          : output.originalFileNames.map((name) => path.resolve(root, name)),
      );
      const list = bundledPackages(ids, root);
      this.emitFile({ type: 'asset', fileName: 'licenses.json', source: JSON.stringify(list) });
    },
  };
}

// Android (`vite build --mode android`, docs/android.md): the renderer talks
// to electron/store.cjs running in a worker on SQLite-WASM. These modules stand
// in for the Node ones the store requires; desktop builds never see them.
const mobile = (file: string) => fileURLToPath(new URL('./src/mobile/' + file, import.meta.url));
function androidBuild(): Plugin {
  return {
    name: 'terra-android',
    transformIndexHtml(html) {
      return html
        .replace(
          '<meta name="viewport" content="width=device-width,initial-scale=1" />',
          '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover" />',
        )
        .replace(
          "connect-src 'self' canvas-media: ws://127.0.0.1:5173;",
          "connect-src 'self' https://*.supabase.co wss://*.supabase.co;",
        );
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'terra-sw.js',
        source: fs.readFileSync(mobile('terra-sw.js'), 'utf8'),
      });
    },
  };
}

// The renderer imports src/mobile/platform.ts (desktop: everything off). Android
// builds get src/mobile/index.ts in its place, whatever relative path imports it,
// and each build fails if it ends up with the other one.
function mobilePlatform(android: boolean): Plugin {
  const stub = path.normalize(mobile('platform.ts')),
    bridge = path.normalize(mobile('index.ts'));
  const name = (file: string) => path.relative(process.cwd(), file);
  return {
    name: 'terra-mobile-platform',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!android || !/(^|\/)platform(\.ts)?$/.test(source)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved && path.normalize(resolved.id) === stub ? bridge : null;
    },
    generateBundle(_options, bundle) {
      const ids = new Set(
        Object.values(bundle).flatMap((output) =>
          output.type === 'chunk'
            ? Object.keys(output.modules).map((id) => path.normalize(id.split('?')[0]))
            : [],
        ),
      );
      if (android && ids.has(stub))
        this.error(`The Android build includes ${name(stub)}, the desktop stub.`);
      if (android && !ids.has(bridge)) this.error(`The Android build is missing ${name(bridge)}.`);
      if (!android && ids.has(bridge))
        this.error(`The desktop build includes ${name(bridge)}, the Android bridge.`);
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: './',
  resolve: {
    alias:
      mode === 'android'
        ? {
            'node:sqlite': mobile('shims/sqlite.ts'),
            'node:fs': mobile('shims/fs.ts'),
            'node:path': mobile('shims/path.ts'),
            'node:crypto': mobile('shims/crypto.ts'),
            'node:os': mobile('shims/node-stubs.ts'),
            'node:stream': mobile('shims/node-stubs.ts'),
            sharp: mobile('shims/sharp.cjs'),
          }
        : {},
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/.local-test/**', '**/Library/**', '**/release/**'] },
  },
  plugins: [
    bundledLicenses(),
    mobilePlatform(mode === 'android'),
    mode === 'android' && androidBuild(),
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
          'importBoard',
          'exportBoard',
          'assetLinks',
          'assetInfo',
          'boardSyncs',
          'boardInfo',
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
}));
