import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Keep the real cache/eviction/decode lifecycle; only the browser fetch/decode,
// display frame and GPU upload boundaries are controlled so a replacement can
// remain in flight.
function fixture() {
  const requests = new Map();
  const frames = [];
  let uid = 0;
  const fetch = (src) =>
    new Promise((resolve, reject) => {
      const request = {
        size: 256,
        resolve: () => resolve({ ok: true, blob: async () => ({ src, size: request.size }) }),
        reject,
      };
      requests.set(src, request);
    });
  const createImageBitmap = async ({ src, size }) => ({
    src,
    width: size,
    height: size,
    closed: false,
    close() {
      this.closed = true;
    },
  });
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(
      readFileSync(new URL('../src/canvas/textures.ts', import.meta.url), 'utf8'),
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      },
    ).outputText,
    {
      exports,
      fetch,
      createImageBitmap,
      requestAnimationFrame: (callback) => frames.push(callback),
      cancelAnimationFrame() {},
      performance,
      require: (id) =>
        id === 'pixi.js'
          ? {
              Texture: {
                from: (image) => ({
                  uid: ++uid,
                  image,
                  destroyed: false,
                  destroy() {
                    this.destroyed = true;
                  },
                }),
              },
            }
          : { mediaUrl: (id, variant) => `${id}/${variant}` },
    },
  );
  const cache = new exports.TextureCache(() => {});
  const decoded = () => new Promise((resolve) => setImmediate(resolve));
  // One display frame: the point where decoded images are handed to the GPU.
  const frame = () => {
    for (const callback of frames.splice(0)) callback();
  };
  const settle = async () => {
    await decoded();
    for (let i = 0; frames.length && i < 100; i++) frame();
  };
  const load = async (key, size = 256) => {
    const request = requests.get(key);
    assert.ok(request, `decode requested for ${key}`);
    request.size = size;
    request.resolve();
    await settle();
    return cache.get(key);
  };
  return { cache, requests, load, settle, decoded, frame };
}

test('previews that finish decoding together are uploaded on separate frames', async () => {
  const { cache, requests, decoded, frame } = fixture();
  const keys = ['a/preview', 'b/preview', 'c/preview'];
  cache.begin(new Set(keys));
  for (const key of keys) cache.get(key);
  for (const key of keys) {
    requests.get(key).size = 1600;
    requests.get(key).resolve();
  }
  await decoded();
  const uploaded = () => keys.filter((key) => cache.get(key)).length;
  assert.equal(uploaded(), 0, 'nothing reaches the GPU outside a frame');
  for (const expected of [1, 2, 3]) {
    frame();
    assert.equal(uploaded(), expected, 'one large preview per frame');
  }
  cache.destroy();
});

test('thumbnails that finish decoding together share one frame', async () => {
  const { cache, requests, decoded, frame } = fixture();
  const keys = ['a/thumb', 'b/thumb', 'c/thumb', 'd/thumb'];
  cache.begin(new Set(keys));
  for (const key of keys) cache.get(key);
  for (const key of keys) requests.get(key).resolve();
  await decoded();
  frame();
  assert.equal(keys.filter((key) => cache.get(key)).length, 4);
  cache.destroy();
});

test('decoded bitmaps are released with their textures', async () => {
  const { cache, requests, load, decoded } = fixture();
  cache.begin(new Set(['kept/thumb', 'late/thumb']));
  cache.get('kept/thumb');
  const kept = await load('kept/thumb');
  cache.get('late/thumb');
  requests.get('late/thumb').resolve();
  await decoded();
  cache.destroy();
  assert.equal(kept.destroyed, true);
  assert.equal(kept.image.closed, true, 'an uploaded bitmap is closed with its texture');
  assert.equal(cache.get('late/thumb'), null, 'a bitmap still waiting for a frame is dropped');
});

