import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Keep the real cache/eviction/decode lifecycle; only the browser image and GPU
// upload boundaries are controlled so a replacement can remain in flight.
function fixture() {
  const requests = new Map();
  let uid = 0;
  class Image {
    naturalWidth = 256;
    naturalHeight = 256;
    decode() {
      return new Promise((resolve, reject) =>
        requests.set(this.src, { resolve, reject, image: this }),
      );
    }
  }
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
      Image,
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
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const load = async (key, size = 256) => {
    const request = requests.get(key);
    assert.ok(request, `decode requested for ${key}`);
    request.image.naturalWidth = request.image.naturalHeight = size;
    request.resolve();
    await settle();
    return cache.get(key);
  };
  return { cache, requests, load, settle };
}

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
