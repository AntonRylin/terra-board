# Terra Board: session memory and working guide

Last verified: 2026-10-01. This is the project handoff from the session that implemented docking, window polish, frames, rich links, compact cards, and palette improvements. Read this before working on the app. Treat source code and fresh verification as authoritative when this file gets older.

## Start here

- **Actual repository: `D:\Projects\terra`.** The chat may start in an empty OneDrive `New project` directory. Set the working directory explicitly; do not create a second project there.
- Current branch at handoff: **`codex/local-canvas`**. Remote: `https://github.com/AntonRylin/terra-board.git`. Check `git status`, branch, log and diff before editing. Other sessions have worked in this same checkout; do not reset, overwrite or attribute their work to yourself.
- This implementation is **Electron + React + TypeScript + PixiJS**, with a SQLite storage worker. Earlier Qt/native architecture discussions are not the implementation to build.
- Source version at handoff is **0.1.24**. Verify `package.json`; do not assume every small edit increments it.
- The user's real data lives in **`D:\Projects\terra\Library`**. It is outside the replaceable build directory and ignored by Git. Never use it for automated test fixtures or delete it to fix a build.
- The deliverable is **`release\win-unpacked\Terra Board.exe`**, launched through **`Open Terra Board.cmd`**. A successful web build does not update the packaged executable.
- Read `docs/user-guide.md` for current features, `docs/development.md` for build/test/release commands, and `docs/verification.md` for dated evidence and limitations. Local test output paths in these documents are evidence on this computer, not files included in Git.

## User's delivery preference from this session

The user explicitly asked to preserve this workflow: implement the feature, verify it, rebuild the packaged app, reopen it for them to try, and **commit each completed, verified feature**. Avoid accumulating uncommitted finished features. They also explicitly requested committing and pushing this handoff and the pending UI work. For later work, follow their current instructions about pushing; a preference to commit every feature is not a request to merge, release or publish unrelated work.

Proceed with routine reversible implementation choices; do not repeatedly ask permission for already requested work. Keep updates short and concrete. Do not claim visual verification from compilation alone. Report the actual branch and commit when delivering Git work.

## Build and reopen the right app

Use PowerShell in the repository. Node **24.13 or later** is the documented baseline; tests use Node's SQLite support and TypeScript imports. Install with `npm ci` when dependencies are missing or the lockfile changed, not before every edit.

```powershell
Set-Location -LiteralPath 'D:\Projects\terra'
npm test
npm run build
```

`npm run build` runs `tsc --noEmit` and Vite. `npm run package` runs that build again and Electron Builder's Windows directory target. If packaging is your next step, a separate build is optional; packaging already checks it. SQLite experimental notices and the Vite large-chunk warning have appeared on passing runs; judge the exit code and actual failures.

Before packaging, close the user's packaged app **gracefully** so it saves and releases executable files:

```powershell
Get-Process 'Terra Board' -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Path -eq 'D:\Projects\terra\release\win-unpacked\Terra Board.exe' -and
    $_.MainWindowHandle -ne 0
  } |
  ForEach-Object { $_.CloseMainWindow() }
```

Wait for it to exit before packaging. Closing can be refused if a save fails; investigate rather than forcibly killing the user's process. If packaging reports a locked file, check for a remaining process from this checkout or a test fixture. Do not kill every Electron process on the machine.

```powershell
npm run package
```

Wait for a successful exit, then reopen the actual deliverable for the user:

```powershell
Start-Process -FilePath 'D:\Projects\terra\Open Terra Board.cmd' `
  -WorkingDirectory 'D:\Projects\terra' -WindowStyle Hidden
