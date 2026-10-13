# Linked frames

Select a source frame and choose **Copy frame link** from its toolbar or right-click menu. On the same board or another board, right-click the insertion point and choose **Paste linked frame**. The copied reference also supports ordinary Ctrl+V. Paste it as often as needed.

Each instance displays the original frame's title and contained objects. Move, resize, rotate, duplicate, group, lock or delete the instance independently. Its contents cannot be edited in place. Double-click anywhere in the instance, or choose **Open original frame**, to focus the original and edit it there.

Changes on the current board appear on the next render. References to other boards refresh when opened and approximately every 1.5 seconds while the destination remains open. Source changes do not rewrite the destination board or add undo entries. Missing originals show a placeholder and reconnect when restored. Circular branches show a placeholder instead of expanding indefinitely.

PNG, JPG and PDF exports include the referenced contents. Portable `.canvas` board files retain reference identities; the original boards must remain in the same library for those references to resolve.

Right-click an original or linked frame and choose **Find usages**. The search-style dialog lists every inserted link across active boards, including separate rows for repeated uses in the same process. Each row shows the nearest containing process frame, its board and nesting path, and an occurrence number. Links outside a process appear as **On board canvas**. Filter by process or board name, then click a row (or use arrow keys and Enter) to focus that exact instance. The action also works on locked frames. **Refresh** reloads the list after external changes; trashed boards are excluded.

## Verification, 2026-10-13

- Full working-tree suite including Find usages: 395 passed, 0 failed. TypeScript/Vite build passed.
- Packaged Electron workflow: three cross-board instances, image and shape previews, read-only content, double-click navigation, original edits and renaming, external changes to a closed source, source deletion/restoration, independent movement/resizing, undo/redo and reload. No renderer exceptions.
- Export dialog check in Electron with deterministic save paths: PNG and JPG include source shape and image pixels; PDF generated successfully.
- Find usages packaged workflow: six separate occurrences across three boards, locked original, trash exclusion, filtering, keyboard navigation, exact cross-board and same-board instance focus, original title resolution, empty states, and refresh after deleting a link. No renderer exceptions.
- Latest packaged output: `release-frame-usages/win-unpacked/Terra Board.exe`. Packaging uses a separate output to preserve existing executables.
- Test scripts: `scripts/desktop-frame-links.mjs` (set `TERRA_TEST_EXE` for a packaged executable; `TERRA_SOURCE_CHECK=1` also runs deterministic export checks), `tests/frame-links.test.mjs`, and linked-frame pointer coverage in `tests/panning.test.mjs`.
- Usage tests: `scripts/desktop-frame-usages.mjs` and `tests/frame-usages.test.mjs`.
