# Verification — Terra Board

## Compact liquid-glass radial menu — 2026-10-20

The quick-tools wheel is a fixed 280 px ring centered on the cursor (nudged inward near window edges), with no scrim, no hub circle and no "Quick tools" caption. It is just seven separate tool tiles plus the settings button, which sits in the empty bottom gap. Each tile is its own clipped `glass-surface` layer, so it blurs the board like the toolbar does. The wheel has no `filter`, because a filter would cut the blur off from the board. Hover and keyboard focus tint only the tile underneath (no button rectangle or outline), and a click anywhere on a tile picks it.

- `npx tsc --noEmit`: passed.
- Packaged build: `scripts/desktop-radial.mjs` passed all flows, including the new assertions (centered on the cursor, 280 px, transparent backdrop) and light/dark screenshots.

## Centered release-to-select radial menu — 2026-10-19

The quick-tools wheel no longer opens at the cursor: it appears centered over the board, scaled to about 85% of the window's smaller dimension (CSS `zoom` keeps text crisp), over a light theme-tinted scrim. Moving the pointer onto a sector only highlights it; the highlighted tool is chosen when the trigger key (Tab by default) is **released**, so nothing is selected just because the cursor crossed a sector. A quick tap keeps the wheel open for click or keyboard selection, and highlighting arms only after the pointer moves, so releasing without moving never picks the sector under the stale cursor. Objects are still anchored at the cursor position where the wheel was invoked. The shortcut was renamed from "Quick tools at cursor" to "Quick tools wheel" and the settings subtitle updated.

- `npx tsc --noEmit`: passed. `tests/radial-layout.test.mjs` and `tests/preferences.test.mjs`: 5 passed.
- `scripts/desktop-radial.mjs` (source build) passed with reworked flows: centered near-fullscreen wheel, hover highlights without selecting, release-to-select, tap keeps the wheel open for clicks, anchor preservation (including from a screen edge), hover preview, click commit, undo/redo, cancel, settings corridor on release, customization, reload persistence, anchored list, editing Tab, light/dark, keyboard selection, Shift/Ctrl-constrained arrows, endpoint alignment. Two stale script assertions were also fixed (the radial layout now lives in `terra-board.preferences`, and the text editor is a rich contenteditable field), and startup waits were extended to 60 s for cold source launches.

## Canvas rendering performance — 2026-10-11

Text layouts are no longer evicted by per-zoom frame titles or by typing; a note's previous fitted size is verified before searching again; text raster regions stay stable while panning; sharper text and frame titles are rebuilt within a per-frame budget; image variants decode off the main thread and reach the GPU a bounded amount per frame; night shadows share one blur pass. No object data, storage or export format changed.

- `npm test`: **363 passed, 0 failed**. New cases cover layout survival across an animated zoom and a long edit, warm fitting equal to a full search, stable and bounded raster regions, staged texture uploads, released bitmaps and the single shadow blur. Five of the six new layout/region cases fail on the previous code.
- `npm run package`: passed, including TypeScript. Packaged startup smoke passed.
- Packaged checks passed on this build: `desktop-check`, `desktop-text-zoom`, `desktop-zoom-flicker` (its decode hold now wraps `fetch`), `desktop-night-mode`, `desktop-export`, `desktop-pdf-composer`. `desktop-lists` passed 6 of 8 runs; the two failures were the hidden test window pausing frames (the saved library and failure screenshot contained the expected second list) and a startup attach race. `desktop-text-formatting` and `desktop-interactions` stop at the same early step on the previous build as well, so they did not exercise this change.
- Measured in a hidden 3819×2033 window at 144 Hz, dark theme with night glow, on disposable boards shaped like real ones (about 90 objects; notes of 900–2,000 characters), two runs each. Note board: wheel zoom 56 → 127 fps with the longest frame 753 → 71 ms; zoom into a note and back 123 → 142 fps; pan 136 → 142 fps; typing in a 2,000-character note 21.0 → 6.7 ms of main-thread work per key. Image/list board: wheel zoom 108 → 136 fps (23% → 4% of frames missed); pan stays at 144 fps with about a quarter of the previous GPU-thread work.
- Screenshots of the previous and new renderer at the same camera states differ by at most 3/255 per channel, except sub-pixel anti-aliasing on text of objects cut by the viewport edge, which now rasterise exactly as when fully visible. Typed notes fit to the identical font size, line height and wrap width. A transparent cutout over shapes, a cropped rotated photo and deep-zoom detail tiles matched within 2/255.

These are machine-specific measurements, not guarantees. The first layout of a long note still costs about 10 ms, so first opening a note-heavy board takes roughly half a second and new notes entering the view can produce 30–70 ms frames. Boards of thousands of objects were not optimised: at 2,000 objects wheel zoom ran at about 61 fps and dragging everything at once at about 64 fps.

## PDF workspace as a paper table — 2026-10-05

The workspace now has stacked/whole-sheet views, page zoom, Ctrl/Shift multi-selection and group dragging. Persistent page rows and column slot counts preserve holes after moving or deleting sheets. Occupied destinations exchange only affected sheets; other slots stay fixed. Export omits empty slots. Existing boards without row metadata retain their previous order. View/zoom/slots pass through storage, clipboard and MCP schemas. The generic frame Bold/Strikethrough controls no longer appear on PDF workspaces.

- `npm test`: **323 passed, 0 failed**, including fixed-slot exchange, group ordering, trailing gaps, invalid coordinates and stored/MCP/clipboard settings.
- `npm run package`: passed, including TypeScript. Package integrity check passed for all **11,694** entries and exact Electron/renderer bytes.
- `CANVAS_COMPOSER_TABLE=1 node scripts/desktop-pdf-composer.mjs`: passed in `.local-test/desktop-pdf-composer-RM5x50`, with zero renderer exceptions. Native controls/pointer input verified non-overlapping whole sheets, stacked mode, increased canvas pixel resolution on zoom, Ctrl selection, Shift ranges, group motion, persistent source holes, single-sheet deletion, gap filling, one-step undo/redo, exact PDF downloads, original-byte preservation, reload and portable roundtrip. Whole-page, zoom and settled dark gap screenshots were inspected.
- The full composer regression also passed in `.local-test/desktop-pdf-composer-xmNxFX`: native file addition, rejected batches, page/column movement, reduced motion, export order/rotation, DOCX/TXT/HTML conversion and persistence. Office conversion code is unchanged from the previous verified build.

Preview resolution is bounded to 2048 pixels wide / 4 million pixels per visible sheet; exported PDFs retain their original page content. All checks used disposable libraries, leaving the user's boards untouched.

## On-board PDF composer and document conversion — 2026-10-04

Dropping convertible documents onto another document creates a persistent frame with one column per source and overlapping page previews. Pages move within and across columns, column grips reorder files, and each hovered or focused column exports an independent PDF copy. Originals remain unchanged. Creation, conversion, previews and export have loading states; page/column moves use interruptible animations and honor reduced motion.

- `npm test`: **321 passed, 0 failed**. Coverage includes metadata validation, nested portable assets, clipboard, immutable page/column edits, source limits, drop targeting, frame hit testing, document conversion, sandboxed printing and UI motion contracts.
- `npm run package`: passed. `node scripts/package-content-check.mjs` verified **11,694** ASAR integrity hashes, current Electron/renderer bytes, valid manifest and exclusion of the personal Library. Source files were frozen during packaging.
- `node scripts/desktop-pdf-composer.mjs`: passed in `.local-test/desktop-pdf-composer-jHzGea`, with **zero renderer exceptions**. Native pointer input covered PDF-on-PDF creation, independent frame movement, PDF/image drops, invalid-batch atomicity, page/column sorting, cross-column moves, empty columns and undo/redo. The check verified active layout animations and their reduced-motion suppression, creation/conversion progress, preview rendering, native downloads and cancellation, exact exported page content/order/rotation, reload and composer-only portable roundtrip. Light/dark and conversion-progress screenshots were inspected.
- Native DOCX/TXT/HTML and legacy DOC/XLS/PPT drops converted and exported successfully in the same packaged run, retaining original bytes, expected Unicode/text and page counts. The built-in printer also passed an actual Electron check with scripts disabled and zero external requests.
- The Office engine download, pinned SHA-256 verification and administrative extraction succeeded in a disposable library. `scripts/office-converter-check.mjs` subsequently passed using that runtime in `.local-test/office-check-vvULiw`: real DOC/XLS/PPT conversion, original-byte preservation, job cleanup and **zero linked-image HTTP requests**.
- The existing full PDF editor/image viewer regression passed in `.local-test/desktop-pdf-workspace-j9sMoI`, with zero renderer exceptions, including original-resolution PNG/TIFF, exported bytes and native-close saving.
- `npm run installer`: passed. The refreshed 0.1.24 x64 installer is **363,039,796 bytes**; its unpacked payload independently passed the same 11,694-entry integrity/source check and excludes the personal Library. Office runtime files remain outside the distribution. The installer configuration is unchanged from the installation/reinstallation/uninstallation audit below.

