# Terra Board

A Windows-first local whiteboard with a minimal, iOS-inspired board launcher. Version 0.1.24 is a working preview release; the original product roadmap is broader than this implementation.

**For coding agents:** read [LLM session memory and working guide](LLM_MEMORY.md) for the verified build/test/reopen workflow, delivery preferences, implementation lessons and important limitations.

## Run

To share the app with other people, run `npm run installer` and send `release/installer/Terra-Board-Setup-0.1.24-x64.exe`. This is a standalone Windows x64 installer with the app and its offline resources included. It offers an installation directory and creates Start menu and desktop shortcuts. Installed copies keep each user's boards in `%LOCALAPPDATA%\Terra Board\Library`, outside the installation directory, so upgrading or uninstalling the app preserves the library. No boards or personal settings from this repository are included. The installer is unsigned unless a signing certificate is configured.

The project lives at `D:\Projects\terra`. Double-click `Open Terra Board.cmd` in that folder, or open `D:\Projects\terra\release\win-unpacked\Terra Board.exe`. Keep the executable's support files alongside it.

The application stores boards, original media, settings, browser caches, logs and temporary runtime files in `D:\Projects\terra\Library`. Development and packaged builds share this repository-local library, outside the replaceable `release` directory. `Library` and compiled builds are ignored by Git. Core board editing works offline without an account, server or telemetry. Pasting a web link now fetches its public preview metadata and image; cached previews remain local. YouTube playback requires a connection and contacts YouTube. Ordinary links open the default browser when activated.

## Working features

- A scrollable icon strip, centered Create button, custom board icons and colors, floating folders, drag-to-folder organization and ordering.
- Create, search, rename, duplicate, move, export, import, trash and restore boards. Rename or dissolve folders while keeping their boards.
- An infinite GPU canvas with pan, cursor-anchored zoom, fit, selection, moving, resizing, grouping, undo/redo, copy/paste, text, sticky notes, shapes, frames and links.
- Paste or drop images; import local images and MP4/WebM videos. Double-click an image for a full-window preview at its original resolution, with fit, actual size, zoom, pan and original-file download. Videos play on demand in a local player.
- Upload documents and other files with **Add files**, drag/drop, or paste. PDF, Word, Excel, PowerPoint, Google Workspace exports, TXT, and arbitrary attachments remain local and downloadable. Document cards use the usual selection, movement, resize, rotation, duplicate, and undo controls.
- Open PDFs in a full-window reader with page navigation, fit and zoom. Edit page order, rotate, duplicate, remove, combine PDFs and images, or extract a page. Convert locally between PDF and PNG/JPG, or export selectable PDF text.
- Portable editable `.canvas` files containing original media. Right-click the canvas to export selected items or the visible area as PNG, JPG, or a lossless single-page PDF. Choose Full quality (original image detail, up to 8K / 32 megapixels), 2K, or 4K; presets set the longest edge and preserve proportions. Progress and Open file / Open folder actions appear after saving. Sharing means giving someone the exported file, with no online service.
- Frosted floating controls, animated folders/dialogs, keyboard focus handling and reduced-motion support.
- A soft, wider Windows window shadow, with native title bar and resizing. The extra shadow hides when maximized, snapped or fullscreen.

Pasted web links start as compact title/website cards with an open-link button. A spinner and loading label appear while fetching. Cards expand if a preview image arrives; without an image, available descriptions appear in a short text card and title-only links stay compact. Site icons are cached locally. Reduced-motion settings disable spinner rotation. Missing thumbnails retry automatically when opening a board or reconnecting. YouTube links briefly autoplay muted on the board (the first eight seconds); click **Play with sound**, the central play button or the selection play action for full inline playback. Close the player to return to its cached thumbnail. The external-link action opens YouTube in your browser. Private, offline or metadata-blocking pages retain a basic link card. Preview metadata, site icons and images travel with editable exports.

## Useful controls

Double-click an image, or choose **Full image preview** from its context menu, to open the original image in a full-window viewer. The viewer uses the full-resolution, orientation-correct source rather than the board thumbnail; **Actual image size** shows one image pixel per CSS pixel. Fit, zoom and pan affect only the viewer. **Escape** returns to the board; clicking an existing title or using the **T** action still edits the board title. Downloads retain the original file and filename.

Select a document to show **Download** beside Duplicate, or right-click it and choose **Download**. The **T** title action adds a board label above the card without changing the imported filename. Double-click a document or choose **Preview document** to read it on the board. PDFs have a first-page card preview, page navigation, and reader zoom. DOCX previews show the document's text and layout; pagination may differ from Word. TXT and other supported text files can be edited in place: the checkmark or **Ctrl+Enter** saves, **Escape** cancels. Edits replace only that board item's copy and can be undone; source files on disk and duplicates stay unchanged.

