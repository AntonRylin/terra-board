import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { officeLocation, VERSION } = require('../electron/office-converter.cjs');

function soffice(file) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '');
  return file;
}

// The Office files extension holds LibreOffice now; copies extracted by 0.1.28
// and earlier under Library/tools, and a LibreOffice installed in Windows, still
// count so nobody downloads 356 MB again.
test('finds LibreOffice in the extension, the old Library tools folder, or Program Files', (t) => {
  mkdirSync(resolve('.local-test'), { recursive: true });
  const base = mkdtempSync(resolve('.local-test/office-location-'));
  const extension = join(base, 'Extensions', 'office-files');
  const library = join(base, 'Library');
  const programFiles = join(base, 'Program Files');
  const inExtension = soffice(join(extension, `libreoffice-${VERSION}`, 'program', 'soffice.com'));
  const legacy = soffice(
    join(library, 'tools', `libreoffice-${VERSION}`, 'program', 'soffice.com'),
  );
  const system = soffice(join(programFiles, 'LibreOffice', 'program', 'soffice.com'));
  const saved = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']];
  t.after(() => {
    process.env.ProgramFiles = saved[0];
    process.env['ProgramFiles(x86)'] = saved[1];
  });
  process.env.ProgramFiles = programFiles;
  process.env['ProgramFiles(x86)'] = join(base, 'missing');

  assert.deepEqual(
    officeLocation({ extensionDir: extension, legacyRoot: library, platform: 'win32' }),
    {
      executable: inExtension,
      system: false,
    },
  );
  assert.deepEqual(officeLocation({ extensionDir: null, legacyRoot: library, platform: 'win32' }), {
    executable: legacy,
    system: false,
    legacy: true,
  });
  assert.deepEqual(
    officeLocation({ extensionDir: null, legacyRoot: join(base, 'empty'), platform: 'win32' }),
    {
      executable: system,
      system: true,
    },
  );
  process.env.ProgramFiles = join(base, 'missing');
  assert.equal(
    officeLocation({ extensionDir: null, legacyRoot: join(base, 'empty'), platform: 'win32' }),
    null,
  );
});

// Linux has no LibreOffice download: Office files uses the one the system's
// packages installed, whatever the extension folders hold.
test('on Linux, finds the LibreOffice installed in the system', () => {
  const files = new Set();
  const find = (opt = []) =>
    officeLocation({
      extensionDir: '/home/anna/.local/share/Terra Board/Extensions/office-files',
      platform: 'linux',
      exists: (file) => files.has(file),
      optFolders: () => opt,
    });
  assert.equal(find(), null);
  files.add('/opt/libreoffice25.8/program/soffice').add('/opt/libreoffice26.2/program/soffice');
  assert.deepEqual(find(['google', 'libreoffice25.8', 'libreoffice26.2']), {
    executable: '/opt/libreoffice26.2/program/soffice',
    system: true,
  });
  files.add('/usr/bin/soffice');
  assert.deepEqual(find(['libreoffice26.2']), { executable: '/usr/bin/soffice', system: true });
});
