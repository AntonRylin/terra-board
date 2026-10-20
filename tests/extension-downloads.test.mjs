import test from 'node:test';
import assert from 'node:assert/strict';
import { unreachable } from '../scripts/check-extension-downloads.mjs';

// Installed copies download extensions from the catalog's addresses; a release
// that forgot to upload the onnxruntime zip must be caught before users are.
test('lists catalog files whose download address does not answer', async () => {
  const catalog = {
    extensions: [
      { id: 'a', files: [{ name: 'ok.bin', url: 'https://example.test/ok.bin' }] },
      { id: 'b', files: [{ name: 'gone.zip', url: 'https://example.test/gone.zip' }] },
      { id: 'c', installer: 'libreoffice' },
    ],
  };
  const asked = [];
  const fetch = async (url, options) => {
    asked.push([url, options.method]);
    return new Response(null, { status: url.endsWith('ok.bin') ? 200 : 404 });
  };
  assert.deepEqual(await unreachable(catalog, fetch), [
    { id: 'b', name: 'gone.zip', url: 'https://example.test/gone.zip', status: 404 },
  ]);
  assert.deepEqual(asked, [
    ['https://example.test/ok.bin', 'HEAD'],
    ['https://example.test/gone.zip', 'HEAD'],
  ]);
});
