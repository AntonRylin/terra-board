const { spawn } = require('node:child_process');
const sharp = require('sharp');

// Windows' built-in recognizer (Windows.Media.Ocr) is fast, private and uses the
// language packs already installed for the user, so nothing is bundled or uploaded.
// A long-lived PowerShell host keeps the WinRT engines warm between requests.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
  $null = [Windows.System.UserProfile.GlobalizationPreferences, Windows.System.UserProfile, ContentType = WindowsRuntime]
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1'
  } | Select-Object -First 1
  $available = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
  $preferred = @([Windows.System.UserProfile.GlobalizationPreferences]::Languages)
  [Console]::Out.WriteLine((@{ ready = $true; languages = $available; preferred = $preferred; maxDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension } | ConvertTo-Json -Compress))
} catch {
  [Console]::Out.WriteLine((@{ ready = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  exit 1
}
function Await($operation, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  $null = $task.Wait(-1)
  $task.Result
}
$engines = @{}
function Engine([string]$tag) {
  if (-not $engines.ContainsKey($tag)) {
    $engines[$tag] = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($tag))
  }
  $engines[$tag]
}
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $request = $null
  try {
    $request = $line | ConvertFrom-Json
    $bytes = [Convert]::FromBase64String($request.image)
    $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream([System.IO.MemoryStream]::new($bytes))
    try {
      $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $results = @()
      foreach ($tag in @($request.languages)) {
        $engine = Engine $tag
        if (-not $engine) { continue }
        $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $lines = @(foreach ($ocrLine in $result.Lines) {
          ,@(foreach ($word in $ocrLine.Words) {
            $box = $word.BoundingRect
            @{ t = $word.Text; x = $box.X; y = $box.Y; w = $box.Width; h = $box.Height }
          })
        })
        $results += @{ language = $tag; lines = $lines }
      }
      $bitmap.Dispose()
    } finally {
      $stream.Dispose()
    }
    [Console]::Out.WriteLine((@{ id = $request.id; results = $results } | ConvertTo-Json -Compress -Depth 6))
  } catch {
    [Console]::Out.WriteLine((@{ id = $(if ($request) { $request.id } else { $null }); error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
}
`;

const NON_LATIN_LANGUAGES = new Set(
  'ru uk be bg sr mk kk ky tg mn el ja zh ko ar fa ur he hi mr ne bn ta te th ka hy am'.split(' '),
);
// Cyrillic and Greek letters that render like Latin ones. A word made only of
// these is ambiguous: "сору" from the Russian engine is usually the English "copy".
const LOOKALIKES = new Set([...'АВЕКМНОРСТХУаеорсухіјѕЅІЈΑΒΕΖΗΙΚΜΝΟΡΤΥΧο']);
const primary = (tag) => String(tag).toLowerCase().split('-')[0];
const latinEngine = (tag) => !NON_LATIN_LANGUAGES.has(primary(tag));

function scriptOf(text) {
  let other = false,
    lookalike = false;
  for (const char of text) {
    if (!/\p{L}/u.test(char) || /\p{Script=Latin}/u.test(char)) continue;
    if (LOOKALIKES.has(char)) lookalike = true;
    else other = true;
  }
  return other ? 'other' : lookalike ? 'lookalike' : 'latin';
}

// Recognizers for the user's Windows display languages, in their order.
function matchLanguages(preferred, available) {
  const chosen = [];
  for (const tag of preferred || []) {
    const match =
      available.find((item) => item.toLowerCase() === String(tag).toLowerCase()) ||
      available.find((item) => primary(item) === primary(tag));
    if (match && !chosen.includes(match)) chosen.push(match);
    if (chosen.length === 3) break;
  }
  if (!chosen.length && available.length)
    chosen.push(available.find((item) => primary(item) === 'en') || available[0]);
  return chosen;
}

function overlap(a, b) {
  const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
    height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  const shared = width * height;
  return shared / (a.w * a.h + b.w * b.h - shared);
}

// Combine one reading per recognizer into the best reading of each word.
function mergeRecognitions(results) {
  const readings = results.filter((result) => Array.isArray(result.lines));
  if (!readings.length) return [];
  const count = (result) => result.lines.reduce((sum, line) => sum + line.length, 0);
  const base = readings.reduce((best, result) => (count(result) > count(best) ? result : best));
  if (readings.length === 1) return base.lines;
  const others = readings.filter((result) => result !== base);
  return base.lines.map((line) => {
    const words = line.map((word) => {
      const candidates = [{ word, language: base.language }];
      for (const result of others) {
        let best = null,
          score = 0.5;
        for (const other of result.lines.flat()) {
          const value = overlap(word, other);
          if (value > score) [best, score] = [other, value];
        }
        if (best) candidates.push({ word: best, language: result.language });
      }
      return candidates.map((candidate) => ({ ...candidate, script: scriptOf(candidate.word.t) }));
    });
    const distinct = words.filter((c) => c.some((item) => item.script === 'other')).length;
    const latin = words.filter((c) => c.every((item) => item.script === 'latin')).length;
    const lineIsLatin = latin >= distinct;
    return words.map((candidates) => {
      const pick =
        candidates.find((item) => item.script === 'other') ||
        (!lineIsLatin && candidates.find((item) => item.script === 'lookalike')) ||
        candidates.find((item) => item.script === 'latin' && latinEngine(item.language)) ||
        candidates.find((item) => item.script === 'latin') ||
        candidates[0];
      return { ...candidates[0].word, t: pick.word.t };
    });
  });
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

// Normalized boxes (0-1 of the image). Words share their line's height so a
// selection highlights evenly instead of hugging ascenders and descenders.
function normalizeLines(lines, width, height) {
  return lines
    .filter((line) => line.length)
    .map((line) => {
      const top = Math.min(...line.map((word) => word.y)),
        bottom = Math.max(...line.map((word) => word.y + word.h));
      return {
        words: line.map((word, index) => ({
          text: word.t,
          x: word.x / width,
          y: top / height,
          width: word.w / width,
          height: (bottom - top) / height,
          ...(index && CJK.test(line[index - 1].t.at(-1) || '') && CJK.test(word.t[0] || '')
            ? { join: true }
            : {}),
        })),
      };
    });
}

// Small screenshots read better enlarged; huge photos must fit the engine's limit.
async function prepareImage(input, maxDimension = 10000) {
  let image = sharp(input, { limitInputPixels: 100000000, animated: false }).rotate();
  const metadata = await image.metadata();
  let width = metadata.width,
    height = metadata.height;
  if (!width || !height) throw Error('This image could not be read.');
  if ((metadata.orientation || 1) >= 5) [width, height] = [height, width];
  const longest = Math.max(width, height);
  let scale = longest < 1600 ? Math.min(2, 1600 / longest) : 1;
  scale = Math.min(scale, maxDimension / longest);
  if (Math.min(width, height) * scale < 40) scale = Math.max(scale, 40 / Math.min(width, height));
  scale = Math.min(scale, maxDimension / longest);
  const outWidth = Math.max(1, Math.round(width * scale)),
    outHeight = Math.max(1, Math.round(height * scale));
  image = image.flatten({ background: '#ffffff' });
  if (outWidth !== width || outHeight !== height)
    image = image.resize(outWidth, outHeight, {
      fit: 'fill',
      kernel: scale > 1 ? 'cubic' : 'lanczos3',
    });
  const bytes =
    outWidth * outHeight > 4000000
      ? await image.jpeg({ quality: 92 }).toBuffer()
      : await image.png({ compressionLevel: 1 }).toBuffer();
  return { bytes, width: outWidth, height: outHeight };
}

function createOcr({ loadAsset, spawnHost, idleMs = 120000, timeoutMs = 90000 }) {
  let host = null,
    nextId = 1;
  const cache = new Map();

  function start() {
    if (process.platform !== 'win32') throw Error('Text recognition needs Windows 10 or later.');
    const child = spawnHost
      ? spawnHost()
      : spawn(
          'powershell.exe',
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            Buffer.from(SCRIPT, 'utf16le').toString('base64'),
          ],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
        );
    const state = { child, pending: new Map(), idle: null, buffer: '', ready: null };
    let resolveReady, rejectReady;
    state.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    state.ready.catch(() => {});
    const fail = (error) => {
      rejectReady(error);
      for (const request of state.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      state.pending.clear();
      clearTimeout(state.idle);
      if (host === state) host = null;
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      state.buffer += chunk;
      let index;
      while ((index = state.buffer.indexOf('\n')) >= 0) {
        const line = state.buffer.slice(0, index).trim();
        state.buffer = state.buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if ('ready' in message) {
          if (message.ready) resolveReady(message);
          else fail(Error('Windows text recognition is unavailable: ' + message.error));
          continue;
        }
        const request = state.pending.get(message.id);
        if (!request) continue;
        state.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(Error('Text recognition failed: ' + message.error));
        else request.resolve(message.results || []);
        scheduleIdle(state);
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', (error) => fail(Error('Text recognition could not start: ' + error.message)));
    child.on('exit', () => fail(Error('Text recognition stopped unexpectedly.')));
    child.stdin.on('error', () => {});
    return state;
  }

  function scheduleIdle(state) {
    clearTimeout(state.idle);
    if (state.pending.size) return;
    state.idle = setTimeout(() => {
      if (host === state && !state.pending.size) {
        host = null;
        state.child.stdin.end();
      }
    }, idleMs);
    state.idle.unref?.();
  }

  async function recognize(input) {
    if (!host) host = start();
    const state = host;
    clearTimeout(state.idle);
    const info = await state.ready;
    const image = await prepareImage(input, info.maxDimension || 10000);
    const languages = matchLanguages(info.preferred, info.languages || []);
    if (!languages.length)
      throw Error('No Windows OCR language is installed. Add a language in Windows Settings.');
    const id = nextId++;
    const results = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(Error('Text recognition took too long.'));
        if (host === state) host = null;
        state.child.kill();
      }, timeoutMs);
      state.pending.set(id, { resolve, reject, timer });
      state.child.stdin.write(
        JSON.stringify({ id, languages, image: image.bytes.toString('base64') }) + '\n',
      );
    });
    return { lines: normalizeLines(mergeRecognitions(results), image.width, image.height) };
  }

  return {
    async recognizeAsset(id) {
      if (cache.has(id)) {
        const cached = cache.get(id);
        cache.delete(id);
        cache.set(id, cached);
        return cached;
      }
      const asset = await loadAsset(id);
      if (!asset.mime.startsWith('image/')) throw Error('Only images can be read as text.');
      const task = recognize(asset.file);
      cache.set(id, task);
      if (cache.size > 40) cache.delete(cache.keys().next().value);
      task.catch(() => cache.get(id) === task && cache.delete(id));
      return task;
    },
    recognizeImage(bytes) {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 64 * 1024 * 1024)
        throw Error('Invalid image');
      return recognize(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    },
    dispose() {
      const state = host;
      host = null;
      if (state) {
        clearTimeout(state.idle);
        state.child.stdin.end();
      }
    },
  };
}

module.exports = {
  createOcr,
  mergeRecognitions,
  matchLanguages,
  normalizeLines,
  prepareImage,
  scriptOf,
};
