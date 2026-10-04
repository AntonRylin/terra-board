const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const VERSION = '26.2.6';
const SHA256 = 'f9877032fd908beb9c0ddf06df4af5c2e85f419c42e14876c4cce5aae5fb2660';
const DOWNLOAD = `https://download.documentfoundation.org/libreoffice/stable/${VERSION}/win/x86_64/LibreOffice_${VERSION}_Win_x86-64.msi`;
const ARCHIVE =
  'https://downloadarchive.documentfoundation.org/libreoffice/old/26.2.6.3/win/x86_64/LibreOffice_26.2.6.3_Win_x86-64.msi';
const OFFICE_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.docm',
  '.dot',
  '.dotx',
  '.rtf',
  '.odt',
  '.ott',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.xlsb',
  '.ods',
  '.ots',
  '.ppt',
  '.pptx',
  '.pptm',
  '.odp',
  '.odg',
]);
const MAX_BYTES = 64 * 1024 * 1024;

function run(executable, args, { signal, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => {
      if (process.platform === 'win32' && child.pid)
        spawn(
          path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/pid', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' },
        ).on('error', () => child.kill());
      else child.kill();
    };
    signal?.addEventListener('abort', stop, { once: true });
    let output = '';
    const collect = (data) => {
      if (output.length < 4096) output += data.toString().slice(0, 4096 - output.length);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(stop, timeout);
    child.once('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) reject(signal.reason || Error('Conversion cancelled.'));
      else if (code !== 0)
        reject(Error(`Office conversion failed (${code ?? 'timeout'}). ${output.trim()}`));
      else resolve(output);
    });
  });
}

async function safeRemove(root, target) {
  const base = path.resolve(root),
    resolved = path.resolve(target);
  if (!resolved.startsWith(base + path.sep)) throw Error('Invalid converter cleanup path');
  await fs.promises.rm(resolved, { recursive: true, force: true });
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function ensureOfficeRuntime(root, { signal, onProgress = () => {} } = {}) {
  const runtime = path.join(root, 'tools', `libreoffice-${VERSION}`);
  const executable = path.join(runtime, 'program', 'soffice.com');
  if (fs.existsSync(executable)) return executable;
  for (const programFiles of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(
    Boolean,
  )) {
    const installed = path.join(programFiles, 'LibreOffice', 'program', 'soffice.com');
    if (fs.existsSync(installed)) return installed;
  }
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('Office conversion currently requires 64-bit Windows.');
  const toolsRoot = path.join(root, 'tools');
  await fs.promises.mkdir(toolsRoot, { recursive: true });
  const packageFile = path.join(toolsRoot, `LibreOffice-${VERSION}.msi`);
  if (!fs.existsSync(packageFile) || (await hashFile(packageFile)) !== SHA256) {
    const temporary = packageFile + '.' + randomUUID() + '.download';
    onProgress('Downloading the Office converter (once)…');
    try {
      const options = {
        signal: AbortSignal.any([
          signal || new AbortController().signal,
          AbortSignal.timeout(600000),
        ]),
      };
      let response = await fetch(DOWNLOAD, options);
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel();
        response = await fetch(ARCHIVE, options);
      }
      if (!response.ok || !response.body || !response.url.startsWith('https://'))
        throw Error(
          'The Office converter could not be downloaded. Check your connection and try again.',
        );
      let size = 0,
        reported = -1;
      const total = Number(response.headers.get('content-length')) || 0;
      const hash = createHash('sha256');
      const file = await fs.promises.open(temporary, 'wx');
      try {
        for await (const chunk of response.body) {
          signal?.throwIfAborted();
          size += chunk.length;
          if (size > 450 * 1024 * 1024) throw Error('Office converter download is too large.');
          hash.update(chunk);
          await file.writeFile(chunk);
          const percent = total ? Math.floor((size * 100) / total) : Math.floor(size / 1048576);
          if (percent !== reported) {
            reported = percent;
            onProgress(`Downloading Office converter · ${percent}${total ? '%' : ' MB'}`);
          }
        }
      } finally {
        await file.close();
      }
      if (hash.digest('hex') !== SHA256)
        throw Error('Office converter verification failed. Please try again.');
      await fs.promises.rename(temporary, packageFile);
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
  }
  const staging = path.join(toolsRoot, `office-setup-${randomUUID()}`);
  await fs.promises.mkdir(staging);
  try {
    onProgress('Preparing the Office converter…');
    // Administrative extraction creates an app-local image; it does not install
    // Office, change file associations, or register a Windows application.
    await run(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'msiexec.exe'),
      ['/a', packageFile, '/qn', '/norestart', `TARGETDIR=${staging}`],
      { signal, timeout: 600000 },
    );
    if (!fs.existsSync(path.join(staging, 'program', 'soffice.com')))
      throw Error('The Office converter could not be prepared.');
    await fs.promises.rename(staging, runtime);
    await fs.promises.rm(packageFile, { force: true });
    return executable;
  } finally {
    await safeRemove(toolsRoot, staging);
  }
}

