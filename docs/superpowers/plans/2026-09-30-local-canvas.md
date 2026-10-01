# Local Canvas desktop implementation plan

**Delivery status:** the functional Windows preview has been implemented and packaged. The checklists below retain the original plan; current evidence and outstanding production gates are in `docs/verification.md`. The minimum-window viewport automation did not apply its requested size in the browser harness, so narrow-window verification remains open. No production certification is implied by this plan.

> **For agentic workers:** Use superpowers:executing-plans to implement these tasks inline. Track progress in docs/implementation-log.md.

**Goal:** Deliver a runnable Windows desktop application implementing the approved floating-folder launcher, with the Create button centered with its icons, persistent boards, and a functional local canvas.

**Architecture:** Electron provides an isolated desktop shell. A background worker owns SQLite and immutable local media; React renders the small application chrome and PixiJS renders only spatially visible canvas objects. There is no account, server, telemetry, or runtime CDN dependency.

**Tech stack:** Electron 44, React 19, TypeScript, PixiJS 8, SQLite through Node, Sharp image previews, RBush viewport index.

**Spec:** docs/product-design.md, updated by the user's approval of the floating-folder mockup and request to implement.

## Global constraints

- Windows first; single scrollable icon column, floating folders, centered Create button.
- Keep current documentation and uncommitted work. No commit, push, or installation into system directories.
- Store the production library in `D:\Projects\terra\Library`, inside the repository. This location supersedes the original AppData decision as of 2026-10-01; builds and runtime data must also stay out of OneDrive.
- Save transactions before acknowledging success. Surface failures instead of claiming saved.
- This release is a functional first increment. Do not claim 10,000-image performance without a representative benchmark.
- Use shipped icons and fonts. External links open only after explicit activation.

## Review focus

- Abrupt termination after acknowledged saves: reopen SQLite and verify document and asset references.
- Malformed portable files: reject paths, unknown objects, invalid numbers and missing assets before changing the library.
- Board switches during imports or saves: bind operations to originating board IDs.
- Thousands of offscreen images: spatially filter objects and bound decoded texture storage and concurrent loads.
- Unicode names and duplicate titles: stable IDs remain authoritative; duplicate documents edit independently.

## Task 1: Local storage and document contract

Files: electron/store.cjs, electron/worker.cjs, tests/store.test.mjs, src/model.ts.

Interface: Store(root) exposes library(), createBoard(name,folderId), createFolder(name), updateBoard(id,patch), updateFolder(id,patch), duplicateBoard(id), saveBoard(id,objects,camera,revision), loadBoard(id), importAsset(input), exportBoard(id), importBoard(payload), restoreBoard(id). Objects have stable IDs, type, x/y/width/height, text/color/assetId/url, and z order. Revisions reject stale saves.

- [ ] Write tests for durable reopen, duplicate independence, stale revision rejection, trash/restore, invalid documents, and media round trips. Run `npm test` and confirm missing-contract failures.
- [ ] Implement WAL/FULL SQLite, transactional metadata and immutable hashed assets, deriving bounded image previews in the worker. Validate every IPC input at this boundary.
- [ ] Run `npm test`; require all storage tests green.

## Task 2: Desktop boundary and packaging

Files: electron/main.cjs, electron/preload.cjs, scripts/dev.mjs, scripts/desktop-check.mjs, vite.config.ts, tsconfig.json.

Interface: window.canvas.invoke(command,args) is an allowlisted asynchronous bridge, plus import picker, save picker, open external link, and media URLs. Browser-only preview uses a separate demo adapter and announces its temporary status.

- [ ] Connect worker request/reply IDs and safely serve registered local assets through a custom protocol.
- [ ] Keep context isolation, renderer sandbox, navigation restrictions, and CSP; block remote requests in the packaged app.
- [ ] Build and run the desktop with a disposable test library; check SQLite version, library commands, IPC boundary, renderer boot, and graceful shutdown.

## Task 3: Approved launcher and board management

Files: src/App.tsx, src/components/Launcher.tsx, src/components/Dialogs.tsx, src/styles.css, src/bridge.ts.

- [ ] Implement single-column 72px rail with 38px icons and geometrically centered footer buttons, folder mosaic sheets, search, contextual rename/icon/duplicate/move/export/trash, restore, and create/import flows.
- [ ] Keep display names as text, keyboard controls, escape dismissal, and visible save/error feedback.
- [ ] Inspect actual UI at desktop and narrow sizes. Verify board and folder creation, rename, move, duplicate, delete, and restore against real local persistence.

## Task 4: Canvas interactions and bounded media

Files: src/canvas/engine.ts, src/canvas/history.ts, src/canvas/geometry.ts, src/components/Whiteboard.tsx, tests/geometry.test.mjs.

- [ ] Write geometry tests for zoom anchoring, spatial visibility, negative coordinates, and selection bounds. Run red, implement, then green.
- [ ] Implement selection/multi-select, drag, resize, pan, wheel zoom, fit, text editing, notes, rectangles, frames, links, group/ungroup, delete, copy/duplicate and bounded undo/redo.
- [ ] Paste image/text/URL data and drop/import image/video files. Bind asynchronous imports to their original board. Play local videos on demand.
- [ ] Query spatial bounds before creating display objects, use previews by zoom level, limit parallel image loading, and evict unused textures by estimated decoded bytes.
- [ ] Persist edits through a serialized revision queue; keep recoverable in-memory edits on failure and expose retry. Flush pending changes before closing.

## Task 5: Verification and delivery

Files: README.md, docs/implementation-log.md, release/Local Canvas.exe (packaged directory).

- [ ] Run complete tests, type check, production build, desktop smoke checks and a spatial-index workload. Record measured scope.
- [ ] Perform fresh review, fix material defects, and repeat relevant checks.
- [ ] Package a runnable Windows folder, open the application, document launch/data/export/limitations. No commit or push.
