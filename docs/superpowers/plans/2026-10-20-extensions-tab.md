# Extensions Tab and Downloadable Payloads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Settings → Extensions, where people install and remove optional parts. Ship the three heavy ones as downloads instead of inside the installer:
- Background removal: the u2net model and onnxruntime.
- Song links: yt-dlp.
- Office files: LibreOffice, which is already downloaded on first use.

**Architecture:**
- **Manager.** A main-process extension manager (`electron/extensions.cjs`) installs payload files into `Extensions/<id>/`. It verifies every file against the SHA-256 in a catalog that the build generates and the app embeds.
- **Sources.** Repository builds install from the local build output (`release/extensions`); installed builds download from GitHub.
- **Feature code stays in the core.** It only looks for its payload in the extension folder.
- **Background removal moves to a `utilityProcess`.** Its DLLs then unload after each job, so Remove works right away.
- **The renderer** shows a new Settings section, and hides "Remove background" until the extension is installed.

**Tech Stack:** Electron 44 (`utilityProcess`, `session.fetch`), fflate (zip), React, `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-20-extensions-design.md`: decisions 4 to 9, "Main process", "Settings → Extensions", and rollout step 2.

## Global Constraints

- **Install location:** `TERRA_EXTENSIONS_DIR`, or else a folder named `Extensions` next to the Library root.
- **Sources:**
  - Repository builds read from `TERRA_EXTENSIONS_SOURCE`, or else `<repo>/release/extensions`.
  - Installed builds (`terraDistribution === 'installed'`) use the catalog URLs.
- **Payload URLs:**
  - u2net: `https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx`, sha256 `8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491`.
  - yt-dlp: `https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe`, sha256 `66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a`.
  - The onnxruntime zip: `https://github.com/AntonRylin/terra-board/releases/download/v<version>/<zip name>`.
  - LibreOffice keeps its own URLs and hash (`office-converter.cjs`).
- **Removing an extension never touches board data.**
- **Entry points of a missing extension are hidden:**
  - The image context menu has no "Remove background".
  - Flat icon cut-outs still work in the core.
- **Wording:**
  - Names: "Background removal", "Song links", "Office files".
  - Errors name the tab: "Install Background removal in Settings → Extensions…".

## Review Focus

1. **Remove while a cut-out is running, or right after one.** The DLLs must not stay locked, and the job must fail cleanly. Covered by a `createBackgroundRemoval` test with a fake fork: `stop()` rejects pending jobs. The packaged check covers removing after a cut-out.
2. **A download that is interrupted, corrupted or cancelled** leaves no half-installed folder, and the tab shows Install again. Covered by manager tests for hash mismatch, cancel, and leftover cleanup at start.
3. **A zip entry that escapes its folder** (`../`, an absolute path) is rejected. Covered by a manager test.
4. **Upgrading from 0.1.28 with LibreOffice already extracted in `Library/tools`.** It shows as installed and isn't downloaded again. Covered by an `officeLocation` test for the old folder.
5. **Opening Settings in the browser preview or as a live-share guest** (no desktop bridge). The tab says the feature is desktop-only, and nothing throws. Covered by the renderer guard and checked in the build.

---

### Task 1: Extension manager

**Files:**
- Create `electron/extensions.cjs`.
- Create `tests/extensions.test.mjs`.

**Interfaces:**
- Produces `createExtensions({ root, catalog, source, fetch, installers, beforeRemove, onChange })`, which returns:
  - `list(): Status[]`
  - `install(id): Promise<void>`
  - `cancel(id)`
  - `remove(id): Promise<void>`
  - `path(id): string | null`
  - `cleanup(): Promise<void>`
- Arguments:
  - `catalog.extensions[]`: `{ id, name, description, version, files?: [{ name, url, sha256, size, unzip? }], installer?, downloadSize, installedSize }`.
  - `source`: `{ dir }` for local, or `{ remote: true }`.
  - `installers[id]({ dir, signal, progress })` runs custom installs.
  - `beforeRemove(id)` is awaited before deleting.
- `Status`: `{ id, name, description, version, state: 'available'|'installing'|'installed', downloadBytes, installedBytes?, progress?: { received, total, label? }, system?, error? }`.
- Installing writes `<root>/<id>/extension.json`, `{ id, version, installedAt }`, last. It installs through `<root>/.partial-<id>-<uuid>` and finishes with a rename.

