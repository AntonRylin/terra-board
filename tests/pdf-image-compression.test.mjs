import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import sharp from 'sharp';
import { PDFDocument, PDFName, decodePDFRawStream } from 'pdf-lib';

const require = createRequire(import.meta.url);

test(
  'oversized image batches export with smaller images, intact pages and transparent pixels',
  { timeout: 60000 },
  async () => {
    mkdirSync(resolve('.local-test'), { recursive: true });
    const root = mkdtempSync(resolve('.local-test/pdf-image-compression-'));
    // Each image is acceptable on its own, but together they exceed 128 MiB decoded.
    const inputs = [];
    for (const [id, width, height, color, kind] of [
      ['wide', 4800, 2400, '#ff000080', 'png'],
      ['tall', 2400, 4800, '#00ff00', 'jpg'],
      ['square', 3600, 3600, '#0000ff', 'png'],
      ['small', 120, 80, '#123456', 'png'],
    ]) {
      const pipeline = sharp({ create: { width, height, channels: 4, background: color } });
      const bytes = await (kind === 'jpg' ? pipeline.jpeg() : pipeline.png()).toBuffer();
      writeFileSync(join(root, `${id}.${kind}`), bytes);
      inputs.push({ id, name: `${id}.${kind}`, kind });
    }
    // Run the production implementation with real Chromium bitmap/canvas APIs.
    // pdf-edit.ts imports ./pdf-sources.ts; both become CommonJS .js files here.
    writeFileSync(join(root, 'package.json'), '{ "type": "commonjs" }');
    for (const name of ['pdf-edit', 'pdf-sources'])
      writeFileSync(
        join(root, `${name}.js`),
        ts.transpileModule(readFileSync(resolve(`src/canvas/${name}.ts`), 'utf8'), {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            rewriteRelativeImportExtensions: true,
          },
        }).outputText,
      );
    writeFileSync(join(root, 'blank.html'), '<!doctype html><title>PDF compression test</title>');
    const expression = `(async () => {
      const fs = require('node:fs'), path = require('node:path');
      const root = ${JSON.stringify(root)};
      const { assemblePdf } = require(path.join(root, 'pdf-edit.js'));
      const sources = ${JSON.stringify(inputs)}.map(s => ({...s,
        bytes: Uint8Array.from(fs.readFileSync(path.join(root, s.name)))}));
      const snapshots = sources.map(s => Buffer.from(s.bytes));
      const pages = [
        {id:'tall',sourceId:'tall',pageIndex:0,rotation:90},
        {id:'wide',sourceId:'wide',pageIndex:0,rotation:0},
        {id:'square',sourceId:'square',pageIndex:0,rotation:0},
        {id:'copy',sourceId:'wide',pageIndex:0,rotation:180},
        {id:'small',sourceId:'small',pageIndex:0,rotation:0}
      ];
      fs.writeFileSync(path.join(root,'output.pdf'), await assemblePdf(sources, pages));
      // Unselected large images must not reduce a small export's resolution.
      fs.writeFileSync(path.join(root,'small.pdf'), await assemblePdf(sources, [pages[4]]));
      require('node:assert/strict').ok(sources.every((s,i) => snapshots[i].equals(Buffer.from(s.bytes))));
    })()`;
    const runner = join(root, 'run.cjs');
    writeFileSync(
      runner,
      `
      const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
      app.setPath('userData',__dirname);app.setPath('sessionData',__dirname);app.setPath('temp',__dirname);
      app.disableHardwareAcceleration();
      app.whenReady().then(async()=>{
        try {
          const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}});
          await win.loadFile(path.join(__dirname,'blank.html'));
          await win.webContents.executeJavaScript(${JSON.stringify(expression)});
          app.exit(0);
        } catch(error) {fs.writeFileSync(path.join(__dirname,'error.txt'),error.stack);app.exit(1);}
      });
    `,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [runner], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostics = '';
    child.stdout.on('data', (data) => {
      diagnostics += data;
    });
    child.stderr.on('data', (data) => {
      diagnostics += data;
    });
    const timer = setTimeout(() => child.kill(), 50000);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    }).finally(() => clearTimeout(timer));
    const error = existsSync(join(root, 'error.txt'))
      ? readFileSync(join(root, 'error.txt'), 'utf8')
      : '';
    assert.equal(code, 0, `${error}\n${diagnostics}`);
    const doc = await PDFDocument.load(readFileSync(join(root, 'output.pdf')));
    assert.equal(doc.getPageCount(), 5);
    assert.deepEqual(
      doc.getPages().map((p) => p.getSize()),
      [
        { width: 720, height: 1440 },
        { width: 1440, height: 720 },
        { width: 1440, height: 1440 },
        { width: 1440, height: 720 },
        { width: 120, height: 80 },
      ],
    );
    assert.deepEqual(
      doc.getPages().map((p) => p.getRotation().angle),
      [90, 0, 0, 180, 0],
    );
    const embedded = (document, page) => {
      const [, ref] = document
        .getPage(page)
        .node.Resources()
        .lookup(PDFName.of('XObject'))
        .entries()[0];
      return { ref, image: document.context.lookup(ref) };
    };
    let pixels = 0;
    for (const [index, width, height] of [
      [0, 2400, 4800],
      [1, 4800, 2400],
      [2, 3600, 3600],
    ]) {
      const { image } = embedded(doc, index);
      const w = image.dict.get(PDFName.of('Width')).asNumber();
      const h = image.dict.get(PDFName.of('Height')).asNumber();
      assert.ok(w < width && h < height, 'image pixels were actually downsampled');
      assert.ok(Math.abs(w / h - width / height) < 0.002, 'aspect ratio survives rounding');
      pixels += w * h;
    }
    assert.ok(pixels * 4 <= 128 * 1024 * 1024, 'embedded batch fits the decode budget');
    assert.equal(
      embedded(doc, 1).ref.toString(),
      embedded(doc, 3).ref.toString(),
      'duplicates reuse their image',
    );
    const alpha = doc.context.lookup(embedded(doc, 1).image.dict.get(PDFName.of('SMask')));
    assert.ok(alpha, 'transparent PNG retains an alpha mask');
    assert.ok(Math.abs(decodePDFRawStream(alpha).decode()[0] - 128) <= 1);
    const rgb = decodePDFRawStream(embedded(doc, 1).image).decode();
    assert.ok(rgb[0] > 250 && rgb[1] < 5 && rgb[2] < 5, 'transparent red stays red');
    const small = await PDFDocument.load(readFileSync(join(root, 'small.pdf')));
    assert.equal(embedded(small, 0).image.dict.get(PDFName.of('Width')).asNumber(), 120);
    assert.equal(embedded(small, 0).image.dict.get(PDFName.of('Height')).asNumber(), 80);
  },
);
