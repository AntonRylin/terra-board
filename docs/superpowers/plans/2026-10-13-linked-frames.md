# Linked frames implementation plan

Build reusable, read-only views of a source frame, including references across boards. Instances retain their own size, position, rotation and lock state. Source titles and contents update everywhere; double-click opens and focuses the source. Use the existing React/Pixi/Electron stack and preserve concurrent radial-menu work.

1. Add a validated `frameLink: { boardId, frameId }` reference to frame persistence and clipboard parsing. Test round trips, malformed references, and clipboard copying.
2. Resolve frame contents with existing rotated containment rules. Test repeated instances, live updates, missing sources, nested links and cycles. References never own editable child objects.
3. Render source contents through the existing canvas renderer, uniformly fitted into each instance. Refresh referenced boards without editing their data. Include contents in image/PDF exports.
4. Add contextual Copy frame link / Paste linked frame actions and Open original. Use existing board navigation and focus. Keep formatting and title editing disabled on instances.
5. Run focused and full tests, build, and packaged desktop checks in an isolated library. Verify three instances, updates, navigation, transforms, undo/redo, persistence, missing sources and read-only contents.

Implementation choices: links preserve aspect ratio inside independently resizable bounds; deleted/trashed originals show a placeholder and recover when restored. Circular branches show a placeholder. Portable board files preserve reference identities and need the source boards in the same library.
