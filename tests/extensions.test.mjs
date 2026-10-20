import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { strToU8, zipSync } from 'fflate';

const require = createRequire(import.meta.url);
const { createExtensions } = require('../electron/extensions.cjs');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function workspace() {
  mkdirSync(resolve('.local-test'), { recursive: true });
  const base = mkdtempSync(resolve('.local-test/extensions-'));
  const root = join(base, 'Extensions');
  const source = join(base, 'source');
  mkdirSync(source, { recursive: true });
  return { root, source };
}
function payload(source, name, bytes) {
  writeFileSync(join(source, name), bytes);
  return { name, url: `https://example.test/${name}`, sha256: sha256(bytes), size: bytes.length };
}
const entry = (id, files, extra = {}) => ({
  id,
  name: id,
  description: `${id} description`,
  version: '1',
  files,
  downloadSize: files.reduce((sum, f) => sum + f.size, 0),
  installedSize: 1,
  ...extra,
});
const status = (extensions, id) => extensions.list().find((e) => e.id === id);

test('installs files from a local source and reports them installed', async () => {
  const { root, source } = workspace();
  const tool = payload(source, 'tool.exe', Buffer.from('tool bytes'));
  const changes = [];
  const extensions = createExtensions({
    root,
    catalog: { extensions: [entry('tool', [tool])] },
    source: { dir: source },
    onChange: (list) => changes.push(list),
  });
  assert.equal(status(extensions, 'tool').state, 'available');
  assert.equal(extensions.path('tool'), null);
  await extensions.install('tool');
  const dir = extensions.path('tool');
  assert.equal(dir, join(root, 'tool'));
  assert.equal(readFileSync(join(dir, 'tool.exe'), 'utf8'), 'tool bytes');
  assert.equal(JSON.parse(readFileSync(join(dir, 'extension.json'), 'utf8')).version, '1');
  assert.equal(status(extensions, 'tool').state, 'installed');
  assert.ok(status(extensions, 'tool').installedBytes >= 10);
  assert.ok(changes.length > 0, 'the tab hears about the install');
  // A new manager over the same folder finds it installed.
  const again = createExtensions({
    root,
    catalog: { extensions: [entry('tool', [tool])] },
    source: { dir: source },
  });
  assert.equal(status(again, 'tool').state, 'installed');
});

test('rejects a file whose checksum does not match and leaves nothing behind', async () => {
  const { root, source } = workspace();
  const tool = payload(source, 'tool.exe', Buffer.from('original'));
  writeFileSync(join(source, 'tool.exe'), 'tampered');
  const extensions = createExtensions({
    root,
    catalog: { extensions: [entry('tool', [tool])] },
    source: { dir: source },
  });
  await assert.rejects(extensions.install('tool'), /damaged|check/i);
  assert.equal(status(extensions, 'tool').state, 'available');
  assert.match(status(extensions, 'tool').error, /damaged|check/i);
  assert.deepEqual(existsSync(root) ? readdirSync(root) : [], []);
});

test('unzips archives and refuses entries outside the extension folder', async () => {
  const { root, source } = workspace();
  const good = payload(
    source,
    'runtime.zip',
    Buffer.from(zipSync({ 'node_modules/lib/index.js': strToU8('module.exports = 1;') })),
  );
  const extensions = createExtensions({
    root,
    catalog: {
      extensions: [
        entry('runtime', [{ ...good, unzip: true }]),
        entry('evil', [
          {
            ...payload(
              source,
              'evil.zip',
              Buffer.from(zipSync({ '../escaped.txt': strToU8('x') })),
            ),
            unzip: true,
          },
        ]),
      ],
    },
    source: { dir: source },
  });
  await extensions.install('runtime');
  const dir = extensions.path('runtime');
  assert.equal(readFileSync(join(dir, 'node_modules/lib/index.js'), 'utf8'), 'module.exports = 1;');
  assert.ok(!existsSync(join(dir, 'runtime.zip')), 'the archive is removed after unpacking');
  await assert.rejects(extensions.install('evil'), /outside|invalid/i);
  assert.ok(!existsSync(join(root, '..', 'escaped.txt')));
  assert.equal(extensions.path('evil'), null);
});

