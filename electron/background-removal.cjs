const { Worker } = require('node:worker_threads');
const path = require('node:path');

// One inference at a time, outside both the renderer and SQLite worker.
// Dispose its native session after each job instead of retaining hundreds of MB.
let chain = Promise.resolve();
let queued = 0;
function removeBackground(file, icon = false) {
  if (queued >= 4)
    return Promise.reject(Error('Background removal is busy. Please try again shortly.'));
  queued++;
  const task = chain.then(
    () =>
      new Promise((resolve, reject) => {
        const model = path
          .join(__dirname, '../assets/models/u2net.onnx')
          .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
        const worker = new Worker(path.join(__dirname, 'background-removal-worker.cjs'), {
          workerData: { file, icon, model },
        });
        let settled = false;
        const finish = async (error, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          await worker.terminate();
          error ? reject(error) : resolve(result?.bytes ? Buffer.from(result.bytes) : null);
        };
        const timer = setTimeout(
          () => void finish(Error('Background removal took too long. Try a smaller image.')),
          90000,
        );
        worker.once(
          'message',
          (result) => void finish(result.error ? Error(result.error) : null, result),
        );
        worker.once('error', (error) => void finish(error));
        worker.once(
          'exit',
          () => void finish(Error('Background removal stopped unexpectedly. Please try again.')),
        );
      }),
  );
  chain = task.catch(() => {});
  return task.finally(() => queued--);
}
module.exports = { removeBackground };
