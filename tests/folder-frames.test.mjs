import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { clipboardObjects } from '../src/canvas/content.ts';
import { alpha, subtract } from '../src/components/app-pictures.ts';
import {
  displayName,
  dropMode,
  fileLinkValue,
  iconTier,
  pathCrumbs,
  sortItems,
} from '../src/canvas/file-link.ts';

test('the address bar splits a path into folders to click', () => {
  const pc = (dir) => pathCrumbs(dir, '::computer', 'This PC');
  assert.deepEqual(pc('::computer'), [{ label: 'This PC', target: null }]);
  assert.deepEqual(pc('C:\\'), [
    { label: 'This PC', target: null },
    { label: 'C:', target: 'C:\\' },
  ]);
  assert.deepEqual(
    pc('C:\\Users\\anton\\OneDrive\\Desktop').map((c) => c.target),
    [
      null,
      'C:\\',
      'C:\\Users',
      'C:\\Users\\anton',
      'C:\\Users\\anton\\OneDrive',
      'C:\\Users\\anton\\OneDrive\\Desktop',
    ],
  );
  assert.deepEqual(
    pc('\\\\nas\\share\\Films').map((c) => c.label),
    ['This PC', '\\\\nas\\share', 'Films'],
  );
  // A frame of a known folder starts at that folder.
  const desk = pathCrumbs('C:\\Users\\a\\Desktop\\Work\\2026', 'C:\\Users\\a\\Desktop', 'Desktop');
  assert.deepEqual(desk, [
    { label: 'Desktop', target: null },
    { label: 'Work', target: 'C:\\Users\\a\\Desktop\\Work' },
    { label: '2026', target: 'C:\\Users\\a\\Desktop\\Work\\2026' },
  ]);
  assert.equal(pathCrumbs('c:\\users\\a\\desktop', 'C:\\Users\\a\\Desktop', 'Desktop').length, 1);
  assert.deepEqual(
    pathCrumbs('/home/a/Music', '/home/a', 'Home', false).map((c) => c.target),
    [null, '/home/a/Music'],
  );
});
const require = createRequire(import.meta.url);
const { objectValue, fileLinkValue: storeFileLinkValue } = require('../electron/store.cjs');
const {
  createLocalFiles,
  nameProblem,
  freeName,
  within,
  splitArgs,
} = require('../electron/local-files.cjs');

const links = [
  { root: 'desktop', path: '', kind: 'folder' },
  {
    root: 'desktop',
    path: 'Projects/Notes',
    kind: 'folder',
    view: 'list',
    sort: 'size',
    descending: true,
  },
  { root: 'downloads', path: 'setup.exe', kind: 'file', iconSize: 'huge', hidden: true },
  { path: 'D:\\Projects\\terra', kind: 'folder', view: 'icons', iconSize: 'small' },
  { path: '\\\\server\\share\\folder', kind: 'folder' },
  { path: '/home/someone/Desktop', kind: 'folder' },
  { path: 'C:/Users/x', kind: 'file', view: 'bogus', sort: 'nope', descending: 'yes', extra: 1 },
];
const invalid = [
  null,
  [],
  { path: '', kind: 'folder' },
  { path: 'relative\\path', kind: 'folder' },
  { root: 'desktop', path: '..\\Secrets', kind: 'folder' },
  { root: 'desktop', path: 'a/./b', kind: 'folder' },
  { root: 'desktop', path: 'C:\\Windows', kind: 'folder' },
  { root: 'desktop', path: '/etc', kind: 'folder' },
  { root: 'system32', path: '', kind: 'folder' },
  { root: 'desktop', path: '', kind: 'drive' },
  { root: 'desktop', path: 'a\u0000b', kind: 'folder' },
  { root: 'desktop', path: 'x'.repeat(5000), kind: 'folder' },
];

test('folder links are validated the same in the app and the store', () => {
  for (const link of links) assert.deepEqual(fileLinkValue(link), storeFileLinkValue(link));
  assert.deepEqual(fileLinkValue(links[6]), { path: 'C:/Users/x', kind: 'file' });
  for (const value of invalid) {
    assert.throws(() => fileLinkValue(value), undefined, JSON.stringify(value));
    assert.throws(() => storeFileLinkValue(value), undefined, JSON.stringify(value));
  }
});

