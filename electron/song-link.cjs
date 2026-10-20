const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

// The audio of a song link: YouTube and the many other sites yt-dlp knows, or a
// direct link to an audio file. Only the audio track is fetched, never video.
// yt-dlp comes from the Song links extension, and runs this app's own Electron
// as Node for the JavaScript YouTube needs.

function songLinkValue(value) {
  if (typeof value !== 'string' || value.length > 2000) throw Error('Paste a link to a song.');
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw Error('Paste a link to a song.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw Error('Paste a link that starts with https://.');
  return url.href;
}

const run = (exe, args, env) =>
  new Promise((resolve, reject) =>
    execFile(
      exe,
      args,
      { env, timeout: 180000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error ? reject(Object.assign(error, { stderr })) : resolve(stdout),
    ),
  );

// Short reasons for the common failures; yt-dlp's own messages are long.
function reason(error) {
  const text = String(error.stderr || error.message || error);
  if (error.killed) return 'The download took too long. Try another link.';
  if (/max-filesize|larger than max/i.test(text)) return 'This song is too long. Try another link.';
  if (/does not pass filter/i.test(text)) return 'Choose a song up to 30 minutes long.';
  if (/Unsupported URL/i.test(text)) return 'This link has no song Terra Board can use.';
  if (/Private video|Sign in|members-only|age/i.test(text))
    return 'This video needs a sign-in, so its song cannot be used.';
  if (/unavailable|not available|removed/i.test(text)) return 'This video is not available.';
  if (/getaddrinfo|network|timed out|resolve host/i.test(text))
    return 'Could not reach the site. Check the internet connection.';
  return 'Could not get the song from this link.';
}

async function downloadSongLink(value, exe) {
  const url = songLinkValue(value);
  if (!exe || !fs.existsSync(exe))
    throw Error('Install Song links in Settings → Extensions to use song links.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-song-'));
  try {
    let title;
    try {
      const stdout = await run(
        exe,
        [
          '--ignore-config',
          '--no-playlist',
          '--no-warnings',
          '--no-progress',
          '--no-mtime',
          '--fixup',
          'never',
          '--js-runtimes',
          'node:' + process.execPath,
          '-f',
          'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best[ext=mp4]/best',
          '--max-filesize',
          '60M',
          '--match-filter',
          '!is_live & duration <=? 1800',
          '-o',
          path.join(dir, 'song.%(ext)s'),
          '--print',
          'after_move:%(title)s',
          '--',
          url,
        ],
        { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      );
      title = stdout.trim().split(/\r?\n/).at(-1)?.trim();
    } catch (e) {
      throw Error(reason(e));
    }
    const file = fs.readdirSync(dir).find((f) => f.startsWith('song.') && !f.endsWith('.part'));
    if (!file) throw Error('Could not get the song from this link.');
    return {
      bytes: new Uint8Array(fs.readFileSync(path.join(dir, file))),
      name: (title || 'Song').slice(0, 120) + path.extname(file),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { downloadSongLink, songLinkValue };
