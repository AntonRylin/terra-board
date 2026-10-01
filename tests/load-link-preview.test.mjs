import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLinkPreview } from '../src/canvas/load-link-preview.ts';
import {
  linkLayout,
  withLinkPreview,
  compactLinkHeight,
  normalizeLinkSize,
  setLinkCompact,
  hasLinkImage,
  hitsLinkPlay,
} from '../src/canvas/link-preview.ts';
const object = { id: 'link', type: 'link', url: 'https://www.youtube.com/watch?v=YLz9IdSQ7IM' };
test('a failed saved preview recovers its thumbnail without a click', async () => {
  let calls = 0;
  const applied = [];
  await loadLinkPreview(
    object,
    async () => {
      calls++;
      if (calls === 1) throw Error('offline');
      return calls === 2
        ? { text: 'Title', linkDescription: 'YouTube' }
        : { text: 'Title', linkDescription: '', assetId: 'thumbnail' };
    },
    () => true,
    (p) => applied.push(p),
    async () => {},
  );
  assert.equal(calls, 3);
  assert.equal(applied.at(-1).assetId, 'thumbnail');
});
test('a late preview never updates a board after leaving it', async () => {
  let current = true;
  await loadLinkPreview(
    object,
    async () => {
      current = false;
      return { text: 'Title', assetId: 'thumbnail' };
    },
    () => current,
    () => assert.fail('stale board updated'),
  );
});
test('link caption occupies a compact two-line footer', () => {
  const layout = linkLayout(440, 314);
  assert.equal(layout.footer, 56);
  assert.equal(layout.width / layout.height, 16 / 9);
});

test('a compact card only expands when a thumbnail arrives, preserving manual sizing', () => {
  const card = { ...object, x: 100, y: 100, width: 440, height: compactLinkHeight, z: 1 };
  assert.equal(withLinkPreview(card, { text: 'Example' }).height, 76);
  assert.equal(withLinkPreview(card, { assetId: 'thumbnail' }).height, 314);
  assert.equal(withLinkPreview({ ...card, height: 190 }, { assetId: 'thumbnail' }).height, 190);
});

test('text previews finish without retries and expand only for a description', async () => {
  for (const meta of [
    { text: 'Site', linkDescription: 'A useful summary' },
    { text: 'Site', linkDescription: '', linkIconId: 'icon' },
  ]) {
    let calls = 0;
    await loadLinkPreview(
      { ...object, url: 'https://example.com' },
      async () => {
        calls++;
        return meta;
      },
      () => true,
      () => {},
      async () => {},
    );
    assert.equal(calls, 1);
    const card = { ...object, width: 440, height: 76 };
    const result = withLinkPreview(card, meta);
    assert.equal(result.height, meta.linkDescription ? 112 : 76);
    assert.equal(withLinkPreview(result, { assetId: 'thumbnail' }).height, 314);
    assert.equal(withLinkPreview({ ...card, height: 190 }, meta).height, 190);
  }
});

test('reopening migrates old automatic cards and preserves custom sizes', () => {
  const card = { ...object, width: 440, height: 168, linkDescription: 'Summary' };
  assert.equal(normalizeLinkSize(card).height, 112);
  assert.equal(normalizeLinkSize({ ...card, height: 115.2 }).height, 115.2);
  assert.equal(normalizeLinkSize({ ...card, height: 314, assetId: 'image' }).height, 314);
});

test('compact mode retains cached media, restores preview height and survives late metadata', () => {
  const card = {
    ...object,
    width: 440,
    height: 390,
    assetId: 'image',
    linkIconId: 'icon',
    linkDescription: 'Summary',
  };
  const compact = setLinkCompact(card, true);
  assert.equal(compact.height, 112);
  assert.equal(compact.assetId, 'image');
  assert.equal(compact.linkIconId, 'icon');
  assert.equal(hasLinkImage(compact), false);
  assert.equal(
    withLinkPreview(compact, { assetId: 'updated', linkDescription: 'New summary' }).height,
    112,
  );
  assert.equal(normalizeLinkSize(compact).height, 112);
  const expanded = setLinkCompact(compact, false);
  assert.equal(expanded.height, 390);
  assert.equal(hasLinkImage(expanded), true);
  assert.equal(hitsLinkPlay(compact, { x: 220, y: 56 }), false);
  assert.equal(hitsLinkPlay(compact, { x: 410, y: 36 }), true);
  const pending = setLinkCompact({ ...card, assetId: undefined, height: 76 }, true);
  assert.equal(withLinkPreview(pending, { assetId: 'new image' }).height, 112);
});
