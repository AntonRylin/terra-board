import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { downloadSongLink } = require('../electron/song-link.cjs');

// yt-dlp comes from the Song links extension; without it the app says where
// to get it instead of failing obscurely.
test('missing yt-dlp asks to install Song links', async () => {
  mkdirSync(resolve('.local-test'), { recursive: true });
  const dir = mkdtempSync(resolve('.local-test/song-link-'));
  const link = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  await assert.rejects(downloadSongLink(link, null), /Install Song links in Settings → Extensions/);
  await assert.rejects(
    downloadSongLink(link, join(dir, 'yt-dlp.exe')),
    /Install Song links in Settings → Extensions/,
  );
  // The link itself is still checked first.
  await assert.rejects(downloadSongLink('ftp://example.com/song', null), /https:\/\//);
});
