# Packaging Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the installer and install smaller (about 345 → 290 MB and 864 → 600 MB) without changing any feature.

**Architecture:**
- Renderer-only packages become `devDependencies`. Vite already bundles them, so electron-builder stops copying them into `app.asar`.
- The license list moves to build time, because the runtime walk can no longer see those packages.
- Chromium keeps only English. Websites get the Windows languages through `Accept-Language` instead.
- Unused files of the main-process packages and onnxruntime's DirectML DLLs are excluded.
- pdf-lib leaves the startup chunk.

**Tech Stack:** Electron 44, electron-builder 26, Vite 8 (Rolldown), Node 24 `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-20-extensions-design.md`, section "Step 1: packaging fixes".

## Global Constraints

- No feature, UI or board-data change.
- Main-process `require()` targets must keep resolving: `pdf-lib` → `cjs/`, `zod` → `index.cjs` + `v4/`/`v3/`, `@modelcontextprotocol/sdk` → `dist/cjs/`.
- Background removal stays on the CPU execution provider (`electron/image-cutout.cjs`).
- `electronLanguages: ['en-US']`.

## Review Focus

1. **A main-process `require` hits an excluded file** (the app fails at start, or MCP or PDF printing fails). Covered by running the packaged app's `desktop-mcp.mjs` and a PDF conversion check (Task 3).
2. **The licenses page loses entries in the packaged app.** Covered by the unit test (Task 2), plus a check that `dist/licenses.json` inside `app.asar` lists react and pixi.js (Task 3).
3. **Background removal breaks without the DirectML DLLs.** A CPU inference worked without them in a scratch copy. Covered by `desktop-background-removal.mjs` on the packaged build (Task 3).
4. **Non-English Windows: browser frames fall back to English sites.** A probe showed this happens with an English-only Chromium. Covered by the `Accept-Language` helper and its unit test (Task 3).
5. **PDF features break with pdf-lib loaded lazily.** Covered by the existing PDF tests and `desktop-pdf-pages.mjs` / `desktop-pdf-composer.mjs` (Tasks 1 and 3).

---

### Task 1: Keep pdf-lib out of the startup chunk

**Files:**
- Create `src/canvas/pdf-sources.ts`. It takes from `pdf-edit.ts`, with no pdf-lib import:
  - `PdfSource`, `PdfPageSpec`
  - `MAX_PDF_WORKSPACE_BYTES`, `MAX_PDF_PAGES`
  - `PdfEditError`, `sourceLabel`
  - `validatePdfSources`
- Modify `src/canvas/pdf-edit.ts`. It imports those from `./pdf-sources.ts` and re-exports them, so the worker and tests are unchanged.
- Modify the main-thread importers to use `pdf-sources`:
  - `src/canvas/pdf-edit-client.ts`
  - `src/canvas/pdf-composer-files.ts`
  - `src/canvas/pdf-pages-files.ts`
  - `src/canvas/pdf-render.ts` (type import)
  - `src/components/PdfWorkspace.tsx`
- Modify `src/canvas/pdf-size.ts`: `compressPdfPages` loads `PDFDocument` with `await import('pdf-lib')`.
- Test: create `tests/startup-imports.test.mjs`.

- [ ] Write `startup modules never import pdf-lib`. It walks static `import … from` / `export … from` specifiers from `src/main.tsx` through relative `.ts`/`.tsx` files and skips type-only imports and `import()`. It asserts that `pdf-lib` is not among the bare specifiers reached and that `react` is (a sanity check).
- [ ] Run `node --test tests/startup-imports.test.mjs`. Expected: FAIL, with pdf-lib reached via `pdf-size.ts` / `pdf-edit.ts`.
- [ ] Make the moves above.
- [ ] Run `node --test tests/startup-imports.test.mjs tests/pdf-*.test.mjs`. Expected: PASS.

### Task 2: Build-time license list

**Files:**
- Create `electron/licenses.cjs`:
  - Signature: `collectLicenses({ appPath, resourcesPath }) → Array<{ name, version, license }>`.
  - It walks the main-process packages from `appPath/package.json`, following `dependencies` and `optionalDependencies` recursively. Packages that aren't installed are skipped.
  - It merges in `appPath/dist/licenses.json` when present.
  - It adds notices for bundled payloads, each only if its file exists:
    - "U-2-Net background-removal model" (Apache-2.0)
    - "yt-dlp" 2026.08.19 (Unlicense)
    - "Microsoft Visual C++ Runtime" (Microsoft Software License Terms)
  - It dedupes by name and version, then sorts by name.
