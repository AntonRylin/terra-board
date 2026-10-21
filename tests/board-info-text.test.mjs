import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardPlace,
  formatBytes,
  mergePeople,
  placeText,
  relativeTime,
  sizeText,
} from '../src/components/board-info-text.ts';

test('formatBytes uses one decimal below 10 and whole numbers above', () => {
  assert.equal(formatBytes(0), '0 KB');
  assert.equal(formatBytes(512), '512 bytes');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(812 * 1024), '812 KB');
  assert.equal(formatBytes(2.44 * 1024 * 1024), '2.4 MB');
  assert.equal(formatBytes(245.3 * 1024 * 1024), '245 MB');
  assert.equal(formatBytes(1023.8 * 1024), '1 MB');
  assert.equal(formatBytes(3.25 * 1024 ** 3), '3.3 GB');
});

test('sizeText reads like the card line', () => {
  const info = {
    objects: 1203,
    contentBytes: 1024 * 1024,
    files: 87,
    fileBytes: 244 * 1024 * 1024,
  };
  assert.equal(sizeText({ ...info, linkedFiles: 0 }), '245 MB · 1,203 objects · 87 files');
  assert.equal(
    sizeText({ objects: 1, contentBytes: 300, files: 1, fileBytes: 0, linkedFiles: 2 }),
    '300 bytes · 1 object · 1 file (+2 linked files not counted)',
  );
  assert.equal(
    sizeText({ objects: 0, contentBytes: 0, files: 0, fileBytes: 0, linkedFiles: 0 }),
    '0 KB · 0 objects',
  );
});

test('relativeTime says how long ago in plain words', () => {
  const now = new Date(2026, 9, 21, 15, 30).getTime();
  const at = (...parts) => new Date(...parts).getTime();
  assert.equal(relativeTime(now - 10_000, now), 'just now');
  assert.equal(relativeTime(now + 60_000, now), 'just now');
  assert.equal(relativeTime(now - 60_000, now), '1 minute ago');
  assert.equal(relativeTime(now - 5 * 60_000, now), '5 minutes ago');
  assert.equal(relativeTime(at(2026, 9, 21, 12, 0), now), '3 hours ago');
  assert.equal(relativeTime(at(2026, 9, 20, 23, 50), now), 'yesterday');
  assert.equal(relativeTime(at(2026, 9, 17, 9, 0), now), '4 days ago');
  assert.equal(relativeTime(at(2026, 9, 7), now), '2 weeks ago');
  assert.equal(relativeTime(at(2026, 6, 1), now), '3 months ago');
  assert.equal(relativeTime(at(2024, 9, 1), now), '2 years ago');
});

const library = (sharing) => ({ folders: [{ id: 'f1', name: 'Work', position: 1 }], sharing });
const place = (over) =>
  boardPlace({
    boardId: 'b1',
    folderId: null,
    library: library({ boards: {}, folders: {}, local: [] }),
    configured: true,
    librarySync: false,
    syncs: false,
    ...over,
  });

test('boardPlace reads where a board lives', () => {
  assert.equal(place({ configured: undefined }), null, 'unknown until the cloud status loads');
  assert.equal(placeText(place({ configured: false, librarySync: true })), 'Only on this computer');
  assert.equal(placeText(place({})), 'Only on this computer');
  assert.equal(place({ librarySync: true, syncs: undefined }), null);
  assert.equal(
    placeText(place({ librarySync: true, syncs: true })),
    'In the cloud — synced with your library',
  );
  assert.equal(
    placeText(
      place({
        librarySync: true,
        syncs: false,
        library: library({ boards: {}, folders: {}, local: ['b1'] }),
      }),
    ),
    'Kept on this computer — removed from the cloud',
  );
  assert.equal(
    placeText(place({ library: library({ boards: { b1: { shared: 'owner' } }, folders: {} }) })),
    'In the cloud — shared by you',
  );
  const viaFolder = place({
    folderId: 'f1',
    library: library({ boards: {}, folders: { f1: { shared: 'owner' } } }),
  });
  assert.deepEqual(viaFolder, {
    kind: 'owner',
    board: false,
    folder: { id: 'f1', name: 'Work' },
  });
  assert.equal(placeText(viaFolder), 'In the cloud — shared by you through the folder “Work”');
  assert.equal(
    placeText(
      place({
        library: library({ boards: { b1: { shared: 'edit', owner: 'Anna' } }, folders: {} }),
      }),
    ),
    'Shared with you by Anna — you can edit',
  );
  assert.equal(
    placeText(
      place({
        folderId: 'f1',
        library: library({ boards: {}, folders: { f1: { shared: 'view' } } }),
      }),
    ),
    'Shared with you by Someone — you can view',
  );
});

test('mergePeople keeps one entry per person with the stronger right', () => {
  assert.deepEqual(
    mergePeople(
      [{ id: 'a', name: 'Anna', role: 'view' }],
      [
        { id: 'a', name: 'Anna', role: 'edit' },
        { id: 'b', name: 'Ben', role: 'view' },
      ],
    ),
    [
      { id: 'a', name: 'Anna', role: 'edit' },
      { id: 'b', name: 'Ben', role: 'view' },
    ],
  );
});