For PDFs, **Full PDF preview** opens the large reader; **Edit PDF** reveals page thumbnails and a compact editing toolbar. Drag thumbnails to reorder them, or use the move buttons / **Alt+Arrow** keys. **Ctrl+Z** and **Ctrl+Shift+Z** undo and redo page changes. Add PDF, PNG and JPG files with the page-plus button or drop them into the reader. **Save copy** adds an edited PDF beside the source. Right-click multiple selected PDFs/images to combine them, or an image to **Convert to PDF**. Closing an unsaved edit offers Save / Discard / Keep editing; app close and board synchronization flush changes to the board copy.

Drop a PDF or a convertible document/image onto a PDF or convertible document card to open an on-board **PDF workspace**. Each input file becomes a column of overlapping page previews. Drop more files into the workspace, drag pages within or between columns, drag a column's grip to reorder files, or add an empty column to split a document. Hover a column to **Export PDF**; this downloads a new PDF copy without changing the originals. Column names control export names. The workspace can be moved, resized, duplicated, copied, undone, and saved in portable boards. Page and column movements animate smoothly; creation, conversion and export show progress, with reduced-motion support. **Alt+Up/Down** moves a focused page, **Alt+Left/Right** moves it between columns; use the column grip with **Alt+Left/Right** to reorder columns.

PDFs and images use their original content. DOCX, TXT and HTML convert locally through the built-in renderer; DOCX pagination can differ from Word. Legacy Word, Excel, PowerPoint, RTF and OpenDocument formats use a local LibreOffice engine, downloaded and verified once when first needed (about 356 MB), then available offline. An existing LibreOffice installation is reused. The converter is extracted alongside Terra's local library without installing Office or changing file associations; source documents are never uploaded. Google Workspace shortcuts do not contain the document itself: import an exported document or spreadsheet instead. A workspace supports up to 500 pages and 64 MB of converted PDF/image sources.

Use the workspace header to switch between stacked and whole sheets, or enlarge/reduce pages. Previews render at the current screen scale for readable zoom. **Ctrl-click** toggles pages, **Shift-click** selects a range, and dragging a selected sheet moves the group. **Delete** or the selection trash button removes sheets. Moving/removing sheets leaves persistent empty slots, including trailing slots; other sheets keep their positions. Drop into a gap to fill it, or onto occupied slots to exchange the affected sheets. Export skips gaps and follows the visible slot order. View, zoom and slots survive undo, reopening and portable export. Bold/Strikethrough are excluded from PDF workspace controls.

The reader's download menu exports PNG/JPG pages (one ZIP for multiple pages), a UTF-8 text file, or the current page as a separate PDF. Image exports render at 144 dpi, bounded to 8192 pixels per edge / 16 megapixels; text export requires selectable text and does not perform OCR. Page edits use bundled [pdf-lib](https://pdf-lib.js.org/) in a cancellable local worker. The workspace accepts up to 64 MiB of sources and 500 pages, with a 128 MiB conversion output limit. Saved copies preserve page content rather than rasterizing PDFs; form fields become static, and document-level bookmarks, signatures and attachments are not copied. Password-protected and dynamic XFA files need an unlocked/static export before editing. Original attachments remain unchanged.