test('file objects survive storage and the clipboard, and only they hold a file', () => {
  const o = {
    id: 'f1',
    type: 'file',
    text: 'Desktop',
    file: links[1],
    x: 0,
    y: 0,
    width: 760,
    height: 500,
    z: 1,
  };
  assert.deepEqual(objectValue(o).file, links[1]);
  assert.deepEqual(clipboardObjects([o])[0].file, links[1]);
  assert.throws(() => clipboardObjects([{ ...o, type: 'note' }]));
  assert.throws(() => objectValue({ ...o, type: 'note' }));
  assert.throws(() => objectValue({ ...o, file: undefined }));
});

test('names follow the Windows rules', () => {
  for (const bad of [
    '',
    '  ',
    'a/b',
    'a\\b',
    'a:b',
    'what?',
    'star*',
    '<x>',
    'pipe|',
    'end.',
    'end ',
    'CON',
    'con.txt',
    'LPT1',
    'nul',
  ])
    assert.ok(nameProblem(bad), bad);
  for (const good of ['Report.pdf', 'Новая папка', 'Ünïcode 🚁', '.gitignore', 'a.b.c', 'CONSOLE'])
    assert.equal(nameProblem(good), null, good);
  assert.ok(within('C:\\a\\b', 'C:\\a') || within('/a/b', '/a'));
  assert.deepEqual(splitArgs('--flag "C:\\Program Files\\x" plain ""'), [
    '--flag',
    'C:\\Program Files\\x',
    'plain',
    '',
  ]);
});

test('display names, sorting, icon sizes and drop keys', () => {
  const item = (name, extra = {}) => ({
    name,
    path: '/x/' + name,
    folder: false,
    size: 1,
    modified: 1,
    hidden: false,
    ...extra,
  });
  assert.equal(displayName(item('VLC.lnk', { shortcut: true }), false), 'VLC');
  assert.equal(displayName(item('a.pdf'), false), 'a.pdf');
  assert.equal(displayName(item('a.pdf'), true), 'a');
  assert.equal(displayName(item('.gitignore'), true), '.gitignore');
  assert.equal(displayName(item('dir.v2', { folder: true }), true), 'dir.v2');
  const sorted = sortItems(
    [
      item('b10.txt', { size: 5 }),
      item('b9.txt', { size: 50 }),
      item('Zed', { folder: true }),
      item('a.png', { size: 9 }),
    ],
    'name',
  ).map((i) => i.name);
  assert.deepEqual(sorted, ['Zed', 'a.png', 'b9.txt', 'b10.txt']);
  assert.deepEqual(
    sortItems([item('x', { size: 5 }), item('y', { size: 50 })], 'size', true).map((i) => i.name),
    ['y', 'x'],
  );
  assert.deepEqual([20, 33, 64, 65, 300].map(iconTier), [32, 64, 64, 128, 256]);
  const keys = (ctrlKey, shiftKey, altKey) => dropMode({ ctrlKey, shiftKey, altKey });
  assert.equal(keys(false, false, false), 'auto');
  assert.equal(keys(true, false, false), 'copy');
  assert.equal(keys(false, true, false), 'move');
  assert.equal(keys(false, false, true), 'link');
  assert.equal(keys(true, true, false), 'link');
});