- Modify `electron/main.cjs:75-110`: `bundledLicenses()` becomes a memoized call to `collectLicenses`.
- Modify `vite.config.ts` with a build-only plugin. In `generateBundle` it collects packages from chunks' rendered modules (`chunk.modules[id].renderedLength > 0`, falling back to `chunk.moduleIds`), reads each package's `name`, `version` and `license`, and emits `licenses.json`.
- Modify `package.json`: move pixi.js, pdfjs-dist, lucide-react, rbush, react, react-dom, dompurify and docx-preview to `devDependencies`, and refresh `package-lock.json`.
- Test: create `tests/licenses.test.mjs`.

- [ ] Write `collects main packages, optional natives, the renderer list and payloads`. It uses a temp fixture:
  - package `a` (MIT), which depends on `c` (ISC);
  - optional `b` ("Apache-2.0 AND LGPL-3.0-or-later");
  - `dist/licenses.json` with react (MIT) and `a` again;
  - `resources/yt-dlp/yt-dlp.exe`.
  It expects exactly `a, b, c, react, yt-dlp` in name order, each once.
- [ ] Run it. Expected: FAIL ("Cannot find module").
- [ ] Implement it, then run `node --test tests/licenses.test.mjs`. Expected: PASS.
- [ ] Run `npm run build`, then check that `dist/licenses.json` lists pixi.js, react, react-dom, pdfjs-dist, lucide-react and docx-preview.

### Task 3: Packaging config, the Accept-Language fix, and verification

**Files:**
- Modify `package.json` `build`:
  - `electronLanguages: ["en-US"]`
  - exclusions:
    - `!node_modules/pdf-lib/{dist,es,src}/**`
    - `!node_modules/zod/src/**`
    - `!node_modules/@modelcontextprotocol/sdk/dist/esm/**`
    - `!node_modules/**/*.map`
    - `!node_modules/onnxruntime-node/bin/napi-v6/win32/x64/{DirectML.dll,dxcompiler.dll,dxil.dll}`
- Modify `electron/browser-frames.cjs`:
  - Add `acceptLanguages(languages: string[]) → string`. It keeps valid language tags (`/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/`), drops duplicates, keeps at most 10, and joins them with commas.
  - `browserSession(session, languages)` passes the result to `setUserAgent`.
- Modify `electron/main.cjs`:
  - At ready, compute the value once from `app.getPreferredSystemLanguages()`.
  - Apply it to `session.defaultSession` (YouTube player, embeds) and to the browser-frame session.
- Test: in `tests/html-card.test.mjs` (it already covers browser-frame helpers), add `accept-languages keeps valid unique tags`. Input `['en-US','ru','en-US','x y','']` gives `'en-US,ru'`, and `[]` gives `''`.

- [ ] Write the test, run it (FAIL), implement it, and run it again (PASS).
- [ ] Run `npm test`. Expected: all pass.
- [ ] Package to `release/staging-packaging`:

  ```bash
  node node_modules/electron-builder/cli.js --win dir -c.directories.output=release/staging-packaging -c.electronDist=node_modules/electron/dist
  ```

  This comes after `npm run build` and `node scripts/prepare-vc-runtime.mjs`. Expected:
  - `locales` holds only `en-US.pak`;
  - `app.asar` is under 40 MB;
  - there is no `@napi-rs` and no `DirectML.dll`.
- [ ] Run the packaged checks with `TERRA_TEST_EXE` / `CANVAS_EXECUTABLE` set to the staging exe:
  - `desktop-mcp.mjs`
  - `desktop-background-removal.mjs`
  - `desktop-pdf-pages.mjs`
  - `desktop-html-embed.mjs`
  - `desktop-check.mjs`

  Expected: each passes as it does on the current build.
- [ ] Build an installer into `release/staging-installer` and record its size.
- [ ] Update the "Step 1" status and measured numbers in the spec, then commit.
- [ ] Swap into `release\win-unpacked` and relaunch, following the staging-swap procedure in the packaging notes.
