const path = require('node:path');

// One cut-out at a time, each in its own short-lived utility process
// (background-removal-process.cjs). The ONNX runtime's DLLs unload when that
// process exits, so the extension can be removed right away, and a crash in
// inference can't take the app down. `location()` gives the installed
// extension's model and runtime folder, or null; flat icons need neither.
function createBackgroundRemoval({ fork, location }) {
  let chain = Promise.resolve();
  let queued = 0;
  let generation = 0;
  let current = null;
  function job(file, icon, started) {
    return new Promise((resolve, reject) => {
      if (started !== generation) return reject(Error('Background removal was stopped.'));
      const paths = location();
      const child = fork(path.join(__dirname, 'background-removal-process.cjs'));
      let settled = false;
      const finish = (error, bytes) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        current = null;
        child.kill();
        error ? reject(error) : resolve(bytes ? Buffer.from(bytes) : null);
      };
      current = { finish, exited: new Promise((resolve) => child.once('exit', resolve)) };
      const timer = setTimeout(
        () => finish(Error('Background removal took too long. Try a smaller image.')),
        90000,
      );
      child.on('message', (message) =>
        finish(message?.error ? Error(message.error) : null, message?.bytes),
      );
      child.on('exit', () =>
        finish(Error('Background removal stopped unexpectedly. Please try again.')),
      );
      child.postMessage({
        file,
        icon,
        model: paths?.model ?? null,
        runtime: paths?.runtime ?? null,
      });
    });
  }
  function run(file, icon = false) {
    if (queued >= 4)
      return Promise.reject(Error('Background removal is busy. Please try again shortly.'));
    queued++;
    const started = generation;
    const task = chain.then(() => job(file, icon, started));
    chain = task.catch(() => {});
    return task.finally(() => queued--);
  }
  // For removing the extension or quitting: ends the running job, turns away
  // the ones still waiting, and resolves once its process has exited, so the
  // runtime's DLLs are no longer in use.
  async function stop() {
    generation++;
    const running = current;
    if (!running) return;
    running.finish(Error('Background removal was stopped.'));
    await Promise.race([running.exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  return { run, stop };
}

// The cut-out of an image asset, saved as a new PNG asset beside the original;
// the original itself when there was nothing to remove (an already transparent
// icon).
async function removeAssetBackground({ id, icon = false } = {}, { readAsset, importAsset, run }) {
  if (typeof icon !== 'boolean') throw Error('Invalid icon option');
  const asset = await readAsset({ id, variant: 'original' });
  if (!asset.mime.startsWith('image/')) throw Error('Choose an image to remove its background.');
  const bytes = await run(asset.file, icon);
  if (!bytes) {
    const { file, contentType, ...original } = asset;
    return original;
  }
  return importAsset({ bytes, name: asset.name.replace(/\.[^.]+$/, '') + ' - cutout.png' });
}

module.exports = { createBackgroundRemoval, removeAssetBackground };
