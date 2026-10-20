// Electron utility process for one background cut-out (background-removal.cjs).
// It loads the ONNX runtime from the installed extension, so its DLLs are
// released when this process exits.
const path = require('node:path');
const { cutout } = require('./image-cutout.cjs');

process.parentPort.once('message', ({ data }) => {
  const { file, icon, model, runtime } = data;
  cutout(file, {
    icon,
    model,
    loadOrt: runtime ? () => require(path.join(runtime, 'node_modules', 'onnxruntime-node')) : null,
  })
    .then((bytes) => process.parentPort.postMessage({ bytes }))
    .catch((error) => process.parentPort.postMessage({ error: error.message }));
});
