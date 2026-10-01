# Local Canvas

A Windows-first local whiteboard with a minimal, iOS-inspired board launcher. Version 0.1.24 is a working preview release; the original product roadmap is broader than this implementation.

## Run

The project lives at `D:\Projects\terra`. Double-click `Open Local Canvas.cmd` in that folder, or open `D:\Projects\terra\release\win-unpacked\Local Canvas.exe`. Keep the executable's support files alongside it.

The application stores boards, original media, settings, browser caches, logs and temporary runtime files in `D:\Projects\terra\Library`. Development and packaged builds share this repository-local library, outside the replaceable `release` directory. `Library` and compiled builds are ignored by Git. Core board editing works offline without an account, server or telemetry. Pasting a web link now fetches its public preview metadata and image; cached previews remain local. YouTube playback requires a connection and contacts YouTube. Ordinary links open the default browser when activated.

## Working features

- A scrollable icon strip, centered Create button, custom board icons and colors, floating folders, drag-to-folder organization and ordering.
- Create, search, rename, duplicate, move, export, import, trash and restore boards. Rename or dissolve folders while keeping their boards.
- An infinite GPU canvas with pan, cursor-anchored zoom, fit, selection, moving, resizing, grouping, undo/redo, copy/paste, text, sticky notes, shapes, frames and links.
- Paste or drop images; import local images and MP4/WebM videos. Videos play on demand in a local player.
- Portable editable `.canvas` files containing original media; PNG export of the visible canvas. Sharing means giving someone the exported file, with no online service.
- Frosted floating controls, animated folders/dialogs, keyboard focus handling and reduced-motion support.
- A soft, wider Windows window shadow, with native title bar and resizing. The extra shadow hides when maximized, snapped or fullscreen.

Pasted web links start as compact title/website cards with an open-link button. A spinner and loading label appear while fetching. Cards expand if a preview image arrives; without an image, available descriptions appear in a short text card and title-only links stay compact. Site icons are cached locally. Reduced-motion settings disable spinner rotation. Missing thumbnails retry automatically when opening a board or reconnecting. YouTube links briefly autoplay muted on the board (the first eight seconds); click **Play with sound**, the central play button or the selection play action for full inline playback. Close the player to return to its cached thumbnail. The external-link action opens YouTube in your browser. Private, offline or metadata-blocking pages retain a basic link card. Preview metadata, site icons and images travel with editable exports.

## Useful controls

Hold the **right mouse button and drag** to move around the board. A plain right-click opens the canvas menu. Use **V** to select, **H** or hold **Space** to pan, **T** for text, **N** for a note, **R** for a shape, **F** for a frame, **L** for a link, and **0** to fit the board. Use the **mouse wheel** to zoom in and out toward the cursor, **Ctrl+K** to search, **Ctrl+Z / Ctrl+Shift+Z** for undo/redo, and **Ctrl+Enter** to finish editing. Double-click text to edit it. Drag any of the four selection corners to resize. Plain text scales its font and box together, keeping the opposite corner fixed; images keep their proportions unless Shift is held. Selection actions stay beside the selected object or group and follow movement, pan and zoom.

Right-click board and folder icons for their actions. The three-dot menus expose board operations, canvas export, Trash, and the keyboard reference.

Drag any empty space in the board panel toward the left, right, top or bottom window edge. A translucent preview marks the destination; release to glide into place. Top and bottom placements use a horizontal strip. Escape or releasing away from an edge returns the panel to its original position. Placement is remembered on this computer. Board icons still drag into folders or into a new order; the mouse wheel scrolls a horizontal strip.

Double-click a board name, folder name, or canvas title to rename it directly where it appears. Enter saves a name, Escape cancels; canvas text uses Ctrl+Enter to save. Local video titles also edit in place; use the selection toolbar to play a video. Notes keep their dimensions and automatically shrink long text to fit, expanding the text back toward its chosen size as content is removed.

The selection outline, handles and nearby actions remain visible during text editing. Plain-text boxes initially fit their content with a small margin and resize as you type; Enter adds a new line. Drag a middle edge handle to change only the box width or height without scaling its font. Manually sized text boxes keep those dimensions and wrap text, including after reopening the board. Notes continue to shrink their text to fit. Clicking away from empty or whitespace-only plain text removes it; Ctrl+Z restores deleted content. Empty notes, frames and shapes remain on the board.