The Windows x64 Office engine downloads once into the local library (or reuses installed LibreOffice); it is not bundled in the installer and documents are not uploaded. DOCX pagination can differ from Word. Google Workspace shortcut files require an exported document. Native save-dialog choices are stubbed only in the isolated harness; production IPC writes the actual PDFs. All automated mutations used disposable libraries.

## Shareable Windows installer — 2026-10-04

`npm run installer` builds the current app into a standalone Windows x64 NSIS installer in `release/installer`, separate from the repository-local executable. Only this distribution has `terraDistribution: installed` in its packaged metadata. It uses `%LOCALAPPDATA%\Terra Board\Library` for each user's data; the ordinary development/repository package retains its existing library path. Explicit `CANVAS_DATA_DIR` overrides both. The installer offers a destination folder and shortcuts, and does not remove saved boards on uninstall.

- `npm test`: **285 passed, 0 failed**, including new installed-path/invalid-path coverage and the existing repository-local path regression.
- `npm run installer`: passed. `Terra-Board-Setup-0.1.24-x64.exe` is **363,021,034 bytes**, including offline PDF, document, image and background-removal resources. Authenticode reports **NotSigned**; no signing certificate was configured.
- `node scripts/installer-check.mjs`: passed in `.local-test/installer-7ZVTGk`. The actual installer was run silently into a disposable path containing spaces. It created the Start menu shortcut and registered the app. The installed payload matches the current main/storage source and renderer entry point, carries the distribution marker, and excludes personal library/database/portable-board files.
- Three installed-app startup checks passed: the default per-user path, reinstalling with a saved board, and an explicit isolated library override. All runtime paths remained within their intended libraries. Actual uninstall removed the executable, shortcut and registration while retaining the saved board. The test cleaned its installer cache and left the repository Library untouched.

This verifies installation on the current Windows machine, including native installer/uninstaller execution; it does not claim a clean virtual-machine or interactive wizard audit. The check refuses existing Terra Board installations, running processes and conflicting shortcuts/cache files before making changes.

## PDF workspace and original-resolution image viewer — 2026-10-04

PDFs have a full-window reader and a page editor with thumbnail reordering, move/rotate/duplicate/remove, undo/redo, PDF/image merging, page extraction, and local PDF ↔ PNG/JPG / PDF → text conversion. Page editing runs in a disposable pdf-lib worker; a shared PDF.js worker renders workspace previews. Save copy creates a sibling attachment and leaves the original untouched. Double-clicking an image body opens its full-resolution, orientation-correct source with fit, actual size, zoom, pan and original download. Existing image title clicks, the T action and the title context action retain inline editing.

- `npm test`: **283 passed, 0 failed**. Added coverage includes page order/rotation, PDF forms and crop boxes, encrypted/malformed inputs, worker transfer/cancellation/timeout, bounded rendering and ZIP output, selectable text, shared preview workers, image zoom/pan bounds, and image body/title activation. The title-click regression was reproduced before its fix.
- `npm run package`: passed, including TypeScript and production compilation. Packaged renderer entry/assets, PDF workers and main/preload/store files match the tested source/build byte for byte; bundled pdf-lib is 1.17.1.
- `node scripts/desktop-pdf-workspace.mjs`: passed in `.local-test/desktop-pdf-workspace-ieuP1e`, with **zero renderer exceptions**. Real pointer/keyboard input exercised full preview, navigation, zoom/fit, thumbnail dragging, page actions, undo/redo, adding PDF/PNG/JPG pages, and atomic rejection of a malformed import batch.
- Downloaded TXT, PNG/JPG ZIPs and extracted PDFs match the edited page order and rotation. Saved copies preserve vector page content; originals retain exact bytes. Dotted filenames, cancelled native downloads, cancellation during a delayed asset import, renderer reload, MCP synchronization, modal keyboard isolation and native app-close saving of an unsaved PDF draft passed.
- Real image-body double clicks opened the viewer, while single body clicks selected and existing-title clicks edited. PNG and TIFF previews retained all **2560×1600** decoded RGBA pixels; original downloads matched exact file bytes and filenames. Actual-size rendering, fit, zoom, native pointer pan, window resizing, Escape/Close, selection preservation, T/context title editing and a failed-preview download fallback passed. Light/dark image and PDF screenshots were inspected.
- The existing `scripts/desktop-documents.mjs` regression suite also passed in `.local-test/desktop-documents-QwMtkC` before the image-viewer addition: document downloads, PDF/DOCX previews, TXT edits, proportional lists, clipboard, persistence and portable assets, with zero renderer exceptions.

All mutations used disposable repository-local libraries. The harness waits for theme transitions to stop intercepting canvas clicks. Native picker choices are stubbed only inside its own test process; production IPC performs the actual file writes. Image previews use a full-resolution lossless PNG for browser-incompatible originals, while downloads keep the original format. PDF text conversion requires selectable text and does not perform OCR; form fields become static in edited copies, and document-level bookmarks, signatures and attachments are not copied. Protected/dynamic XFA files require an unlocked/static export.

## Documents and proportional lists — 2026-10-04

Document cards preserve their original filename separately from the board title. PDF, DOCX, editable UTF-8/UTF-16 text, and generic attachments use the local immutable asset store; PDF.js and docx-preview are bundled for local previews. Excel, legacy Word and Google Workspace shortcut files remain downloadable attachments. Text edits replace only the edited object's asset reference and support undo. List resizing scales text, checkboxes and spacing, while preserving previously stretched lists.

- `npm test`: **247 passed, 0 failed**. Covers byte fidelity, empty files, document/media hash collisions, portable transfer, search/MCP/clipboard fields, safe downloads, bounded/cancellable previews, Unicode encoding, title/body concurrency, preview hydration through gestures/history, proportional lists and legacy list layout/export.
- `npm run package`: passed, including TypeScript and production build. PDF worker, CMaps, fonts and codecs ship inside the package.
- `node scripts/desktop-documents.mjs`: passed in `.local-test/desktop-documents-3saYCw`, with **zero renderer exceptions**. Real Chromium file drops and pointer/keyboard input exercised selection, separate titles, four resize corners, zoomed resizing, native clipboard, duplicate, undo/redo, TXT edits, simultaneous title/body saves, and a deliberately delayed save followed by another reader request.
- The packaged check navigated a two-page PDF and verified page pixels, checked DOCX iframe content, empty TXT, damaged PDF fallback, and generic Excel/Google shortcut/binary attachments. Ribbon and context downloads produced exact bytes and original filenames. The native save-dialog choice was stubbed only in the disposable test process; the production IPC handler performed the filesystem writes.
- Scaled lists retained interactive checkboxes, editable text and proportional new-row height. A legacy 640×188 list kept both rows visible without geometry changes; both rows were verified in a real 4096×1221 PNG export. Renderer reload, board reopening and portable originals/preview assets passed. PDF, DOCX and scaled-list screenshots were inspected.

The document check waits for the intended board and visible, stable controls. Its non-unit-zoom resize check uses the actual zoom buttons; it does not claim to re-audit wheel animation. All mutations used disposable repository-local libraries.

## MCP concurrency and quiet view persistence — 2026-10-04

Camera movement previously entered the content save queue, changed the board revision and updated the modified timestamp. It now uses a separate queue retaining one latest view, debounced for 1.2 seconds and flushed on board switch/close. Its SQLite update touches only the camera column; it does not change object rows, revision, modified time, or the content save indicator.

Object revision tracking now merges independent stale edits atomically. Changes or deletions to a target object still reject the complete conflicting request and identify the object IDs. Deleted-object history survives restart and is pruned with a 500-revision merge window. Existing libraries require a fresh read before their first tracked edit. SQLite schema version 2 prevents older app versions from writing without updating this history.

- `npm test`: **197 passed, 0 failed**. Includes independent merges, overlapping edits/deletions, atomic failure, reopen, history pruning, legacy history, retries, and camera coalescing/flush.
- Production build and `electron-builder --win dir --config.directories.output=.local-test/mcp-candidate` passed. Candidate packaged main/storage/worker/MCP files and renderer index matched source/build. Packaged smoke passed.
- Packaged `scripts/desktop-mcp.mjs` passed in `.local-test/desktop-input-WFR5lI`: HTTP and Claude stdio; quiet real wheel zoom without revision/timestamp/content changes or save-indicator transitions; user typing after the AI read preserved alongside an independent AI edit; overlapping deletion rejected; draft synchronization, undo/redo, media import/read, board settings/create/open, gallery copy, duplicate/trash/restore, folders and disabling access. No renderer exceptions.
- The audit's obsolete Settings entry was updated for the current contextual menu; controls are scrolled into view. The audit also reproduced and fixed Ctrl+K opening board search from Settings. Reload checks now await the new renderer document before testing readiness.
- A disposable 20,000-object SQLite board received 10,000 camera events: **one persistence call, one SQLite row update, unchanged content revision**, 78.7 ms for enqueueing and persistence. This isolates view persistence, not complete frame-rendering cost. A two-second packaged idle sample measured 1.30% renderer task time and 8.79 MiB JavaScript heap; this excludes native/GPU/process memory and is not a whole-app benchmark.
- Claude Desktop's actual Microsoft Store configuration was tested before and after replacement: **11 tools, 15 boards, no connector stderr or tool errors**. No connection failure was reproduced. The HTTP connection also worked after restart. Mutation audits used disposable libraries.
- Terra was closed through its normal save-and-exit path, the verified candidate promoted to `release/win-unpacked`, and the normal app reopened. Previous package: `release/win-unpacked-before-mcp-20261004`; pre-upgrade metadata backup: `Library/backups/before-concurrent-edits-20261004.sqlite`. Installed library schema is 2; `PRAGMA quick_check` returned `ok`.