```

The launcher sets `CANVAS_DATA_DIR` to the repository's `Library` and clears `ELECTRON_RUN_AS_NODE` and `CANVAS_DEV_URL`. These variables matter: a stale dev URL can load the wrong frontend, and Electron running as Node is not the desktop app. Keep support files beside the executable; copying only the EXE is not a distribution. `dist`, `release`, `Library`, `.local-test` and `node_modules` are ignored and must not enter commits.

Development: `npm run dev` launches Vite plus Electron. It uses the same repository library by default, so use an explicit disposable `CANVAS_DATA_DIR` for experiments. `npm run preview` uses the browser harness and its separate `.local-test/browser-library`; it does not prove Electron-specific behavior. Restart development processes after native dependency changes.

## Choose verification to match the change

| Command | Purpose and limits |
| --- | --- |
| `npm test` | Model, storage, parsing, image decoding, geometry, history and worker tests. 104 passed at this handoff, including another session's image-title tests. Counts will change. |
| `npm run build` | TypeScript and frontend production compilation. Does not refresh `release/win-unpacked`. |
| `npm run package` | Build the Windows executable the user actually launches. |
| `node scripts/desktop-interactions.mjs` | Packaged app with real Chromium pointer/keyboard input: text editing, frame movement, resize/rotation, crop, saving and graceful close. |
| `node scripts/desktop-links.mjs` | Packaged live-network preview recovery, loading, metadata, compact/image switching, undo, board reopening, video playback and portable export/import. External sites can change or fail. |
| `node scripts/desktop-docking.mjs` | Board panel docking interactions. Inspect current script for setup and coverage. |
| `node scripts/window-shadow-check.cjs` | Windows shadow fixture, owner lifecycle and native window behavior. |
| `npm run test:desktop` | Desktop startup fixture; `CANVAS_SCALE=1` enables the documented large workload. `CANVAS_EXECUTABLE` selects the packaged artifact. Inspect script before expensive runs. |

Run focused checks for the change. Do not add implementation-mirroring tests for a trivial visual adjustment, or repeatedly run expensive live suites without a new reason. Storage, geometry, async history, parsing and import changes deserve regression coverage. Unit tests do not prove native picker operation, successful video playback, visual layout or sustained performance.

The packaged scripts create disposable libraries under `.local-test`, set `CANVAS_DATA_DIR`, clear dev/Node overrides, start their own executable with a loopback remote-debugging port, and use CDP. They collect screenshots and renderer exceptions. Reuse this working approach when native UI automation is unavailable. Do not enable a debug port on the user's real library just to make a fixture easier.

Use real pointer/keyboard input for hit-testing, drag, selection and toolbar behavior. Injecting clipboard data tests the paste handler but does not prove the OS clipboard. Setting a native input's value and dispatching events tests the React change/save path but does not prove interacting with the OS dialog. Preserve that distinction in reports.

For close/save tests, `Page.close` bypasses Electron's native close guard. `desktop-interactions.mjs` contains a scoped WM_CLOSE helper for its own process; hidden windows may have no `MainWindowHandle`. Never generalize that helper into killing unrelated processes.

Wait for actual readiness and saved state, not a fixed arbitrary delay. A CDP `Page.reload` attempt during link testing hit old-document/readiness races and a `.canvas-loading` timeout. The final passing reopen check used the normal launcher to switch to `Other board` and back. Do not present that result as proof renderer reload was fixed. YouTube creates and destroys separate frame/debug contexts; its timed preview can disappear while you inspect it. Main-renderer errors and embedded-player context teardown must be distinguished.

Inspect screenshots with the image viewer, including the actual selected state and intended zoom/rotation. Do not call a file visually verified merely because it exists. Performance fixtures are bounded measurements, not promises of unlimited objects or sustained 60 FPS on arbitrary hardware.

## Source map and invariants

- `src/components/Whiteboard.tsx`: toolbar, context menus, inline editing, link enrichment and embedded player orchestration.
- `src/canvas/engine.ts`: Pixi rendering, selection, gestures, spatial queries, textures, applying edits and metadata hydration. Keep visual geometry, hit areas and rotated coordinates consistent.
- `src/model.ts`: shared object fields. Adding a field usually also requires `electron/store.cjs` validation/serialization and `src/canvas/content.ts` clipboard validation. Check duplicate, save/reopen and portable export/import, not only rendering.
- `src/canvas/history.ts`, `save-queue.ts`: undo/redo and queued durable saves. `Engine.apply` is the normal user-edit path. Do not mutate React state alone and assume a board was saved.
- `electron/store.cjs`, `worker.cjs`, `storage-paths.cjs`: validation, SQLite, local assets and worker transport. Media decoding/import should not block acknowledged board edits.
- `src/canvas/text-style.ts`, `text-layout.ts`, `text-alignment.ts`, `text-rendering.ts`, `frame-label.ts`: shared editor/render geometry. A title outside an object also needs spatial/hit-query coverage; do not patch only a DOM editor position.
- `src/components/useLauncherDock.ts`: docking input. `electron/window-shadow.cjs`: extra native shadow. `src/styles.css`: toolbar and app chrome.

SQLite uses WAL and FULL synchronization; successful acknowledgment is what the save checkmark means. Closing, switching boards and exporting flush pending edits and media imports. Failed operations retain IDs for retry. Original media is content-addressed and retained after deleting objects. Full backups need the **entire closed Library**, not only a metadata snapshot. Never patch the user's database directly for a visual fix; read-only inspection can diagnose saved state.

Async preview hydration must preserve later movement and undo/redo, reject stale board responses, and save committed geometry if metadata arrives during a gesture that is cancelled. Tests for these cases exist. Capturing an object before an async wait and later overwriting it loses user edits.

Wheel zoom now uses the engine's existing RAF draw loop: logarithmic easing with a 55ms time constant, a target accumulated from normalized/clamped wheel deltas, and coefficient 0.001 instead of 0.004. A 100px event changes scale about 10.5% instead of 49%. Keep the previous frame timestamp across event bursts, or high-frequency wheels can starve interpolation. Reverse direction discards the old pending target. `zoomAt` preserves the cursor anchor each frame. `stopCameraAnimation` freezes the visible camera before pointer gestures, editing, explicit fit/zoom, blur, disposal and Whiteboard save/board-switch flush; wheel events during active gestures do not alter geometry. Reduced motion applies the smaller step immediately. Existing high-zoom desktop tests now send twelve smaller events instead of relying on a single giant wheel jump.

## Product behavior established in this chat

### Window and board panel

- The board panel docks to left, right, top or bottom by dragging empty space. Destination preview, smooth transition, Escape/cancel, orientation-specific scrolling, saved placement, icon reordering and folder drops must coexist.
- Final Create-button preference: the plus is always the last item inside `.launcher-scroll`, after all boards/folders, and scrolls with them. No divider. Only library options stay in the footer. The user explicitly simplified away the earlier conditional pinned behavior. The docking test begins in empty panel corner space so it does not accidentally hit a board or the Create button.
- Content meets the window edges. The old full-width white header panel and reserved canvas inset were removed; name, save state and options float over the canvas, with empty header space passing pointer input through.
- Native Windows chrome/resizing remains. A rounded inner panel is not proof the native window shape changed. A separate non-focusable click-through owned window provides the softer, wider shadow. The first stronger shadow was reduced after feedback (13% and 8% layers). Hide it for maximized/snapped/fullscreen/minimized states; destroy it with its owner or on shadow-renderer failure. Do not reintroduce a heavy halo.

### Frames

- Frames are opaque pure white with the name outside the upper-left edge. One click on the name edits it; dragging the name moves the frame. Enter saves, Escape cancels. Names stay outside under zoom/rotation and ignore shape text-centering flags.
- Fully contained objects move with a dragged frame. Membership comes from current geometry at drag start, using transformed corners and the spatial index. Nested frame contents and explicitly selected children are deduplicated. Partial overlap does not establish membership, moving an object out releases it, and a moving frame does not collect objects it passes.
- A frame drag and its contents commit/undo/cancel as one operation. Resizing/rotating the frame changes its region; it does not transform all contents. Do not silently replace this with a persistent parent tree.

### Rich links and their limits

- Core editing is local/offline. The user explicitly requested online link metadata and YouTube playback later; these are intentional network features, with locally cached metadata/assets. Do not remove them because early planning said local-only, or claim all app features are offline.
- Links start compact, show loading feedback, and expand after an image arrives. Missing images are not a reason to allocate an empty giant card. Text-only cards still display available icon/title/domain/description.
- Default width is 440 canvas units. Title-only cards are 76 high; description cards 112 with at most two description lines. Rich cards use a 16:9 media region and compact footer (440-wide defaults commonly yield height 314). Preserve manually resized geometry; migrate only known old automatic sizes.
- Card corners and single-link selection outlines match (16-unit radius), including rotated cards. Resize handles are circular. Avoid the earlier square selection around a rounded card.
- `src/canvas/link-preview.ts` owns shared layout, `hasLinkImage`, `setLinkCompact`, sizing and play hit tests. Do not use `assetId` alone to decide whether the large image is displayed.
- Right-click a single link with a cached image: **Show compact card** / **Show image preview**. `linkCompact` remembers the choice; `linkPreviewHeight` remembers the expanded height. Compact mode retains its image asset and logo, avoids requesting the large texture, and restores without refetching. Late metadata must not reopen a deliberately compact card. Both fields survive clipboard, save and export/import.
- Compact external-link buttons open the URL. Explicit YouTube play can expand the card and play. Compact YouTube cards must not retain an invisible center play hit area. Switching appearance closes an active player.
- Link-only selections no longer show irrelevant disabled text alignment controls. The toolbar renders alignment controls only when an eligible alignment selection exists.
- `src/canvas/load-link-preview.ts` has three bounded attempts with 1.5/3-second retry delays and stale-engine protection. Reopening/reconnecting recovers incomplete saved previews. YouTube missing a thumbnail remains incomplete even if author text arrived. Recovery must not autoplay.
- A newly pasted YouTube link starts its muted **eight-second** preview after thumbnail availability. Explicit play gives full playback with sound; closing returns to the cached thumbnail. The timed preview iframe has bounded lifetime. The player follows canvas transforms. A provider can reject embedding; retain an external-open action.

### What actually fixed Google and Google Trends

- `electron/link-preview.cjs` fetches/parses bounded public HTML without executing page scripts. Open Graph/Twitter metadata is first choice, then microdata, `image_src`, JSON-LD image fields and ranked page content images. Relevant introductory/hero/large images outrank incidental images. Logos, avatars, trackers and tiny images are excluded from big-image fallback. Four fallback candidates maximum; decoded fallback images must be at least 160 by 90 with a reasonable aspect ratio.
- Preserve network guards: reject credentials/private destinations, validate redirects, pin public DNS results, and bound time, redirects, bytes, image pixels and concurrency. Existing limits include 8-second requests, four redirects, 1 MiB HTML, 5 MiB images and 512 KiB icons; inspect code before changing. Do not execute arbitrary page JavaScript or use an unbounded fetch to recover one logo.
- The Trends favicon is a bitmap ICO that Sharp and Electron `nativeImage` could not decode in the observed environment. `electron/icon-image.cjs` now validates dimensions/frame bounds/format limits before decoding via **`icojs@1.0.1`**, then imports PNG through the usual asset path. Both compact cards and rich-card footers show the site icon.
- An attempted `@humanwhocodes/ico-to-png` path produced bad PNG/checksum behavior and was removed. Do not reinstall it as if it was the working fix. ICO tests cover orientation/alpha, embedded PNG and malformed bounds.
- Observed on 2026-10-01: `https://trends.google.com/trends/` supplied title and description but no social preview image. Its introductory page artwork resolved to **`https://ssl.gstatic.com/trends/training/data.png`**, a real 484 by 272 Google-hosted repeating Trends-logo image. **It was downloaded from Google, not generated from the icon. It is not the illustration in the user's Miro screenshot.** Miro's exact discovery/cache source was not established. Do not promise an exact match or fabricate provenance.
- Observed Google homepage metadata omitted a description. The exact `google.com` / `www.google.com` root page gets a narrow built-in summary only if missing: “Search the web for webpages, images, videos, news and more.” The logo came from microdata. That summary is a fallback written in the app, not text proved downloaded from Google. Other Google paths do not inherit it.

