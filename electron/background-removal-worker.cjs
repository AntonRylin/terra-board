const { parentPort, workerData } = require('node:worker_threads');
const { cutout } = require('./image-cutout.cjs');

cutout(workerData.file, workerData.model, workerData.icon)
  .then((bytes) => parentPort.postMessage({ bytes }))
  .catch((error) => parentPort.postMessage({ error: error.message }));
