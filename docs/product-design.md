# Terra Board: product design and roadmap

Date: 2026-09-30. Status: exploratory draft; UI brainstorming is in progress.

Latest direction: a left-side iOS-style app launcher. Use one narrow, vertically scrollable column of small icons. Names are hidden by default and revealed on hover/focus; some boards are inside iOS-style folders that open on click. The user explicitly rejected the conventional navigation list and entries such as All boards, Recent, Favorites, Personal, and Work. Board management still includes create, rename, duplicate, move, edit icon, export/share a copy, and delete. Continue visual brainstorming before writing application code. Portable file export remains the proposal for local-only sharing.

## 1. Intent and accepted direction

Build a Windows-first personal visual workspace that feels as polished and fluid as a good Apple application. The core experience is an effectively unbounded whiteboard containing images, text, frames, shapes, links, and eventually local video and PDFs. Content is easy to paste with Ctrl+V, organize, search, recover, and carry to another machine.

The user has selected Windows first, an iOS-inspired appearance, and the best large-board performance that is reasonable. Their organization request is now clarified as app-like board icons and opening folders in the left panel. The previous file-browser sidebar and separate named-list collection proposal are superseded.

Success is a trustworthy daily workspace, not a feature-count comparison with Miro. Native rendering is a candidate architecture, not proof of speed.

## 2. Organization model

Use a visual launcher with directly placed boards and folder tiles. The following interaction details are proposed for review:

| Concept | Purpose | Contains | Important behavior |
|---|---|---|---|
| Board icon | Open a board like a separate app | One board reference with a custom icon and short label | Single click opens the board in the main area and preserves the launcher. |
| Folder tile | Organize board icons | Ordered boards; shown as a miniature icon mosaic | Single click expands a rounded folder sheet containing larger board icons. |
| Launcher | The main board organizer on the left | Ordered standalone board icons and folder tiles | A single vertically scrollable icon column with user-controlled order; no category navigation list. |
| Canvas group | A movable selection on a board | Board objects | Separate from sidebar groups; transforms and undo apply to the group together. |
| Frame | A named region inside a board | Explicit member objects | Used for navigation, organization, and later presentation/export. |

Each board can use a chosen symbol, emoji, or imported picture within an app-like rounded-square icon. Its name is available on hover/focus; names underneath are an optional density setting. Folders display a mosaic of their contained board icons. Duplicate display names are allowed; stable IDs identify data. Rename validates trimmed names of 1–120 Unicode grapheme clusters. Paths never derive from display names.

The launcher and folder interiors use manual icon order. Use one column in a 72-pixel strip, with 38-pixel icons. Compare floating folder sheets against an adjacent narrow folder panel in clickable mockups. Scrolling supports larger libraries, with only visible tiles instantiated. Search is a small button/keyboard command, not a permanent category menu. The first design uses one folder level; nested folders are not an approved requirement.

Example launcher: one vertical column containing Studio, References (folder), Ideas, Travel (folder), and the user's other folders. Search sits at the top; Create and a compact utility menu stay at the bottom. Only the icon collection scrolls.

Clicking References opens a rounded sheet anchored to the launcher with a grid of board icons such as Interiors, Architecture, Colors, Materials, Lighting, and Furniture. The currently open canvas remains behind it. Clicking a contained board switches the canvas and closes the folder. Outside click or Escape closes the folder without switching boards. A subtle active indicator identifies the current board, including on its containing folder when closed.

### Drag-and-drop and deletion

