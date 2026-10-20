# Extensions: a modular Terra Board

Date: 2026-10-20. Status: proposal, not started.

Sizes are as Windows shows them (MiB). "Installed" is the `release\win-unpacked` folder; "installer" is `Terra-Board-Setup-x64.exe`.

## Summary

Terra's installer is 345 MB and the installed app is 864 MB. Very little of that is the optional features themselves: the gallery is a few kilobytes of code, Word preview is a 171 KB chunk, and all renderer code together is 7.6 MB. The space goes to three things:

1. Libraries the app ships twice. Vite already bundles them into `dist`, and electron-builder copies them again into `app.asar` because they are listed in `dependencies`. That is about 225 MB installed, counting the extra Chromium languages.
2. The background-removal AI: the u2net model (168 MB) plus onnxruntime (65 MB), half of the installer.
3. Electron itself, about 320 MB installed and 87 MB in the installer. This is the floor.

The proposal has two parts:

- **Packaging fixes** (step 1, done 2026-10-20). They took the installer to 288 MB and the install to 580 MB, with no feature changes.
- **Extensions** (steps 2 to 4). Optional features become packages people install and remove in **Settings → Extensions**.
  - The installer ships only the core: about 100 MB, about 390 MB on disk.
  - Heavy payloads (background removal, the Office converter, the song downloader) and optional features (galleries, albums, Word documents, PDF tools, web cards, papers, sharing, AI access) download when someone wants them.
  - A board that uses an extension you don't have still opens and keeps all of its content.

## Where the space goes today (measured)

| Part | Installed | In installer |
|---|---|---|
| Electron runtime: Chromium with English only (exe 235 MB, DLLs, paks) | 319 MB | 87 MB |
| The other 54 Chromium languages | 48 MB | 8 MB |
| Libraries packed twice: pixi.js 68 MB, pdf.js 33 MB plus its unused native canvas binary (`@napi-rs/canvas`) 37 MB, lucide-react 20 MB, react-dom 8 MB, gifuct-js, dompurify, docx-preview | 176 MB | ~47 MB |
| Background removal: `u2net.onnx` 168 MB, `onnxruntime-node` 65 MB | 233 MB | 175 MB |
| yt-dlp, which fetches entrance songs | 18 MB | 17 MB |
| Terra itself: `app.asar` without the duplicates 52 MB (of which `dist` is 7.6 MB), sharp 20 MB | 72 MB | 12 MB |
| **Total** (parts are rounded) | **864 MB** | **345 MB** |

**How these numbers were measured**
- `du` on `release\win-unpacked` (0.1.28).
- The installer share of each part comes from compressing it with 7-Zip `-mx=9`. That is the setting electron-builder uses for the NSIS archive, and the parts add up to the real installer within 1 MB.
- A scratch build with the renderer-only packages moved to `devDependencies` and `electronLanguages: ['en-US']` measured 473 MB. The scratch copy left out the 168 MB model, so with the model it comes to 641 MB.