### Palette and editing

- The palette now includes true black `#000000` and a multicolor plus swatch backed by native `input[type=color]`. Shared `setSelectionColor` updates an active editing session or makes a normal engine edit for the selected objects.
- Swatch changes during editing preserve the draft and return focus. The native color input is exempt from the toolbar's pointer `preventDefault`, and its change handler does not forcibly focus the textarea while the picker is in use. Do not break the picker by indiscriminately preventing all toolbar pointer defaults.
- A one-off packaged check saved black and a custom `#a34fd2`, verified undo, and captured an inspected palette screenshot with zero renderer exceptions. It exercised the color input event path, not manual operation of the OS color dialog. Its temporary script was removed; evidence: `.local-test/desktop-input-cLEB8K/palette.png`.

## Recent evidence and Git handoff

### Follow-up: uploaded board icons

`src/components/BoardIconImage.tsx` handles file selection/drop and the crop draft in the board icon dialog. `src/canvas/icon-crop.ts` clamps square crops for landscape/portrait images. The normalized imported preview provides orientation-correct pixels; Save produces a 512px PNG through a CORS-enabled local media image and canvas. The draft is not applied until Save, and choosing a built-in glyph clears it. Supported inputs follow the existing local image pipeline (PNG/JPEG/WebP/GIF/AVIF/TIFF/ICO), with static output for animation. No remote upload service is involved.

