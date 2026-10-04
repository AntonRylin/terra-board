import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { zipSync, strToU8 } from 'fflate';

const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const {
  createOfficeConverter,
  ensureOfficeRuntime,
  VERSION,
} = require('../electron/office-converter.cjs');
const root = await fs.mkdtemp(path.resolve('.local-test/office-check-'));
const library = path.join(root, 'library');
await fs.mkdir(library, { recursive: true });
if (process.env.CANVAS_OFFICE_RUNTIME) {
  await fs.mkdir(path.join(library, 'tools'), { recursive: true });
  await fs.symlink(
    path.resolve(process.env.CANVAS_OFFICE_RUNTIME),
    path.join(library, 'tools', `libreoffice-${VERSION}`),
    'junction',
  );
}
console.log(root);
const executable = await ensureOfficeRuntime(library, { onProgress: console.log });
const fixtures = path.join(root, 'fixtures');
await fs.mkdir(fixtures);
await fs.writeFile(
  path.join(fixtures, 'office-word.rtf'),
  '{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Calibri;}}\\f0\\fs28 OFFICE WORD ALPHA\\par Original Word content retained.\\page OFFICE WORD SECOND PAGE}',
);
await fs.writeFile(
  path.join(fixtures, 'office-sheet.csv'),
  'Item,Value\nOFFICE SHEET BRAVO,42\nSecond row,100\n',
);
await fs.writeFile(
  path.join(fixtures, 'office-slide.fodp'),
  `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation">
<office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="21cm" style:print-orientation="landscape"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles>
<office:body><office:presentation><draw:page draw:name="Slide1" draw:master-page-name="Default"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="23cm" svg:height="10cm"><draw:text-box><text:p>OFFICE SLIDE CHARLIE</text:p><text:p>Original slide content retained.</text:p></draw:text-box></draw:frame></draw:page></office:presentation></office:body></office:document>`,
);
const cases = [
  {
    input: 'office-word.rtf',
    format: 'doc:MS Word 97',
    file: 'office-word.doc',
    marker: 'OFFICE WORD ALPHA',
    pages: 2,
  },
  {
    input: 'office-sheet.csv',
    format: 'xls:MS Excel 97',
    file: 'office-sheet.xls',
    marker: 'OFFICE SHEET BRAVO',
    pages: 1,
  },
  {
    input: 'office-slide.fodp',
    format: 'ppt:MS PowerPoint 97',
    file: 'office-slide.ppt',
    marker: 'OFFICE SLIDE CHARLIE',
    pages: 1,
  },
];
const store = new Store(library);
const converter = createOfficeConverter({
  root: library,
  readAsset: (args) => store.readAsset(args),
  importAsset: (args) => store.importAsset(args),
  onProgress: console.log,
});
try {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  for (const fixture of cases) {
    await promisify(execFile)(
      executable,
      [
        `-env:UserInstallation=${pathToFileURL(path.join(root, 'fixture-profile')).href}`,
        '--headless',
        '--nologo',
        '--convert-to',
        fixture.format,
        '--outdir',
        fixtures,
        path.join(fixtures, fixture.input),
      ],
      { windowsHide: true, timeout: 120000 },
    );
    const original = await fs.readFile(path.join(fixtures, fixture.file));
    const asset = await store.importAsset({ name: fixture.file, bytes: original });
    const result = await converter.convert({ id: asset.id, name: fixture.file });
    const saved = await store.readAsset({ id: result.id, variant: 'original' });
    const pdf = await getDocument({
      data: new Uint8Array(await fs.readFile(saved.file)),
      useSystemFonts: true,
    }).promise;
    try {
      assert.equal(pdf.numPages, fixture.pages);
      let text = '';
      for (let index = 1; index <= pdf.numPages; index++)
        text +=
          (await (await pdf.getPage(index)).getTextContent()).items
            .map((item) => item.str || '')
            .join(' ') + '\n';
      assert.ok(text.includes(fixture.marker), text);
    } finally {
      await pdf.loadingTask.destroy();
    }
    const unchanged = await store.readAsset({ id: asset.id, variant: 'original' });
    assert.deepEqual(await fs.readFile(unchanged.file), original);
    assert.equal(asset.id, createHash('sha256').update(original).digest('hex'));
    console.log(`CONVERTED ${fixture.file} -> ${fixture.pages} PDF pages`);
  }
  const linkedRequests = [];
  const linkedServer = createServer((request, response) => {
    linkedRequests.push(request.url);
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgQIAKc6eIAAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
  });
  await new Promise((resolve, reject) => {
    linkedServer.once('error', reject);
    linkedServer.listen(0, '127.0.0.1', resolve);
  });
  try {
    const linkedUrl = `http://127.0.0.1:${linkedServer.address().port}/office-image-canary.png`;
    const linkedBytes = zipSync({
      mimetype: [strToU8('application/vnd.oasis.opendocument.text'), { level: 0 }],
      'content.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.2"><office:body><office:text><text:p>OFFICE EXTERNAL IMAGE CANARY</text:p><text:p><draw:frame draw:name="Canary" text:anchor-type="as-char" svg:width="4cm" svg:height="4cm"><draw:image xlink:href="${linkedUrl}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p></office:text></office:body></office:document-content>`),
      'META-INF/manifest.xml': strToU8(`<?xml version="1.0"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`),
    });
    const linkedAsset = await store.importAsset({ name: 'linked-image.odt', bytes: linkedBytes });
    const linkedResult = await converter.convert({ id: linkedAsset.id, name: 'linked-image.odt' });
    const linkedPdf = await store.readAsset({ id: linkedResult.id, variant: 'original' });
    assert.equal((await fs.readFile(linkedPdf.file)).subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual(linkedRequests, [], 'Office conversion must not fetch linked images');
    assert.deepEqual(
      await fs.readdir(path.join(library, 'temp')),
      [],
      'Private jobs must be removed',
    );
    console.log('OFFICE_EXTERNAL_LINKS_BLOCKED');
  } finally {
    await new Promise((resolve) => linkedServer.close(resolve));
  }
  await assert.rejects(
    converter.convert({ id: 'a'.repeat(64), name: 'unknown.exe' }),
    /cannot be converted/,
  );
  console.log('OFFICE_CONVERTER_OK ' + root);
} finally {
  converter.dispose();
  store.close();
}