function createOfficeConverter({ root, readAsset, importAsset, onProgress = () => {} }) {
  const lifetime = new AbortController();
  let tail = Promise.resolve(),
    runtime;
  return {
    convert(args) {
      const task = tail
        .catch(() => {})
        .then(async () => {
          const signal = lifetime.signal;
          signal.throwIfAborted();
          if (
            !args ||
            typeof args.id !== 'string' ||
            !/^[a-f0-9]{64}$/.test(args.id) ||
            typeof args.name !== 'string'
          )
            throw Error('Invalid Office file.');
          const extension = path.extname(args.name).toLowerCase();
          if (!OFFICE_EXTENSIONS.has(extension))
            throw Error('This file format cannot be converted to PDF.');
          const asset = await readAsset({ id: args.id, variant: 'original' });
          const stat = await fs.promises.stat(asset.file);
          if (stat.size > MAX_BYTES) throw Error('Office conversion supports files up to 64 MB.');
          runtime ||= ensureOfficeRuntime(root, { signal, onProgress }).catch((error) => {
            runtime = null;
            throw error;
          });
          const executable = await runtime;
          const tempRoot = path.join(root, 'temp');
          await fs.promises.mkdir(tempRoot, { recursive: true });
          const job = await fs.promises.mkdtemp(path.join(tempRoot, 'office-'));
          try {
            const profile = path.join(job, 'profile');
            await fs.promises.mkdir(path.join(profile, 'user'), { recursive: true });
            await fs.promises.writeFile(
              path.join(profile, 'user', 'registrymodifications.xcu'),
              '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item><item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item></oor:items>',
            );
            const input = path.join(job, `input${extension}`);
            await fs.promises.copyFile(asset.file, input);
            onProgress(`Converting ${path.basename(args.name)}…`);
            await run(
              executable,
              [
                `-env:UserInstallation=${pathToFileURL(profile).href}`,
                '--headless',
                '--nologo',
                '--nodefault',
                '--nolockcheck',
                '--norestore',
                '--convert-to',
                'pdf',
                '--outdir',
                job,
                input,
              ],
              { signal },
            );
            signal.throwIfAborted();
            const output = path.join(job, 'input.pdf');
            if (!fs.existsSync(output))
              throw Error(
                'This Office file could not be converted. It may be damaged or password protected.',
              );
            if ((await fs.promises.stat(output)).size > MAX_BYTES)
              throw Error('The converted PDF exceeds 64 MB.');
            const bytes = await fs.promises.readFile(output);
            if (bytes.subarray(0, 5).toString() !== '%PDF-')
              throw Error('Office conversion did not produce a PDF.');
            const name = path.basename(args.name, path.extname(args.name)) + '.pdf';
            return await importAsset({ name, bytes });
          } finally {
            await safeRemove(tempRoot, job);
            onProgress('');
          }
        });
      tail = task.finally(() => onProgress(''));
      return tail;
    },
    dispose() {
      lifetime.abort();
    },
  };
}
module.exports = {
  createOfficeConverter,
  ensureOfficeRuntime,
  OFFICE_EXTENSIONS,
  VERSION,
  SHA256,
  safeRemove,
};
