// Folder frames and file tiles (board objects of type 'file'): reading folders
// on this computer, watching them, their icons, and the Windows actions done
// to them from the board. Nothing listed here is stored in a board; boards hold
// only which folder to show (`root` + `path`, see src/canvas/file-link.ts).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createNightLight } = require('./night-light.cjs');

const roots = ['desktop', 'downloads', 'documents', 'pictures', 'music', 'videos', 'home'];
const rootLabels = {
  desktop: 'Desktop',
  downloads: 'Downloads',
  documents: 'Documents',
  pictures: 'Pictures',
  music: 'Music',
  videos: 'Videos',
  home: 'Home',
};
const listLimit = 5000;
const shortcutExtensions = new Set(['.lnk', '.url', '.website', '.desktop']);
const appExtensions = new Set([
  '.exe',
  '.com',
  '.bat',
  '.cmd',
  '.msi',
  '.appref-ms',
  '.msc',
  '.appimage',
]);
const pictureExtensions = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.avif',
  '.tif',
  '.tiff',
]);
// Windows attribute bits.
const HIDDEN = 0x2,
  SYSTEM = 0x4,
  OFFLINE = 0x1000,
  RECALL_ON_DATA_ACCESS = 0x400000;
const reservedName = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)/i;

// Why a name cannot be used, or null when it can (Windows rules everywhere, so
// a board's folders stay usable on every computer).
function nameProblem(name) {
  if (typeof name !== 'string' || !name.trim()) return 'Type a name.';
  if (name.length > 255) return 'That name is too long.';
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name))
    return 'A name can’t contain any of these characters: \\ / : * ? " < > |';
  if (/[. ]$/.test(name)) return 'A name can’t end with a dot or a space.';
  if (reservedName.test(name)) return `Windows reserves the name “${name}”.`;
  if (name === '.' || name === '..') return 'Type a different name.';
  return null;
}