Drag the curved-arrow handle just outside the lower-left corner of a selected object to rotate it; the angle appears beside the handle while dragging. Hold Shift for 15° steps, or press Escape to cancel the gesture. Resize handles follow the rotated edges, and images can still be cropped in place after rotating. Each resize or rotation is one undo step.

Click a text-bearing object once to select it; click it again to edit, with no double-click timing required. This includes plain text, notes, shapes, frames and local video titles. The cursor starts at the end, with no text selected, and the selection toolbar has no pencil button. Dragging still moves objects, corner dragging resizes them, and modifier clicks or clicks within a multi-selection keep their selection behavior. Board and folder name editors also place the cursor at the end.

Use **Center horizontally** and **Center vertically** beside the selection/group actions to toggle text alignment independently. Each button highlights when enabled; toggle it off to return to left or top alignment. They work while editing or across selected text-bearing objects, and alignment survives copying, exporting and reopening. Image-only selections disable both buttons.

Drag a selection rectangle around multiple objects, then drag any selected object or the gap between them to move the whole selection. Copy, paste, duplicate, Delete and undo act on the complete selection. Shift/Ctrl-click toggles individual objects; Shift-drag adds a rectangle of objects and Ctrl-drag toggles them.

Frames are opaque bright white rectangles with their name above the top-left edge. Click the name once to rename it in place; Enter saves, Escape cancels, and dragging the name moves the frame. Names remain outside when zooming, resizing or rotating. Frame names stay left-aligned, and frames do not use the shape-color or text-centering controls.

Right-click an image and choose **Crop image**. Drag an edge/corner to crop, or drag inside the crop area to reposition it, then click **Apply** (or press Enter). **Cancel** / Escape discards the draft; **Reset** restores the full source. The original file is preserved, crops survive copy/export/reopen, and Ctrl+Z undoes a crop.

## Saving and recovery

Edits are debounced and committed as SQLite transactions in WAL mode with FULL synchronization. The checkmark means the application received a successful save acknowledgment. Closing, switching boards and exporting flush pending edits and media imports. Failed saves retain their operation ID for an idempotent retry. A failed save keeps the window open.

Original media is content-addressed, written durably before it can be referenced by a saved board, and retained even after object deletion. This favors recovery over automatic disk cleanup. Trash is reversible; there is no permanent purge button in this release.

A daily SQLite metadata snapshot is created on startup under `Library\backups`. These snapshots do **not** contain media. For a full manual backup, close the application and copy the **entire Library directory**, including assets. Portable board export is the supported per-board backup and transfer workflow. There is no automatic backup-restore UI yet.

## Current boundaries

- Individual media files: 256 MiB. Portable exports: up to 512 MiB of originals, with a 544 MiB archive/import envelope. Imports validate file structure, asset hashes and object data.
- Imported images use thumbnails and previews when distant, then load visible detail tiles from the original at close zoom. Detail tiles are at most 512px, image decoding has four concurrent requests, and the image texture cache stays within 192 MiB. Photos retain their source resolution; zooming cannot invent missing image detail. Originals remain intact in storage and portable exports.
- Text is redrawn from font outlines at the current zoom and display density, using textures bounded by the viewport. Double-click to type directly at the text's position; click the board or press Ctrl+Enter to save, or Escape to cancel. Shapes retain vector geometry in the GPU renderer.
- Videos use a generic board card and decode only in the player. Playback depends on Chromium's supported codecs; a generated VP9 WebM clip was tested. Animated images currently display a static preview.
- Dragging a frame carries all objects fully inside its border, including nested frames. Membership follows placement: move an object out to release it. Contents are captured at drag start, and the whole move undoes in one step. Resizing or rotating a frame changes the region without transforming its contents. Nested folders, connectors, freehand ink, rich text, PDF export and editable Miro import are not implemented.
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

The packaging command writes to `release/win-unpacked` inside the repository. Keep this layout so direct executable launches find the repository's `Library` folder. Build and run from `D:\Projects\terra`; do not use AppData or OneDrive as project, build or library destinations.

In PowerShell, `$env:CANVAS_SCALE='1'; npm run test:desktop` generates a disposable 10,000-object / 1,000-image workload and measures first-canvas startup. `CANVAS_EXECUTABLE` can point to the packaged executable to verify that artifact. Remove those environment variables afterward in an interactive shell.

See [verification notes](docs/verification.md) for evidence and open release gates, and [architecture/design](docs/product-design.md) for the longer-term product direction.