The short renderer synchronization barrier during each MCP call remains. Concurrent changes to the same object require the assistant to read it again and reconcile the edit; they are not silently overwritten. Overall CPU and native memory use across large image/video boards was not comprehensively profiled in this change.

## MCP capability audit — 2026-10-02

The MCP editing schema was missing the gallery fields already supported by the canvas and storage. Reading a gallery and sending its complete objects back to `edit_board` failed with unrecognized-key errors. The schema now accepts gallery settings and image membership/cell fields with the same numeric limits as storage. A regression reproduced the failure before the fix and now verifies edits, image copies, invalid inputs and persisted fields after reopening.

- `npm test`: **172 passed, 0 failed**. MCP integration coverage includes all board colors, built-in/emoji/image icons, icon shape, initial visibility, rename, folder moves, ordering, trash/restore, media imports, pagination, stale revisions and authentication.
- `npm run package` passed. Packaged MCP files, storage and renderer entry point match the tested source/build. The package contains SDK **1.31.0**, matching the current npm release of `@modelcontextprotocol/sdk`. Upstream also offers the separate v2 SDK line; no major-version migration was performed.
- Expanded packaged `scripts/desktop-mcp.mjs` passed in `.local-test/desktop-input-tCqhJO`: HTTP and stdio, creating/opening boards, all board settings, imported/custom icons, gallery image copies, duplicate/trash/restore, folders, unsaved draft synchronization, undo/redo and disabling access. No renderer exceptions. Visually inspected `mcp-created-board.png` showing both images and the custom circle icon.
- Packaged icon checks passed in `.local-test/desktop-input-xwLyVv`: file drop, crop/zoom, shape/color/initial, emoji/symbol selection, cancellation and portable icons. The crop screenshot was visually inspected.
- Packaged native clipboard checks passed in `.local-test/clipboard-QH5g8O`: original image pixels read by another process, Ctrl+C, Copy as image, crop/rotation, editable round trips, ordinary text copy and paste-time cursor placement.
- Reopened the normal app and verified 11 tools and the updated gallery schema through both live HTTP and a fresh packaged stdio connection. Real-library checks were read-only; all mutation tests used disposable repository-local libraries. MCP reads board objects and previews individual assets; it has no dedicated whole-board screenshot or open-board tool, so opening and visual inspection were tested through the desktop UI.

## Export quality presets — 2026-10-02

Export resolution now offers Full quality (default), 2K (2048 px longest edge), and 4K (4096 px). Full quality derives pixel density from original image dimensions and normalized crops, with at least 2x rendering and a 4K floor for text/shape-only content. All modes rerender objects at the chosen resolution, retaining proportions and the 8192-edge / 32-million-pixel bounds. The toast reports actual dimensions and any size limiting. JPG uses maximum encoder quality. PDF now embeds losslessly compressed RGB pixels, while keeping physical page size independent of resolution. Unsupported browser image formats use a cached, lossless, orientation-correct PNG of the original rather than the 1600px WebP preview. A previous success toast is hidden while the format dialog is open so it cannot cover format buttons.

All 167 Node tests and the production build passed. Desktop export checks passed in `.local-test/export-jO8CtU`, covering six scope/format combinations at 2K, a 4K selection, and a small rotated/cropped on-board image exported at 4402 × 3874 pixels using its original density. PDF decoded RGB matches separate PNG renders within one level of GPU edge rounding; a direct encoder test proves exact pixel retention. TIFF fallback retains all 2400 × 1200 original pixels. Cancellation, progress, offscreen selections and open actions still pass. The new dialog was visually inspected, and Poppler successfully rendered the lossless PDF with unchanged page dimensions.

Windows packaging and packaged startup smoke also passed. The archived main/preload/store files and renderer assets match the verified source build byte for byte.

## Selected and visible-area image/PDF exports — 2026-10-02

The canvas menu exports either the selection (including selected gallery members and offscreen items) or the exact viewport as PNG, JPG, or a single raster PDF page. Export rendering snapshots objects, waits for images, respects cropping/rotation and external titles, excludes selection handles, and releases per-object textures. Dimensions are proportionally limited to 8192 pixels per edge and 32 million pixels total. PDF embeds a high-quality JPEG at 96 dpi; it is not a vector/editable board format. Progress reports rendering, encoding and saving, followed by persistent Open file / Open folder actions. Native saves write a temporary file before replacement and only successfully saved exports receive open-action tokens.

Production build and all 161 Node tests passed. `node scripts/desktop-export.mjs` passed in `.local-test/export-WvUEoO`: six scope/format combinations, exact viewport dimensions, overlapping unselected-object exclusion, cropped/rotated image pixels, offscreen selection, progress, cancellation and both completion actions, with no renderer exceptions. This uses Electron with the built renderer and deterministic native save-dialog/shell stubs; it verifies the actions reach the OS integration methods, not manual interaction with Windows pickers or external viewer applications. The PDF was independently rendered with Poppler and visually checked, along with the format dialog, progress and completion toast. Tests also cover PDF byte offsets, gallery membership, bounded output dimensions, overwrite, cancellation, write failures and rejection of unknown open tokens. Windows packaging and packaged startup smoke passed; the archived main/preload/export service and all renderer assets match the tested files byte for byte.

## Smooth, gentler mouse-wheel zoom — 2026-10-01

Wheel deltas now target approximately 10.5% per normalized 100px event rather than 49%, with pixel/line/page normalization and a per-event cap. The existing render loop eases logarithmic scale toward the target and anchors each frame to the cursor. Repeated events accumulate; reversing direction drops old pending motion. Pointer gestures, editing, explicit zoom/fit, blur, destruction and save flush stop animation at the visible camera. Active gestures ignore wheel zoom. Reduced motion applies the smaller step immediately.

All 109 Node tests and Windows packaging pass. The packaged interaction suite passed in `.local-test/desktop-input-sbZjrx` with no renderer exceptions, including native wheel input, multiple distinct intermediate rendered scales, the final zoom ratio, cursor anchoring, toolbar placement, high-zoom editing and the existing move/resize/rotate/crop/close-save coverage. `wheel-animation.json` records sampled scales. The fixture's old disabled-frame-alignment assertion was updated to expect the previously requested hidden controls. Unit cases additionally verify reversal, accumulated bursts, zoom bounds, line units, reduced motion and cancellation without camera changes during a drag.

## Create button at the end of the board list — 2026-10-01

The final requested layout keeps Create as the last item inside the scrolling board/folder list on every dock edge, with no divider. Only library options remain in the footer. This supersedes the initially requested conditional pinning behavior.

Production compilation passed. Packaged docking checks passed in `.local-test/docking-3KRNpG`: Create follows the last item, remains the final scroll item in a 220px viewport, is reachable by scrolling, returns to its position after resizing, and opens its menu on all four edges. Existing docking, folder dragging and cancellation checks also pass. Packaging initially failed on an Electron download HTTP 504; using the matching installed `node_modules/electron/dist` distribution allowed packaging to finish. A final CSS-only pass removed the remaining footer separator too.

## File drops onto launcher board icons — 2026-10-01

The original icon upload implementation handled drops only inside the icon dialog. The user's screenshot showed a drop onto the sidebar board button, whose existing handler only parsed internal board-move data and silently ignored files. Board buttons in both the launcher and folder sheet now distinguish file drops from internal moves, highlight copy targets and open the destination board's crop dialog with the dropped file.

Before the fix, `Input.dispatchDragEvent` with a real local file path reproduced the missing crop dialog. After packaging the fix, `scripts/desktop-board-icons.mjs` passed for sidebar and folder-board file drops, correct destination, crop/save/cancel, upload chooser and portable transfer in `.local-test/desktop-input-CsXgWs`. The docking suite passed in `.local-test/docking-76h1Ui`, including native board-to-folder dragging. All 106 Node tests passed. The native-file CDP path improves on the earlier injected drop confined to the dialog; it does not claim manual Explorer interaction.

## Uploaded board icons and manual cropping — 2026-10-01

The board icon dialog accepts file selection and drag/drop. A bounded square crop supports pointer dragging, keyboard positioning, zoom and reset; saving writes a 512px PNG into local asset storage. Cancel leaves board metadata unchanged. Board icon strings may reference a validated image asset; portable exports include that asset even when no canvas object references it. Existing glyphs remain supported.

