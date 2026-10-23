import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { PDFDocument } from 'pdf-lib';
const require = createRequire(import.meta.url);
const { createDocumentPrint, MAX_PRINT_HTML_BYTES } = require('../electron/document-print.cjs');

async function pdf(pages = 2) {
  const value = await PDFDocument.create();
  for (let index = 0; index < pages; index++) value.addPage([595, 842]);
  return Buffer.from(await value.save());
}

function fixture(options = {}) {
  const windows = [],
    imports = [],
    partitions = [];
  const session = new EventEmitter();
  session.setPermissionRequestHandler = (fn) => {
    session.permission = fn;
  };
  session.setPermissionCheckHandler = (fn) => {
    session.check = fn;
  };
  session.webRequest = {
    onBeforeRequest: (...args) => {
      session.request = args.at(-1);
    },
  };
  class BrowserWindow extends EventEmitter {
    constructor(config) {
      super();
      this.config = config;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (fn) => {
        this.open = fn;
      };
      this.webContents.printToPDF = async (args) => {
        this.printArgs = args;
        return options.print ? options.print(this) : pdf();
      };
      windows.push(this);
    }
    async loadURL(url) {
      this.url = url;
      if (options.load) await options.load(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  const service = createDocumentPrint({
    BrowserWindow,
    session: {
      fromPartition: (name, config) => {
        partitions.push({ name, config });
        return session;
      },
    },
    importAsset: async (args) => {
      imports.push(args);
      return {
        id: 'a'.repeat(64),
        name: args.name,
        mime: 'application/pdf',
        bytes: args.bytes.length,
      };
    },
    timeoutMs: options.timeoutMs || 1000,
  });
  return { service, windows, imports, session, partitions };
}

test('native printing creates a new bounded PDF asset and destroys its isolated hidden window', async () => {
  const f = fixture();
  const asset = await f.service.print({ html: '<p>Original words</p>', name: '../Report.docx' });
  const win = f.windows[0];
  assert.equal(asset.name, 'Report.pdf');
  assert.equal((await PDFDocument.load(f.imports[0].bytes)).getPageCount(), 2);
  assert.equal(win.config.show, false);
  assert.equal(win.config.webPreferences.nodeIntegration, false);
  assert.equal(win.config.webPreferences.contextIsolation, true);
  assert.equal(win.config.webPreferences.sandbox, true);
  assert.equal(win.config.webPreferences.javascript, false);
  assert.equal(win.config.webPreferences.preload, undefined);
  assert.ok(!f.partitions[0].name.startsWith('persist:'));
  assert.equal(f.partitions[0].config.cache, false);
  assert.equal(win.destroyed, true);
  assert.equal(win.printArgs.pageRanges, '1-501');
  assert.match(Buffer.from(win.url.split(',')[1], 'base64').toString(), /Content-Security-Policy/);
});

test('print windows deny network, local files, app data, navigation, popups and permissions', async () => {
  const f = fixture();
  await f.service.print({ html: '<p>Safe</p>', name: 'Safe.pdf' });
  for (const url of [
    'https://example.com/x',
    'file:///C:/private.txt',
    'canvas-media://asset/a/original',
    'blob:https://app/x',
  ]) {
    let result;
    f.session.request({ url, resourceType: 'image' }, (value) => {
      result = value;
    });
    assert.equal(result.cancel, true, url);
  }
  let data;
  f.session.request({ url: 'data:image/png;base64,eA==', resourceType: 'image' }, (value) => {
    data = value;
  });
  assert.equal(data.cancel, false);
  assert.equal(f.session.check(), false);
  let granted;
  f.session.permission(null, 'camera', (value) => {
    granted = value;
  });
  assert.equal(granted, false);
  const win = f.windows[0];
  assert.deepEqual(win.open(), { action: 'deny' });
  for (const name of [
    'will-navigate',
    'will-frame-navigate',
    'will-redirect',
    'will-attach-webview',
  ]) {
    let prevented = false;
    win.webContents.emit(name, {
      preventDefault: () => {
        prevented = true;
      },
    });
    assert.equal(prevented, true, name);
  }
});

test('oversized HTML and more than 500 printed pages never enter the asset store', async () => {
  const f = fixture({ print: () => pdf(501) });
  await assert.rejects(
    f.service.print({ html: 'x'.repeat(MAX_PRINT_HTML_BYTES + 1), name: 'Big' }),
    /large|MB/i,
  );
  assert.equal(f.windows.length, 0);
  await assert.rejects(f.service.print({ html: '<p>Many pages</p>', name: 'Many' }), /500 pages/);
  assert.equal(f.windows[0].destroyed, true);
  assert.equal(f.imports.length, 0);
});

test('timed-out and crashed print jobs destroy their windows, discard late PDFs and release the queue', async () => {
  let complete;
  const f = fixture({
    timeoutMs: 20,
    print: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  await assert.rejects(f.service.print({ html: '<p>Timeout</p>', name: 'Timeout' }), /time|long/i);
  assert.equal(f.windows[0].destroyed, true);
  complete(await pdf());
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.imports.length, 0);
  const g = fixture({
    load: (win) => {
      win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    },
  });
  await assert.rejects(
    g.service.print({ html: '<p>Crash</p>', name: 'Crash' }),
    /stopped|crash|closed/i,
  );
  assert.equal(g.windows[0].destroyed, true);
  assert.equal(g.imports.length, 0);
});

test('disposing native print cancels active and queued jobs without leaving windows or assets', async () => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const f = fixture({
    load: () => {
      entered();
      return new Promise(() => {});
    },
  });
  const one = f.service.print({ html: '<p>One</p>', name: 'One' });
  const two = f.service.print({ html: '<p>Two</p>', name: 'Two' });
  const oneCheck = assert.rejects(one, /closed|cancel/i);
  const twoCheck = assert.rejects(two, /closed|cancel/i);
  await started;
  f.service.dispose();
  await Promise.all([oneCheck, twoCheck]);
  assert.equal(f.windows.length, 1);
  assert.equal(f.windows[0].destroyed, true);
  assert.equal(f.imports.length, 0);
});

test(
  'real Electron printing preserves Unicode and multiple pages while blocking scripts and network',
  { timeout: 60000 },
  async () => {
    mkdirSync(resolve('.local-test'), { recursive: true });
    const root = mkdtempSync(resolve('.local-test/document-print-desktop-'));
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.end('Unexpected network');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${server.address().port}/private`;
    const runner = join(root, 'run.cjs');
    writeFileSync(
      runner,
      `
    const {app,BrowserWindow,session}=require('electron');
    const fs=require('node:fs'),path=require('node:path');
    process.on('uncaughtException',error=>{fs.writeFileSync(path.join(__dirname,'error.txt'),error.stack);app.exit(1);});
    const {createDocumentPrint}=require(${JSON.stringify(resolve('electron/document-print.cjs'))});
    const root=__dirname;
    app.setPath('userData',root); app.setPath('sessionData',root); app.setPath('temp',root);
    app.disableHardwareAcceleration();
    app.whenReady().then(async()=>{
      const service=createDocumentPrint({BrowserWindow,session,importAsset:async({bytes,name})=>{fs.writeFileSync(path.join(root,'output.pdf'),bytes);return{name,bytes:bytes.length};}});
      try {
        const result=await service.print({name:'Unicode.txt',html:'<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:16mm}body{font:14pt Arial}</style></head><body><p>Terra café Україна 日本語</p><p style="break-before:page">Second page exact words</p><script>document.body.innerHTML="EXECUTED SCRIPT";fetch(${JSON.stringify(address)})</script><img src="${address}"><iframe src="${address}"></iframe></body></html>'});
        fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({...result,windows:BrowserWindow.getAllWindows().length}));
        service.dispose();app.exit(0);
      }catch(error){fs.writeFileSync(path.join(root,'error.txt'),error.stack);service.dispose();app.exit(1);}
    });
  `,
    );
    try {
      const executable = require('electron');
      const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
      const child = spawn(executable, [runner], {
        cwd: resolve('.'),
        windowsHide: true,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (data) => {
        output += data;
      });
      child.stderr.on('data', (data) => {
        output += data;
      });
      const timer = setTimeout(() => child.kill(), 50000);
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      }).finally(() => clearTimeout(timer));
      let failure = '';
      try {
        failure = readFileSync(join(root, 'error.txt'), 'utf8');
      } catch {}
      assert.equal(code, 0, `${failure}\n${output}`);
      const pdfBytes = readFileSync(join(root, 'output.pdf'));
      const doc = await PDFDocument.load(pdfBytes);
      assert.equal(doc.getPageCount(), 2);
      assert.equal(JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')).windows, 0);
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const loading = pdfjs.getDocument({ data: Uint8Array.from(pdfBytes), useSystemFonts: true });
      const parsed = await loading.promise;
      try {
        const text = [];
        for (let index = 1; index <= parsed.numPages; index++)
          text.push(
            (await (await parsed.getPage(index)).getTextContent()).items
              .map((item) => item.str)
              .join(' '),
          );
        // Noto CJK (Linux) maps 日 to the look-alike Kangxi radical ⽇ and
        // splits it into its own text run; NFKC folds it back.
        assert.match(text[0].normalize('NFKC'), /Terra café Україна\s+日\s*本語/);
        assert.match(text[1], /Second page exact words/);
        assert.doesNotMatch(text.join(' '), /EXECUTED SCRIPT|Unexpected network/);
      } finally {
        await loading.destroy();
      }
      assert.equal(requests, 0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