- Drag an icon to reorder it. Drag a board onto a folder to move it inside; drag it back to the launcher to move it out.
- Propose a deliberate dwell when dropping one board icon onto another to create a folder; show a clear preview and make the move undoable. Normal reordering must not accidentally create folders.
- The plus control offers **New board**, **New folder**, and **Import**. With a folder open, creating a board places it there; otherwise it appears in the launcher.
- Right-click an icon for **Open**, **Rename**, **Change icon**, **Duplicate**, **Move to**, **Export**, **Share a copy**, and **Move to Trash**. These controls are contextual, not a permanent text sidebar.
- Duplicating a board creates a new board ID and independent document, while immutable asset files may be shared internally until edits require new assets.
- Folder rename is available from its title or context menu. Removing a folder can dissolve it into the launcher, preserving its boards, or explicitly move the folder and its boards to Trash.
- Trash is available through a compact utility menu, not an always-visible navigation row. Restore returns a board to its previous location if that folder still exists, otherwise to the launcher.
- Keyboard focus, arrow-key navigation, Enter to open, Escape to dismiss, F2 to rename, and context-menu access remain available alongside pointer interaction.

The launcher folders organize boards. Canvas groups and frames organize objects inside a board. On-canvas automatic-layout lists are not part of this request.

## 3. Core user journeys

1. **Create and organize:** create a board, name it, choose its app-like icon, drag it into a folder, and reopen it by clicking that folder and then its icon.
2. **Collect information:** copy a screenshot, focus the canvas, and paste. A placeholder appears immediately while the original is safely copied and previews are prepared.
3. **Arrange a thought:** add text, select several items, align or group them, wrap them in a named frame, and connect ideas in a later increment.
4. **Resume work:** close the app, reopen, and return to the previous board and camera position. Completed saves remain intact.
5. **Find information:** search board titles and text, then activate a result to open the board and reveal the matching object.
6. **Recover or move:** restore a trashed board or import a complete local snapshot into a fresh library without missing image files.

## 4. Visual and interaction direction

Use the iOS home-screen organization model in a Windows desktop shell: small app icons, names on hover/focus, miniature-icon folders, and a brief folder expansion. The launcher should feel like a small home screen for the user's boards. Its quiet palette and opaque panels allow the canvas to dominate.

Proposed design tokens:

| Token | Initial choice |
|---|---|
| Spacing | 4, 8, 12, 16, 24, 32 logical pixels |
| Launcher | 72 logical pixels; one vertically scrollable column |
| Board icon | 38 × 38 logical pixels, app-like rounded-square shape; optional names underneath |
| Folder | Miniature icon mosaic when closed; 268-pixel floating sheet or 202-pixel adjacent panel in the comparison |
| Toolbar button | 36 × 36 logical pixels; labeled tooltip and accessible name |
| Corners | 10 on controls, 14 on cards, 18 on floating panels |
| Typography | Installed Windows system UI font; 13 body, 15 section title, 24 page title |
| Accent | Restrained blue for controls/active state; individual board icons can have distinct colors |
| Animation | 120–180 ms for panels and state changes; disabled under reduced motion |
| Materials | Opaque surfaces by default; subtle translucency limited to small chrome surfaces |

Provide light and dark themes with semantic color tokens, and an opaque/high-contrast fallback. Validate ordinary text contrast at 4.5:1 and large text/control boundaries at the applicable 3:1 target. Never rely on color alone to convey selection, errors, or import status.

The primary screen combines the icon launcher on the left and the active board on the right. A folder expands over a limited part of the canvas; the rest of the canvas remains recognizable. The first concept has no separate table dashboard or right preview inspector. Canvas tools stay compact and separate from board-launcher icons. Canvas content keeps its authored colors when the app theme changes. Empty-library and no-open-board states need a small creation prompt rather than a category dashboard.

Keep Windows keyboard conventions: Ctrl+C/V/X, Ctrl+Z/Y, Ctrl+Shift+Z, Ctrl+A, Delete, Escape, F2 to rename selected library items, and a context menu key. Text-edit focus owns text shortcuts. Middle-drag or Space+left-drag pans the canvas; wheel zoom is anchored to the cursor. Trackpad behavior is validated with real Windows events before finalizing gesture defaults.

Use bundled, redistribution-compatible icons. Do not assume Apple fonts or SF Symbols are available or appropriate for Windows distribution. An emoji picker uses OS-rendered emoji without requiring a network catalog.

## 5. Scope and release sequence

