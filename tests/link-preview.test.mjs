import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { youtubeId } from '../src/canvas/link-preview.ts';
const { publicAddress, webUrl, metadata, fetchPreview } = createRequire(import.meta.url)(
  '../electron/link-preview.cjs',
);
test('only real YouTube video URLs become embedded players', () => {
  for (const url of [
    'https://youtu.be/abcdefghijk?t=2',
    'https://www.youtube.com/watch?v=abcdefghijk',
    'https://youtube.com/shorts/abcdefghijk',
  ])
    assert.equal(youtubeId(url), 'abcdefghijk');
  for (const url of [
    'https://youtube.com.attacker.test/watch?v=abcdefghijk',
    'javascript:alert(1)',
    'https://youtube.com/playlist?list=abcdefghijk',
  ])
    assert.equal(youtubeId(url), null);
});
test('preview requests reject private networks, credentials, ports and non-web URLs', () => {
  for (const url of [
    'file:///secret',
    'http://localhost',
    'http://127.0.0.1',
    'http://[::1]',
    'https://user:pass@example.com',
    'https://example.com:9000',
    'http://10.0.0.1',
  ])
    assert.throws(() => webUrl(url));
  for (const ip of ['192.168.1.1', '169.254.169.254', '100.64.0.1', '::ffff:127.0.0.1', 'fc00::1'])
    assert.equal(publicAddress(ip), false);
  assert.equal(publicAddress('8.8.8.8'), true);
});
test('messenger metadata handles attribute order, entities, relative images and title fallback', () => {
  assert.deepEqual(
    metadata(
      '<meta content="A &amp; B" property="og:title"><meta name="description" content="Summary"><meta content="/cover.png" property="og:image">',
      'https://example.com/a',
    ),
    { title: 'A & B', description: 'Summary', image: 'https://example.com/cover.png' },
  );
  assert.equal(metadata('<title>Hello &#x1F30D;</title>', 'https://example.com').title, 'Hello 🌍');
});
test('YouTube previews use bounded metadata and an image; failures retain a usable title', async () => {
  const data = await fetchPreview('https://youtu.be/abcdefghijk', async (url) =>
    url.includes('oembed')
      ? { bytes: Buffer.from(JSON.stringify({ title: 'Video title', author_name: 'Creator' })) }
      : { type: 'image/jpeg', bytes: Buffer.from('image') },
  );
  assert.equal(data.title, 'Video title');
  assert.equal(data.description, 'Creator');
  assert.equal(data.imageBytes.toString(), 'image');
  const offline = await fetchPreview('https://youtu.be/abcdefghijk', async () => {
    throw Error('offline');
  });
  assert.equal(offline.title, 'YouTube video');
});

test('text-only sites retain microdata descriptions and resolve site icons', async () => {
  const html =
    '<title>Example</title><meta itemprop="description" content="Useful &amp; concise"><link href="/logo.png" rel="shortcut icon">';
  const meta = metadata(html, 'https://example.com/path');
  assert.equal(meta.description, 'Useful & concise');
  assert.equal(meta.icon, 'https://example.com/logo.png');
  assert.equal(meta.image, undefined);
  const calls = [];
  const result = await fetchPreview('https://example.com/path', async (url, limit) => {
    calls.push([url, limit]);
    return url.endsWith('.png')
      ? { bytes: Buffer.from('icon'), type: 'image/png' }
      : { bytes: Buffer.from(html), type: 'text/html', url };
  });
  assert.equal(result.iconBytes.toString(), 'icon');
  assert.equal(calls[1][1], 512 * 1024);
});

test('Google homepage fallback does not replace page descriptions or apply to other pages', () => {
  const html = '<title>Google</title><meta itemprop="image" content="/logo.png">';
  const meta = metadata(html, 'https://www.google.com/');
  assert.equal(meta.icon, 'https://www.google.com/logo.png');
  assert.match(meta.description, /Search the web/);
  assert.equal(meta.image, undefined);
  assert.equal(metadata(html, 'https://www.google.com/search?q=test').description, '');
  assert.equal(metadata(html, 'https://www.google.com.example.org/').description, '');
  assert.equal(
    metadata(html + '<meta name="description" content="Live summary">', 'https://www.google.com/')
      .description,
    'Live summary',
  );
});

test('image discovery reads microdata, image_src and JSON-LD without executing scripts', () => {
  for (const html of [
    '<meta itemprop="image" content="/cover.png">',
    '<link rel="image_src" href="/cover.png">',
    '<script type="application/ld+json">{"@graph":[{"image":{"contentUrl":"/cover.png"}}]}</script>',
  ])
    assert.deepEqual(metadata(html, 'https://example.com/').fallbackImages, [
      'https://example.com/cover.png',
    ]);
  assert.equal(
    metadata(
      '<script type="application/ld+json">alert(1)</script><meta itemprop="image" content="http://127.0.0.1/private">',
      'https://example.com/',
    ).fallbackImages,
    undefined,
  );
});
test('content fallback favors introductory artwork over incidental mentions, logos and trackers', () => {
  const html =
    '<title>Sample Trends</title><img src="/logo.png" width="400" height="200"><img src="/pixel.gif" width="1" height="1">' +
    '<a><img src="/news.png">A long story about wildlife and data and how people use Sample Trends to discover seasonal changes in bird migration</a>' +
    '<a><img src="/intro.png">What is Sample Trends?</a>';
  assert.deepEqual(metadata(html, 'https://example.com/').fallbackImages, [
    'https://example.com/intro.png',
    'https://example.com/news.png',
  ]);
});
test('a missing social image falls back to a real page image, skipping tiny images', async () => {
  const sharp = createRequire(import.meta.url)('sharp');
  const tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
  const cover = await sharp({
    create: { width: 400, height: 225, channels: 3, background: '#4486d9' },
  })
    .png()
    .toBuffer();
  const html =
    '<meta property="og:image" content="/broken.png"><link rel="image_src" href="/tiny.png"><img class="hero" src="/cover.png">';
  const result = await fetchPreview('https://example.com/', async (url) => {
    if (url.endsWith('broken.png')) throw Error('404');
    if (url.endsWith('.png'))
      return { bytes: url.endsWith('tiny.png') ? tiny : cover, type: 'image/png', url };
    return { bytes: Buffer.from(html), type: 'text/html', url };
  });
  assert.deepEqual(result.imageBytes, cover);
});