**Other findings**
- `onnxruntime-node` carries `DirectML.dll`, `dxcompiler.dll` and `dxil.dll` (38 MB). Background removal runs on the CPU provider, so these are likely unused (`image-cutout.cjs:73-78`).
- The Office converter (LibreOffice) is not in the numbers above.
  - It is a 356 MB MSI, downloaded on first use and extracted into `Library\tools\libreoffice-26.2.6\` (`office-converter.cjs:86-87`). Its size once extracted was not measured.
  - No UI can remove it.
  - A version bump leaves the old folder behind.
  - Because it sits in the Library, it also travels with every manual Library backup.
- The renderer's main chunk is 1.56 MB.
  - It includes pdf-lib (about 390 KB) and fflate, which load at startup even for people who never touch a PDF.
  - pdf-lib ships a second time inside `pdf-edit.worker`.

## Goals

1. **Small download and install.** The installer carries only the core.
2. **One visible place for optional features.** Settings → Extensions lists every one with its size and how many boards use it, and lets people install, update and remove them.
3. **A modular codebase.** Optional features live in their own folders and reach the core only through a small set of contribution points. Today that knowledge is about 200 object-type checks spread through `engine.ts` (3,083 lines) and `Whiteboard.tsx` (4,587 lines).
4. **Boards never break.** Content from a missing extension still opens, draws something sensible, and stays byte-for-byte intact through save, sync, copy, export and import.
5. **No slowdown.** Rendering holds 144 Hz. Startup stays the same or gets faster, since less code loads at start.

## Non-goals (for now)

- **Third-party extensions or a public marketplace.** Extensions are first-party only. The design keeps a path open to these later (step 5).
- **Platforms other than Windows x64.** This is the same scope as today.
- **Replacing Electron to get under the ~320 MB floor.** Tauri or WebView2 would weigh about 10 MB, but they would mean rewriting the main process: the SQLite worker, sharp, MCP, webviews and offscreen capture.
- **Changing the board format of existing features.**

## Anti-goals

- **Silent data loss.** A board must never lose content because an extension is missing, or because a device without the extension synced over a device with it.
- **Fragile extensions.** Extensions must not slow the board down or break when the app updates.
- **Pushy installs.** No setup wizard, and no "install more" nagging.

## Decisions

These are my calls; the user can override any of them.

### 1. The board format stays in the core; extensions own behaviour

The core keeps defining and validating every existing object type and field, including:
- `album`, `gallery*`, `pdfComposer`
- `html`, `browser`, `paper`
- `items`, `documentPreviewId`

Extensions own everything else about their objects:
- drawing
- editing
- menus
- viewers
- import handlers

This is necessary, not just tidy. `objectValue` (`electron/store.cjs:279-573`) **rejects** unknown types and **strips** unknown fields on every write path:
- `patchBoard`
- `importBoard`
- cloud sync apply (`store-sync.cjs:638`)
- copy and paste (`image-clipboard.cjs`)
- live-share guest edits

MCP `edit_board` adds a strict zod schema with its own fixed type list (`mcp-tools.cjs:93-212`). If the format left the core together with the feature, these paths would drop or reject that feature's data on any machine without it.

Keeping the format in the core means extracting today's features changes **no stored data**. No migration is needed. Saving, sync and export behave the same with or without the extension.

### 2. Extensions are built with the app and shipped separately

**What gets built**
- One Vite build produces the core and every first-party extension. Each extension is a lazy `import()` entry point.
- A post-build step assigns every output file to exactly one owner: the core or a single extension. It then packs each extension into `<id>-<version>.terra-ext`, a zip.
- At build time the core embeds the catalog: manifests, file lists, SHA-256 hashes, sizes and download URLs.

**Versioning**
- Extension code shares the app's version.
- Large payloads (the AI model, runtimes, external tools) have their own versions and are named by content hash, so an app update doesn't download them again.

**Why**
- There is no SDK or compatibility layer to maintain while the contribution points are still changing. Every extraction in step 4 will change them.
- React and Pixi are shared automatically.
- No catalog server or signing key is needed, and integrity is as strong as the installed app itself.

**Cost**
- A fix to an extension ships with an app release.
- An app update fetches the small code packages of the extensions that are installed.

When third-party extensions are wanted, freeze the host API and move it to a stable module (step 5).

### 3. Manifests come first

Every extension has a manifest that the core always carries, installed or not. A manifest declares:
- the object kinds the extension owns: a type such as `paper`, or a base type plus a marker field such as an `image` with `album`;
- its fallback;
- its menu and tool entries;
- commands and default shortcuts;
- settings sections;
- file types;
- MCP tools;
- dependencies, such as Entrance songs needing Sharing;
- payloads.

With this data and no extension code loaded, the core can:
- draw fallbacks;
- count usage per board with a `json_extract` query;
- offer one-click installs;
- auto-install the extensions an upgraded library needs;
- show menu entries only when the extension is installed.

### 4. Where extensions are installed

**Location**
- Installed builds: `%LOCALAPPDATA%\Terra Board\Extensions\`, next to `Library` rather than inside it, so a Library backup doesn't carry hundreds of re-downloadable megabytes.
- Repository builds (`release\win-unpacked`): `<repo>\Extensions\`, which must be git-ignored. They install from the local build output (`release\extensions\`), so a packaged test build has everything offline and the current workflow doesn't change.
- `TERRA_EXTENSIONS_DIR` overrides the location, for tests.

**Other housekeeping**
- The Office converter moves here from `Library\tools\`.
- The NSIS uninstaller removes `Extensions` but keeps `Library`.

### 5. Where downloads come from

**Sources**
- Extension code: the GitHub release of the same app version, `releases/download/v<version>/<id>-<version>.terra-ext`.
- Payloads: a fixed `payloads` release, by content hash.
- Both are checked against the SHA-256 embedded in the app.

**How downloads run**
- They run in the main process with Electron `net`, so proxies work, and they report progress and can be cancelled. The renderer can't reach the network anyway (`main.cjs:541-549`).
- Extraction rejects zip-slip paths, has a size cap, unpacks into a temp folder and finishes with an atomic rename, following the LibreOffice download pattern in `office-converter.cjs:97-164`.

**Fallback**
- **Install from file…** accepts a `.terra-ext` for offline PCs or blocked GitHub.

### 6. Native code runs outside the app process

**Background removal**
- Today: a worker nested inside the SQLite worker (`store.cjs:1142` → `background-removal.cjs:18`).
- Proposed: ONNX runs in a `utilityProcess`, started per job and ended after it, as the worker is today.
- **Remove** works immediately, because no DLL stays loaded and locked, and a crash can't take the app down.

**LibreOffice and yt-dlp** already run as child processes.

### 7. One generic bridge

**The bridge**
- The preload gains `canvas.ext.invoke(id, method, args)` and `canvas.ext.on(id, event, callback)`.
- The main process routes these to handlers the extension registered, behind the same `trusted(e)` check.
- The preload never changes for a new extension. It lives in `app.asar` and can't change at runtime anyway.

**What moves behind it**
- Today's feature-specific preload calls move behind this bridge as each feature is extracted: `cloud.*`, `live.*`, `mcp*`, `html*`, `browser*`, `convertOffice`, `songFromLink`, `importAlbumFiles`, `locateAsset`.
- The same applies to the feature-specific store commands:
  - `removeBackground`, `assetLinks`, `boardSyncs`;
  - four allowlists to keep in sync today: `main.cjs:273`, `worker.cjs:7`, `vite.config.ts`, `live-share.cjs`.

### 8. No first-run wizard

**For new installs**
- The installer installs the core.
- Extensions come from Settings → Extensions, or at the moment one is needed:
  - opening a board that uses one;
  - dropping a file only an extension can open;
  - the **Install** button on a fallback card.

**For upgrades from 0.1.x**
- On first launch, the app installs the extensions the library already uses and shows one notice.

### 9. Install and Remove only

There is no separate enable/disable switch. Removing an extension hides all of its entry points; boards keep their content. Each installed extension's own settings appear under it in Settings.

### 10. Each extension's UI is isolated

Every UI piece an extension contributes is wrapped in an error boundary; today the app has none. A failing extension shows "<Name> stopped working · Reload · Remove" instead of a blank board.

## The core and the extensions

### What stays in the core

**Canvas and objects**
- The canvas engine and editing: select, move, resize, rotate, group, undo, snapping, locks, spoilers, linked frames.
- Text, notes, shapes, frames, arrows, highlighter, lists.
- Images (viewer, crop, copy as image) and video.
- Link cards, including YouTube playback.

**Files and export**
- Any file as an attachment card (download, rename, edit text files).
- PDF reading: card preview and reader.
- Copy text from images and PDFs, using Windows OCR with nothing to download.
- `.canvas` import and export, plus PNG, JPG and PDF export.

**App**
- Boards, folders, search, trash.
- Appearance, settings, shortcuts, updates.

**Why these:** they are what a whiteboard is, they cost nothing extra, or they are properties that every object type depends on (spoilers, locks, linked frames). Extracting those would touch every renderer path for no gain.

### Extensions, v1 catalog

| Extension | What it adds | Download / on disk |
|---|---|---|
| Background removal | "Remove background" on images and on photo board icons. Flat-icon cut-outs need no model (`flatIconMask`) and stay in the core. | ~165 MB / ~200 MB, if the DirectML DLLs prove unnecessary (233 MB on disk today) |
| Office files | Open and convert `.doc`, `.xls`, `.ppt`, `.rtf` and OpenDocument through LibreOffice | 356 MB / LibreOffice's extracted size (not measured) |
| Entrance songs | Song clips when you join a shared board (yt-dlp). Needs Sharing. | 17 MB / 18 MB |
| Sharing and live presence | Cloud sharing, live share, cursors, follow, profiles (Supabase) | < 1 MB |
| AI access | The MCP server and tools for Claude and Codex | ~1 MB |
| Web cards | HTML embeds, browser frames, the `html_embed` MCP tool | < 1 MB |
| PDF tools | PDF workspace, edit, reorder and merge pages, convert PDF ↔ images, export dialogs (pdf-lib) | ~1 MB |
| Word documents | DOCX preview, and DOCX/HTML → PDF conversion (docx-preview) | ~0.2 MB |
| Albums | Album cards, the album viewer, linked originals | < 0.1 MB |
| Galleries | Screenshot grids | < 0.1 MB |
| Papers | A4 written documents | < 0.1 MB |

**Rule for future features:** a new optional feature starts as an extension. It moves into the core only if most people need it or every object type depends on it.

## How it works

### Repository layout

```
src/                     core renderer
  host/                  host API: registries, extension loader, fallbacks