const exists = async (file) => {
  try {
    await fs.promises.lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
};

// A free name in dir: "name (2).ext", or "name - Copy.ext" for a copy made
// next to its original, as Explorer names them.
async function freeName(dir, name, { copy = false, folder = false } = {}) {
  const ext = folder ? '' : path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  const candidates = function* () {
    if (copy) {
      yield `${base} - Copy${ext}`;
      for (let i = 2; ; i++) yield `${base} - Copy (${i})${ext}`;
    }
    yield name;
    for (let i = 2; ; i++) yield `${base} (${i})${ext}`;
  };
  let tries = 0;
  for (const candidate of candidates()) {
    const file = path.join(dir, candidate);
    if (!(await exists(file))) return file;
    if (++tries > 10000) throw Error('Too many items with that name');
  }
}

// Whether child is parent itself or inside it.
function within(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function friendly(error) {
  switch (error && error.code) {
    case 'EPERM':
    case 'EACCES':
      return 'Windows doesn’t allow that here. The item may be open in another app or need administrator rights.';
    case 'EBUSY':
      return 'It’s open in another app. Close it and try again.';
    case 'ENOENT':
      return 'It no longer exists.';
    case 'ENOSPC':
      return 'There isn’t enough space on the drive.';
    case 'ENAMETOOLONG':
      return 'The name or folder path is too long.';
    case 'EXDEV':
      return 'It can’t be moved to that drive.';
    default:
      return (error && error.message) || String(error);
  }
}

// Splits a Windows command line (shortcut arguments) into arguments.
function splitArgs(text) {
  const result = [];
  let current = '',
    quoted = false,
    any = false;
  for (const ch of String(text || '')) {
    if (ch === '"') {
      quoted = !quoted;
      any = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (any) result.push(current);
      current = '';
      any = false;
    } else {
      current += ch;
      any = true;
    }
  }
  if (any) result.push(current);
  return result;
}

function createLocalFiles({
  platform = process.platform,
  getPath,
  env = process.env,
  helper = null,
  shell = null,
  nativeImage = null,
  getFileIcon = null,
  sharp = null,
  readAsset = null,
  importFile = null,
  pickFolder = null,
  // A frame's rectangle in the page (CSS pixels) to Terra's window handle and
  // physical screen pixels.
  dockGeometry = null,
  // A screen point in CSS pixels to physical pixels.
  screenPoint = null,
  // App frames' pictures (app-pictures.cjs), and Terra's window handle for them.
  pictures = null,
  pictureTarget = null,
  send = () => {},
  pollMs = 5000,
} = {}) {
  const windows = platform === 'win32';
  const pathApi = windows ? path.win32 : path;
  const same = (a, b) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  const knownPath = (root) => {
    try {
      return getPath(root);
    } catch {
      return null;
    }
  };
  const publicDesktop = () => {
    if (!windows) return null;
    const dir = pathApi.join(env.PUBLIC || 'C:\\Users\\Public', 'Desktop');
    return fs.existsSync(dir) ? dir : null;
  };

  // A full path from the renderer: absolute, no device namespace.
  function absolute(value) {
    if (typeof value !== 'string' || !value || value.length > 32000 || value.includes('\0'))
      throw Error('Invalid path');
    if (windows && /^\\\\[?.]\\/.test(value)) throw Error('Invalid path');
    if (!pathApi.isAbsolute(value)) throw Error('Invalid path');
    return pathApi.normalize(value);
  }
  function paths(value, limit = listLimit) {
    if (!Array.isArray(value) || !value.length || value.length > limit)
      throw Error('Invalid paths');
    return value.map(absolute);
  }
  // A board's folder reference to a full path on this computer.
  function sourcePath(source) {
    if (!source || typeof source !== 'object') throw Error('Invalid folder');
    const rel = typeof source.path === 'string' ? source.path : '';
    if (source.root) {
      if (!roots.includes(source.root)) throw Error('Invalid folder');
      const base = knownPath(source.root);
      if (!base) throw Error(`This computer has no ${rootLabels[source.root]} folder`);
      const parts = rel.split(/[\\/]+/).filter(Boolean);
      if (parts.some((part) => part === '..' || part === '.')) throw Error('Invalid folder');
      return pathApi.join(base, ...parts);
    }
    return absolute(rel);
  }
  // The board reference for a full path: inside a folder every computer has
  // (the deepest one, so Desktop wins over Home), it is stored relative to it.
  function sourceFor(file) {
    file = absolute(file);
    let best = null;
    for (const root of roots) {
      const base = knownPath(root);
      if (!base || !within(file, base)) continue;
      if (!best || base.length > best.base.length) best = { root, base };
    }
    if (!best) return { path: file };
    return {
      root: best.root,
      path: pathApi.relative(best.base, file).split(pathApi.sep).filter(Boolean).join('/'),
    };
  }
  function label(source, file) {
    const rel = typeof source?.path === 'string' ? source.path : '';
    if (source?.root && !rel.split(/[\\/]+/).filter(Boolean).length) return rootLabels[source.root];
    return pathApi.basename(file) || file;
  }

  let hideExtensions = null;
  function readHideExtensions() {
    if (hideExtensions !== null || !windows) return Promise.resolve(!!hideExtensions);
    return new Promise((resolve) => {
      let out = '';
      try {
        const child = spawn(
          'reg',
          [
            'query',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced',
            '/v',
            'HideFileExt',
          ],
          { windowsHide: true },
        );
        child.stdout.on('data', (chunk) => (out += chunk));
        child.on('error', () => resolve((hideExtensions = true)));
        child.on('close', () => {
          const match = /HideFileExt\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
          // Windows hides known extensions unless this is set to 0.
          resolve((hideExtensions = match ? parseInt(match[1], 16) !== 0 : true));
        });
      } catch {
        resolve((hideExtensions = true));
      }
    });
  }

  async function attributes(dir) {
    if (!windows || !helper?.available) return null;
    try {
      return await helper.attributes(dir);
    } catch {
      return null;
    }
  }
  const junk = (name) =>
    /^(desktop\.ini|thumbs\.db|\$recycle\.bin|system volume information)$/i.test(name) ||
    name.startsWith('~$');

  async function readFolder(dir, { hidden, shared = false }) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const attrs = await attributes(dir);
    const items = [];
    let skipped = 0;
    const visible = entries.filter((entry) => {
      const a = attrs?.get(entry.name);
      const isHidden =
        a !== undefined
          ? (a & (HIDDEN | SYSTEM)) !== 0 || junk(entry.name)
          : windows
            ? junk(entry.name)
            : entry.name.startsWith('.');
      entry.hidden = isHidden;
      entry.cloud = a !== undefined && (a & (OFFLINE | RECALL_ON_DATA_ACCESS)) !== 0;
      if (isHidden && !hidden) {
        skipped++;
        return false;
      }
      return true;
    });
    for (let i = 0; i < visible.length; i += 64) {
      const chunk = visible.slice(i, i + 64);
      const stats = await Promise.all(
        chunk.map(async (entry) => {
          const file = pathApi.join(dir, entry.name);
          try {
            return await fs.promises.stat(file);
          } catch {
            // A broken link or an item that vanished while reading.
            try {
              return await fs.promises.lstat(file);
            } catch {
              return null;
            }
          }
        }),
      );
      chunk.forEach((entry, j) => {
        const stat = stats[j];
        if (!stat) return;
        const ext = pathApi.extname(entry.name).toLowerCase();
        const folder = stat.isDirectory();
        items.push({
          name: entry.name,
          path: pathApi.join(dir, entry.name),
          folder,
          size: folder ? null : stat.size,
          modified: Math.round(stat.mtimeMs),
          hidden: entry.hidden,
          ...(entry.cloud ? { cloud: true } : {}),
          ...(!folder && shortcutExtensions.has(ext) ? { shortcut: true } : {}),
          ...(!folder && appExtensions.has(ext) ? { app: true } : {}),
          ...(shared ? { shared: true } : {}),
        });
      });
    }
    return { items, skipped };
  }

  // What a folder reference shows on this computer.
  async function list({ source, sub, hidden = false } = {}) {
    const base = sourcePath(source);
    const dir = sub ? absolute(sub) : base;
    if (sub && !within(dir, base) && !within(dir, publicDesktop() || '\0'))
      throw Error('Invalid folder');
    let stat;
    try {
      stat = await fs.promises.stat(dir);
    } catch (error) {
      return { dir, label: label(source, base), state: 'missing', message: friendly(error) };
    }
    const hide = await readHideExtensions();
    if (!stat.isDirectory()) {
      const ext = pathApi.extname(dir).toLowerCase();
      return {
        dir,
        label: label(source, base),
        state: 'file',
        hideExtensions: hide,
        item: {
          name: pathApi.basename(dir),
          path: dir,
          folder: false,
          size: stat.size,
          modified: Math.round(stat.mtimeMs),
          hidden: false,
          ...(shortcutExtensions.has(ext) ? { shortcut: true } : {}),
          ...(appExtensions.has(ext) ? { app: true } : {}),
        },
      };
    }
    const dirs = [dir];
    let { items, skipped } = await readFolder(dir, { hidden });
    // The desktop Windows shows is the user's Desktop plus the shared one.
    const shared = source.root === 'desktop' && same(dir, base) ? publicDesktop() : null;
    if (shared) {
      dirs.push(shared);
      try {
        const more = await readFolder(shared, { hidden, shared: true });
        items = items.concat(more.items);
        skipped += more.skipped;
      } catch {}
    }
    const total = items.length;
    if (items.length > listLimit) {
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      items.sort((a, b) => Number(b.folder) - Number(a.folder) || collator.compare(a.name, b.name));
      items = items.slice(0, listLimit);
    }
    return {
      dir,
      base,
      dirs,
      label: same(dir, base) ? label(source, base) : pathApi.basename(dir),
      parent: same(dir, base) ? null : pathApi.dirname(dir),
      state: 'folder',
      items,
      total,
      hiddenCount: skipped,
      hideExtensions: hide,
    };
  }

  // One watcher per folder, shared by every frame showing it. Network and
  // removable drives that can't be watched are compared every few seconds.
  const watched = new Map();
  function notify(dir) {
    const entry = watched.get(dir);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => send('canvas:files-changed', dir), 150);
  }
  async function signature(dir) {
    try {
      const [stat, names] = await Promise.all([fs.promises.stat(dir), fs.promises.readdir(dir)]);
      return `${stat.mtimeMs}|${names.length}|${names.join('|').length}`;
    } catch {
      return 'missing';
    }
  }
  function startWatch(dir, entry) {
    try {
      entry.watcher = fs.watch(dir, { persistent: false }, () => notify(dir));
      entry.watcher.on('error', () => {
        entry.watcher?.close();
        entry.watcher = null;
        notify(dir);
        poll(dir, entry);
      });
    } catch {
      entry.watcher = null;
      poll(dir, entry);
    }
  }
  function poll(dir, entry) {
    if (entry.poll) return;
    void signature(dir).then((first) => {
      entry.signature = first;
      entry.poll = setInterval(async () => {
        const next = await signature(dir);
        if (next === entry.signature) return;
        entry.signature = next;
        notify(dir);
        // A folder that came back can be watched again.
        if (next !== 'missing' && !entry.watcher) {
          clearInterval(entry.poll);
          entry.poll = null;
          startWatch(dir, entry);
        }
      }, pollMs);
    });
  }
  const subscriptions = new Map();
  function watch(key, dirs) {
    if (typeof key !== 'string' || key.length > 200) throw Error('Invalid watch');
    unwatch(key);
    const list = paths(dirs, 8);
    subscriptions.set(key, list);
    for (const dir of list) {
      let entry = watched.get(dir);
      if (!entry) {
        entry = { count: 0, watcher: null, poll: null, timer: null, signature: '' };
        watched.set(dir, entry);
        startWatch(dir, entry);
      }
      entry.count++;
    }
  }
  function unwatch(key) {
    const list = subscriptions.get(key);
    if (!list) return;
    subscriptions.delete(key);
    for (const dir of list) {
      const entry = watched.get(dir);
      if (!entry || --entry.count > 0) continue;
      entry.watcher?.close();
      clearInterval(entry.poll);
      clearTimeout(entry.timer);
      watched.delete(dir);
    }
  }
  function unwatchAll() {
    for (const key of [...subscriptions.keys()]) unwatch(key);
  }

  // Icons as Explorer shows them, cached by file, change time and size.
  const icons = new Map();
  const iconSizes = [32, 64, 128, 256];
  async function iconOf(file, size) {
    if (helper?.available) {
      try {
        const png = Buffer.from(await helper.icon(file, size), 'base64');
        if (!sharp) return 'data:image/png;base64,' + png.toString('base64');
        const webp = await sharp(png).webp({ quality: 88, alphaQuality: 100 }).toBuffer();
        return 'data:image/webp;base64,' + webp.toString('base64');
      } catch {}
    }
    if (sharp && pictureExtensions.has(pathApi.extname(file).toLowerCase())) {
      try {
        const webp = await sharp(file, { limitInputPixels: 100000000, animated: false })
          .rotate()
          .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 85 })
          .toBuffer();
        return 'data:image/webp;base64,' + webp.toString('base64');
      } catch {}
    }
    if (getFileIcon) {
      try {
        const image = await getFileIcon(file, { size: 'large' });
        if (!image.isEmpty()) return image.toDataURL();
      } catch {}
    }
    return null;
  }
  async function icon({ path: file, size, modified }) {
    file = absolute(file);
    if (!iconSizes.includes(size)) throw Error('Invalid icon size');
    const key = `${file}|${modified || 0}|${size}`;
    if (icons.has(key)) {
      const value = icons.get(key);
      icons.delete(key);
      icons.set(key, value);
      return value;
    }
    const value = await iconOf(file, size);
    icons.set(key, value);
    while (icons.size > 2000) icons.delete(icons.keys().next().value);
    return value;
  }
  async function iconBatch(requests) {
    if (!Array.isArray(requests) || requests.length > 64) throw Error('Invalid icons');
    const result = [];
    for (const request of requests) {
      try {
        result.push(await icon(request || {}));
      } catch {
        result.push(null);
      }
    }
    return result;
  }

  async function sameVolume(a, b) {
    try {
      const [sa, sb] = await Promise.all([fs.promises.stat(a), fs.promises.stat(b)]);
      if (sa.dev && sb.dev) return sa.dev === sb.dev;
    } catch {}
    return same(pathApi.parse(a).root, pathApi.parse(b).root);
  }
  async function shortcut(target, dir) {
    const name = pathApi.basename(target).replace(/\.lnk$/i, '');
    if (windows) {
      const file = await freeName(dir, `${name} - Shortcut.lnk`);
      if (!shell?.writeShortcutLink(file, 'create', { target }))
        throw Error('Windows couldn’t create the shortcut');
      return file;
    }
    const file = await freeName(dir, name);
    await fs.promises.symlink(target, file);
    return file;
  }
  async function copy(from, to) {
    await fs.promises.cp(from, to, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  }

  // Moves, copies or links items into a folder, as dropping them there in
  // Explorer would. 'auto' moves on the same drive and copies across drives.
  // Nothing is ever replaced: a clash gets a free name.
  async function transfer({ paths: input, target, mode = 'auto' } = {}) {
    if (!['auto', 'copy', 'move', 'link'].includes(mode)) throw Error('Invalid mode');
    const dir = absolute(target);
    const targetStat = await fs.promises.stat(dir).catch(() => null);
    if (!targetStat?.isDirectory()) throw Error('That folder no longer exists.');
    const ops = [],
      errors = [];
    for (const from of paths(input)) {
      const name = pathApi.basename(from);
      try {
        const stat = await fs.promises.lstat(from);
        let op = mode;
        if (op === 'auto') op = (await sameVolume(from, dir)) ? 'move' : 'copy';
        const here = same(pathApi.dirname(from), dir);
        if (op === 'move' && here) continue;
        if (stat.isDirectory() && op !== 'link' && within(dir, from))
          throw Error('A folder can’t go inside itself.');
        let to;
        if (op === 'link') to = await shortcut(from, dir);
        else if (op === 'copy') {
          to = await freeName(dir, name, { copy: here, folder: stat.isDirectory() });
          await copy(from, to);
        } else {
          to = await freeName(dir, name, { folder: stat.isDirectory() });
          try {
            await fs.promises.rename(from, to);
          } catch (error) {
            if (error.code !== 'EXDEV') throw error;
            await copy(from, to);
            await fs.promises.rm(from, { recursive: true });
          }
        }
        ops.push({ op, from, to });
      } catch (error) {
        errors.push(`${name}: ${friendly(error)}`);
      }
    }
    return { ops, errors };
  }

  async function rename({ path: input, name } = {}) {
    const from = absolute(input);
    const problem = nameProblem(name);
    if (problem) throw Error(problem);
    const to = pathApi.join(pathApi.dirname(from), name);
    if (to === from) return { ops: [], errors: [] };
    // Changing only letter case is a rename of the same item on Windows.
    if (!same(to, from) && (await exists(to)))
      throw Error(`There’s already an item named “${name}” here.`);
    try {
      await fs.promises.rename(from, to);
    } catch (error) {
      throw Error(friendly(error));
    }
    return { ops: [{ op: 'rename', from, to }], errors: [] };
  }

  async function newFolder({ dir: input } = {}) {
    const dir = absolute(input);
    const to = await freeName(dir, 'New folder', { folder: true });
    try {
      await fs.promises.mkdir(to);
    } catch (error) {
      throw Error(friendly(error));
    }
    return { ops: [{ op: 'create', to }], errors: [] };
  }

  // To the Recycle Bin (or the desktop's trash), never deleted for good.
  async function trash({ paths: input } = {}) {
    const errors = [];
    let done = 0;
    for (const file of paths(input)) {
      try {
        await shell.trashItem(file);
        done++;
      } catch (error) {
        errors.push(`${pathApi.basename(file)}: ${friendly(error)}`);
      }
    }
    return { done, errors };
  }

  // Undoes operations made here, newest first: moves and renames go back,
  // copies, shortcuts and new folders go to the Recycle Bin.
  async function revert({ ops } = {}) {
    if (!Array.isArray(ops) || ops.length > listLimit) throw Error('Invalid undo');
    const errors = [];
    for (const op of [...ops].reverse()) {
      try {
        const to = absolute(op?.to);
        if (op.op === 'move' || op.op === 'rename') {
          const from = absolute(op.from);
          if (!(await exists(to))) throw Error('It no longer exists.');
          const back = (await exists(from))
            ? await freeName(pathApi.dirname(from), pathApi.basename(from))
            : from;
          await fs.promises.rename(to, back);
        } else if (['copy', 'link', 'create'].includes(op.op)) {
          if (!(await exists(to))) continue;
          await shell.trashItem(to);
        } else throw Error('Invalid undo');
      } catch (error) {
        errors.push(`${pathApi.basename(op?.to || '')}: ${friendly(error)}`);
      }
    }
    return { errors };
  }

  // Board pictures and documents saved into a folder as files.
  const mimeExtensions = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
    'image/tiff': '.tiff',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'application/pdf': '.pdf',
  };
  async function saveAssets({ target, items } = {}) {
    const dir = absolute(target);
    if (!Array.isArray(items) || !items.length || items.length > 500) throw Error('Invalid items');
    const ops = [],
      errors = [];
    for (const item of items) {
      try {
        if (!item || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.id))
          throw Error('Invalid item');
        const asset = await readAsset({ id: item.id, variant: 'original' });
        let name = String(item.name || asset.name || 'File')
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
          .replace(/[. ]+$/, '')
          .slice(0, 200);
        if (!name || reservedName.test(name)) name = 'File';
        const ext = mimeExtensions[asset.mime];
        if (ext && !pathApi.extname(name)) name += ext;
        const to = await freeName(dir, name);
        await fs.promises.copyFile(asset.file, to, fs.constants.COPYFILE_EXCL);
        ops.push({ op: 'copy', from: asset.file, to });
      } catch (error) {
        errors.push(`${item?.name || 'File'}: ${friendly(error)}`);
      }
    }
    return { ops, errors };
  }

  // What dropped paths are: folders become folder frames, apps and shortcuts
  // icon tiles, everything else is added to the board as before.
  async function classify({ paths: input } = {}) {
    const result = [];
    for (const file of paths(input, 500)) {
      const ext = pathApi.extname(file).toLowerCase();
      let folder = false;
      try {
        folder = (await fs.promises.stat(file)).isDirectory();
      } catch {}
      result.push({
        path: file,
        name: pathApi.basename(file) || file,
        kind: folder
          ? 'folder'
          : shortcutExtensions.has(ext)
            ? 'shortcut'
            : appExtensions.has(ext)
              ? 'app'
              : 'file',
        source: sourceFor(file),
      });
    }
    return result;
  }

  // Files added to the board as cards (copied into the library), as dropping
  // them from Explorer does.
  async function importPaths({ paths: input } = {}) {
    const assets = [],
      errors = [];
    for (const file of paths(input, 200)) {
      try {
        const stat = await fs.promises.stat(file);
        if (stat.isDirectory()) throw Error('Folders are added as folder frames.');
        if (stat.size > 256 * 1024 * 1024) throw Error('Files must be no larger than 256 MB.');
        assets.push(await importFile(file));
      } catch (error) {
        errors.push(`${pathApi.basename(file)}: ${friendly(error)}`);
      }
    }
    return { assets, errors };
  }

  async function open({ path: input } = {}) {
    const file = absolute(input);
    if (!(await exists(file))) throw Error('It no longer exists.');
    const failure = await shell.openPath(file);
    if (failure) throw Error(failure);
  }
  // Files dropped on an app open with it, as on the Windows desktop.
  async function openWith({ app, paths: input } = {}) {
    const files = paths(input, 200);
    let target = absolute(app),
      args = [],
      cwd;
    if (windows && pathApi.extname(target).toLowerCase() === '.lnk') {
      const link = shell.readShortcutLink(target);
      target = link.target;
      args = splitArgs(link.args);
      cwd = link.cwd || undefined;
    }
    const ext = pathApi.extname(target).toLowerCase();
    const stat = await fs.promises.stat(target).catch(() => null);
    if (stat?.isDirectory()) return transfer({ paths: files, target, mode: 'auto' });
    if (!stat || (windows ? !['.exe', '.com'].includes(ext) : !(stat.mode & 0o111)))
      throw Error('Drop files on an app to open them with it.');
    const child = spawn(target, [...args, ...files], {
      cwd: cwd || pathApi.dirname(target),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.on('error', () => {});
    child.unref();
    return { ops: [], errors: [] };
  }
  function reveal({ path: input } = {}) {
    shell.showItemInFolder(absolute(input));
  }

  // The file clipboard, shared with Explorer through the Windows helper.
  let clipboard = null;
  async function copyToClipboard({ paths: input, cut = false } = {}) {
    const files = paths(input);
    clipboard = { paths: files, cut: cut === true };
    if (windows && helper?.available) {
      try {
        await helper.setClipboard(files, cut === true);
      } catch {}
    }
  }
  async function readClipboard() {
    if (windows && helper?.available) {
      try {
        return await helper.readClipboard();
      } catch {}
    }
    return clipboard;
  }
  async function clearClipboard() {
    clipboard = null;
  }

  // Desktops frames: Windows' virtual desktops and the windows open on each.
  // Only shown live; nothing about them is stored in a board.
  const windowId = (value) => {
    if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) throw Error('Invalid window');
    return value;
  };
  const steps = (value) => (Number.isInteger(value) ? Math.max(-20, Math.min(20, value)) : 0);
  async function desktops() {
    if (!windows) return { supported: false, message: 'Virtual desktops are a Windows feature.' };
    if (!helper?.available)
      return { supported: false, message: 'Windows didn’t let Terra read the desktops.' };
    try {
      return { supported: true, ...(await helper.desktops()) };
    } catch (error) {
      return { supported: false, message: friendly(error) };
    }
  }
  async function focusWindow({ id, steps: count } = {}) {
    if (!windows || !helper?.available) throw Error('Virtual desktops are a Windows feature.');
    await helper.focusWindow(windowId(id), steps(count));
  }
  async function switchDesktop({ steps: count } = {}) {
    if (!windows || !helper?.available) throw Error('Virtual desktops are a Windows feature.');
    await helper.switchDesktop(steps(count));
  }
  async function closeWindow({ id } = {}) {
    if (!windows || !helper?.available) throw Error('Virtual desktops are a Windows feature.');
    await helper.closeWindow(windowId(id));
  }

  // App frames. A program's window on the board is "parked" while it is
  // used in place (just behind Terra's window, restored and on a screen, so
  // it keeps drawing itself for the frame's picture), laid over its frame
  // when opened as a window, and released
  // (back as it was) when its frame is deleted, the board closes or Terra
  // closes. Which windows are on the board, and how, is kept here.
  const managed = new Map();
  // Where each window was before it joined a board, as the helper reported.
  const saved = new Map();
  const remember = (id, place) => {
    if (place && !saved.has(id)) saved.set(id, place);
  };
  const validRect = (rect) =>
    !!rect &&
    ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(rect[k])) &&
    rect.width >= 1 &&
    rect.height >= 1 &&
    rect.width <= 20000 &&
    rect.height <= 20000;
  const appFrames = () => {
    if (!windows || !helper?.available || !dockGeometry)
      throw Error('App frames need Terra Board for Windows.');
  };
  const track = (id, state) => {
    if (state) managed.set(id, state);
    else managed.delete(id);
    helper.hold(managed.size > 0);
  };
  // rect: the frame's app area in the page (CSS pixels); pixels: the size
  // the window gets, in screen pixels (the frame's size on screen, so its
  // picture is pixel for pixel). Parked right behind the frame, kept inside
  // Terra's window so it stays hidden.
  async function parkWindow({ id, rect, pixels } = {}) {
    appFrames();
    windowId(id);
    if (!validRect(rect) || !validRect({ x: 0, y: 0, ...pixels })) throw Error('Invalid frame');
    const at = dockGeometry(rect);
    const area = at.content;
    const fit = Math.min(1, area.width / pixels.width, area.height / pixels.height);
    const width = Math.max(1, Math.round(pixels.width * fit)),
      height = Math.max(1, Math.round(pixels.height * fit));
    const x = Math.min(Math.max(at.x, area.x), area.x + area.width - width),
      y = Math.min(Math.max(at.y, area.y), area.y + area.height - height);
    track(id, 'parked');
    try {
      remember(id, await helper.parkWindow(id, at.owner, { x, y, width, height }));
    } catch (error) {
      track(id, null);
      throw Error(friendly(error));
    }
    pictures?.refresh(Number(id));
  }
  // click: where (screen, CSS pixels) a click started using it, passed on to
  // the app once its window lies there.
  async function dockWindow({ id, rect, activate = false, click = null } = {}) {
    appFrames();
    windowId(id);
    if (!validRect(rect)) throw Error('Invalid frame');
    const geometry = dockGeometry(rect);
    const point =
      click && Number.isFinite(click.x) && Number.isFinite(click.y) && screenPoint
        ? screenPoint(click)
        : null;
    track(id, 'docked');
    try {
      remember(id, await helper.dockWindow(id, geometry.owner, geometry, activate === true, point));
    } catch (error) {
      track(id, null);
      throw Error(friendly(error));
    }
  }
  async function releaseWindow({ id } = {}) {
    windowId(id);
    if (!managed.has(id)) return;
    track(id, null);
    pictures?.hideWindow(Number(id));
    const place = saved.get(id) || '';
    saved.delete(id);
    await helper.releaseWindow(id, place).catch(() => {});
  }
  async function releaseAll() {
    pictures?.hideAll();
    for (const id of [...managed.keys()]) await releaseWindow({ id });
  }
  // An app frame's picture: Windows' live preview of its window, drawn into
  // Terra's window (see app-pictures.cjs). whole: the frame's picture area,
  // screen pixels; parts: where each visible part goes in Terra's window
  // (dest) and which part of the area it is (src). No parts: none shown.
  const appPictures = () => !!(windows && pictures && pictureTarget);
  function appPicture({ frame, id, whole, parts } = {}) {
    if (!appPictures()) return false;
    if (typeof frame !== 'string' || !frame || frame.length > 100) throw Error('Invalid frame');
    if (!Array.isArray(parts) || !parts.length) {
      pictures.hide(frame);
      return true;
    }
    windowId(id);
    const int = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : NaN);
    const box = (b, lo, hi) =>
      Array.isArray(b) && b.length === 4 ? b.map((v) => int(v, lo, hi)) : [NaN];
    const size =
      Array.isArray(whole) && whole.length === 2 ? whole.map((v) => int(v, 1, 20000)) : [NaN];
    if (size.some(Number.isNaN)) throw Error('Invalid picture');
    const clean = [];
    for (const part of parts.slice(0, 64)) {
      const dest = box(part?.dest, -40000, 40000),
        src = box(part?.src, 0, 20000);
      if ([...dest, ...src].some(Number.isNaN)) throw Error('Invalid picture');
      if (dest[2] > dest[0] && dest[3] > dest[1] && src[2] > src[0] && src[3] > src[1])
        clean.push({ dest, src });
    }
    if (!clean.length) {
      pictures.hide(frame);
      return true;
    }
    return pictures.show(frame, {
      target: pictureTarget(),
      source: Number(id),
      whole: size,
      parts: clean,
    });
  }
  // Terra minimized: its app windows go with it, and come back when it does.
  async function hideAll() {
    for (const [id, state] of managed)
      if (state !== 'hidden') {
        managed.set(id, 'hidden');
        await helper.hideWindow(id).catch(() => {});
      }
  }
  const isDocked = (id) => managed.get(id) === 'docked';
  // An app frame used in place: its mouse and keyboard input, only ever for a
  // window that is on a board.
  const mouseKinds = new Set(['move', 'down', 'double', 'up', 'wheel', 'hwheel', 'leave']);
  const clamp = (value, low, high) =>
    Math.max(low, Math.min(high, Math.round(Number.isFinite(value) ? value : 0)));
  function appInput({ id, event } = {}) {
    if (!windows || !helper?.available || !event || typeof event !== 'object') return;
    windowId(id);
    if (!managed.has(id)) return;
    let clean;
    if (event.type === 'mouse' && mouseKinds.has(event.kind))
      clean = {
        type: 'mouse',
        kind: event.kind,
        x: clamp(event.x, -20000, 30000),
        y: clamp(event.y, -20000, 30000),
        button: clamp(event.button, 0, 2),
        keys: clamp(event.keys, 0, 0xffff),
        delta: clamp(event.delta, -32768, 32767),
      };
    else if (event.type === 'key')
      clean = {
        type: 'key',
        vk: clamp(event.vk, 1, 254),
        scan: clamp(event.scan, 0, 255),
        extended: event.extended === true,
        down: event.down === true,
        mods: clamp(event.mods, 0, 7),
      };
    else if (event.type === 'text' && typeof event.text === 'string' && event.text.length <= 2000)
      clean = { type: 'text', text: event.text };
    else if (event.type === 'focus') clean = { type: 'focus', on: event.on === true };
    else return;
    void helper.appInput(id, clean);
  }
  async function appPopup({ id } = {}) {
    windowId(id);
    if (!windows || !helper?.available || !managed.has(id)) return false;
    return helper.hasPopup(id).catch(() => false);
  }

  async function choose({ defaultPath } = {}) {
    const start = typeof defaultPath === 'string' && defaultPath ? defaultPath : knownPath('home');
    const chosen = await pickFolder(start);
    return chosen ? { path: chosen, source: sourceFor(chosen) } : null;
  }

  function dragIcon(icon) {
    let image = null;
    if (typeof icon === 'string' && icon.startsWith('data:image/') && icon.length < 4000000)
      image = nativeImage.createFromDataURL(icon);
    if (!image || image.isEmpty())
      image = nativeImage.createFromPath(path.join(__dirname, '../assets/icon.png'));
    const { width, height } = image.getSize();
    const scale = 64 / Math.max(width, height, 1);
    return scale < 1
      ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale) })
      : image;
  }

  return {
    roots,
    rootLabels,
    sourcePath,
    sourceFor,
    list,
    watch,
    unwatch,
    unwatchAll,
    icon,
    iconBatch,
    transfer,
    rename,
    newFolder,
    trash,
    revert,
    saveAssets,
    classify,
    importPaths,
    open,
    openWith,
    reveal,
    copyToClipboard,
    readClipboard,
    clearClipboard,
    choose,
    desktops,
    focusWindow,
    switchDesktop,
    closeWindow,
    parkWindow,
    dockWindow,
    releaseWindow,
    releaseAll,
    hideAll,
    isDocked,
    appInput,
    appPopup,
    appPicture,
    appPictures,
    dragIcon,
    absolute,
    paths,
  };
}