Custom icons use `asset-<64-character SHA256>` in the existing board `icon` field; no schema migration. `BoardGlyph` renders the local thumbnail wherever board icons appear. `updateBoard` validates the reference is an image; export must include the icon asset independently of canvas object assets, and import must require it in the manifest. Duplication already copies the icon string. Do not shorten validation to the old 40-character glyph regex and accidentally reject uploaded icons.

Run `node scripts/desktop-board-icons.mjs` for upload chooser interception, drop handling, real crop dragging, saving/cancelling, built-in restoration and portable transfer. Passing fixture: `.local-test/desktop-input-OE2WAL`; crop screenshot inspected. Tests now total 106. Wait for React to render drag changes before asserting geometry; the first immediate DOM read raced rendering. This test uses its own disposable library and never changes the user's icon.

Follow-up correction: the user meant dropping onto the **sidebar board icon**, not just inside the dialog. The initial implementation missed that target; the internal board-reorder parser silently discarded files. `Launcher` now routes file drops from both sidebar and folder-board buttons through `onIconDrop`, while preserving internal move bubbling. `App` passes the file to the icon dialog, where `BoardIconImage` loads it once on mount. Test the exact target in the screenshot, not a convenient nearby target. The updated packaged suite uses `Input.dispatchDragEvent` with a real file path for sidebar/folder drops; `.local-test/desktop-input-CsXgWs` passed. Existing native board-to-folder dragging passed in `.local-test/docking-76h1Ui`.

