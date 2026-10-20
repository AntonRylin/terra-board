// Optional parts of Terra Board that people install and remove in
// Settings → Extensions. Each one is a folder of payload files under `root`
// (the Extensions folder beside the Library). Files come from a local build
// (`source.dir`) or are downloaded (`source.remote`), and every file is checked
// against the SHA-256 in the catalog the build embeds before it is used.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { unzipSync } = require('fflate');

const MARKER = 'extension.json';
const REMOVE = '.remove';

// Windows refuses a rename for a moment while an antivirus or the search
// indexer still reads files that were just written. Retry before giving up.
async function retried(task, attempts) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 50 * 2 ** attempt)));
    }
  }
}

function createExtensions({
  root,
  catalog,
  source,
  fetch,
  installers = {},
  systemInstalled = () => false,
  beforeRemove = async () => {},
  onChange = () => {},
  rename = fs.promises.rename,
}) {
  const entries = new Map((catalog?.extensions || []).map((entry) => [entry.id, entry]));
  const jobs = new Map();
  const errors = new Map();
  const notices = new Map();
  const sizes = new Map();
  let queue = Promise.resolve();
  let timer = null;

  const folder = (id) => path.join(root, id);
  const installed = (id) => {
    if (fs.existsSync(path.join(folder(id), REMOVE))) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(folder(id), MARKER), 'utf8'));
    } catch {
      return null;
    }
  };
  const emit = (now = false) => {
    if (now) {
      clearTimeout(timer);
      timer = null;
      onChange(list());
    } else
      timer ||= setTimeout(() => {
        timer = null;
        onChange(list());
      }, 100);
  };
  const entryOf = (id) => {
    const entry = entries.get(id);
    if (!entry) throw Error('This extension is not part of this version of Terra Board.');
    return entry;
  };

  function sizeOf(dir) {
    let total = 0;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      total += item.isDirectory() ? sizeOf(file) : fs.statSync(file).size;
    }
    return total;
  }

  function status(entry) {
    const job = jobs.get(entry.id);
    const info = installed(entry.id);
    const system = !info && !job && systemInstalled(entry.id);
    if (info && !sizes.has(entry.id)) sizes.set(entry.id, sizeOf(folder(entry.id)));
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      version: entry.version,
      state: job ? 'installing' : info || system ? 'installed' : 'available',
      downloadBytes: entry.downloadSize || 0,
      ...(info && {
        installedBytes: sizes.get(entry.id),
        outdated: info.version !== entry.version,
      }),
      ...(system && { system: true }),
      ...(job && { progress: job.progress }),
      ...(errors.has(entry.id) && { error: errors.get(entry.id) }),
      ...(notices.has(entry.id) && { notice: notices.get(entry.id) }),
    };
  }
  function list() {
    return [...entries.values()].map(status);
  }

  async function copyFile(entry, file, dir, signal, onBytes) {
    if (!/^[\w.-]+$/.test(file.name))
      throw Error(`The ${entry.name} catalog has an invalid file name.`);
    let stream;
    if (source?.dir) {
      const local = path.join(source.dir, file.name);
      if (!fs.existsSync(local))
        throw Error(`${file.name} is missing from ${source.dir}. Build the extensions first.`);
      stream = fs.createReadStream(local);
    } else {
      let response;
      try {
        response = await fetch(file.url, { signal });
      } catch (error) {
        if (signal.aborted) throw error;
        throw Error(`Couldn't download ${entry.name}. Check your connection and try again.`);
      }
      if (!response.ok || !response.body)
        throw Error(`Couldn't download ${entry.name} (HTTP ${response.status}). Try again later.`);
      stream = Readable.fromWeb(response.body);
    }
    const hash = createHash('sha256');
    const output = await fs.promises.open(path.join(dir, file.name), 'wx');
    let size = 0;
    try {
      for await (const chunk of stream) {
        signal.throwIfAborted();
        size += chunk.length;
        if (size > file.size) break;
        hash.update(chunk);
        await output.write(chunk);
        onBytes(size);
      }
    } finally {
      stream.destroy?.();
      await output.close();
    }
    signal.throwIfAborted();
    if (size !== file.size || hash.digest('hex') !== file.sha256)
      throw Error(`The download of ${entry.name} was damaged. Try again.`);
  }

  async function unpack(entry, archive, dir) {
    const files = unzipSync(await fs.promises.readFile(archive));
    const base = path.resolve(dir);
    for (const [name, bytes] of Object.entries(files)) {
      if (name.endsWith('/')) continue;
      const target = path.resolve(base, name);
      if (path.isAbsolute(name) || !target.startsWith(base + path.sep))
        throw Error(`The ${entry.name} archive has a file outside its folder.`);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, bytes);
    }
    await fs.promises.rm(archive);
  }

  // Moves a folder aside and deletes it. A file that Windows keeps locked marks
  // the folder for deletion when the app next starts (cleanup).
  async function discard(dir) {
    const trash = path.join(root, `.trash-${path.basename(dir)}-${randomUUID()}`);
    try {
      await retried(() => rename(dir, trash), 4);
    } catch {
      await fs.promises.writeFile(path.join(dir, REMOVE), '');
      return false;
    }
    await fs.promises.rm(trash, { recursive: true, force: true }).catch(() => {});
    return true;
  }

  async function run(entry, job) {
    const signal = job.controller.signal;
    await fs.promises.mkdir(root, { recursive: true });
    const staging = path.join(root, `.partial-${entry.id}-${randomUUID()}`);
    await fs.promises.mkdir(staging);
    try {
      if (entry.installer) {
        const installer = installers[entry.installer];
        if (!installer) throw Error(`${entry.name} can't be installed in this build.`);
        await installer({
          dir: staging,
          signal,
          progress: (progress) => {
            job.progress = progress;
            emit();
          },
        });
      } else {
        let done = 0;
        for (const file of entry.files || []) {
          await copyFile(entry, file, staging, signal, (bytes) => {
            job.progress = { received: done + bytes, total: entry.downloadSize || 0 };
            emit();
          });
          done += file.size;
          if (file.unzip) await unpack(entry, path.join(staging, file.name), staging);
        }
      }
      signal.throwIfAborted();
      await fs.promises.writeFile(
        path.join(staging, MARKER),
        JSON.stringify({
          id: entry.id,
          version: entry.version,
          installedAt: new Date().toISOString(),
        }),
      );
      const target = folder(entry.id);
      if (fs.existsSync(target) && !(await discard(target)))
        throw Error(`Close anything that uses ${entry.name}, then try again.`);
      await retried(() => rename(staging, target), 8);
      sizes.delete(entry.id);
    } catch (error) {
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
      if (signal.aborted) throw Error(`Installing ${entry.name} was cancelled.`);
      errors.set(entry.id, error.message || String(error));
      throw error;
    }
  }

  function install(id) {
    const entry = entryOf(id);
    if (jobs.has(id)) return jobs.get(id).promise;
    const job = {
      controller: new AbortController(),
      progress: { received: 0, total: entry.downloadSize || 0 },
    };
    jobs.set(id, job);
    errors.delete(id);
    notices.delete(id);
    emit(true);
    job.promise = queue
      .catch(() => {})
      .then(() => run(entry, job))
      .finally(() => {
        jobs.delete(id);
        emit(true);
      });
    queue = job.promise;
    return job.promise;
  }

  async function remove(id) {
    const entry = entryOf(id);
    const job = jobs.get(id);
    if (job) {
      job.controller.abort();
      await job.promise.catch(() => {});
    }
    await beforeRemove(id);
    const dir = folder(id);
    errors.delete(id);
    if (fs.existsSync(dir) && !(await discard(dir)))
      notices.set(id, `${entry.name} finishes removing when Terra Board restarts.`);
    sizes.delete(id);
    emit(true);
  }

  // Takes over a folder that already holds an extension's files, such as the
  // LibreOffice that 0.1.28 and earlier extracted into Library/tools. It moves
  // into the extension's folder under its own name. False when there is
  // nothing to take over or the extension is already installed.
  async function adopt(id, existing) {
    const entry = entryOf(id);
    if (installed(id) || jobs.has(id) || !fs.existsSync(existing)) return false;
    await fs.promises.mkdir(root, { recursive: true });
    const staging = path.join(root, `.partial-${id}-${randomUUID()}`);
    await fs.promises.mkdir(staging);
    try {
      await retried(() => rename(existing, path.join(staging, path.basename(existing))), 4);
      await fs.promises.writeFile(
        path.join(staging, MARKER),
        JSON.stringify({ id, version: entry.version, installedAt: new Date().toISOString() }),
      );
      await retried(() => rename(staging, folder(id)), 8);
    } catch {
      // Put the old folder back where it was; it still works from there.
      const moved = path.join(staging, path.basename(existing));
      const restored =
        !fs.existsSync(moved) ||
        (await rename(moved, existing).then(
          () => true,
          () => false,
        ));
      if (restored) await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
      return false;
    }
    sizes.delete(id);
    emit(true);
    return true;
  }

  async function cleanup() {
    if (!fs.existsSync(root)) return;
    for (const name of await fs.promises.readdir(root)) {
      const dir = path.join(root, name);
      if (
        name.startsWith('.partial-') ||
        name.startsWith('.trash-') ||
        fs.existsSync(path.join(dir, REMOVE))
      )
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    list,
    install,
    cancel: (id) => jobs.get(id)?.controller.abort(),
    remove,
    path: (id) => (installed(id) ? folder(id) : null),
    cleanup,
    adopt,
  };
}

module.exports = { createExtensions };