// The renderer's channels: canvas:files-<name>.
function registerLocalFiles({ ipcMain, trusted, files }) {
  const nightLight = createNightLight();
  const handlers = {
    list: files.list,
    icons: files.iconBatch,
    transfer: files.transfer,
    rename: files.rename,
    'new-folder': files.newFolder,
    trash: files.trash,
    revert: files.revert,
    'save-assets': files.saveAssets,
    classify: files.classify,
    import: files.importPaths,
    open: files.open,
    'open-with': files.openWith,
    reveal: files.reveal,
    'clipboard-copy': files.copyToClipboard,
    'clipboard-read': files.readClipboard,
    'clipboard-clear': files.clearClipboard,
    choose: files.choose,
    desktops: files.desktops,
    'focus-window': files.focusWindow,
    'switch-desktop': files.switchDesktop,
    'close-window': files.closeWindow,
    'park-window': files.parkWindow,
    'dock-window': files.dockWindow,
    'release-window': files.releaseWindow,
    'app-popup': files.appPopup,
    'app-pictures': files.appPictures,
    'night-light': nightLight.state,
    'set-night-light': nightLight.set,
    source: ({ path: file } = {}) => files.sourceFor(file),
    watch: ({ key, dirs } = {}) => files.watch(key, dirs),
    unwatch: ({ key } = {}) => files.unwatch(key),
    // A page (re)load: watches and docked windows from before it are let go.
    reset: async () => {
      files.unwatchAll();
      await files.releaseAll();
    },
  };
  for (const [name, handler] of Object.entries(handlers))
    ipcMain.handle('canvas:files-' + name, async (event, args) => {
      trusted(event);
      return handler(args || {});
    });
  // Mouse and keyboard for an app frame used in place: sent, not awaited.
  ipcMain.on('canvas:files-app-input', (event, args) => {
    try {
      trusted(event);
      files.appInput(args || {});
    } catch {}
  });
  // An app frame's picture moved, changed size or was partly covered: sent
  // as often as every screen refresh, not awaited.
  ipcMain.on('canvas:files-app-picture', (event, args) => {
    try {
      trusted(event);
      files.appPicture(args || {});
    } catch {}
  });
  // A real Windows drag of files, to Explorer, other apps or the board itself.
  ipcMain.on('canvas:files-drag', (event, { paths: input, icon } = {}) => {
    try {
      trusted(event);
      const list = files.paths(input, 500);
      event.sender.startDrag({ file: list[0], files: list, icon: files.dragIcon(icon) });
    } catch {}
  });
}

module.exports = {
  createLocalFiles,
  registerLocalFiles,
  nameProblem,
  freeName,
  within,
  splitArgs,
  roots,
  rootLabels,
};