| Increment | Outcome | Includes |
|---|---|---|
| A — Foundation | A usable, recoverable local image workspace | App-like board icons, opening folders, launcher reordering and board actions, image paste/import, text, frames, canvas groups, pan/zoom, move/resize, undo, save/reopen, backups, native renderer measurements |
| B — Editor completion | Comfortable daily visual authoring | Shapes, connectors, pen, richer text, snapping/alignment, crop/rotation UI, layer outline, canvas search reveal, reusable templates, frame export, richer global content search |
| C — Rich media | More information types stay local | Video poster/playback, PDF pages, attachments, local link cards and board links |
| D — Scale and release hardening | A measured, portable release | Full 10,000-image/100,000-object validation on reference hardware, huge-image tiles, cold-cache/4K tuning, accessibility and installer QA, long-session and failure testing |

Increment A already establishes bounded caches, viewport queries, low-zoom previews, and stress instrumentation. Scale is measured from the beginning; D raises the release standard using real mixed-content fixtures and hardware.

Cloud sync, multiplayer, server-side AI, accounts, online integrations, and editable Miro import are outside these increments. A later feature can be evaluated on its own merits without weakening offline behavior.

## 6. Architecture decision

**Implementation update, 2026-09-30:** the shipped preview uses Electron 44, React 19, TypeScript, PixiJS 8, RBush and SQLite. Disk and image preparation run in a worker; the renderer uses viewport culling, on-demand frames and a bounded image cache. The Qt proposal below is retained as the original planning comparison, not the current build specification. See [implementation record](implementation-log.md) and [verification](verification.md). A native renderer remains an option only if measurements justify the migration cost.

Original candidate: C++20 with Qt 6/Qt Quick, SQLite, and a custom Qt scene-graph canvas. QML would handle the application interface and the active text-edit overlay. C++ would handle the document, spatial lookup, resource scheduling, persistence, and rendering snapshots.

Use public `QQuickItem`/scene-graph APIs. Avoid making each stored object a permanent QML delegate, painting the complete board into one bitmap, or writing a raw Direct3D engine before measurement shows a need. A spatially filtered pool of visible text delegates is acceptable initially if it remains bounded and measured.

Qt's scene graph retains geometry and batches compatible draws, but application-level culling and texture management remain our responsibility. [Qt scene graph](https://doc.qt.io/qt-6.11/qtquick-visualcanvas-scenegraph.html), [renderer behavior](https://doc.qt.io/qt-6/qtquick-visualcanvas-scenegraph-renderer.html)