All 106 Node tests and Windows packaging pass. `node scripts/desktop-board-icons.mjs` passed in `.local-test/desktop-input-OE2WAL`, including an intercepted upload file chooser, injected file drop, real crop pointer input, zoom, save, cancellation, switching back to a built-in glyph, launcher image loading and portable transfer to a fresh library. The saved PNG dimensions are checked and `icon-crop.png` was visually inspected; no renderer exceptions occurred. An initial assertion read the crop position before React rendered; it now waits for the actual changed position. Storage tests additionally cover close/reopen, duplication, invalid/missing icon assets and incomplete portable manifests.

## 0.1.24 switch between compact and image link cards — 2026-10-01

Right-click a single link with a cached preview to choose “Show compact card” or “Show image preview”. Compact mode retains the image asset while showing the logo, title, website and description. Switching back restores the previous preview height. The preference and height survive clipboard, duplication, save and portable export/import. Metadata arriving later cannot force a compact card open; switching closes any active player. Compact card external-link buttons open the website, while the explicit YouTube play action expands the card for playback.

All 102 Node tests and production packaging pass. `.local-test/desktop-links-4XEUv8` passes real right-click switching in both directions, undo, saved compact state after switching away and reopening the board through the launcher, plus portable export/import. `trends-compact.png` was visually inspected in `.local-test/desktop-links-CKfXBW`. Existing preview recovery, loading animation, rotation and video playback checks pass with no renderer exceptions. An initial CDP renderer-reload check timed out waiting for canvas readiness; reopen validation uses the app's normal board navigation.

## 0.1.23 ICO logos and fallback image discovery — 2026-10-01

Google Trends supplies a Windows bitmap ICO logo that both Sharp and Electron nativeImage rejected. Icons now undergo bounded ICO validation and decode through icojs in the storage worker, then enter the existing PNG asset pipeline. Rich image cards also render their saved site logo alongside the caption.

Image discovery now considers microdata, image_src, JSON-LD image/primaryImageOfPage/thumbnailUrl fields and ranked page images after standard social metadata. Introductory images closely matching the page title outrank incidental references; visible hero/large images are also candidates. Four candidates at most are fetched, subject to existing public-network and byte/time bounds. Fallback images must decode and exceed thumbnail/tracking dimensions. Page scripts are never executed. Google Trends currently resolves to its own introductory logo-pattern artwork, not the different illustration shown by Miro.

All 101 Node tests pass, including bitmap orientation/transparency, embedded PNG, malformed ICO bounds, structured metadata, candidate ranking and recovery after failed/tiny images. Production packaging and the live packaged suite pass in `.local-test/desktop-links-UdElzA`. A saved text-only Trends card automatically gains both image and logo, expands to image geometry, and survives portable export/import. `trends-preview.png` was visually inspected; existing loading, rounded rotation, thumbnail recovery and muted/full playback checks also pass with no renderer exceptions.

## 0.1.22 compact rounded link cards — 2026-10-01

Text previews default to 440×112, close to the user's manually shortened 440×115 card. Descriptions use at most two lines with ellipsis, tighter spacing, and 16-unit card corners. Open buttons have softer corners. Single-link selection uses the same rounded outline under zoom and rotation, with circular resize handles. Reopening migrates old automatic heights but preserves custom card sizes.

All 95 Node tests and production packaging pass. The packaged live suite passes in `.local-test/desktop-links-3Gvjs8`; `google-summary.png` and `google-rounded-rotated.png` were visually inspected. Real pointer input rotates the selected card 30 degrees while its outline follows the curved perimeter. Existing preview loading, compact fallback, thumbnails, playback and portable export/import checks pass without renderer exceptions.

## 0.1.21 site logos and text previews — 2026-10-01

Cards without thumbnails now display available descriptions in a 168-unit text layout; links without descriptions remain 76 units high. Metadata extraction also reads microdata descriptions and HTML icon links. Site logos are imported as local assets and preserved by clipboard, save and portable export/import. Google's homepage exposes its logo through microdata but currently omits a description, so that exact homepage receives a short built-in product summary when no description is supplied; other pages do not receive this fallback. YouTube still retries missing thumbnails even when author text is already available.

All 94 Node tests and production packaging pass. The live packaged suite passes in `.local-test/desktop-links-kvHzNW`, checking Google's logo and text layout, icon export/import, compact image-free links, loading animation, thumbnail recovery and muted/full YouTube playback, with no renderer exceptions. The Google screenshot was visually inspected in the preceding run `.local-test/desktop-links-qzOdFX`; that run reached the correct Google card but later lost the YouTube debug session when its timed preview closed. A repeat of the complete suite passed.

## 0.1.20 compact links without images and preview loading — 2026-10-01

New links start as 76-unit compact cards with a title, website and single-click open button. Saved links without thumbnail assets are normalized to the compact layout on open. An arriving thumbnail expands the initial card to a 16:9 image area and compact caption; manual sizing is preserved. YouTube autoplay waits for the thumbnail instead of covering an empty placeholder. While fetching metadata or decoding a thumbnail, visible cards show a rotating spinner; compact cards also show “Loading preview…”. Reduced-motion settings keep the indicator static, and offscreen cards do not schedule animation frames.

All 91 Node tests and production packaging pass. The packaged link suite passes in `.local-test/desktop-links-oKEJgO`. It verifies that Example Domain remains 76 units high without an image after fetching completes, compares spinner-region screenshots 160ms apart to confirm motion, and checks busy-state completion. `compact-link.png` and `loading-preview.png` were visually inspected. Thumbnail recovery, image expansion, muted/full YouTube playback and export/import checks also pass without main-renderer errors.

## 0.1.19 thumbnail recovery and compact captions — 2026-10-01

The reported saved YouTube card had neither a thumbnail asset nor fetched title. Its exact URL returned valid metadata when checked, but missing previews were never retried after loading a board. Incomplete cards now recover on board open, reconnection and object paste, with three bounded attempts and guards against stale board responses. Recovery does not start playback. Captions use a 56-unit footer instead of 108, with a 14px title and 11px website line. New cards use 440×314 geometry for a 16:9 preview; existing manually resized geometry remains intact.

All 90 Node tests and production packaging pass. The packaged link suite passes in `.local-test/desktop-links-uajLrQ`: it starts with an incomplete saved card for the reported video, verifies the title and local thumbnail appear before any input, and confirms no video player opens during recovery. `recovered-thumbnail.png` was visually inspected. Eight-second muted preview, full playback, normal website metadata and portable export/import checks also pass with no main-renderer exceptions.

## 0.1.18 rich link cards and inline YouTube — 2026-10-01