- `b438b54`: docking/window shadow; `b98610e`: white frames and contained movement; `c04819b`: rich links and rounded compact cards; `7e90fc6`: ICO/site-image recovery; `a3c15c8`: compact/image mode toggle. Those commits were pushed to `codex/local-canvas` during this chat.
- At handoff inspection, **`616b4c1` Add editable image titles to canvas menus** had arrived from another session. It adds image-title behavior/tests. Preserve it; do not claim it was implemented by this session or revert it while editing the shared toolbar.
- Compact-switch packaged suite passed in `.local-test/desktop-links-4XEUv8`; screenshot inspected in `.local-test/desktop-links-CKfXBW`. ICO/image discovery passed in `.local-test/desktop-links-UdElzA`. These were earlier runs, not automatic proof every future change passes.
- The final pending UI changes for this handoff are hidden irrelevant alignment controls and the black/custom palette, alongside this document. Fresh `npm test` during handoff passed **104/104**. Record new verification rather than treating these counts as permanent requirements.

Before committing: inspect the full diff, run appropriate verification and `git -c core.safecrlf=false diff --check`. Stage explicit task files. After committing, audit `git show --stat HEAD`. For a requested push, push the actual branch without force, then compare `git rev-parse HEAD` against `git ls-remote origin refs/heads/codex/local-canvas` and check the worktree. If a concurrent commit appeared, inspect and preserve it; never reset to the hash remembered in this document. Reopen the verified packaged app for the user after a UI feature. Report what changed, verification and any material limitation succinctly.


Packaging fallback observed 2026-10-01: Electron Builder hit HTTP 504 while retrieving Electron even though `node_modules/electron/dist` already existed. After the failed process exited, `npm run build` followed by `npx electron-builder --win dir --config.electronDist=node_modules/electron/dist` successfully used the installed Electron distribution. Verify the installed Electron version matches the package version first; this avoids an unnecessary download, not compilation or packaged testing.

## Animated board and folder ordering
Boards and folders sort by **pointer events, not HTML drag-and-drop**: the user rejected the browser's faded ghost image and red no-drop cursor. `useLauncherReorder.ts` lifts the tile's own `.app-icon` into the top layer (`popover="manual"`, fixed position) so it follows the pointer unclipped with no clone, hides the source slot, and animates it into its slot on release. Items are `draggable={false}`; do not reintroduce `draggable`/`dataTransfer` for internal moves. HTML drop handlers in `Launcher.tsx` now exist only for image files dropped onto board icons. A 5px threshold separates click from drag and the click after a drag is suppressed; Escape, blur, resize or releasing away from a group cancels. Boards can also be carried between the strip and an open folder sheet. During a drag, it snapshots untransformed slot offsets and translates sibling items with a 220 ms easing transition; it does not reorder the DOM or write storage on hover. Persist the new position between neighboring items only on drop. Clear preview transforms before paint when the saved library order arrives, avoiding a jump back. The middle of a folder accepts a board into it, while folder edges permit reordering; folders themselves reorder among root boards. Folder-grid boards also preview their new slots. Containers must remain positioned so offsetLeft/offsetTop are relative to the scroll container. Reduced-motion skips the transitions.

`scripts/desktop-reorder.mjs` uses real mouse press/move/release to check that the held tile is the real element under the pointer, that no `dragstart` ever fires, sibling animation, vertical/horizontal order, folders, folder-grid ordering, moving out of a folder, Escape/release-away cancellation and persistence. `desktop-docking.mjs` and `desktop-board-icons.mjs` cover panel docking and external image drops; all three passed against the packaged build for this change.

## Multi-object proportional scaling
Multiple selections show four fixed-screen-size corner handles. Drag any corner to scale all selected objects about the opposite corner, including positions and text sizes. One common scale respects every object's size/font limits. `resizeSelection` in `src/canvas/resize.ts` owns this calculation. The engine snapshots contained objects of selected frames as well, deduplicates them, and saves one undo transaction. Single-frame resizing retains its original region-only behavior. Regression tests cover all corners, cancellation, undo and frame contents; the packaged interaction suite checks a real whole-selection drag and writes `selection-scale-handles.png`.

