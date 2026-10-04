const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');

const documentMimes = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.docm': 'application/vnd.ms-word.document.macroEnabled.12',
  '.dotx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  '.rtf': 'application/rtf',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xlsb': 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.gdoc': 'application/vnd.google-apps.document',
  '.gsheet': 'application/vnd.google-apps.spreadsheet',
  '.gslides': 'application/vnd.google-apps.presentation',
};
const mediaExtensions = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.avif',
  '.tif',
  '.tiff',
  '.ico',
  '.mp4',
  '.webm',
]);

// Document extensions always retain their bytes, even for damaged or unsupported
// previews. Only recognized images enter Sharp; arbitrary attachments never do.
function attachmentMime(name, data) {
  const ext = path.extname(name).toLowerCase();
  if (documentMimes[ext]) return documentMimes[ext];
  if (mediaExtensions.has(ext)) return null;
  if (data.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  const head = data.subarray(0, 12);
  const image =
    head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (data[0] === 255 && data[1] === 216 && data[2] === 255) ||
    /^(GIF87a|GIF89a)/.test(head.toString('ascii')) ||
    (head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP') ||
    head.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) ||
    head.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42])) ||
    (head.subarray(4, 8).toString() === 'ftyp' &&
      ['avif', 'avis'].includes(head.subarray(8, 12).toString()));
  return image ? null : 'application/octet-stream';
}

function safeFilename(name) {
  const basename = path.posix.basename(String(name || 'Document').replace(/\\/g, '/'));
  let clean = basename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '');
  const extension = path.extname(clean).slice(0, 32);
  if (clean.length > 240) clean = clean.slice(0, 240 - extension.length) + extension;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) clean = '_' + clean;
  return clean || 'Document';
}

function createAssetDownload({ dialog, getWindow, readAsset }) {
  return {
    async save({ id, name }) {
      if (typeof name !== 'string' || name.length > 100000) throw Error('Invalid filename');
      const asset = await readAsset({ id, variant: 'original' });
      const result = await dialog.showSaveDialog(getWindow(), {
        title: 'Download file',
        defaultPath: safeFilename(name || asset.name),
      });
      if (result.canceled || !result.filePath) return false;
      if (path.resolve(result.filePath) === path.resolve(asset.file)) return true;
      const temporary = result.filePath + '.' + randomUUID() + '.tmp';
      try {
        await fs.promises.copyFile(asset.file, temporary, fs.constants.COPYFILE_EXCL);
        await fs.promises.rename(temporary, result.filePath);
      } finally {
        await fs.promises.rm(temporary, { force: true }).catch(() => {});
      }
      return true;
    },
  };
}

function assetResponse(asset, range) {
  const size = fs.statSync(asset.file).size;
  let start = 0,
    end = size - 1,
    status = 200;
  const headers = {
    'Content-Type': asset.contentType,
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=31536000, immutable',
  };
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) return new Response(null, { status: 416 });
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), end) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size)
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      });
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  return new Response(
    size ? Readable.toWeb(fs.createReadStream(asset.file, { start, end })) : null,
    {
      status,
      headers,
    },
  );
}

module.exports = { attachmentMime, createAssetDownload, assetResponse };