test('remove calls beforeRemove, deletes the folder and returns to available', async () => {
  const { root, source } = workspace();
  const tool = payload(source, 'tool.exe', Buffer.from('tool'));
  const stopped = [];
  const extensions = createExtensions({
    root,
    catalog: { extensions: [entry('tool', [tool])] },
    source: { dir: source },
    beforeRemove: async (id) => stopped.push(id),
  });
  await extensions.install('tool');
  await extensions.remove('tool');
  assert.deepEqual(stopped, ['tool']);
  assert.equal(extensions.path('tool'), null);
  assert.equal(status(extensions, 'tool').state, 'available');
  assert.ok(!existsSync(join(root, 'tool')));
});

test('cancel stops a running install and cleans up', async () => {
  const { root } = workspace();
  const bytes = Buffer.alloc(64 * 1024, 7);
  let pulls = 0;
  const fetch = async () =>
    new Response(
      new ReadableStream({
        async pull(controller) {
          await new Promise((r) => setTimeout(r, 20));
          if (pulls++ < 1000) controller.enqueue(bytes.subarray(0, 1024));
          else controller.close();
        },
      }),
      { headers: { 'content-length': String(bytes.length * 1000) } },
    );
  const extensions = createExtensions({
    root,
    catalog: {
      extensions: [
        entry('big', [
          { name: 'big.bin', url: 'https://example.test/big.bin', sha256: 'x', size: 1024 * 1000 },
        ]),
      ],
    },
    source: { remote: true },
    fetch,
  });
  const install = extensions.install('big');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(status(extensions, 'big').state, 'installing');
  extensions.cancel('big');
  await assert.rejects(install, /cancel/i);
  assert.equal(status(extensions, 'big').state, 'available');
  assert.equal(status(extensions, 'big').error, undefined, 'cancelling is not an error');
  assert.deepEqual(existsSync(root) ? readdirSync(root) : [], []);
});

test('cleanup deletes leftover partial and trash folders', async () => {
  const { root, source } = workspace();
  const tool = payload(source, 'tool.exe', Buffer.from('tool'));
  for (const name of ['.partial-tool-1', '.trash-tool-2'])
    mkdirSync(join(root, name), { recursive: true });
  mkdirSync(join(root, 'old'), { recursive: true });
  writeFileSync(join(root, 'old', '.remove'), '');
  const extensions = createExtensions({
    root,
    catalog: { extensions: [entry('tool', [tool])] },
    source: { dir: source },
  });
  await extensions.cleanup();
  assert.deepEqual(readdirSync(root), []);
});

test('downloads remote files with progress', async () => {
  const { root } = workspace();
  const bytes = Buffer.from('downloaded payload');
  const requested = [];
  const fetch = async (url) => {
    requested.push(url);
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  };
  const seen = [];
  const extensions = createExtensions({
    root,
    catalog: {
      extensions: [
        entry('tool', [
          {
            name: 'tool.exe',
            url: 'https://example.test/tool.exe',
            sha256: sha256(bytes),
            size: bytes.length,
          },
        ]),
      ],
    },
    source: { remote: true },
    fetch,
    onChange: (list) => seen.push(list.find((e) => e.id === 'tool')),
  });
  await extensions.install('tool');
  assert.deepEqual(requested, ['https://example.test/tool.exe']);
  assert.equal(
    readFileSync(join(extensions.path('tool'), 'tool.exe'), 'utf8'),
    'downloaded payload',
  );
  assert.ok(
    seen.some((s) => s.state === 'installing' && s.progress),
    'progress was reported',
  );
});

test('custom installers write into the staging folder', async () => {
  const { root } = workspace();
  const extensions = createExtensions({
    root,
    catalog: { extensions: [entry('office', [], { installer: 'office', downloadSize: 100 })] },
    source: { remote: true },
    installers: {
      office: async ({ dir, progress }) => {
        progress({ received: 50, total: 100, label: 'Downloading' });
        writeFileSync(join(dir, 'soffice.com'), 'office');
      },
    },
  });
  await extensions.install('office');
  assert.equal(readFileSync(join(extensions.path('office'), 'soffice.com'), 'utf8'), 'office');
});