Pasting or adding a web URL creates a white preview card. Public Open Graph, Twitter-card and HTML title/description metadata supply its text and thumbnail; YouTube uses oEmbed and its thumbnail endpoint. Images are imported into the local asset library, so cards survive offline use and portable export. Unavailable/private pages retain a basic card. Fetching uses time, byte, redirect and concurrency limits, validates each redirect and pins public DNS results for the request. Metadata HTML never executes. The renderer keeps its local-only script policy; the sandboxed YouTube player has a dedicated frame source and restricted network hosts. Its embed request identifies the desktop app per [YouTube's embedded-player guidance](https://developers.google.com/youtube/terms/required-minimum-functionality#embedded-player-api-client-identity).

YouTube links automatically play a muted eight-second preview on the board. Play with sound or the card's play badge opens full inline playback. The player follows canvas transforms; closing returns to the cached card. An external-link action opens YouTube in the browser. Delayed metadata preserves move/undo/redo and saves committed geometry if it arrives during a cancelled drag.

All 87 Node tests pass, followed by a focused 35-test pointer/history run for the drag-save case. The packaged interaction suite passes in `.local-test/desktop-input-bASQ9o`, covering editing, frame movement, resizing, rotation, cropping and close/save. Live-network `scripts/desktop-links.mjs` passes in `.local-test/desktop-links-z5HUXH`: injected clipboard data exercises the paste handler; real mouse input switches playback and moves cards. It verifies a muted video with advancing time, paused playback at eight seconds, full playback with advancing time, Wikipedia title/description/image, local persistence and portable export/import. Screenshots of both cards and the inline player were inspected. No main-renderer exceptions occurred. Sites may omit metadata or block retrieval, and YouTube may prohibit embedding particular videos; the external URL remains available.

## 0.1.17 frame contents move together — 2026-10-01

Starting a frame drag captures objects fully contained in its body, using transformed corners for rotated objects and frames. The spatial index limits candidate lookup. Nested frames and their contents come along, and explicitly selected children are deduplicated. Membership follows current geometry, so objects moved out are released and a moving frame does not collect objects along its path. Resizing and rotating only change the frame region. Drag commit, cancellation, undo and redo use the same complete object snapshot.

All 81 Node tests pass. Focused cases cover nested frames, selected children, partial overlaps, objects outside a rotated frame, releasing moved-out objects, cancellation and one-step undo/redo. Production packaging succeeds. The packaged desktop interaction suite passes in `.local-test/desktop-input-moE0iG`: real mouse input places a shape inside a frame, moves the frame and shape together, verifies persisted positions, then undoes the complete movement in one step. Existing editing, resize, rotation, crop and graceful-close checks pass with no renderer exceptions.

## 0.1.16 white frames with outside names — 2026-10-01

Frames now draw a solid #ffffff rectangular surface and place names above their top-left edge. Clicking the outside name activates its inline editor on the first click; dragging still moves the frame. Enter saves the name. Rendering, editor placement and the spatial index include external names, including rotated names and viewports containing only the name; resize handles remain on the frame body. Frame names ignore legacy centering flags and frame surfaces no longer use shape colors.

All 79 Node tests pass, including first-click/drag behavior and outside-name hit queries at four rotations and three zoom levels. Production packaging and the desktop interaction suite pass in `.local-test/desktop-input-30EAza`. Real input verifies an unselected outside name opens on one click, the editor is above and aligned to the left frame edge, and Enter persists the rename. A sampled interior screenshot patch is entirely RGB 255/255/255. `white-frame.png` was visually inspected. Existing editing, resizing, rotation, cropping and native close/save checks pass with no renderer exceptions.

## 0.1.15 floating board header — 2026-10-01

Removed the full-width header background and reserved 54px canvas inset. The board name, save status and options remain floating controls; the surrounding header area passes pointer input through to the full-height canvas. Production packaging passes. A packaged-app check confirmed matching workspace/canvas top bounds at 0, a transparent header background, canvas hit-testing through the empty header area, and working board menu and inline renaming. The screenshot in `.local-test/docking-6pHLnr/floating-header.png` was visually inspected.

## 0.1.14 softer external window shadow — 2026-10-01

A non-focusable, click-through owned window draws a wider shadow around the native Windows frame. The main window remains opaque and flush to its content edges. The additional shadow uses 13% and 8% opacity layers, reduced by half after visual feedback, and dims when inactive. It follows move/resize and hides on minimize, maximize, snap, fullscreen or hide; it is destroyed with the owner or if its renderer fails.

All 76 Node tests pass. The native Electron fixture in `.local-test/window-shadow-2m6Om5` verifies transparent center pixels, outward shadow falloff, alignment with DWM visible-frame bounds at 150% display scaling, native click-through/no-activate flags, focus retention, moving/resizing, maximize/restore, minimize/restore, hide/show and close. The desktop crop was visually checked. Snap and renderer-failure lifecycle behavior are also covered by the focused unit tests.

Production packaging passes and the packaged shadow module matches source byte for byte. Packaged interaction checks pass in `.local-test/desktop-input-T6CKtF`, including native close/save persistence and existing editing, resizing, rotation and cropping, with no renderer exceptions.

## 0.1.13 draggable board panel — 2026-10-01

Follow-up: removed the app shell's 12px outer margin, inner rounded border and narrow-window inset so the workspace fills the native window's content area. Production packaging and the docking suite pass again in `.local-test/docking-laQPjE`; the right-docked screenshot confirms the panel meets the content edges. Native Windows title bar and window controls are retained.

Empty-space pointer drags lift the launcher into a floating panel. Edge previews show left/right/top/bottom destinations; release animates the panel into its dock, with horizontal icons at the top and bottom. The workspace reserves the dock's space, folders anchor inward, and the selected edge persists in local settings. Escape, pointer cancellation, focus loss and resizing cancel a gesture. Reduced-motion users skip the settling animation.

All 74 Node tests and production packaging pass. `scripts/desktop-docking.mjs` first failed on the missing right-edge preview before implementation. Its packaged run in `.local-test/docking-bVCkCF` passes all four placements, previews, active settling animation, workspace clearance, folder/menu visibility, Escape, invalid drop, persisted placement after reload, reduced motion, real native board-to-folder dragging, pointer cancellation, and folder containment in a 600×420 viewport. Top-dock and drag-preview screenshots were visually inspected. The existing packaged interaction suite also passes in `.local-test/desktop-input-BCC4Il`, covering editing, alignment, resizing, rotation, cropping and close/save persistence with no renderer exceptions.

## 0.1.12 edge resizing and rotation — 2026-10-01

Single objects now have four corner handles, four middle-edge handles, and a curved-arrow rotation handle outside the lower-left corner with a live angle badge, matching the user's Miro reference. Edges change the box dimensions without changing the base font size; plain text switches to a persistent wrapping box. Corners keep proportional plain-text font scaling. Rotation supports Shift snapping in 15-degree steps, Escape cancellation, undo, clipboard, portable export and reopen. Rendering, culling, hit testing, inline editing and image cropping use the same center-based rotation geometry.

All 74 Node tests pass and TypeScript/production packaging pass. Packaged native input in `.local-test/desktop-input-qRPdWV` verifies every edge on text and notes, opposite-edge anchors, unchanged base font, 90/180-degree rotation, the live angle badge, rotated edge resizing, toolbar clearance, Escape cancellation, rotated inline editing, short centered editor containment and saved/reopened transforms. It also rotates a cropped image, opens its real right-click crop menu, drags the rotated top edge, applies and reopens the result. Existing editing, corner scaling, alignment, crop and native-close checks pass with no renderer exceptions. `transform-controls.png` and `rotated-crop.png` were visually inspected. Packaged v0.1.12 renderer assets match `dist` byte for byte.

Review fixes preserve the top-left anchor when rotated automatic text grows, clamp manually sized editor height, avoid materializing large selections during cursor updates, and keep the toolbar clear of the rotation handle. Default unrotated viewport calculations retain their direct arithmetic path; image decode concurrency, viewport culling, detail tiles and texture-cache budgets remain in place. No new large-board frame-time or memory benchmark was performed for this release.

## 0.1.11 independent text-centering toggles — 2026-10-01

Two binary buttons beside selection/group actions independently toggle horizontal and vertical text centering. They update active drafts without losing the caret, apply together to selected text-bearing objects, expose their state with `aria-pressed`, and are disabled for image-only selections. Boolean alignment fields are validated and retained by clipboard, storage and portable export/import. Renderer and editor use consistent alignment origins, with cached native note height accounting for mixed-script wrapping. Alignment flags invalidate cached views immediately. Centered frame labels remain clickable through their rendered bounds. Text textures intersect the visible ink region, avoiding blank viewport-sized allocations for centered offscreen labels.

All 68 Node tests pass. New tests cover independent placement, storage/clipboard/export/reopen validation and zero offscreen-label allocation. Packaged native input in `.local-test/desktop-input-agCNDf` verifies toggles independently, editor placement, centered rendered pixels, direct toolbar redraw without an editor, multi-selection, undo/redo, centered mixed-script note containment, clicking a centered frame title and reopened alignment. All previous editing/cropping/close regressions pass with no renderer exceptions. `centered-note.png` was visually checked. TypeScript/production packaging pass, and v0.1.11 renderer assets match `dist` byte for byte. Review findings about stale views, clipping, frame hits and texture allocation were corrected before delivery.

## 0.1.10 consistent object editing and caret placement — 2026-10-01

The second selected-object click now enters editing for every text-bearing object type: text, note, rectangle, ellipse, frame, link and video title. Images remain excluded. All selection toolbar pencil buttons are removed. Canvas editors collapse their selection at the end of the draft; inline board/folder name editors likewise place their caret at the end. Drag/modifier/multi-selection protections remain unchanged.

All 65 Node tests pass, including second-click and drag/modifier checks across all seven editable types. Six new type-specific click tests failed against the previous implementation. The packaged native run `.local-test/desktop-input-ky6cZX` uses separate clicks 800 ms apart on text, notes, frames and shapes, verifies both selection endpoints equal the text length, and types an append to prove existing text is retained. It also confirms pencil buttons are absent and repeats the prior editing, resize, toolbar, crop and close-persistence checks with no renderer exceptions. Production build/package pass; v0.1.10 packaged renderer assets match `dist` byte for byte. Read-only review found no important interaction issues.

## 0.1.9 click selected text to edit — 2026-10-01

The first plain-text click selects; a subsequent ordinary click edits on pointer release, without a timing requirement. The plain-text toolbar omits its pencil button. The gesture remembers whether the object was already the sole selection and whether the pointer crossed the drag threshold. Dragging (including dragging away and back), corner resizing, modifier clicks and multi-selection do not enter editing. A following browser double-click event cannot reopen an already active editor.

All 59 Node tests pass, including the new handler regressions (the selected-text click test failed before the implementation). Production packaging passes and v0.1.9 renderer assets match `dist`. The packaged native test `.local-test/desktop-input-Cc4E1M` confirms first-click selection, a separate click 800 ms later opening the editor, and absence of the pencil button. The full native editing/resize/toolbar/high-zoom/crop/close-persistence checks also pass with no renderer exceptions. Read-only interaction review found no important regressions. Rendering and image resource management are unchanged.

## 0.1.8 fitted text and selection controls during editing — 2026-10-01

Plain-text boxes use natural line widths, explicit newlines and a font-relative margin. Their geometry updates while typing, on commit, on external text paste and once when loading existing board text. The selection outline, corner handles and action toolbar remain visible during editing. Live preview geometry/style does not mutate stored objects or history; cancel restores the original, while commit stores the draft and fitted bounds. Empty/whitespace-only plain text is removed on blur, with normal undo. Notes/frames/shapes keep their existing geometry behavior. Toolbar pointer actions retain the caret/draft, duplicate commits the current draft, and toolbar keyboard focus cannot dispatch board deletion/clipboard/undo shortcuts against an active edit.

The packaged native-input test passed in `.local-test/desktop-input-szecZ2`: double-click editors retain the toolbar; typing longer multiline content grows the box and removing it shrinks it; color clicks retain focus and draft; saved Flightline bounds closely match measured text; keyboard traversal into Delete followed by Delete/Escape preserves the original; corner dragging works from an active editor; empty existing/new text is removed on blur and undo restores content; duplicate includes the live draft. Existing corner resize, pan/zoom toolbar positioning, note containment, crop/apply/undo/redo and native-close persistence checks also pass, with no renderer exceptions. `editing-controls.png` was visually checked.

The final packaged run `.local-test/desktop-input-ip2mE5` repeated those checks and added a 30-line editor above 300% zoom: the toolbar remains above the textarea, receives actual color-button clicks, and Escape restores the original draft. Packaged v0.1.8 assets match `dist` byte for byte.

All 57 Node tests pass; TypeScript/production packaging pass. Desktop startup/IPC smoke passed at 2,576 ms while the Node suite ran concurrently (not a comparable performance benchmark). The renderer retains spatial culling and the existing image tile/decoder/cache bounds. No new image benchmark was needed for this text-only change.

## 0.1.7 nearby selection controls and four-corner text scaling — 2026-10-01

Selection actions now follow the selected object/group in screen coordinates, normally 14 CSS pixels above it, flipping below near the top and clamping to the viewport. The engine updates the small overlay on its existing demand-rendered frames; toolbar size is cached by ResizeObserver, with no per-frame React state update or full-board scan added. Image culling, detail loading, decoder concurrency and cache limits are unchanged; the large-image startup benchmark was not repeated for this interaction-only change.

All four single-object corners have visible handles and diagonal resize cursors. Plain text scales font size and geometry proportionally around the opposite corner, including vertical-only drags. Images/videos keep aspect ratio unless Shift is held; notes retain their existing automatic text fit. Each gesture remains one undo operation. Review found and corrected exact-bound font rounding and overlapping low-zoom handle hit areas: final font/geometry are clamped to storage limits and the closest corner wins.

Verification: 57 Node tests pass, TypeScript/production packaging pass, and packaged v0.1.7 renderer assets match `dist` byte for byte. The packaged native-input test drags each text corner, checks font/geometry/opposite anchors and undo, and verifies toolbar placement during a live object drag, pan and wheel zoom. It also rechecks actual double-click editing, note containment, image crop/apply/undo/redo and native-close persistence; no renderer exceptions occurred. The screenshot `.local-test/desktop-input-sklJNY/text-controls.png` was visually checked. Desktop startup/IPC smoke passed at 1,976 ms on its disposable starter library. All interaction tests use isolated repository-local libraries.

## 0.1.6 actual double-click input and image cropping — 2026-10-01

The user's packaged-app report exposed a gap in the earlier browser tests: those activated editors through callbacks instead of exercising a complete mouse sequence. Chromium retargets the double-click event to the board's pointer-capturing host, while the engine accepted only the canvas element. The handler now accepts both and still rejects overlays. The new regression fails against the former handler and passes with the fix.

`node scripts/desktop-interactions.mjs` runs the actual `release/win-unpacked/Terra Board.exe` against a disposable repository-local library. Chromium input produces trusted mouse double-clicks (confirmed on the capturing host), edits text, notes, frame titles, shapes and the board name, and verifies their saved values through the real desktop bridge. The same test right-clicks an image, chooses Crop, performs a real pointer drag, applies it, verifies persistence and undo/redo, and sends native WM_CLOSE to the test process's window. Reopening confirms the crop and active board-name draft survived. No renderer exceptions occurred. The previous executable reproduced the actual double-click failure. A screenshot of the crop controls was visually checked. Direct DevTools Page.close/window.close bypassed the desktop close guard and were replaced in the test by native WM_CLOSE.

Cropping stores normalized original-source bounds. GPU texture views reuse existing image sources; cropped detail requests retain the existing visible-tile/decoder/cache limits. The original bytes remain intact. Four new crop tests cover source geometry/reset, viewport tile clipping, clipboard/export/reopen/original preservation and undersized crops re-edited at smaller zoom. Browser pixel checks returned the expected `[42,176,106,255]` source color at both 100% and 800%; Apply, Cancel, Reset and undo/redo passed. Native input additionally verified the mouse-drag path. The crop handles, grid, Reset/Cancel/Apply toolbar and short hint appear directly over the image.

Final verification: 46 Node tests pass; TypeScript and production packaging pass. The executable's embedded package reports 0.1.6, and every packaged renderer asset matches `dist` byte for byte. Packaged startup/IPC smoke testing passed at 1,945 ms on the disposable starter library. The final same-library 10,000-image comparison recorded baseline v0.1.4 at 8,099/412 ms and candidate v0.1.6 at 4,020/358 ms. These highly variable first-versus-warm starts are retained as measured and do not establish a frame-rate or cold-start improvement. Image culling, bounded detail tiles, four decode slots and the 192 MiB cache limit remain enforced.

## 0.1.5 in-place names, fitted notes and persistent selections — 2026-10-01

Board and folder names use their existing text element for double-click editing, including folder cards, Search and Trash. Enter/blur saves, Escape cancels, and no rename popup opens. Canvas shape, link and video titles also edit in place; Open/Play remains on the selection toolbar. Name input freezes during asynchronous saving, and the desktop close path waits for active and pending names even when the originating folder/dialog has unmounted.

Notes retain fixed dimensions while text fits to the interior. Rendering and editing share cached layout, with handwriting ink allowance, retained trailing blank lines and native mixed-script wrapping measurements. One hidden measurement probe is reused only for layout cache misses; fitting does not run on image frames or every pan. Text expands back toward its chosen font size when space allows. Existing viewport culling, image detail levels, four decode slots and the 192 MiB image-cache ceiling remain in place.

Selection persists when dragging a selected object or an empty gap inside its bounds. Shift/Ctrl/Meta clicks add or remove objects; Shift marquee unions and Ctrl/Meta marquee toggles. Group movement, duplicate, copy/paste, Delete and undo keep the complete selection.

The full Node suite has 41 passing tests, including four new actual-handler selection regressions. Browser checks covered board/folder/card/search/trash renaming and Escape, active-title close flush, a deliberately delayed rename surviving component unmount, four additional canvas object title types, note save/reopen/undo without size changes, complete-selection clipboard/delete, and trailing-newline/long-word/mixed-script note fitting at 25%, 100% and 800%. The existing six rendering/editor regressions pass. A visual check at 200% showed all note content inside its original rectangle while editing.

On the same warm 10,000-image-object / 1,000-generated-image library, the repeated alternating comparison measured v0.1.4 at 1,357/1,340 ms and the candidate at 1,427/1,348 ms to first canvas. An earlier pass measured baseline 1,316/1,718 ms and candidate 7,204/1,415 ms; the isolated slow candidate startup is retained in `.local-test/rendering-startup-first-0.1.5.json`, with no diagnosed cause claimed. This supports comparable repeated warm startup, not sustained pan/zoom FPS or cold-cache performance with representative photographs.

## 0.1.4 zoom quality and in-place editing — 2026-10-01

Text is rendered from font outlines at a zoom/DPI-dependent resolution; only the visible part is rasterized for the GPU. Shapes keep their existing vector geometry. Text, note, and frame-title editing now uses the same font, line spacing, inset and location, with a transparent editor and the underlying glyphs hidden. Clicking back onto the board or Ctrl+Enter commits one undoable edit; Escape discards the draft. Frames edit just their title rather than displaying a frame-sized white input.

Close-up images request visible original-source tiles of at most 512px. The renderer retains RBush culling, demand-driven rendering, four concurrent decodes and the 192 MiB image texture admission ceiling. Base previews are reserved before details. Loaded tiles replace the corresponding preview region, preserving alpha. Image generation runs outside the worker's serialized edit queue so decoding cannot delay acknowledged saves. Cached image views survive panning within an unchanged tile set.

Verification: 37 Node tests pass, including original-pixel stripe preservation, bounded visible tile requests, original-byte preservation, cache reuse, invalid tile rejection and a deliberately delayed decoder running concurrently with a real SQLite save. TypeScript and production builds pass. The packaged `release/win-unpacked/Local Canvas.exe` contains version 0.1.4 and passes desktop startup/IPC/first-render smoke verification (1,947 ms on the seeded starter library).

The browser fixture at `tests/rendering.html` passed six editing/rendering checks: 800% text density at DPR 1.5, bounded allocations for a large text object at 17%, transparent frame-title editing, hidden original glyphs and cancellation, blur/undo/redo, and Ctrl+Enter/Escape. Its image check loaded 21 detail tiles, sampled the expected singly composited transparent pixel `[125,176,226,255]`, and used 10,625,024 image-texture bytes. A one-pixel pan retained the same image view. Run `window.runRenderingChecks()` and `window.runImageChecks()` on this fixture with the Vite browser harness.

Startup comparison used the same warm library with 10,000 image objects and 1,000 distinct generated 512×384 images, outside fixture-generation timing. In alternating baseline/candidate/candidate/baseline order, v0.1.3 measured 2,986 and 1,333 ms; the candidate measured 1,366 and 1,293 ms. These show comparable warm first-viewport startup, not sustained frame rate, cold-cache decoding, or representative high-resolution photographic workloads. `scripts/compare-rendering.mjs` takes a baseline executable path; raw results are in `.local-test/rendering-startup-results.json`. A prior run during heavy fixture/file-watcher activity measured 9,635 ms and is not used as a performance improvement claim. Generated libraries and builds are now excluded from the Vite watcher.

Photos retain their finite original resolution. Derivative tiles persist in the ignored Library; automatic derivative cleanup, aggregate text-memory stress, long-session and representative-photo benchmarks remain open.

## 0.1.3 repository-local application and data — 2026-10-01

The active repository is `D:\Projects\terra`. Launch with `Open Terra Board.cmd` at its root or `release\win-unpacked\Terra Board.exe`. The default library is now the repository's `Library` directory in both development and packaged builds. Settings, browser caches, logs, crash dumps and temporary runtime files also resolve beneath that directory. Compiled builds and user data are Git-ignored.

All 34 tests pass, including development/packaged storage-path parity and isolated test overrides. The production package builds on D:. A packaged smoke run from a different working directory, without a data-directory override, loads the existing library and reports every runtime path under `D:\Projects\terra\Library`. First canvas: 1,570 ms. Packaged source and renderer assets match the verified build. The copied library passes SQLite integrity checking; all 437 files from the former AppData location were verified against their D: copies with SHA-256.

Previous binaries are preserved under `release\previous-builds`. The historical AppData/OneDrive destinations below are superseded by this repository-local layout.

## 0.1.2 wheel zoom update — 2026-10-01

The mouse wheel now zooms in and out around the cursor without requiring Ctrl. Right-drag panning remains available. The keyboard reference and README describe the updated controls.

All 32 Node tests pass, including event-handler checks for wheel direction, cursor anchoring with an offset canvas, camera saving, Ctrl/Meta compatibility, overlay scrolling and existing panning. The unmodified wheel handler failed the new default-wheel zoom test. These tests exercise the actual Engine handlers with GPU dependencies stubbed; they are not a physical-mouse test.

TypeScript checking, the production build and formatting checks pass. The packaged 0.1.2 executable passes the desktop smoke test using a disposable library (first canvas: 1,549 ms). Its version metadata reports 0.1.2, and the packaged HTML, CSS and JavaScript match the verified build. Existing SQLite experimental and Vite bundle-size advisories remain.

This prior executable is archived at `release\previous-builds\Build-0.1.2\win-unpacked\Local Canvas.exe`. Use the current launcher at the repository root.

## 0.1.1 panning update — 2026-10-01

Right mouse dragging now pans in every canvas tool. A plain right-click opens the menu once; dragging suppresses the release menu, including press-before-release context-menu event ordering. The cursor changes to grabbing and restores after release/cancellation. Existing selection and object positions are preserved; the camera save uses the normal save queue.

Six tests execute the actual Engine pointer handlers with the GPU dependencies stubbed: right-drag, right-click jitter/menu timing, dragging back to the origin, cancellation, content/selection preservation and existing middle-button/hand panning. The first four reproduced failures in the previous handler; all six pass with the fix. The complete suite has 30 passing tests. This is event-handler coverage, not a physical-mouse test of the packaged window.

This prior executable is archived at `release\previous-builds\Build-0.1.1\win-unpacked`. Use the current launcher at the repository root.

Validated on this Windows machine on 2026-09-30 / 2026-10-01. This is a working preview, not a completed production certification of the entire product roadmap.

## Automated checks

- 24 Node tests pass: local save/reopen, Unicode names, independent duplication, folder dissolve, trash/restore, atomic edits, stale-revision rejection, idempotent failed-ack retry, queued/in-flight save ordering, input validation, zoom anchoring, spatial lookup, undo/redo branching, bounded text previews, damaged import rollback and future-schema refusal.
- A subprocess is force-terminated after acknowledging an edit. Reopening retains that edit and SQLite integrity_check returns `ok`. This is process-crash evidence, not a simulated power failure or exhausted disk test.
- The real storage worker imports a Unicode filesystem path, writes an editable export, imports it, rejects an unsupported command and reopens the imported content after worker termination.
- TypeScript checking and production Vite build pass. Vite reports a size advisory for the approximately 580 KB main JavaScript chunk; it is bundled locally.
- The packaged Windows executable starts, completes the library IPC path and draws its first canvas under the production content-security policy. Runtime: Electron 44.5.1, Node 24.21.0, SQLite 3.53.4.
- Sharp was updated to 0.35.5 after the dependency audit found a vulnerability in the previous bundled image decoder. The old hard-coded test PNG was malformed and rejected by the updated decoder; the round-trip fixture now uses a valid generated PNG and compares original bytes.
- Final `npm audit --omit=dev --audit-level=high`: zero reported vulnerabilities. The final packaged starter board reached its first canvas in 600 ms. The executable's Authenticode status is `NotSigned`.

## Live UI checks

The browser harness uses the same React/canvas code and a separate local SQLite test library. The packaged smoke test additionally covers the desktop bridge and production protocols; browser UI checks do not by themselves verify native dialogs.

| Flow | Observed result |
| --- | --- |
| Create folder and board inside it | Folder opens; new board becomes active |
| Rename board, change icon and color | Header, launcher and folder mosaic update |
| Duplicate, move to strip, trash, restore | Independent duplicate and recovered board appear |
| Search | Matching titles and folder locations filter correctly |
| Rename/dissolve folder | Name updates; boards survive on the strip |
| Image file chooser | Local generated image imports and renders |
| Portable export/import | Downloaded `.canvas` file reimports as an editable board |
| PNG export | Nonempty PNG written to Downloads |
| Paste image/text, note editing | Text appears; Ctrl+Enter commits |
| Shape color, frame label, grouping | Controls update selected objects; group/ungroup execute |
| Duplicate/delete/undo | Canvas state responds to each operation |
| Zoom in/out/fit | Zoom label and viewport update |
| Local video | Generated VP9 WebM decodes at 640×360, reaches 1.956916 seconds, readyState 4, no media error |
| Keyboard reference and dialog focus | Reference opens; text dialogs initially focus their editable field |
| Board switching | Imported media renders after repeated switches in a clean page session |

The browser download-event observer timed out, but the files were actually written. Export was verified from the downloaded file and by importing that file through the UI. A transient blank-image render occurred during development hot reload; a clean reload and repeated board switches rendered correctly. Production smoke tests do not use hot reload. A requested 760×560 viewport override did not take effect (the actual DOM viewport stayed 1280×720); this is not counted as a successful narrow-window test.

## Performance evidence

- 100,000-object RBush fixture: index build 36.10 ms; 1,000 viewport queries, p95 0.0046 ms and p99 0.0126 ms, averaging 17.05 matches. **Spatial lookup only**, excluding rendering and decoding.
- Actual Electron startup with **10,000 image objects backed by 1,000 distinct generated 512×384 images**: first canvas at **1,499 ms** from main-process setup in the packaged build (1,329 ms in the earlier source-build run). This confirms opening the first viewport, not completion of every visible image decode, cold OS cache, full-board rendering, sustained panning, or 10,000 unique high-resolution photographs.
- Renderer work is demand-driven; offscreen objects are spatially excluded. Texture preparation has four concurrent decodes, thumbnail/preview levels and a 192 MiB admission ceiling. This is the image-cache budget, not a total application-memory guarantee.

## Open production release gates

Representative photographs/videos at scale; sustained pan/zoom frame-time and memory measurements; 4K and mixed-DPI displays; long-session leak checks; full native dialog and clipboard automation; drag/drop/reorder edge cases; disk-full and power-interruption fault injection; negative renderer-origin IPC tests; keyboard/screen-reader audit; signed installer and upgrade/migration testing. The preview is not a substitute for passing these gates.

Native backup restoration, automatic asset cleanup, richer content types and frame ownership remain product work. See the README for limits. No network sharing or cloud synchronization was added.

### 2026-10-01: editable arrows
- `npm test`: 120 passing; `npm run build`: passing.
- Packaged desktop interactions passed with `.local-test/desktop-input-mBn06o`: mouse-drawn arrow, midpoint insertion, undo/redo, all path types, dashed stroke, thickness, marker swap, saved/cancelled label, bend deletion, endpoint movement, and persisted arrow after closing/reopening. Screenshot: `arrow-controls.png`.
- Added a focused renderer regression for vertical elbows with a zero-length first segment; rebuilt the final executable after this correction.

### 2026-10-01: arrow direction and visual settings
- `npm test`: 121 passing; `npm run build`: passing. The new steep-end curve regression failed before the geometry fix and passes afterward; it also checks bounded geometry and insertion dots on the actual curve.
- Packaged `node scripts/desktop-interactions.mjs` passed in `.local-test/desktop-input-YUaCkO` with no renderer exceptions. It clicks every path/stroke preview, drags the thickness slider, verifies single-step undo/redo, selects graphical endpoint markers, edits labels and bends, and checks persisted state after closing.
- Inspected `arrow-style-previews.png` and `arrow-head-previews.png` from that run. The settings expose the slider and all six path/stroke choices without nested dropdowns.

### 2026-10-01: clean arrow tips and new application icon
- `npm test`: 123 passing; production build and local-Electron packaging passed. Added a regression that failed on the old shaft for filled arrowheads at thickness 40 with solid/dashed/dotted strokes, plus a short-arrow check.
- Focused packaged pointer check passed in `.local-test/desktop-input-v47g8H`, creating a diagonal arrow with triangle markers at both ends and thickness 40. Inspected `thick-arrow-tips.png`: clean tips with no rounded shaft protrusion; no renderer exceptions.
- The broad desktop suite did not complete on this run: one attempt timed out at `Input.dispatchMouseEvent` during earlier text editing; its retry stalled before reaching arrows. This is not counted as a passing full interaction suite.
- All three latest icon assets in packaged `app.asar` matched source bytes. Extracted the executable's Windows icon to `.local-test/packaged-app-icon-latest.png` and visually verified the latest pale-blue orbit artwork. Fixture generation no longer replaces application icons.

### 2026-10-01: arrow label slider and input styling
- `npm test`: 123 passing; production build and packaging passed.
- Focused packaged font-slider check passed in `.local-test/desktop-input-DOFpSI`: actual pointer drag from 18 to 54, saved updates before pointer release, one-step undo/redo, unchanged label text and persisted size after close. No renderer exceptions. The reusable font-slider steps are in `scripts/desktop-interactions.mjs`; the entire broad desktop suite was not rerun for this change.
- Inspected `arrow-font-slider.png`: rounded text input, size readout and slider; the complete larger label renders without the old fixed-width clipping.

### 2026-10-01: dynamic alignment guides
- `npm test`: 129 passing; production build and packaging passed. Pure geometry tests cover edge/center alignment, independent axes, zoom-invariant thresholds, release/bypass, empty targets and merged coincident anchors. Engine tests cover all object types, frame contents, undo and guide cleanup.
- `node scripts/desktop-snapping.mjs` passed in `.local-test/desktop-input-lN8o4F` with no renderer exceptions. Real pointer input aligned images and text, checked guide pixels across the image gap and their disappearance on release, then verified Alt bypass, undo/redo, Escape and saved placement after close.
- Inspected `image-alignment-during-drag.png` and `text-alignment-during-drag.png`. Early assertions were corrected for screenshot antialiasing and floating-point coordinate tolerance; no production behavior was changed to satisfy those assertion corrections.

### 2026-10-02: image galleries
- `npm test`: 149 passing; production build and Windows directory packaging passed. Gallery tests cover row/column aspect preservation, append/delete/reflow, membership release, internal-drag normalization, size changes, clipboard validation, save/reopen, board duplication and portable export/import. Engine regression covers resize previews returning to their initial size, cancellation and undo.
- Packaged `scripts/desktop-gallery.mjs` passed in `.local-test/gallery-8mAuAA` with no renderer exceptions. Real pointer/keyboard checks cover Insert, inline gallery naming, repeated native Ctrl+V, both directions, gallery resizing and undo, dragging by name with all members, mixed-content paste, copying/deleting a whole gallery, ordinary paste after deselection and reopening the board.
- Visually inspected empty, row and column screenshots. The UI has a quiet external name and a two-button direction control. Gallery images share width in columns or height in rows, with aspect ratio preserved. Native clipboard fixtures use Terra's clipboard bridge; external-app image copying was verified separately by the clipboard suite.

### 2026-10-02: gallery matrices and faster image cut/copy
- `npm test`: 152 passing. Production build and Windows directory packaging passed. Added matrix insertion/transposition, cell serialization through clipboard/duplicate/portable import, fixed-gap resize preview/commit/undo and unchanged-PNG byte-reuse regressions.
- Packaged `scripts/desktop-gallery.mjs` passed in `.local-test/gallery-zS9Sni`: 14px Gallery menu text/19px icon, hover targets, repeated native Ctrl+V beside/below images, native file drop onto a target, step/variant insertion, orientation transposition, undo/redo and persisted cells after board reopening. Existing name/drag/clipboard/resize checks still pass. No renderer exceptions. Inspected matrix and menu screenshots in the equivalent source run `.local-test/gallery-yGSML3`.
- Packaged `scripts/desktop-clipboard.mjs` passed in `.local-test/clipboard-YLUuBX`, including original pixel resolution, exact PNG pixels in another process, crop/rotation, editable round trips, cut with board switching and ordinary text copying.
- Measured a deterministic 3840x2160 RGB PNG (24,929,495 bytes) using `.local-test/clipboard-benchmark.cjs` and a separate Electron clipboard process `.local-test/clipboard-speed.cjs`: unchanged PNG preparation dropped from 313.9 ms to 9.6 ms; total native copy including clipboard fingerprint checks, image/file formats and OS write dropped from 645.3 ms to 325.6 ms. Cropped/rotated preparation dropped from 413.7 ms to 229.3 ms. These are local fixture measurements, not guarantees for all images. Unchanged PNGs reuse original bytes; transformations use one final lossless PNG encode. Cut still deletes only after the OS clipboard write succeeds.
- One initial source-app run timed out waiting for canvas readiness; a retry and the final packaged run passed. A matrix hover test initially used stale saved camera coordinates after Fit; the harness now waits for the saved-state indicator before pointer positioning.

### 2026-10-02: paste images at the cursor
- Ctrl+V centers imported images and copied image selections on the mouse position captured when paste starts, using the current pan/zoom. Relative positions within copied selections are preserved. Gallery selection alone no longer captures a paste elsewhere; hovered matrix insertion targets and an empty gallery's "Paste images here" area still route images into that gallery.
- `npm test`: 153 passing; production build and Windows packaging passed. Packaged `scripts/desktop-gallery.mjs` passed in `.local-test/gallery-mHvF0b`, asserting cursor placement under the fitted camera, selection-independent ordinary paste, empty-gallery first insertion and matrix target paste/drop. Packaged `scripts/desktop-clipboard.mjs` passed in `.local-test/clipboard-hGOgaS`, asserting paste-time placement for a pending internal copy and native image-only clipboard import even after the mouse moves, plus existing full-quality pixel/crop/roundtrip/cut checks. No renderer exceptions.
- Empty advertised custom clipboard payloads now fall back to native image/files; a regression covers this path. Desktop fixtures focus the canvas before testing native image-only paste, and use the gallery's corner handle to avoid overlapping image insertion targets during resize checks.

### 2026-10-04: image and night-glow continuity during zoom
- Images retain the loaded thumbnail/preview while the next resolution decodes, including failed loads and cache pressure. Render signatures use texture identity so the replacement appears when ready. Lighting retains its canvas backing surface during camera changes, explicitly clearing pixels and resetting the transform on redraw.
- `npm test`: 191 passed, including a 400-thumbnail cache-pressure case and shared-asset protection. Five new regression cases failed against the original code and passed after the fix. `npm run package` passed after closing three repository-packaged MCP stdio helpers that held `app.asar` open; the first package attempt reported that lock.
- Packaged `node scripts/desktop-zoom-flicker.mjs` passed in `.local-test/zoom-flicker-ipNLSd` with no renderer exceptions. Real wheel input crosses thumbnail/preview boundaries in both directions and themes while replacement decoding is held open. All 24 sampled image regions retain their loaded pixels, then switch to the replacement after decoding. The original package showed placeholders in all 24 samples (`.local-test/zoom-flicker-PxVqJe`). Dark-mode canvas dimension resets fell from 114/122 to zero in those runs. These are bounded resolution-transition checks, not a large-board performance benchmark.
- Packaged `scripts/desktop-night-mode.mjs` passed in `.local-test/night-mode-gDqmiJ`: Light/Dark/System, OS changes, persistence, keyboard/reduced motion, small-window layout, glass opacity, glow toggle, pan/zoom lighting, and unchanged saved content. Updated its removed Library options selector to the current panel context menu. Inspected the dark-mode zoom screenshot from the regression fixture.