## Board icon shape and palette
The icon dialog offers rounded-square and circular masks, including a matching live crop mask, plus seven pastel colors (yellow added). `boards.iconShape` is an additive SQLite column defaulting to `rounded`; preserve it through update validation, duplication and portable manifests. The image asset stays square and unmodified so changing shape is reversible. `AppIcon` and the board header apply the chosen mask. `tests/board-icon.test.mjs` covers shape/color persistence and validation; `scripts/desktop-board-icons.mjs` checks circle crop, yellow selection and saved state in the packaged app.

## Editable arrows
Arrow tool uses **A**, with drag creation and a useful default length on click. `src/canvas/arrows.ts` owns normalized points, sampled curves, midpoint insertion and line hit testing; `arrow-rendering.ts` draws strokes and independent endpoint markers. Single-arrow selection uses endpoint/bend handles, not rectangular resize handles. Drag intermediate dots to insert bends; double-click interior knots to remove. All gestures snapshot original geometry for one-step undo/cancel. Horizontal/vertical arrows keep storage dimensions >=1 but normalized points preserve the true path when shrinking a group.

ArrowControls owns line style, dash, thickness, heads, swap, color and label drafts; Whiteboard flush includes pending arrow text. Arrow data must be validated in both `electron/store.cjs` and `src/canvas/content.ts`, including finite normalized coordinates, 2–32 points and bounded thickness. Export/import uses the existing object JSON. Endpoints are free-positioned, without automatic object attachment. Packaged `desktop-interactions.mjs` exercises draw, bends, endpoints, style, labels and reopen, with `arrow-controls.png` as visual evidence.

Arrow follow-up: do not force horizontal Bezier tangents at each knot. Curves now use component-wise monotone Hermite tangents from adjacent knots, with terminal tangents following the endpoint segment. This fixes steep-arrowhead orientation while keeping the path inside the object's bounds. Insertion dots use the sampled curve midpoint, not the chord midpoint. Marker direction follows the sampled path. Endpoint menus show SVG previews; the line settings show all path/stroke choices and a live 0.5–40 thickness slider together. Slider changes persist live without recording each sample; release/blur/flush records one undo transaction. The packaged interaction test clicks preview buttons and drags the actual slider, including one-step undo/redo.

Arrow shaft ends must be shortened by path length into their markers before stroking: a rounded shaft drawn to a filled tip sticks out visibly at large thickness. Marker positions/directions still use the full path. Very short arrows can have overlapping markers and no shaft; never generate reversed or non-finite geometry. The new pale-blue orbit app icon lives in `assets/icon.png` and `assets/icon.ico`; `scripts/fixtures.mjs` must not regenerate the old icon when making test media. Electron uses the PNG for its window, and electron-builder embeds the ICO in the executable.

Arrow label font size uses a live 8–300 range slider with a size readout and one undo step per drag, matching thickness behavior. The label text field has explicit rounded styling; do not fall back to the browser's square input. `arrowLabelObject` in `frame-label.ts` measures the label for rendering, hit testing and spatial bounds. The old fixed 240-unit box clipped larger labels; changing only the slider without expanding that geometry was insufficient.

Arrow label text on the canvas must have **no background**. The user explicitly rejected the white backdrop; render only the transparent text sprite, allowing the arrow and objects beneath it to remain visible.

## Alignment snapping while moving
`src/canvas/snapping.ts` indexes left/center/right and top/center/bottom anchors. The engine snapshots stationary candidates from the visible viewport plus a 100-screen-pixel margin at drag start, excluding every moving object (including frame contents). Sorted, merged anchors allow binary-search lookups on pointer moves without scanning the board each frame. Snap distance is 6 screen pixels, with a 10-pixel release threshold to avoid jitter. Alt bypasses snapping. Groups and carried frame contents share one delta, retaining their layout; rotated objects use their world-aligned bounds. This applies to object movement, not resize handles or arrow bend editing. Guides are thin dashed screen-space lines and clear on release, Escape, pointer cancellation and blur. Normal single-operation undo/save behavior is preserved.

`node scripts/desktop-snapping.mjs` uses a disposable library to check image/text snapping, actual guide pixels during/after drag, Alt bypass, undo/redo, cancellation and persisted placement. Native screenshot antialiasing can lighten guide colors; compare blue-channel contrast rather than one exact RGB value, and use tolerance for floating-point positions.

## Bold and strikethrough
Selection toolbar Bold and Strikethrough toggle whole text objects (not rich-text ranges), including note/shape text, frame names, arrow labels and existing image titles. Mixed selections enable the property for all eligible objects; images without titles, links and video are excluded. Ctrl+B works on the selection and during native text editing. Editing toggles preserve the draft/focus and save with the edit transaction.

