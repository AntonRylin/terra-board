# Find usages for linked frames

Add a read-only context action on source and linked frames, including locked frames. Resolve links by stable board/frame identity. List every direct stored occurrence separately across non-trashed boards, using existing stacking hierarchy to name the nearest containing process and its ancestor path. Preserve duplicates with per-process occurrence numbers; show uncontained links as “On board canvas.”

Reuse the search modal layout and keyboard navigation. Flush current drafts before scanning saved boards, load in bounded batches, handle cancellation and errors, and offer filtering and refresh. Result activation closes the dialog and uses existing board/object focus navigation. Prevent Ctrl+F from stacking the library search over this dialog.

Validation: focused identity/containment tests, full test suite, TypeScript/Vite build, and an isolated Electron workflow with repeated links, cross-board and same-board focus, locked originals, filtering, keyboard interaction, empty results and refresh after deletion. Verify the final packaged executable without replacing a running package.
