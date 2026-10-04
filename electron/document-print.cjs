const { randomUUID } = require('node:crypto');

const MAX_PRINT_HTML_BYTES = 16 * 1024 * 1024;
const MAX_PRINT_PDF_BYTES = 64 * 1024 * 1024;
const MAX_PRINT_PAGES = 500;
const CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'";

function printInput(args) {
  if (!args || typeof args.html !== 'string' || typeof args.name !== 'string')
    throw Error('Invalid document conversion request.');
  if (Buffer.byteLength(args.html, 'utf8') > MAX_PRINT_HTML_BYTES)
    throw Error('Rendered documents are limited to 16 MB. Use a smaller document.');
  const name =
    (args.name.split(/[\\/]/).pop() || 'Document')
      .replace(/\.[^.]+$/, '')
      .replace(/[<>:"|?*\x00-\x1f]/g, '-')
      .replace(/[. ]+$/, '')
      .slice(0, 160) || 'Document';
  return { html: args.html, name: name + '.pdf' };
}

function createDocumentPrint({ BrowserWindow, session, importAsset, timeoutMs = 45000 }) {
  let tail = Promise.resolve(),
    pending = 0,
    disposed = false,
    cancelActive,
    documentUrl;
  // An in-memory session is shared only by this serial converter, never by the app.
  const isolated = session.fromPartition(`terra-document-print-${randomUUID()}`, { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on('will-download', (event) => event.preventDefault());
  isolated.webRequest.onBeforeRequest((details, reply) => {
    const embedded =
      details.url.startsWith('data:') && ['image', 'font'].includes(details.resourceType);
    const initialDocument = details.resourceType === 'mainFrame' && details.url === documentUrl;
    reply({ cancel: !embedded && !initialDocument });
  });

  async function render(input) {
    if (disposed) throw Error('Document conversion was cancelled because Terra Board is closing.');
    const win = new BrowserWindow({
      width: 794,
      height: 1123,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        session: isolated,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        javascript: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    let cancelled = false,
      timer;
    const stopped = new Promise((_, reject) => {
      const cancel = (error = Error('Document conversion was cancelled.')) => {
        cancelled = true;
        reject(error);
      };
      cancelActive = cancel;
      timer = setTimeout(
        () => cancel(Error('Document conversion took too long. Use a smaller document.')),
        timeoutMs,
      );
      win.once('closed', () => {
        if (!cancelled) cancel(Error('The document conversion window closed.'));
      });
      win.webContents.once('render-process-gone', () =>
        cancel(Error('The document converter stopped unexpectedly. Try a smaller file.')),
      );
    });
    const check = () => {
      if (cancelled || disposed) throw Error('Document conversion was cancelled.');
    };
    const prevent = (event) => event.preventDefault();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const name of [
      'will-navigate',
      'will-frame-navigate',
      'will-redirect',
      'will-attach-webview',
    ])
      win.webContents.on(name, prevent);
    const work = async () => {
      // Even a malformed supplied document meets this policy before any of its markup.
      const html =
        `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">` +
        input.html;
      documentUrl =
        'data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64');
      try {
        await win.loadURL(documentUrl);
      } catch {
        check();
        throw Error('This document could not be prepared for printing.');
      }
      check();
      const bytes = await win.webContents.printToPDF({
        printBackground: true,
        displayHeaderFooter: false,
        preferCSSPageSize: false,
        pageSize: 'A4',
        pageRanges: '1-501',
        generateTaggedPDF: true,
      });
      check();
      if (!bytes.length || bytes.length > MAX_PRINT_PDF_BYTES)
        throw Error('Converted PDFs are limited to 64 MB. Use a smaller document.');
      const { PDFDocument } = require('pdf-lib');
      const pdf = await PDFDocument.load(bytes, {
        updateMetadata: false,
        throwOnInvalidObject: true,
      });
      check();
      if (!pdf.getPageCount() || pdf.getPageCount() > MAX_PRINT_PAGES)
        throw Error('Document conversion is limited to 500 pages. Split this document first.');
      return importAsset({ bytes, name: input.name });
    };
    try {
      return await Promise.race([work(), stopped]);
    } finally {
      clearTimeout(timer);
      cancelled = true;
      cancelActive = undefined;
      documentUrl = undefined;
      if (!win.isDestroyed()) win.destroy();
    }
  }

  return {
    async print(args) {
      const input = printInput(args);
      if (disposed)
        throw Error('Document conversion was cancelled because Terra Board is closing.');
      if (pending >= 8) throw Error('Too many document conversions are queued. Please try again.');
      pending++;
      const task = tail.then(() => render(input));
      tail = task.catch(() => {});
      try {
        return await task;
      } finally {
        pending--;
      }
    },
    dispose() {
      disposed = true;
      cancelActive?.();
    },
  };
}

module.exports = {
  createDocumentPrint,
  MAX_PRINT_HTML_BYTES,
  MAX_PRINT_PDF_BYTES,
  MAX_PRINT_PAGES,
};