- [ ] Write the tests:
  - `installs files from a local source and reports them installed`
  - `rejects a file whose checksum does not match and leaves nothing behind`
  - `unzips archives and refuses entries outside the extension folder`
  - `remove calls beforeRemove, deletes the folder and returns to available`
  - `cancel stops a running install and cleans up`
  - `cleanup deletes leftover partial and trash folders`
  - `downloads remote files with progress`, using a fake `fetch` returning a streamed `Response`
  - `custom installers write into the staging folder`
- [ ] Run `node --test tests/extensions.test.mjs`. Expected: FAIL, module missing.
- [ ] Implement it.
  - Streaming copy or download into the partial folder, with SHA-256 and size checks.
  - fflate `unzipSync` for zips, with every resolved path kept inside the partial folder.
  - Throttled `onChange(list())`.
  - A single install queue.
  - `remove` renames the folder to `.trash-<id>-<uuid>` and deletes it. If that fails, it writes a `.remove` marker that `cleanup` honours.
- [ ] Run `node --test tests/extensions.test.mjs`. Expected: PASS.

### Task 2: Background removal from the extension, in a utility process

**Files:**
- Modify `electron/image-cutout.cjs`: `cutout(file, { model, icon, loadOrt })`.
- Rewrite `electron/background-removal.cjs`.
- Create `electron/background-removal-process.cjs`.
- Delete `electron/background-removal-worker.cjs`.
- Modify `electron/store.cjs` (drop `removeBackground`), `electron/worker.cjs`, and `vite.config.ts` (drop it from the allowlists).
- Test: rewrite `tests/background-removal.test.mjs`.

**Interfaces:**
- `createBackgroundRemoval({ fork, location })`:
  - Returns `{ run(file, icon): Promise<Buffer|null>, stop() }`.
  - `fork(modulePath)` returns an Electron `UtilityProcess`.
  - `location()` returns `{ model, runtime } | null`.
  - Keeps today's queue: one job, up to 4 waiting, 90 s timeout.
- `removeAssetBackground({ id, icon }, { readAsset, importAsset, run })`:
  - Returns the cut-out asset, or the original's metadata when there is nothing to remove.
- When the model is needed but `location()` is null, the error is "Install Background removal in Settings → Extensions to remove backgrounds from photos."

- [ ] Write the tests:
  - The existing icon and photo cases, now through `removeAssetBackground`. They use the real store and an in-process `run` that calls `cutout` with `require('onnxruntime-node')` and the model.
  - `flat icons work without the extension`.
  - `photos without the extension ask to install it`.
  - `stop rejects waiting jobs and kills the process`, with a fake fork.
- [ ] Run them. Expected: FAIL.
- [ ] Implement them. Run `node --test tests/background-removal.test.mjs`. Expected: PASS.

### Task 3: Song links and Office files from the extensions folder

**Files:**
- Modify `electron/song-link.cjs`: `downloadSongLink(url, exe)`.
- Modify `electron/office-converter.cjs`:
  - `officeLocation({ extensionDir, legacyRoot })` returns `{ executable, system } | null`.
  - `installOffice({ dir, signal, progress })`.
  - `createOfficeConverter({ root, runtime, readAsset, importAsset, onProgress })`, where `runtime()` returns the executable path.
- Tests:
  - `tests/song-link.test.mjs` (create): `missing yt-dlp asks to install Song links`.
  - Add to `tests/document-convert.test.mjs`, or create `tests/office-converter.test.mjs`: `finds LibreOffice in the extension, the old Library tools folder, or Program Files`.

- [ ] Write the tests, run them (FAIL), implement, run them again (PASS).

### Task 4: Catalog, packaging and licenses

**Files:**
- Create `extensions/background-removal/manifest.json`, `extensions/song-links/manifest.json` and `extensions/office-files/manifest.json`, each with `{ id, name, description }`.
- Create `scripts/build-extensions.mjs`. It writes:
  - `release/extensions/u2net.onnx`
  - `release/extensions/yt-dlp.exe`
  - `release/extensions/onnxruntime-<ver>-win32-x64-<sha8>.zip`: onnxruntime-node's `package.json`, `dist/**` and the win32-x64 `.node` and `.dll` files, the VC++ DLLs next to them, and onnxruntime-common's `package.json` and `dist/cjs/**`. Entries are sorted, with a fixed mtime.
  - `electron/generated/extensions.json`