electron/                core main process
  extensions/            manager (install, remove, stage), host (activate main parts), router
extensions/
  albums/
    manifest.json
    renderer/index.ts    default export: defineExtension({ activate(terra) { … } })
    main/index.cjs       optional: exports.activate = (host) => { … }
    tests/
  background-removal/
    manifest.json        payloads: model, onnxruntime, VC++ runtime (url, sha256, size)
    main/…               utilityProcess worker
  …
scripts/build-extensions.mjs   ownership check, packs .terra-ext files, writes the embedded catalog
```

**Import rules, enforced by a build check:**
- Core code never imports `extensions/**`, apart from the generated loader map.
- Extensions import the core only through `src/host`.
- Extensions never import each other. They use declared services: Entrance songs, for example, gets presence from Sharing through `terra.services.get('sharing')`.

### Manifest example

```json
{
  "id": "albums",
  "name": "Albums",
  "description": "Unite images into one card you can flip through.",
  "icon": "photo",
  "kinds": [{ "id": "album", "base": "image", "field": "album", "fallback": "base" }],
  "contributes": {
    "menus": { "object.context": ["albums.make", "albums.open", "albums.release"] },
    "selectionTools": ["albums.settings"],
    "drop": ["albums.addImages"]
  },
  "activation": ["onKind:album", "onCommand:albums.make"],
  "requires": []
}
```

### Main process

**`ExtensionManager`** handles the extension lifecycle:
- reads `Extensions\installed.json`;
- installs: download → verify → extract → rename;
- removes: deactivate → end processes → delete, or delete at next start if a file is locked;
- counts usage through a store query;
- stages packages for app updates;
- exposes `canvas:ext-*` handlers for the Settings tab, with progress events.

**`ExtensionHost`** loads the main part of an installed extension on its first activation event and passes it a `host` object:
- `ipc.handle` and `emit`, namespaced by extension id;
- `store.call` for allowlisted generic store commands;
- `assets`: file path, import, read;
- `paths.payload` and `paths.data`;
- `utility.fork`;
- `mcp.registerTool`;
- `services`;
- `log`.

Extension main code is bundled with esbuild into a single file, so its npm dependencies (Supabase, the MCP SDK) leave the core. Native dependencies travel in its payload and are loaded by absolute path.

**Serving extension files**
- `canvas-app://app/assets/<file>` (`main.cjs:386-407`) also serves the files of installed packages, looked up by hashed file name in their file lists.
- Unknown names return 404. A failed `import()` means "not installed".
- This stays inside the CSP `script-src 'self'` and needs no new scheme. A new scheme would have to be registered before the app is ready anyway.

### Renderer host API: contribution points

Each point below replaces wiring that is hard-coded today.

| Contribution point | What an extension provides | What it replaces today |
|---|---|---|
| **Kinds** | Pixi view and view-cache fields, hit test, label, media and LOD choice, selection handles, resize rules, export drawing, open/edit/activate, duplicate and paste id remap, ownership rules (stacking, export, lock, spoiler, linked frames), edit middleware, async hydrate | `makeObjectView` chain (`engine.ts:2150-2587`), view signature (`1980-2036`), `hit` (`517-569`), LOD (`1864-1908`), selection chrome (`2656-2776`), export (`2803-2994`); `activate`, `startEdit`, `openObject`, `finishEdit`, `create` (`Whiteboard.tsx:1445-1770`); `resize.ts`, `stacking.ts`, `export-plan.ts`, `object-lock.ts`, `spoiler-objects.ts`, `frame-links.ts`; `engine.apply` → `galleryEdit` (`engine.ts:1615`) |
| **Overlays** | A DOM layer above the canvas, or under it with an erased hole. It receives visible objects and the camera, and keeps its own state. | The `lists`, `papers`, `composers` and `embeds` feeds (`engine.ts:1817-1834`); Whiteboard state and JSX (`Whiteboard.tsx:1796-1835`, `3209-3319`, `4497-4522`). Also removes a whole-Whiteboard re-render on each zoom frame. |
| **Menus and tools** | Context menu items, selection-toolbar buttons, Insert / More tools entries, radial-menu entries. Each has a `when` condition and a lock policy. | `contextItems` (`Whiteboard.tsx:2774-3164`, about 33 feature items); the selection toolbar JSX (`3540-4053`) and its closed id list (`selection-toolbar-layout.ts:3-35`); the tool lists (`4241-4291`) and `toolbarIds`; the lock allowlist that matches label text (`4380-4397`) |
| **Commands** | Namespaced command ids with default shortcuts, rebindable in Keyboard shortcuts | The closed `commands` array and `CommandId` union (`shortcuts/commands.ts:23-115`). Saved overrides for commands of extensions that aren't installed are kept. |
| **Files, drop and paste** | Handlers by file type, drop targets on objects, paste handlers | Drop chain (`Whiteboard.tsx:2652-2671`), paste chain (`2483-2555`), the MIME → type map (`2088-2122`), engine `objectDrag` / `objectDrop` |
| **Viewers** | Full-window surfaces. The host tracks which one is open and flushes it on close or board switch. | Per-viewer state and JSX (`Whiteboard.tsx:812-845`, `3334-3424`); DOM-class checks for `.pdf-workspace` / `.image-viewer` (`App.tsx:324`, `364`; `RadialMenu.tsx:158`; `Whiteboard.tsx:2479`); `flush` (`2327-2335`) |
| **Settings** | A section plus searchable rows | The closed `SectionId`, the JSX chain (`SettingsPage.tsx:218-236`) and the `rows` index (`settings-index.ts`) |
| **Services** | Values shared between extensions, and main-process handlers, store commands and MCP tools | Feature IPC channels in `main.cjs`; the tool list (`mcp-tools.cjs`); four command allowlists |

**Performance rules for the host API**
- Registries are consulted when a view is built or rebuilt, never inside the per-frame `draw()` loop.
- Core types keep their current code paths. Only extension kinds go through the registry, so the 144 Hz hot path doesn't change.

**Cross-feature links to undo first**
- **Albums**
  - Albums and galleries exclude each other, and the album badge reuses `galleryTargetsRef`.
  - Albums are excluded from PDF input.
- **Shared code living in the wrong feature**
  - `composerView` is typed as the Lists `ListView`.
  - `ListEditOutline`'s CSS lives in `canvas-lists.css`.
  - `page-text.ts` mixes image OCR with PDF code.
  - `document-files.ts` holds the image-title helper.
- **Web cards**
  - HTML embeds and browser frames share files, CSS and the capture loop. They become one extension.
  - The MCP `html_embed` tool belongs to Web cards and registers itself with AI access when both are installed.
  - "Open as browser frame" on link cards becomes a menu item that Web cards contributes.

These two are core-to-core and stay, but they are worth fixing while the code is open:
- Double-clicking an arrow clicks a DOM button inside `ArrowControls` (`Whiteboard.tsx:1474-1477`).
- The image and PDF viewers trigger OCR.

### Fallbacks when an extension is missing

| Kind | What the board shows |
|---|---|
| Album | The cover image, with an "Album · Install Albums" badge on hover |
| Gallery | A plain frame. Its images are ordinary images and stop reflowing. |
| PDF workspace | Its snapshot picture (`pdf-composer-snapshot.ts`), or a placeholder card |
| HTML embed, browser frame | The picture they already store |
| Paper | A placeholder card with the title and page count |
| Anything else | A placeholder card: icon, name, "Needs <Extension>", **Install** |

**What still works on these objects**
- select, move, resize, rotate, delete, duplicate, lock, spoiler;
- export, as drawn;
- search, because the search fields are core.

Double-clicking or editing one opens the install prompt. Renderer-only extensions start working without a restart; extensions with a main-process part start on install too, and only their removal can need a restart.

### Board data

**Kept as is (decision 1)**
- `objectValue`, the `content.ts` validators, the MCP schema, `referencedAssets` and the search fields all keep knowing every existing field.

**A generic slot, added before the first brand-new extension kind** (not needed to extract today's features)
- It takes the form of `type: 'ext'` objects plus an `ext` field on any object: `{ [extensionId]: { v, data, assets: [], text } }`.
- The core validates it generically: JSON only, a size cap, and every listed asset must exist.
- It is kept on every path, and its assets join:
  - export packing (`objectAssetIds`, `store.cjs:217-224`);
  - sync (`referencedAssets`, `store-sync.cjs:101-114`);
  - the server's `push_entities` asset refs (a Supabase migration);
  - live-share asset serving.
- `searchContent` searches `text`.

**Existing gaps found during the analysis, worth fixing regardless**
- **Album images in shared boards.** The server's `push_entities` asset refs (`20261015090000_sharing.sql:185-211`) leave out album images, which the client does list (`store-sync.cjs:111`). Share recipients can only read media in that list.
- **Rows lost during cloud sync.** Cloud apply skips a row that fails validation but still advances the cursor (`store-sync.cjs:502-508`), so the row is lost on that device. A device that later edits a stripped copy pushes it over the full one.
- **Saving can get stuck.** `SaveQueue` resends a rejected batch forever (`save-queue.ts:101`, `129-137`), so one rejected object blocks every later save on that board.
- **Incomplete license notices.** Settings → About → Open-source licenses misses:
  - optional and native packages, such as sharp's libvips, which is LGPL;
  - the u2net model, yt-dlp, the VC++ runtime and LibreOffice.

**Inferred from reading the code, not yet verified**
- **Browser-frame session not configured early enough.** The `persist:terra-browser` partition's permission rules and user agent are only applied on the first offscreen capture (`browser-frames.cjs:9-20`, `html-cards.cjs:199`). A frame opened before that may run on an unconfigured session.
- **OCR starts when nobody asked for it.** Opening the image viewer, or a PDF page with little text, starts the PowerShell OCR host (`ImageViewer.tsx:229-243`, `page-text.ts:71-73`).
- **Cursor messages with no one to receive them.** Cursor positions go over IPC up to every 70 ms on every board, even when no one else is there (`CollabLayer.tsx`).
- **A timer on every board.** A 1.5-second timer checks every open board for linked frames (`Whiteboard.tsx:2010-2012`).

### Settings → Extensions

**Placement**
- A new **Extensions** group sits high in the Settings sidebar: **All extensions**, followed by the settings pages of installed extensions (AI access's MCP settings move here, for example).
- It is also reachable from the launcher's three-dot menu, and from **Get more tools…** at the end of Insert / More tools.

**The All extensions page**
- Header: "Add the features you use. Removing one never deletes anything on your boards."
- A summary line: "6 installed · 1.4 GB on this PC", plus **Check for updates**.
- Filters: All, Installed, Available. Plus search.
- One row per extension:
  - icon, name, one-line description;
  - download size, or size on disk;
  - "Used on N boards";
  - one button: Install, Update or Remove.
- Installing shows progress in the row (percent, MB, **Cancel**).
- Dependencies are explained in plain words:
  - Installing Entrance songs offers to add Sharing.
  - Removing Sharing first warns that Entrance songs will stop.
- Removing an extension used on boards confirms first: "Albums is on 3 boards. They'll show the album covers until you install it again."
- **Install from file…** is at the bottom.

**Search**
- Settings search finds extensions by name and description.

### Updates

**App updates**
1. electron-updater downloads the new installer, as today.
2. The app then downloads the new version's code packages for every installed extension into `Extensions\staging\<version>`.
3. **Restart to update** appears only when both downloads are ready.
4. The first launch of the new version swaps the staged packages in.

**If a package can't be staged** (offline), those extensions wait and a banner offers to retry. Boards use fallbacks in the meantime and lose nothing.

**Payloads** download again only when their hash changes.

### Live share, MCP and cloud

**Live share**
- It serves the renderer bundle to guest browsers (`live-share.cjs:269`, `415-432`).
- It must also serve installed extension files.
- Guests see fallbacks for anything the host hasn't installed.

**MCP**
- `electron/mcp-stdio.cjs` stays at its current path inside `app.asar`, because AI clients' configs point there (`mcp-server.cjs:66`).
- The proxy should list tools from the running app over HTTP, instead of requiring `mcp-tools.cjs` at its own startup (`mcp-stdio.cjs:12`), so extension tools appear.
- Without AI access, the proxy answers with "AI access isn't installed in Terra Board".
- The HTTP server already builds its tool list per request (`mcp-server.cjs:123-131`), so extension tools can join without a restart.

**Cloud**
- Today the Supabase client and the MCP SDK load at process start (`main.cjs:16-52`), and signed-in cloud runs a 30-second interval (`cloud-sync.cjs:144`).
- As extensions, they load only when installed.
- The local half of sync stays in the core storage worker. That means the change triggers, the outbox, `apply`, and the `sync_tracked` view that albums read (`store-sync.cjs`).
  - It is part of the data layer.
  - It runs inside the SQLite worker, not in the main process.
- The Sharing extension owns:
  - the Supabase client (`cloud-sync.cjs`);
  - the Wi-Fi live-share server (`live-share.cjs`);
  - presence and cursors (`CollabLayer.tsx`), and join toasts;
  - profiles, the share dialogs and their settings pages.

### Things that stay in the core for technical reasons

- **Scheme registration.**
  - Privileged schemes (`terra-html`, `canvas-media`, `canvas-app`) must be registered before the app is ready (`main.cjs:37-51`), so the core always registers them.
  - The Web cards extension installs the `terra-html` handler when it activates.
- **The `<webview>` setting.** `webviewTag: true` and `hardenWebviews` must be set when the window is created (`main.cjs:443-446`), so they stay; they are cheap. Browser frames themselves move.
- **The external-change channel.** It pauses the board, applies outside edits and refreshes, for AI, cloud and guest edits alike (`main.cjs:111-187`, `App.tsx:354-424`). It belongs to the core and should be renamed from `canvas:mcp-sync` / `canvas:mcp-ready` to something neutral.
- **The flat-icon cut-out.** Board icons and profile pictures use it (`BoardIconImage.tsx:87-122`). It needs only sharp, so it stays in the core; the model-based path is the extension.

### Security

**Trust model**
- Extensions are first-party only.
- Packages are verified against SHA-256 hashes embedded in the app and downloaded over HTTPS from the project's own releases.
- Extension code runs with the app's privileges, as VS Code extensions do. That is why third-party code waits until there is a sandbox model.

**Safeguards**
- Only files in a package's file list are served.
- Extraction rejects zip-slip paths and has a size cap.
- Downloaded executables (yt-dlp, LibreOffice) keep their pinned hashes.

### Performance

**Startup**
- Only installed extensions load, and each loads on its activation event.
- Supabase, the MCP SDK, zod, pdf-lib (390 KB of the main chunk) and fflate stop loading at startup for people who don't use those features.

**Rendering**
- The per-frame path doesn't change.
- Moving overlay state out of Whiteboard removes today's re-render of the whole 4,600-line component on each zoom frame.

**Checking**
- Measure each extraction before and after with the existing 144 Hz method.

## Step 1: packaging fixes

These need no extension system and change no features.

1. **Move renderer-only packages to `devDependencies`:** pixi.js, pdfjs-dist, lucide-react, rbush, react, react-dom, dompurify, docx-preview.
   - Measured: `app.asar` drops from 191 to 52 MB, and `@napi-rs/canvas` (37 MB) goes away.
   - `fflate` and `pdf-lib` stay, because the main process uses them.
2. **Build the open-source license list at build time.** Generate it from the Vite bundle's modules, the main-process packages (including optional and native ones) and the non-npm payloads.
   - It replaces `bundledLicenses()` (`main.cjs:75-110`), which walks production `dependencies` at runtime and would lose the moved packages.
   - It also fixes today's missing notices.
3. **Set `electronLanguages: ['en-US']`**, or a short list.
   - Saves 48 MB installed and 8 MB from the installer.
   - Check that browser frames and link previews still send the system languages (`Accept-Language`).
4. **Shrink the main-process packages.** Exclude their unused copies (pdf-lib's `dist` and `es` builds, zod's sources, and so on), or bundle `electron/` with esbuild.
   - Estimated saving: about 30 MB installed.
5. **Drop `DirectML.dll`, `dxcompiler.dll` and `dxil.dll` from onnxruntime-node** if background removal stays on the CPU.
   - Saves 38 MB.
   - Verify with `desktop-background-removal.mjs`.
6. **Load pdf-lib with a dynamic `import()` in the renderer.** It saves 390 KB from the startup chunk.

**Result:** about 290 MB installer and about 600 MB installed. Items 1 and 3 alone come to 641 MB (the scratch build, plus the model it left out).

**Status: done on 2026-10-20.** The plan is `docs/superpowers/plans/2026-10-20-packaging-fixes.md`.

Measured on the packaged build:

| | Before | After |
|---|---|---|
| Installer | 345 MB (361,643,278 bytes) | 288 MB (302,070,665 bytes) |
| Installed | 864 MB | 580 MB |
| `app.asar` | 191 MB | 27 MB |
| Startup chunk | 1.56 MB | 1.14 MB |

What changed along the way:
- **Background removal works without the DirectML DLLs.** A CPU inference passed with them removed, and so did `desktop-background-removal.mjs`.
- **The licenses page lists 175 entries.** It now also includes:
  - sharp's LGPL libvips build;
  - the model, yt-dlp and the VC++ runtime.
- **Websites still get the right languages.** A probe on English-only Chromium showed that Accept-Language, `navigator.language` and date formats fall back to English on a non-English Windows. Spellcheck didn't change, because it follows the Windows languages. The app now sends the Windows languages as Accept-Language, both in browser frames and on the main session.
- **The browser-frame session is set up at startup.** Before, it was set up on the first capture.

## Rollout

Each step ships on its own.

1. **Packaging fixes (done).** Installer 288 MB, installed 580 MB.
2. **Extension manager, Settings → Extensions, and the payload extensions:** Background removal, Office files, Entrance songs.
   - Installer about 100 MB, installed about 390 MB.
   - Background removal moves to a `utilityProcess`.
   - Existing LibreOffice folders move over, or Storage offers to remove them.
3. **Renderer host API.**
   - Contribution points, fallbacks, upgrade auto-install and error boundaries.
   - Galleries as the pilot: the smallest feature, but it reaches into `engine.apply`, clipboard, duplicate and stacking, so it tests the API well.
4. **Extract the rest, one pull request each:** Albums → Papers → Word documents → PDF tools → Web cards → AI access → Sharing and live presence (with the Entrance songs UI).
   - Each pull request moves the code, replaces hard-wired branches with registrations, adds the fallback and tests, and checks the packaged app with the extension installed, removed and reinstalled.
5. **Later, when wanted:** the generic `ext` data slot, then a stable host API and a sandbox for third-party extensions.

## Testing

- **Data invariant.** The core alone opens fixture boards that contain every extension's objects, then draws fallbacks, saves, syncs, exports and re-imports them. The objects must be byte-identical afterwards. This guards the anti-goal.
- **Build check.**
  - Every emitted file has exactly one owner.
  - No core chunk statically imports an extension chunk.
  - No extension imports another.
- **Manager tests.**
  - A hash mismatch is rejected.
  - Zip-slip paths are rejected.
  - An interrupted download is cleaned up.
  - An extension can be removed while in use, and a locked file is deleted on the next start.
  - Staging works around updates.
- **Packaged checks.** Reuse `desktop-gallery.mjs`, `desktop-albums.mjs`, `desktop-html-embed.mjs`, `desktop-pdf-*.mjs` and `desktop-background-removal.mjs`. Run each with the extension installed, then removed (fallback visible, data intact), then reinstalled.
- **Performance.** Before and after each extraction, on the boards described in the performance notes.
- **Existing tests.** They import feature modules by path (for example `tests/list-scaling.test.mjs`), so they move along with the code.

## Risks

| Risk | Mitigation |
|---|---|
| Regressions from refactoring `Whiteboard.tsx` and `engine.ts` | One extension per pull request, with its existing desktop script as the acceptance test. Core types keep today's code paths. |
| App updates need extension downloads | Stage them before the restart; offline falls back without losing anything |
| Other sessions edit the same files during the refactor | Work in a branch or worktree and land one extension at a time |
| GitHub is blocked (corporate networks) | Clear error with Retry, plus **Install from file…** |
| Antivirus flags downloaded executables (yt-dlp) more than bundled ones | Pinned hashes, and the same files as today |

## Calls I made

Check these while reading.

1. The board format stays in the core (decision 1), so no data migration is needed.
2. Extensions are first-party, built with the app, and share its version (decision 2). Third-party extensions come later.
3. The core and extension split, including keeping lists, spoilers, locks, linked frames, PDF reading and OCR in the core.
4. The install location sits next to `Library`, not inside it, and the Office converter moves there.
5. Downloads come from the project's GitHub releases. There is no catalog server.
6. No first-run wizard; upgraders get the extensions their boards use installed automatically.
7. Install and Remove only, with no enable/disable switch.
8. English is the only Chromium language kept, unless the user wants more.

## Left to the implementation plan

- Exact host API types and the manifest JSON schema.
- How to enforce chunk ownership with Vite 8 / Rolldown: chunk groups, or a small plugin plus a `generateBundle` check.
- The extension package and staging file formats.
- UI copy and icons.
- The order of work inside step 4.