for (const [from, to] of [
  ['thumb', 'preview'],
  ['preview', 'thumb'],
]) {
  test(`zoom keeps ${from} visible until ${to} finishes decoding`, async () => {
    const { cache, load } = fixture();
    cache.begin(new Set([`photo/${from}`]));
    assert.equal(cache.get(`photo/${from}`), null);
    const previous = await load(`photo/${from}`);
    cache.begin(new Set([`photo/${to}`]));
    assert.equal(cache.get(`photo/${to}`), previous, 'no blank frame during the resolution change');
    const replacement = await load(`photo/${to}`);
    assert.notEqual(replacement.uid, previous.uid, 'the renderer can detect the quality upgrade');
    cache.destroy();
  });
}

test('an in-flight resolution change retains its fallback under cache pressure', async () => {
  const { cache, load } = fixture();
  cache.begin(new Set(['photo/preview', 'old-a/preview', 'old-b/preview']));
  cache.get('photo/preview');
  const previous = await load('photo/preview', 1600);
  for (const id of ['old-a', 'old-b']) {
    cache.get(`${id}/preview`);
    await load(`${id}/preview`, 4500);
  }
  cache.begin(new Set(['photo/thumb']));
  assert.equal(previous.destroyed, false, 'the visible fallback is pinned before eviction');
  assert.equal(cache.get('photo/thumb'), previous);
  cache.destroy();
});

test('zooming out on a crowded board frees preview memory so every thumbnail can load', async () => {
  const { cache, requests, load, settle } = fixture();
  const old = Array.from({ length: 10 }, (_, i) => `old-${i}`);
  cache.begin(new Set(old.map((id) => `${id}/preview`)));
  for (const id of old) {
    cache.get(`${id}/preview`);
    await load(`${id}/preview`, 1600);
  }
  const keys = [
    ...Array.from({ length: 390 }, (_, i) => `new-${i}/thumb`),
    ...old.map((id) => `${id}/thumb`),
  ];
  const wanted = new Set(keys);
  const complete = new Set();
  // Settle decodes between redraws, matching the real cache's four-load queue.
  for (let frame = 0; frame < 5; frame++) {
    cache.begin(wanted);
    for (const key of keys) cache.get(key);
    for (;;) {
      const pending = [...requests].filter(
        ([key, request]) => wanted.has(key) && !complete.has(request),
      );
      if (!pending.length) break;
      for (const [key, request] of pending) {
        complete.add(request);
        request.resolve();
      }
      await settle();
    }
  }
  for (const key of keys) {
    const texture = cache.get(key);
    assert.ok(texture, `${key} must not remain blank at a settled camera`);
    assert.equal(texture.image.src, key, 'replacement thumbnails release their large previews');
  }
  cache.destroy();
});

test('failed replacements keep the same asset visible without borrowing other assets or detail tiles', async () => {
  const { cache, requests, load, settle } = fixture();
  cache.begin(new Set(['photo/thumb']));
  cache.get('photo/thumb');
  const previous = await load('photo/thumb');
  cache.begin(new Set(['photo/preview', 'other/preview', 'photo/tile-4-4-0-0']));
  cache.get('photo/preview');
  requests.get('photo/preview').reject(Error('unavailable'));
  await settle();
  assert.equal(cache.get('photo/preview'), previous);
  assert.equal(cache.get('other/preview'), null);
  assert.equal(cache.get('photo/tile-4-4-0-0'), null);
  cache.destroy();
});

test('reclaiming a fallback never destroys a variant still requested by another visible object', async () => {
  const { cache, load } = fixture();
  const wanted = new Set(['photo/preview', 'other-a/preview', 'other-b/preview']);
  cache.begin(wanted);
  let preview;
  for (const key of wanted) {
    cache.get(key);
    const texture = await load(key, 4096);
    if (key === 'photo/preview') preview = texture;
  }
  cache.begin(new Set([...wanted, 'photo/thumb']));
  cache.get('photo/thumb');
  await load('photo/thumb');
  assert.equal(preview.destroyed, false);
  assert.equal(cache.get('photo/preview'), preview);
  assert.equal(cache.get('photo/thumb'), preview);
  cache.destroy();
});
