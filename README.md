# Local Canvas

A Windows-first local whiteboard with a minimal, iOS-inspired board launcher. Version 0.1.2 is a working preview release; the original product roadmap is broader than this implementation.

## Run

Open `Local Canvas.exe` inside the packaged `win-unpacked` directory. Keep that directory's support files alongside the executable. The current tested build is at `%LOCALAPPDATA%\LocalCanvas\Build-0.1.2\win-unpacked\Local Canvas.exe`.

The application stores boards and original media in `%LOCALAPPDATA%\LocalCanvas\Library`, independently of the source checkout. No account, server, telemetry, external fonts, or network connection is needed. A link opens your default browser only when you activate it.

## Working features

- A scrollable icon strip, centered Create button, custom board icons and colors, floating folders, drag-to-folder organization and ordering.
- Create, search, rename, duplicate, move, export, import, trash and restore boards. Rename or dissolve folders while keeping their boards.
- An infinite GPU canvas with pan, cursor-anchored zoom, fit, selection, moving, resizing, grouping, undo/redo, copy/paste, text, sticky notes, shapes, frames and links.
- Paste or drop images; import local images and MP4/WebM videos. Videos play on demand in a local player.
- Portable editable `.canvas` files containing original media; PNG export of the visible canvas. Sharing means giving someone the exported file, with no online service.
- Frosted floating controls, animated folders/dialogs, keyboard focus handling and reduced-motion support.

## Useful controls

Hold the **right mouse button and drag** to move around the board. A plain right-click opens the canvas menu. Use **V** to select, **H** or hold **Space** to pan, **T** for text, **N** for a note, **R** for a shape, **F** for a frame, **L** for a link, and **0** to fit the board. Use the **mouse wheel** to zoom in and out toward the cursor, **Ctrl+K** to search, **Ctrl+Z / Ctrl+Shift+Z** for undo/redo, and **Ctrl+Enter** to finish editing. Double-click text to edit it. Drag the bottom-right selection handle to resize; images keep their proportions unless Shift is held.

Right-click board and folder icons for their actions. The three-dot menus expose board operations, canvas export, Trash, and the keyboard reference.

## Saving and recovery

Edits are debounced and committed as SQLite transactions in WAL mode with FULL synchronization. The checkmark means the application received a successful save acknowledgment. Closing, switching boards and exporting flush pending edits and media imports. Failed saves retain their operation ID for an idempotent retry. A failed save keeps the window open.

Original media is content-addressed, written durably before it can be referenced by a saved board, and retained even after object deletion. This favors recovery over automatic disk cleanup. Trash is reversible; there is no permanent purge button in this release.

A daily SQLite metadata snapshot is created on startup under `Library\backups`. These snapshots do **not** contain media. For a full manual backup, close the application and copy the **entire Library directory**, including assets. Portable board export is the supported per-board backup and transfer workflow. There is no automatic backup-restore UI yet.

## Current boundaries

- Individual media files: 256 MiB. Portable exports: up to 512 MiB of originals, with a 544 MiB archive/import envelope. Imports validate file structure, asset hashes and object data.
- Imported images display 256px thumbnails or previews up to 1600px. Originals remain intact in storage and portable exports. Full-resolution tiled zoom for enormous images is still on the roadmap.
- Videos use a generic board card and decode only in the player. Playback depends on Chromium's supported codecs; a generated VP9 WebM clip was tested. Animated images currently display a static preview.
- Frames are visual regions. Moving a frame does not automatically move everything visually inside it; group items for joint movement. Nested folders, connectors, freehand ink, rich text, PDF export and editable Miro import are not implemented.
- The canvas is not yet fully screen-reader navigable. Reduced-motion behavior and keyboard-operable controls are implemented, but a full accessibility audit remains open.
- The build is unsigned and has no installer or automatic updater. The large-board startup test is not a certification of sustained 60 FPS, 10,000 distinct high-resolution photos, 4K displays, or long editing sessions.

## Development and verification

Use Node 24.13 or later. Install with `npm ci`, then `npm run dev` for Electron or `npm run preview` for the browser test harness. The browser harness keeps a separate disposable library under `.local-test/browser-library`; it is not the production data location. After changing native image dependencies, restart the dev server.

```
npm test
npm run build
npm run test:desktop
npm audit --omit=dev --audit-level=high
npm run package
```

The packaging command normally writes to `release/win-unpacked`. If OneDrive locks the staging directory, build outside the sync root:

```
npx electron-builder --win dir --config.directories.output=C:/Users/anton/AppData/Local/LocalCanvas/Build-0.1.2
```

In PowerShell, `$env:CANVAS_SCALE='1'; npm run test:desktop` generates a disposable 10,000-object / 1,000-image workload and measures first-canvas startup. `CANVAS_EXECUTABLE` can point to the packaged executable to verify that artifact. Remove those environment variables afterward in an interactive shell.

See [verification notes](docs/verification.md) for evidence and open release gates, and [architecture/design](docs/product-design.md) for the longer-term product direction.