Persist optional `bold` and `strikethrough` booleans through both storage validation and clipboard normalization. Bold participates in text layout caches, hidden textarea fitting, canvas raster fonts and native editor style; both flags participate in the engine view signature. Strikethrough is drawn separately per rendered line using its measured width and current color, with no background. Natural text objects refit when formatting changes. `node scripts/desktop-text-formatting.mjs` verifies actual toolbar/keyboard input, editor appearance, mixed selections, undo/redo and reopen in a disposable library. This implementation passed 131 unit tests, production build and the packaged check (`.local-test/desktop-input-rFPkGg`); run fresh checks for future changes.

## Text at overview zoom
Do not hide text based solely on camera zoom. The former `zoom > 0.16` detail gate made all text disappear abruptly, even when large fonts were still readable. Keep that gate only for decorative link controls; text, note/shape contents, frame/image titles, arrow labels and link captions render at every zoom. Their view signatures must still include resolution and visible region below 16%, so subsequent zooms/pans update textures. Existing viewport culling and zoom-scaled raster resolution bound rendering work. `scripts/desktop-text-zoom.mjs` checks actual text pixels in the packaged app from 15% down to the normal zoom minimum (2.5% in `geometry.ts`); it reproduced the missing text before the fix.

## Color-only and emoji board icons
Built-in symbols now use `BoardSymbolPicker.tsx`: four quick choices plus a More button opening a large icon gallery. The selected symbol stays in the quick row so clicking it again clears it. `IconPickerOverlay.tsx` shares the portal, parent inert state, Escape handling and focus restoration with the emoji picker; preserve the emoji gallery virtualization.

New boards use `icon: 'none'` and show the uppercase first grapheme of their name by default. The icon dialog's Show first letter switch controls `showInitial`; explicit symbols, emojis and uploaded images take precedence over the letter. Existing explicit icons stay unchanged. `boards.showInitial` is an additive SQLite boolean column defaulting to 1, returned as a boolean and preserved through duplication, portable transfer and MCP edits. Both `iconShape` and `showInitial` must be included in `library()` metadata or reopening the picker loses its saved settings. Packaged icon checks cover rename-to-initial updates, clearing a symbol, disabling the letter, persistence and both overlays; unit checks cover migration and transfer.

Emoji performance: mounting all 959 buttons caused a cold first-open layout stall (378 ms layout, 388 ms until the second animation frame on this PC). `EmojiGallery.tsx` renders only visible rows plus a one-row margin, with fixed 48px rows and responsive columns. All 959 choices remain in the scroll layout; arrow keys/Home/End can focus unmounted choices after scrolling. Packaged measurement dropped to 63 ms layout / 69 ms opening with 139 mounted buttons. Reopening was about 10–12 ms. `node scripts/desktop-emoji-performance.mjs` measures cold/warm opens in a disposable packaged library; timings are machine/run specific. Do not eagerly render the full catalog again. CSS content-visibility alone still cost about 212 ms in the probe.

Board icons support explicit `none` (color only) and `emoji:` followed by one Unicode emoji grapheme, in addition to built-in names and asset IDs. Clicking a selected built-in/emoji toggles it off; the preview removes the current icon. BoardEmojiPicker shows four emojis plus a More button. More must open a wider, larger portal overlay above the icon dialog, not expand the form inline. Its bundled catalog has 959 emojis in categories; custom input is only “Paste custom emoji…” and OK, with no instructional paragraph. Picking closes the overlay; Escape closes only the overlay and restores focus to More. Parent dialog is inert while the overlay is open. Keep `none` explicit so import/default fallbacks do not restore the lightbulb. Store validation and portable transfer preserve emoji sequences. `desktop-board-icons.mjs` checks these flows alongside upload/crop.

## Local MCP server for Codex and Claude Desktop
Settings is a full-window page (`SettingsPage.tsx`), not a modal. Keep the underlying board mounted and inert so its camera/history survive. Stop keyboard and clipboard events at the settings page to prevent global canvas shortcuts; Back to board and Escape return to the existing canvas. The page owns scrolling, not the MCP section. The packaged MCP check verifies full-window bounds, shortcut isolation and the retained canvas.

Library options → Settings → AI access via MCP controls the loopback HTTP server. Off by default for new libraries; persisted enabled/port/token live in ignored `Library/settings/mcp.json`. `electron/mcp-server.cjs` hosts the official SDK stateless Streamable HTTP transport with bearer authentication, Host/Origin checks and bounded bodies. All tools use the existing worker/store, never a second writer or direct database edits. `mcp-tools.cjs` exposes 11 typed tools covering boards, folders, complete object edits, local/base64 media import and actual image previews. Read pagination and edits carry revisions; never bypass conflict protection.