PDF and DOCX previews use bundled [PDF.js](https://mozilla.github.io/pdf.js/) and [docx-preview](https://github.com/VolodymyrBaydalka/docxjs), with no online conversion service. On-board PDF/DOCX previews are limited to 32 MiB (the full PDF workspace accepts 64 MiB), and text editing to 2 MiB (UTF-8 or UTF-16, preserving BOM and newline format). Larger, protected, damaged, or unsupported files remain downloadable. Excel, old `.doc`, and other formats currently show attachment cards. Google Docs/Sheets/Slides exports work in their exported format; `.gdoc`, `.gsheet`, and `.gslides` shortcuts contain a cloud reference rather than an offline document.

Resize a list from a corner to scale its text, checkboxes, and spacing together. List editing and new rows keep the chosen scale.

Press **F11** to toggle full screen, or choose **Full screen** from the library's three-dot menu. Press **Escape** or choose **Exit full screen** to return to the previous window size. Leaving full screen with Escape keeps an active text edit open.

Select an image and press **Ctrl+C**, or right-click it and choose **Copy as image**, to paste it into another app at its original pixel resolution. Crops and rotation are applied to the source image, independent of canvas size or zoom. The Windows clipboard includes an image and a lossless PNG file (including transparency); apps choose the format they support. Pasting back into Terra keeps the editable image, its title, crop and rotation. Ordinary text copying still works inside editors. Generated PNGs are cached under `Library/temp/clipboard` so copied files remain available after closing Terra.

Choose **+ Insert > Gallery** in the canvas toolbar to collect screenshots in a matrix. **Below** runs a journey vertically with alternatives beside each step; **Right** runs it horizontally with alternatives underneath. Hover an image to reveal right/below arrow targets, then move over a target and press **Ctrl+V** or drop image files there. Inserting along the journey creates a row or column; inserting across it shifts only that step's later alternatives. Images keep their proportions and consistent spacing. Changing direction transposes the matrix. Ordinary image pastes are centered at the mouse cursor, even when a gallery is selected; hover an insertion target to add them to the gallery. For an empty gallery, hover its "Paste images here" area to add the first image.

Click the gallery name to edit it; Enter saves and Escape cancels. Drag its name to move all its images together. Resize across the layout to change image size. Clicking outside returns to ordinary pasting. Copy, duplicate, or delete a selected gallery includes its images; undo restores the whole operation. Drag an image outside to release it, or right-click the gallery and choose **Release images** to remove only the container. Existing one-dimensional galleries work with the new hover targets.

Hold the **right mouse button and drag** to move around the board. A plain right-click opens the canvas menu. Use **V** to select, **H** or hold **Space** to pan, **T** for text, **N** for a note, **R** for a shape, **A** for an arrow, **F** for a frame, **L** for a link, and **0** to fit the board. Use the **mouse wheel** to zoom in and out toward the cursor, **Ctrl+K** to search, **Ctrl+Z / Ctrl+Shift+Z** for undo/redo, and **Ctrl+Enter** to finish editing. Double-click text to edit it. Drag any of the four selection corners to resize. Plain text scales its font and box together, keeping the opposite corner fixed; images keep their proportions unless Shift is held. Selection actions stay beside the selected object or group and follow movement, pan and zoom.

Right-click board and folder icons for their actions. The three-dot menus expose board operations, canvas export, Trash, and the keyboard reference.

Mouse-wheel zoom eases smoothly around the cursor with smaller steps (about 10% for a typical 100-pixel wheel event). Reversing direction responds immediately; starting a drag stops the remaining zoom motion. Reduced-motion settings keep the gentler steps without animation.

Drop an image file directly onto a board icon in the sidebar or inside a folder to open its crop editor. In **Change icon**, you can also choose **Upload image** or drop an image into the dialog. Drag the crop preview to position the image and use **Zoom** to crop closer; arrow keys also reposition it. **Save** applies the square crop, while **Cancel** keeps the previous icon. PNG, JPEG, WebP, GIF, AVIF, TIFF and ICO use the local image pipeline (animated files use a static image). Uploaded icons are included when duplicating or exporting boards. Select a built-in symbol to switch back.

Drag any empty space in the board panel toward the left, right, top or bottom window edge. A translucent preview marks the destination; release to glide into place. Top and bottom placements use a horizontal strip. Escape or releasing away from an edge returns the panel to its original position. Placement is remembered on this computer. Board icons still drag into folders or into a new order; the mouse wheel scrolls a horizontal strip.

The Create **+** is always the last item after the boards and folders, and scrolls with them. There is no divider before it; library options stay at the far edge.

Double-click a board name, folder name, or canvas title to rename it directly where it appears. Enter saves a name, Escape cancels; canvas text uses Ctrl+Enter to save. Local video titles also edit in place; use the selection toolbar to play a video. Notes keep their dimensions and automatically shrink long text to fit, expanding the text back toward its chosen size as content is removed.

The selection outline, handles and nearby actions remain visible during text editing. Plain-text boxes initially fit their content with a small margin and resize as you type; Enter adds a new line. Drag a middle edge handle to change only the box width or height without scaling its font. Manually sized text boxes keep those dimensions and wrap text, including after reopening the board. Notes continue to shrink their text to fit. Clicking away from empty or whitespace-only plain text removes it; Ctrl+Z restores deleted content. Empty notes, frames and shapes remain on the board.

Drag the curved-arrow handle just outside the lower-left corner of a selected object to rotate it; the angle appears beside the handle while dragging. Hold Shift for 15° steps, or press Escape to cancel the gesture. Resize handles follow the rotated edges, and images can still be cropped in place after rotating. Each resize or rotation is one undo step.

Click a text-bearing object once to select it; click it again to edit, with no double-click timing required. This includes plain text, notes, shapes, frames and local video titles. The cursor starts at the end, with no text selected, and the selection toolbar has no pencil button. Dragging still moves objects, corner dragging resizes them, and modifier clicks or clicks within a multi-selection keep their selection behavior. Board and folder name editors also place the cursor at the end.

Use **Center horizontally** and **Center vertically** beside the selection/group actions to toggle text alignment independently. Each button highlights when enabled; toggle it off to return to left or top alignment. They work while editing or across selected text-bearing objects, and alignment survives copying, exporting and reopening. The controls are hidden when no selected object supports text alignment. The color palette includes black; its multicolor **+** swatch opens a custom color picker.

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


Arrows: choose **Arrow (A)** and drag between two points. Drag an endpoint to reposition it; drag a small dot along the path to insert a bend. Double-click an interior bend to remove it. The selection toolbar provides straight, curved and elbow paths, solid/dashed/dotted strokes, thickness, color, independent start/end markers, a swap action and a text label. Labels save on Enter, blur or app close; Escape cancels the label draft. Arrows move and scale with selections and frames, and retain their shape through undo, clipboard, reopening and board export/import. Endpoints are freely positioned; they do not automatically attach to other objects.