- Modify `package.json`:
  - Move onnxruntime-node to `devDependencies`.
  - Drop its `asarUnpack` and `files` entries, the model's entries, and `extraResources`.
  - Add `!assets/models/**`.
  - Run build-extensions in `dev`, `package`, `installer` and `release`.
- Modify `.gitignore`: add `/Extensions/` and `electron/generated/`.
- Modify `electron/licenses.cjs`: `collectLicenses({ appPath, resourcesPath, extensionsRoot })`. It reads notices and `node_modules` packages from installed extensions, and adds a LibreOffice MPL-2.0 notice when it is present.
- Test: update `tests/licenses.test.mjs` so yt-dlp is found under `extensionsRoot/song-links`.

- [ ] Update the licenses test, run it (FAIL), implement it, and run it again (PASS).
- [ ] Run `node scripts/build-extensions.mjs` twice. Expected: the same zip name both times (deterministic), and a catalog with 3 entries.

### Task 5: Main process, preload and bridge

**Files:**
- Modify `electron/main.cjs`:
  - Extensions root and source.
  - The manager, with `fetch` from `session.fromPartition('terra-downloads', { cache: false })`.
  - `cleanup()` at start.
  - IPC: `canvas:extensions-list`, `-install`, `-cancel` and `-remove`, plus the event `canvas:extensions-changed`.
  - `removeBackground` handled in main.
  - The song-link exe from the manager.
  - The Office runtime from the manager: it auto-installs on first conversion as today, with board progress messages kept.
  - Licenses get `extensionsRoot`.
  - Stop background removal on quit.
- Modify `electron/preload.cjs`: `extensions: { list, install, cancel, remove, onChange }`.
- Modify `src/bridge.ts`: add the `ExtensionStatus` type and the `extensions` member.

- [ ] Run `npm test` and `npx tsc --noEmit`. Expected: pass.

### Task 6: Settings → Extensions and gated entry points

**Files:**
- Create `src/extensions.ts`: `useExtensions(): ExtensionStatus[] | null` and `useExtensionInstalled(id)`.
- Create `src/components/settings/ExtensionsSettings.tsx`, with CSS in `settings/settings.css`.
- Modify `src/components/settings/settings-index.ts`:
  - Add a section `extensions` in group `Extensions`, after `panel`, using the Puzzle icon, with the subtitle "Add the features you use. Removing one never deletes anything on your boards."
  - Add rows `extensionBackgroundRemoval`, `extensionSongLinks` and `extensionOfficeFiles`.
- Modify `src/components/SettingsPage.tsx` to render the section.
- Modify `src/components/Whiteboard.tsx`: "Remove background" only when installed.
- Modify `src/components/settings/ProfileSettings.tsx`: "From link…" without Song links shows a notice pointing to Extensions.
- Test: the tab is checked end to end in Task 7.

- [ ] Run `npx tsc --noEmit` and `npm run build`. Expected: pass.

### Task 7: Docs, desktop checks, packaging and the swap

**Files:**
- Update `docs/user-guide.md`, `README.md` and `docs/development.md` (building extensions, uploading the zip with each release).
- Mark step 2 done in the spec.
- Modify `scripts/desktop-background-removal.mjs`:
  - Set `TERRA_EXTENSIONS_DIR` (temp) and `TERRA_EXTENSIONS_SOURCE`.
  - Check that the menu item is hidden.
  - Install through `window.canvas.extensions.install`.
- Create `scripts/desktop-extensions.mjs`. Through the UI, it opens Settings → Extensions, installs Song links, checks the file on disk, removes it, and checks it is gone.

- [ ] Package to `release/staging-extensions`. Run `desktop-check`, `desktop-extensions`, `desktop-background-removal`, `desktop-mcp`, `desktop-pdf-composer` and `desktop-browser-frame`. Expected: pass.
- [ ] Build the installer into `release/staging-installer` and record its size. Expected: about 100 MB.
- [ ] Final review, then the swap into `release\win-unpacked` and a relaunch.
