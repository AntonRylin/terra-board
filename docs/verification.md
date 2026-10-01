# Verification — Local Canvas 0.1.0

## 0.1.1 panning update — 2026-10-01

Right mouse dragging now pans in every canvas tool. A plain right-click opens the menu once; dragging suppresses the release menu, including press-before-release context-menu event ordering. The cursor changes to grabbing and restores after release/cancellation. Existing selection and object positions are preserved; the camera save uses the normal save queue.

Six tests execute the actual Engine pointer handlers with the GPU dependencies stubbed: right-drag, right-click jitter/menu timing, dragging back to the origin, cancellation, content/selection preservation and existing middle-button/hand panning. The first four reproduced failures in the previous handler; all six pass with the fix. The complete suite has 30 passing tests. This is event-handler coverage, not a physical-mouse test of the packaged window.

The updated executable is in `%LOCALAPPDATA%\LocalCanvas\Build-0.1.1\win-unpacked`. Close the older running version before opening it; both versions use the same production library.

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

Full-resolution image tiles, native backup restoration, automatic asset cleanup, richer content types and frame ownership remain product work. See the README for limits. No network sharing or cloud synchronization was added.