function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'terra-folders-'));
  const dirs = {};
  for (const name of [
    'desktop',
    'downloads',
    'documents',
    'pictures',
    'music',
    'videos',
    'home',
    'trash',
  ])
    dirs[name] = path.join(root, name === 'home' ? 'home' : `home-${name}`);
  dirs.home = path.join(root, 'home');
  dirs.desktop = path.join(dirs.home, 'Desktop');
  dirs.downloads = path.join(dirs.home, 'Downloads');
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const trashed = [];
  const opened = [];
  const files = createLocalFiles({
    platform: process.platform,
    getPath: (name) => dirs[name],
    env: { PUBLIC: path.join(root, 'no-public') },
    shell: {
      trashItem: async (file) => {
        const to = path.join(dirs.trash, `${trashed.length}-${path.basename(file)}`);
        fs.renameSync(file, to);
        trashed.push(file);
      },
      openPath: async (file) => {
        opened.push(file);
        return '';
      },
      showItemInFolder: (file) => opened.push('reveal:' + file),
      writeShortcutLink: (file, _mode, { target }) => {
        fs.writeFileSync(file, 'shortcut to ' + target);
        return true;
      },
      readShortcutLink: () => ({ target: '', args: '' }),
    },
    readAsset: async ({ id }) => ({
      file: path.join(root, 'asset-' + id),
      name: 'Photo',
      mime: 'image/png',
    }),
    importFile: async (file) => ({ id: 'x', name: path.basename(file) }),
  });
  return {
    root,
    dirs,
    files,
    trashed,
    opened,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('known folders are stored relative to themselves, everything else by full path', () => {
  const { dirs, files, cleanup } = fixture();
  try {
    assert.deepEqual(files.sourceFor(dirs.desktop), { root: 'desktop', path: '' });
    assert.deepEqual(files.sourceFor(path.join(dirs.desktop, 'A', 'B')), {
      root: 'desktop',
      path: 'A/B',
    });
    // Desktop lies inside Home; the deeper folder wins.
    assert.deepEqual(files.sourceFor(path.join(dirs.home, 'Elsewhere')), {
      root: 'home',
      path: 'Elsewhere',
    });
    const outside = path.join(tmpdir(), 'not-known');
    assert.deepEqual(files.sourceFor(outside), { path: path.normalize(outside) });
    assert.equal(
      files.sourcePath({ root: 'desktop', path: 'A/B' }),
      path.join(dirs.desktop, 'A', 'B'),
    );
    assert.throws(() => files.sourcePath({ root: 'desktop', path: '../x' }));
    assert.throws(() => files.sourcePath({ path: 'relative' }));
  } finally {
    cleanup();
  }
});

test('This PC lists the drives; a drive leads back to it and is never renamed or trashed', async (t) => {
  if (process.platform !== 'win32') return t.skip('drive letters are a Windows thing');
  const { dirs, files, cleanup } = fixture();
  try {
    const source = { root: 'computer', path: '' };
    const top = await files.list({ source });
    assert.equal(top.state, 'folder');
    assert.equal(top.label, 'This PC');
    assert.equal(top.parent, null);
    const drive = path.parse(dirs.home).root;
    const item = top.items.find((i) => i.path.toLowerCase() === drive.toLowerCase());
    assert.ok(item, 'the drive holding the test folder is listed');
    assert.equal(item.drive, true);
    assert.equal(item.folder, true);
    assert.match(item.name, /\([A-Z]:\)$/);
    const inDrive = await files.list({ source, sub: drive });
    assert.equal(inDrive.parent, top.base);
    const deeper = await files.list({ source, sub: dirs.home });
    assert.equal(deeper.state, 'folder');
    await assert.rejects(files.rename({ path: drive, name: 'X' }));
    const trashed = await files.trash({ paths: [drive] });
    assert.equal(trashed.done, 0);
    assert.equal(trashed.errors.length, 1);
    const thisPc = { root: 'computer', path: '', kind: 'folder' };
    assert.deepEqual(fileLinkValue(thisPc), storeFileLinkValue(thisPc));
    for (const check of [fileLinkValue, storeFileLinkValue])
      assert.throws(() => check({ root: 'computer', path: 'Users', kind: 'folder' }));
  } finally {
    cleanup();
  }
});

test('a folder lists its items live, hides system files and reports missing folders', async () => {
  const { dirs, files, cleanup } = fixture();
  try {
    fs.writeFileSync(path.join(dirs.desktop, 'b.txt'), 'hello');
    fs.writeFileSync(path.join(dirs.desktop, 'desktop.ini'), '[x]');
    fs.writeFileSync(path.join(dirs.desktop, 'VLC.lnk'), 'x');
    fs.writeFileSync(path.join(dirs.desktop, 'setup.exe'), 'x');
    fs.mkdirSync(path.join(dirs.desktop, 'Folder'));
    let listing = await files.list({ source: { root: 'desktop', path: '' } });
    assert.equal(listing.state, 'folder');
    assert.equal(listing.label, 'Desktop');
    assert.equal(listing.parent, null);
    const names = listing.items.map((i) => i.name).sort();
    const windows = process.platform === 'win32';
    assert.deepEqual(
      names,
      windows
        ? ['Folder', 'VLC.lnk', 'b.txt', 'setup.exe']
        : ['Folder', 'VLC.lnk', 'b.txt', 'desktop.ini', 'setup.exe'],
    );
    const byName = Object.fromEntries(listing.items.map((i) => [i.name, i]));
    assert.equal(byName['VLC.lnk'].shortcut, true);
    assert.equal(byName['setup.exe'].app, true);
    assert.equal(byName.Folder.folder, true);
    assert.equal(byName['b.txt'].size, 5);
    listing = await files.list({ source: { root: 'desktop', path: '' }, hidden: true });
    assert.ok(listing.items.some((i) => i.name === 'desktop.ini'));
    const inner = await files.list({
      source: { root: 'desktop', path: '' },
      sub: path.join(dirs.desktop, 'Folder'),
    });
    assert.equal(inner.label, 'Folder');
    assert.equal(inner.parent, dirs.desktop);
    // A sub folder must lie inside the frame's folder.
    await assert.rejects(
      files.list({ source: { root: 'desktop', path: '' }, sub: dirs.downloads }),
    );
    const missing = await files.list({ source: { root: 'desktop', path: 'Gone' } });
    assert.equal(missing.state, 'missing');
    const file = await files.list({ source: { root: 'desktop', path: 'b.txt' } });
    assert.equal(file.state, 'file');
    assert.equal(file.item.name, 'b.txt');
  } finally {
    cleanup();
  }
});

test('moves, copies and shortcuts never overwrite, and undo puts things back', async () => {
  const { dirs, files, trashed, cleanup } = fixture();
  try {
    const a = path.join(dirs.desktop, 'a.txt');
    fs.writeFileSync(a, 'A');
    fs.writeFileSync(path.join(dirs.downloads, 'a.txt'), 'existing');
    // Same drive: moved, and the clash gets a free name.
    let result = await files.transfer({ paths: [a], target: dirs.downloads, mode: 'auto' });
    assert.deepEqual(result.errors, []);
    assert.equal(result.ops[0].op, 'move');
    assert.equal(path.basename(result.ops[0].to), 'a (2).txt');
    assert.equal(fs.readFileSync(path.join(dirs.downloads, 'a.txt'), 'utf8'), 'existing');
    assert.ok(!fs.existsSync(a));
    await files.revert({ ops: result.ops });
    assert.equal(fs.readFileSync(a, 'utf8'), 'A');
    // A copy next to its original is "name - Copy", as in Explorer.
    result = await files.transfer({ paths: [a], target: dirs.desktop, mode: 'copy' });
    assert.equal(path.basename(result.ops[0].to), 'a - Copy.txt');
    result = await files.transfer({ paths: [a], target: dirs.desktop, mode: 'copy' });
    assert.equal(path.basename(result.ops[0].to), 'a - Copy (2).txt');
    // Undoing a copy sends it to the Recycle Bin, not away for good.
    await files.revert({ ops: result.ops });
    assert.equal(trashed.length, 1);
    // Moving into the folder it is already in does nothing.
    result = await files.transfer({ paths: [a], target: dirs.desktop, mode: 'move' });
    assert.deepEqual(result, { ops: [], errors: [] });
    // A folder can't go inside itself.
    const folder = path.join(dirs.desktop, 'Folder');
    fs.mkdirSync(path.join(folder, 'Inner'), { recursive: true });
    result = await files.transfer({
      paths: [folder],
      target: path.join(folder, 'Inner'),
      mode: 'move',
    });
    assert.equal(result.ops.length, 0);
    assert.match(result.errors[0], /inside itself/);
    // Folders copy with what they hold.
    fs.writeFileSync(path.join(folder, 'Inner', 'deep.txt'), 'D');
    result = await files.transfer({ paths: [folder], target: dirs.downloads, mode: 'copy' });
    assert.equal(
      fs.readFileSync(path.join(dirs.downloads, 'Folder', 'Inner', 'deep.txt'), 'utf8'),
      'D',
    );
    // Shortcuts.
    if (process.platform === 'win32') {
      result = await files.transfer({ paths: [a], target: dirs.downloads, mode: 'link' });
      assert.equal(path.basename(result.ops[0].to), 'a.txt - Shortcut.lnk');
    }
    await assert.rejects(
      files.transfer({ paths: [a], target: path.join(dirs.desktop, 'nope'), mode: 'copy' }),
    );
  } finally {
    cleanup();
  }
});

test('renaming, new folders and saving board files', async () => {
  const { root, dirs, files, cleanup } = fixture();
  try {
    const a = path.join(dirs.desktop, 'a.txt');
    fs.writeFileSync(a, 'A');
    fs.writeFileSync(path.join(dirs.desktop, 'taken.txt'), 'T');
    await assert.rejects(files.rename({ path: a, name: 'bad?.txt' }), /can’t contain/);
    await assert.rejects(files.rename({ path: a, name: 'taken.txt' }), /already an item/);
    const renamed = await files.rename({ path: a, name: 'b.txt' });
    assert.ok(fs.existsSync(path.join(dirs.desktop, 'b.txt')));
    await files.revert({ ops: renamed.ops });
    assert.ok(fs.existsSync(a));
    const first = await files.newFolder({ dir: dirs.desktop });
    const second = await files.newFolder({ dir: dirs.desktop });
    assert.equal(path.basename(first.ops[0].to), 'New folder');
    assert.equal(path.basename(second.ops[0].to), 'New folder (2)');
    const id = 'a'.repeat(64);
    fs.writeFileSync(path.join(root, 'asset-' + id), 'PNG');
    const saved = await files.saveAssets({
      target: dirs.desktop,
      items: [{ id, name: 'Holiday' }, { id }],
    });
    assert.deepEqual(
      saved.ops.map((op) => path.basename(op.to)),
      ['Holiday.png', 'Photo.png'],
    );
    const kinds = await files.classify({
      paths: [dirs.desktop, a, path.join(dirs.desktop, 'x.lnk'), path.join(dirs.desktop, 'y.exe')],
    });
    assert.deepEqual(
      kinds.map((k) => k.kind),
      ['folder', 'file', 'shortcut', 'app'],
    );
    assert.deepEqual(kinds[0].source, { root: 'desktop', path: '' });
    await assert.rejects(
      freeName(dirs.desktop, 'New folder', { folder: true }).then((f) => {
        assert.equal(path.basename(f), 'New folder (3)');
        throw Error('checked');
      }),
      /checked/,
    );
  } finally {
    cleanup();
  }
});

test('folders are watched, and a change is reported once', async () => {
  const { dirs, cleanup } = fixture();
  const sent = [];
  const files = createLocalFiles({
    getPath: (name) => dirs[name],
    send: (channel, dir) => sent.push([channel, dir]),
  });
  try {
    files.watch('one', [dirs.desktop]);
    files.watch('two', [dirs.desktop]);
    fs.writeFileSync(path.join(dirs.desktop, 'new.txt'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(sent.length >= 1);
    assert.deepEqual(sent[0], ['canvas:files-changed', dirs.desktop]);
    files.unwatchAll();
  } finally {
    files.unwatchAll();
    cleanup();
  }
});

test('app frames keep their program, and folders can be arranged freely', () => {
  for (const link of [
    { root: 'home', path: 'AppData/Roaming/Telegram Desktop/Telegram.exe', kind: 'app' },
    { path: 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe', kind: 'app' },
    { root: 'desktop', path: '', kind: 'folder', arrange: 'free' },
    { root: 'desktop', path: '', kind: 'folder', arrange: 'grid' },
  ])
    assert.deepEqual(fileLinkValue(link), storeFileLinkValue(link));
  assert.equal(
    fileLinkValue({ root: 'desktop', path: '', kind: 'folder', arrange: 'free' }).arrange,
    'free',
  );
  assert.equal(
    fileLinkValue({ root: 'desktop', path: '', kind: 'folder', arrange: 'grid' }).arrange,
    undefined,
  );
  assert.throws(() => fileLinkValue({ path: 'relative.exe', kind: 'app' }));
  assert.throws(() => storeFileLinkValue({ path: 'relative.exe', kind: 'app' }));
});

test('desktops frames hold nothing but their kind', () => {
  const desktops = { path: '', kind: 'desktops', view: 'list', root: undefined };
  assert.deepEqual(fileLinkValue(desktops), { path: '', kind: 'desktops' });
  assert.deepEqual(storeFileLinkValue(desktops), { path: '', kind: 'desktops' });
  for (const bad of [
    { path: 'C:\\x', kind: 'desktops' },
    { root: 'desktop', path: '', kind: 'desktops' },
  ]) {
    assert.throws(() => fileLinkValue(bad));
    assert.throws(() => storeFileLinkValue(bad));
  }
});

test('desktops come from the Windows helper, and only Windows has them', async () => {
  const calls = [];
  const helper = {
    available: true,
    desktops: async () => ({
      current: 'a',
      desktops: [{ id: 'a', name: 'Desktop 1', wallpaper: '' }],
      windows: [
        {
          id: '42',
          title: 'Notes',
          exe: 'C:\\n.exe',
          app: 'Notes',
          desktop: 'a',
          minimized: false,
          focused: true,
        },
      ],
    }),
    focusWindow: async (id, steps) => calls.push(['focus', id, steps]),
    switchDesktop: async (steps) => calls.push(['switch', steps]),
    closeWindow: async (id) => calls.push(['close', id]),
  };
  const win = createLocalFiles({ platform: 'win32', getPath: () => tmpdir(), helper });
  const state = await win.desktops();
  assert.equal(state.supported, true);
  assert.equal(state.windows[0].title, 'Notes');
  await win.focusWindow({ id: '42', steps: 99 });
  await win.switchDesktop({ steps: -1 });
  await win.closeWindow({ id: '42' });
  assert.deepEqual(calls, [
    ['focus', '42', 20],
    ['switch', -1],
    ['close', '42'],
  ]);
  await assert.rejects(win.focusWindow({ id: '42; rm', steps: 0 }), /Invalid window/);
  await assert.rejects(win.closeWindow({ id: 42 }), /Invalid window/);
  const linux = createLocalFiles({ platform: 'linux', getPath: () => tmpdir(), helper });
  assert.equal((await linux.desktops()).supported, false);
  await assert.rejects(linux.switchDesktop({ steps: 1 }));
  const broken = createLocalFiles({
    platform: 'win32',
    getPath: () => tmpdir(),
    helper: { available: false },
  });
  assert.deepEqual(await broken.desktops(), {
    supported: false,
    message: 'Windows didn’t let Terra read the desktops.',
  });
});

test('app frame pictures: parts around what covers them, checked before Windows draws them', () => {
  // A menu over the middle of a frame leaves the parts above, below and beside it.
  const parts = subtract([{ x0: 0, y0: 0, x1: 100, y1: 50 }], { x0: 40, y0: 10, x1: 60, y1: 30 });
  assert.deepEqual(parts, [
    { x0: 0, y0: 0, x1: 100, y1: 10 },
    { x0: 0, y0: 30, x1: 100, y1: 50 },
    { x0: 0, y0: 10, x1: 40, y1: 30 },
    { x0: 60, y0: 10, x1: 100, y1: 30 },
  ]);
  assert.deepEqual(subtract(parts, { x0: -5, y0: -5, x1: 200, y1: 200 }), []);
  assert.equal(alpha('rgba(0, 0, 0, 0)'), 0);
  assert.equal(alpha('rgb(0, 0, 0)'), 1);
  assert.equal(alpha('rgba(255, 255, 255, 0.5)'), 0.5);
  assert.equal(alpha('oklch(0.5 0.1 200 / 0)'), 0);
  assert.equal(alpha('transparent'), 0);

  const shown = [];
  const pictures = {
    show: (key, picture) => (shown.push([key, picture]), true),
    hide: (key) => shown.push([key, null]),
  };
  const files = createLocalFiles({
    platform: 'win32',
    getPath: () => tmpdir(),
    pictures,
    pictureTarget: () => 42,
  });
  assert.equal(files.appPictures(), true);
  const part = { dest: [10, 20, 110, 70], src: [0, 0, 100, 50] };
  assert.equal(files.appPicture({ frame: 'f', id: '123', whole: [100, 50], parts: [part] }), true);
  assert.deepEqual(shown.pop(), [
    'f',
    { target: 42, source: 123, whole: [100, 50], parts: [part] },
  ]);
  files.appPicture({ frame: 'f', id: '0', whole: [1, 1], parts: [] });
  assert.deepEqual(shown.pop(), ['f', null]);
  assert.throws(() => files.appPicture({ frame: 'f', id: 'x', whole: [100, 50], parts: [part] }));
  assert.throws(() =>
    files.appPicture({
      frame: 'f',
      id: '1',
      whole: [100, 50],
      parts: [{ dest: [0, 0, 1], src: [0, 0, 1, 1] }],
    }),
  );
  assert.equal(
    createLocalFiles({
      platform: 'linux',
      getPath: () => tmpdir(),
      pictures,
      pictureTarget: () => 1,
    }).appPictures(),
    false,
  );
});