The alternative is Tauri + Rust + PixiJS, with React/TypeScript for chrome. Before the native UI grows substantially, compare the core workload in a bounded PixiJS probe if the native renderer misses the scale target or text/UI integration is materially expensive. This comparison excludes folders, persistence, and a second complete application. The decision must record timings, memory, missing functionality, and maintenance cost; framework names are not evidence. [Tauri architecture](https://v2.tauri.app/concept/process-model/), [PixiJS performance](https://pixijs.com/8.x/guides/concepts/performance-tips)

The native first-increment build specification and implementation plan will be written after dashboard design review. If the comparison changes the renderer choice, revise those documents before extending implementation; do not maintain two production renderers by default.

## 7. Storage and local-only behavior

An active library consists of SQLite metadata, immutable original assets, derived caches, and temporary import staging. Names and organizational paths are metadata; moving a board does not move image files.

Implemented default data destination: `D:\Projects\terra\Library`, inside the repository and outside the replaceable build directory. The project, builds and runtime data live on D: rather than AppData or OneDrive. `CANVAS_DATA_DIR` is an advanced environment override used by isolated tests; a library location picker is not yet implemented.

Core editing remains local, without an account, telemetry or online activation. As requested on 2026-10-01, pasted links fetch public preview metadata and thumbnails, and YouTube cards support a brief muted preview plus full inline playback. Runtime UI assets ship locally; saved thumbnails work offline and are included in portable exports. Remote preview fetching is bounded and rejects private-network destinations; web pages are never executed to extract metadata.

Automatic backups remain local. Snapshot export contains a consistent database image, a manifest, and all referenced original assets. Cache is optional and rebuildable. Restore imports into a new library and validates it before offering to switch.

Use one writer with transactions and durable acknowledgements. SQLite WAL is not the undo system or backup format. Use a supported SQLite build containing the WAL-reset fix (3.51.3 or a documented patched release), with `synchronous=FULL` and bounded checkpointing in the storage worker. [SQLite WAL](https://sqlite.org/wal.html), [backup API](https://sqlite.org/backup.html)

## 8. Performance and reliability objectives

Product workload: 10,000 distinct images within a 100,000-object mixed board. It is not a fixed document cap. Benchmark distinct decoded media, dense overlap, far-apart regions, text, group moves, and full-board views. Duplicating one tiny texture does not represent this workload.

Use a named 16 GB Windows/SSD reference system before claiming the product target. Also report measurements on the user's current machine: Ryzen 7 9800X3D, approximately 31.2 GiB OS-reported RAM, and RTX 5070 Ti (an AMD integrated adapter is also present). Record the actual adapter used. Results from this stronger machine do not establish behavior on the reference system.

Targets are 60 Hz navigation, p95 frame intervals at or below 20 ms and p99 at or below 33.3 ms during a specified warm-cache route, and no interaction stall over 100 ms during ordinary navigation. Aim for 2 seconds to an interactive saved viewport on a prepared board, separating that from full-detail readiness and initial asset preparation.

Begin with a 2 GiB total-process-working-set goal during the steady reference route and independently enforce decoded-image, GPU-texture, and in-flight-job budgets. Report process memory and graphics memory without pretending integrated-GPU allocations are independent physical RAM. Measure 1080p and 4K separately.

Recovery acceptance: acknowledged committed operations and their imported assets survive the supported process-failure tests. Forced process termination is not a power-loss test. Validate storage durability separately under a suitable VM or controlled power-loss simulation, while documenting the storage-device assumptions.

## 9. Research boundaries

Miro's documented feature set informed the interaction inventory, not a claim to reproduce its internals. It recommends fewer than 5,000 objects for a better experience despite allowing 100,000, and does not offer an offline mode. [Miro performance](https://help.miro.com/hc/en-us/articles/360013588560-Board-performance-and-loading-issues), [system requirements](https://help.miro.com/hc/en-us/articles/360017731553-System-requirements)

Miro's dashboard and Spaces informed the board-management action inventory. The user rejected its conventional sidebar layout and selected an iOS-inspired board-icon launcher direction instead; the visual concept remains under review. [Dashboard](https://help.miro.com/hc/en-us/articles/360017571294-What-is-on-your-dashboard), [Spaces](https://help.miro.com/hc/en-us/articles/21040490154898-Spaces)

Miro supports file/URL insertion, frames, and uploaded video. The dedicated video documentation currently permits 150 MB uploads, so a generic 30 MB upload limit should not be applied to all Miro video features. Our limits will be based on local resource handling and supported decoders rather than copying those cloud limits. [Import](https://help.miro.com/hc/en-us/articles/360017731013-Uploading-files-to-boards), [Frames](https://help.miro.com/hc/en-us/articles/360018261813-Frames), [Video](https://help.miro.com/hc/en-us/articles/30316193985170-Video-upload-and-playback)

The repository was empty apart from Git metadata at planning time. CMake, Ninja, Node.js, and a WinLibs compiler are available. Qt was not detected on PATH or in the checked `C:\Qt` and `D:\Qt` locations. A compatible Qt kit must be selected and verified during implementation; the existing compiler must not be assumed ABI-compatible with a Qt binary package.

## Clickable mockup review

The current conversational mockup compares Floating folder and Side folder. It demonstrates the single-column launcher, folder opening, board switching, contextual rename/duplicate/move actions, creating folders and boards, and basic canvas interactions. Export is a dialog preview and creates no file. Mockup changes are demonstration state, not application data. No production canvas, storage layer, or performance claim is implied.