Before tool execution, main asks the renderer to pause input, finish drafts/imports and flush saves. Afterwards it refreshes metadata and applies changed objects into the current engine with one undo record while rebasing SaveQueue to the committed revision. Preview hydration is suspended during this interval. Reads preserve undo history. Test concurrency/drafts in the packaged app, not only direct Store tests.

Claude Desktop must launch the packaged EXE with `ELECTRON_RUN_AS_NODE=1` and the absolute `resources/app.asar/electron/mcp-stdio.cjs` argument, plus `CANVAS_DATA_DIR`. Running the GUI EXE with a custom `--mcp-stdio` flag closed its stdio connection immediately on Windows; do not restore that approach. The bundled proxy lists tools offline but forwards every data operation through the app's authenticated enabled server. No external Node install is needed.

`tests/mcp.test.mjs` exercises HTTP/stdio SDK interoperability, CRUD/media, revision conflicts, validation, authentication, origin/host rejection, disabling queued writes, settings persistence and port conflicts. `scripts/desktop-mcp.mjs` exercises the actual packaged settings switches, drafts, canvas refresh, undo/redo, photo upload and the packaged stdio entry. Initial final verification: 135 unit tests, production build and packaged run `.local-test/desktop-input-BKJsAF` all passed. See `docs/MCP.md` for tool/client documentation. User selected Codex and Claude Desktop; their local configurations were backed up and Terra entries added, with existing settings preserved. Claude is a Windows Store install, so its active config is under the Claude package's LocalCache/Roaming/Claude rather than normal Roaming/Claude. Server was enabled on port 47831 and both configured transports listed 11 tools against the running app. Clients need restart to load new entries. Never commit the token or client config backups.

## Bundled fonts (Inter) and packaging while MCP clients run
Text marks can use `font: 'inter'`: Inter from `@fontsource-variable/inter` (exact version, OFL-1.1), a free near-twin of Apple's San Francisco. The font list lives in three places that must agree: `textFonts`/`fontFamilies` in `src/canvas/rich-text.ts` (menu, canvas, clipboard), `markFonts` in `electron/store.cjs`, and the mark `font` enum in `electron/mcp-tools.cjs`. `tests/rich-text.test.mjs` holds all three. Canvas text never waits for a web font and is cached once drawn, so `src/fonts.ts` loads Inter's Latin, Cyrillic and Greek parts (normal and italic) before `main.tsx` renders, with a 2 s cap. The Vite licence plugin also counts bundled asset files (fonts arrive through CSS), so Inter is listed in About.

Packaging: every MCP client (Claude Desktop, Claude Code, Codex) runs `mcp-stdio.cjs` from inside `release/win-unpacked`, which locks `app.asar` and the EXE even after the app is closed. Stop only those `mcp-stdio` processes, package, then reopen the app; clients start a new helper on their next call. A client keeps the tool schema it listed when its session began, so a session started before a schema change still rejects new enum values until it is restarted.

## Linux build
Linux x64 (AppImage + .deb) builds only in GitHub Actions (`.github/workflows/linux.yml`, manual or on `v*` tags; artifact only, never a release). Building on Windows would ship Windows sharp/onnxruntime binaries. Platform branches: `userDataBase` (XDG library path), `managedServerFile` (`/etc/terra-board/server.json`), preload omits `recognizeAsset`/`recognizeImage` off Windows (OCR off, `canRecognizeText()` false), `officeLocation` uses the system LibreOffice on Linux and the catalog marks Office files `unavailable` otherwise, yt-dlp payload per platform (`ytDlpBuilds`, `executable` flag chmods it), `installsUpdates()` (only the AppImage self-updates; reads `latest-linux.yml`), no login item on Linux. AppImage-only: `integrateAppImage` writes its own menu entry (needed for `terraboard://`), `systemEnv` strips the AppImage's folders from LibreOffice's environment, and the MCP stdio entry is a `/bin/sh -c` script that runs `$APPIMAGE --appimage-mount` and starts mcp-stdio.cjs from the mount (`stdioLauncher`): the mount path changes per launch, and going through AppRun would add `--no-sandbox`, which Electron's node mode rejects ("bad option"). Launch at login on Linux is an XDG autostart entry (`setAutostart`). Keep Windows paths unchanged when touching these; tests pass `platform` explicitly so they run on both systems. CI proves the packages with `scripts/app-smoke.mjs` (board+note+image survive a restart, extensions install and run, MCP stdio works) on the AppImage and the installed .deb with Ubuntu's userns restriction on. See docs/development.md → Linux.
