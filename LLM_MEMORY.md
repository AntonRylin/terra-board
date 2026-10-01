# Local Canvas: session memory and working guide

Last verified: 2026-10-01. This is the project handoff from the session that implemented docking, window polish, frames, rich links, compact cards, and palette improvements. Read this before working on the app. Treat source code and fresh verification as authoritative when this file gets older.

## Start here

- **Actual repository: `D:\Projects\terra`.** The chat may start in an empty OneDrive `New project` directory. Set the working directory explicitly; do not create a second project there.
- Current branch at handoff: **`codex/local-canvas`**. Remote: `https://github.com/AntonRylin/local-canvas.git`. Check `git status`, branch, log and diff before editing. Other sessions have worked in this same checkout; do not reset, overwrite or attribute their work to yourself.
- This implementation is **Electron + React + TypeScript + PixiJS**, with a SQLite storage worker. Earlier Qt/native architecture discussions are not the implementation to build.
- Source version at handoff is **0.1.24**. Verify `package.json`; do not assume every small edit increments it.
- The user's real data lives in **`D:\Projects\terra\Library`**. It is outside the replaceable build directory and ignored by Git. Never use it for automated test fixtures or delete it to fix a build.
- The deliverable is **`release\win-unpacked\Local Canvas.exe`**, launched through **`Open Local Canvas.cmd`**. A successful web build does not update the packaged executable.
- Read `README.md` for current features and `docs/verification.md` for dated evidence and limitations. Local test output paths in these documents are evidence on this computer, not files included in Git.

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
Get-Process 'Local Canvas' -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Path -eq 'D:\Projects\terra\release\win-unpacked\Local Canvas.exe' -and
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
Start-Process -FilePath 'D:\Projects\terra\Open Local Canvas.cmd' `
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

## Product behavior established in this chat

### Window and board panel

- The board panel docks to left, right, top or bottom by dragging empty space. Destination preview, smooth transition, Escape/cancel, orientation-specific scrolling, saved placement, icon reordering and folder drops must coexist.
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

- `b438b54`: docking/window shadow; `b98610e`: white frames and contained movement; `c04819b`: rich links and rounded compact cards; `7e90fc6`: ICO/site-image recovery; `a3c15c8`: compact/image mode toggle. Those commits were pushed to `codex/local-canvas` during this chat.
- At handoff inspection, **`616b4c1` Add editable image titles to canvas menus** had arrived from another session. It adds image-title behavior/tests. Preserve it; do not claim it was implemented by this session or revert it while editing the shared toolbar.
- Compact-switch packaged suite passed in `.local-test/desktop-links-4XEUv8`; screenshot inspected in `.local-test/desktop-links-CKfXBW`. ICO/image discovery passed in `.local-test/desktop-links-UdElzA`. These were earlier runs, not automatic proof every future change passes.
- The final pending UI changes for this handoff are hidden irrelevant alignment controls and the black/custom palette, alongside this document. Fresh `npm test` during handoff passed **104/104**. Record new verification rather than treating these counts as permanent requirements.

Before committing: inspect the full diff, run appropriate verification and `git -c core.safecrlf=false diff --check`. Stage explicit task files. After committing, audit `git show --stat HEAD`. For a requested push, push the actual branch without force, then compare `git rev-parse HEAD` against `git ls-remote origin refs/heads/codex/local-canvas` and check the worktree. If a concurrent commit appeared, inspect and preserve it; never reset to the hash remembered in this document. Reopen the verified packaged app for the user after a UI feature. Report what changed, verification and any material limitation succinctly.
