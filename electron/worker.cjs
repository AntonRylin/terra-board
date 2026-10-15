const { parentPort, workerData } = require('node:worker_threads');
const { Store } = require('./store.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const store = new Store(workerData.root);
const allowed = new Set([
  'library',
  'createBoard',
  'createFolder',
  'updateBoard',
  'updateFolder',
  'removeFolder',
  'restoreBoard',
  'duplicateBoard',
  'loadBoard',
  'searchContent',
  'patchBoard',
  'saveCamera',
  'setLastBoard',
  'importAsset',
  'asset',
  'exportBoard',
  'importBoard',
  'syncStatus',
  'syncEnable',
  'syncDisable',
  'syncIdentity',
  'syncLibrary',
  'syncOwned',
  'syncReconcile',
  'syncKeepLocal',
  'syncCursor',
  'syncRename',
  'syncProfile',
  'syncSetProfile',
  'syncTake',
  'syncAck',
  'syncMissingAssets',
  'syncApply',
  'syncImportAsset',
]);
let chain = Promise.resolve();
const assetJobs = new Set();
parentPort.on('message', (message) => {
  // Image work must not block the saved-edit queue. Inference runs in its own
  // bounded worker; asset metadata is read/committed synchronously between awaits.
  // Closing waits for these jobs before closing SQLite.
  if (message.command === 'asset' || message.command === 'removeBackground') {
    const job = store[message.command === 'asset' ? 'readAsset' : 'removeBackground'](message.args)
      .then((result) => parentPort.postMessage({ id: message.id, result }))
      .catch((e) => parentPort.postMessage({ id: message.id, error: e.message }))
      .finally(() => assetJobs.delete(job));
    assetJobs.add(job);
    return;
  }
  chain = chain.then(async () => {
    try {
      let result;
      if (message.command === 'close') {
        await Promise.all(assetJobs);
        store.close();
        result = true;
      } else if (message.command === 'importFile') {
        const file = message.args.file;
        const stat = fs.statSync(file);
        if (!stat.isFile()) throw Error('Choose a regular file');
        const size = stat.size;
        const portable =
          message.args.attachment !== true && path.extname(file).toLowerCase() === '.canvas';
        if (size > (portable ? 544 : 256) * 1024 * 1024)
          throw Error(portable ? 'Portable board exceeds 544 MB' : 'File exceeds 256 MB');
        const bytes = fs.readFileSync(file);
        result = portable
          ? await store.importBoard({ bytes })
          : await store.importAsset({ bytes, name: path.basename(file) });
      } else if (message.command === 'exportFile') {
        const bytes = await store.exportBoard({ id: message.args.id });
        const file = message.args.file,
          tmp = file + '.' + randomUUID() + '.tmp';
        const fd = fs.openSync(tmp, 'wx');
        try {
          fs.writeFileSync(fd, bytes);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
        result = true;
      } else {
        if (!allowed.has(message.command)) throw Error('Unknown command');
        result = await store[message.command](message.args);
      }
      parentPort.postMessage({ id: message.id, result });
    } catch (e) {
      parentPort.postMessage({ id: message.id, error: e.message });
    }
  });
});
