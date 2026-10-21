# Terra Board MCP

Open **Library options (the three dots on the board strip) → Settings → AI access via MCP**. The server is off by default. Its enabled state and port persist in `Library/settings/mcp.json`; keep this file private and outside Git. Keep Terra Board open while using either client.

## Connect Codex

In Settings, press **Copy setup** next to Codex and paste it into your user Codex `config.toml`, alongside your existing MCP entries, then restart Codex. The generated entry uses a loopback Streamable HTTP URL and a private Authorization header. If you change the port, copy the updated configuration. Do not share the access token.

## Connect Claude

In Settings, press **Copy setup** next to Claude and paste the prompt into Claude Code or the Code tab of Claude Desktop on the same computer. The prompt carries the `terra_board` entry generated for that installation and tells Claude to back up and merge it into `claude_desktop_config.json`, register it with Claude Code, and verify the paths. Restart Claude afterwards. Copy the prompt on each computer; its paths are not portable.

To do it by hand, merge the `terra_board` entry from the prompt into the existing `mcpServers` object in Claude Desktop's Developer → Edit Config file, preserving other servers and preferences. On Windows the config normally lives at `%APPDATA%/Claude/claude_desktop_config.json`; Store installs can keep it inside the Claude package's `LocalCache/Roaming/Claude` directory.

The generated command uses Terra Board's packaged Electron executable with `ELECTRON_RUN_AS_NODE=1` and its bundled `mcp-stdio.cjs`. No separate Node/Python installation or downloaded proxy is needed. Do not remove these arguments or environment settings. The connector can list its tools while access is disabled; data access and edits still require the app and its MCP switch to be on.

## Tools

- `list_boards`: all boards, folders and trash, with optional name filtering.
- `read_board`: text, geometry, formatting, object IDs, image IDs, revision and camera. Read subsequent pages until `nextOffset` is null. Supply the same revision across pages to detect intervening changes. `query` keeps only objects whose text, image/document title, link, list items or table cells contain it (case-insensitive), for finding something by name without reading the whole board.
- `create_board`, `update_board`, `duplicate_board`: create, rename, organize, set icons/colors, duplicate, trash and restore boards.
- `create_folder`, `update_folder`, `remove_folder`: organize folders. Removing a folder preserves its boards.
- `edit_board`: atomic object creation/replacement/deletion. Supports text, notes, shapes, frames, links, images, video, documents, lists, and editable arrows, including all stored formatting/crop/group properties.
- `import_media`: local absolute file path (up to 256 MB) or base64 bytes plus filename (up to 24 MB). Returns an asset ID. Images use the normal media validation pipeline; document and generic attachment bytes are retained exactly. It never fetches remote URLs.
- `read_asset`: returns an image preview as an MCP image block, or video/document metadata.

Typical photo workflow: `import_media` → `read_board` → `edit_board` with an image object containing the returned `assetId` and its desired position/size.

For attachments, create a `document` object with `assetId`, `text` (the original filename), `documentMime`, `documentBytes`, and position/size. An initial 320×400 card is suitable. `documentTitle` is an independent board label. Optional `documentPreviewId`, `documentExcerpt`, and `documentPageCount` retain previews through copying and portable exports; preserve them when replacing whole objects. Documents visible in the app receive supported previews automatically.

Edits require the latest board revision. Upserts replace **whole objects**; preserve fields from `read_board`. Use unique IDs for new objects and an `operationId` for retryable edits. On a revision conflict, reread and reconcile instead of blindly retrying old content. These tools do not execute code from board content.

## Saving and access control

Requests are serialized. Before accessing a board, Terra Board finishes text/crop drafts, cancels incomplete pointer gestures, and flushes pending imports/saves. During the operation it briefly pauses input. Changes refresh the current canvas; object edits are added to its normal undo history. Unopened boards are saved directly. An open board's revision is rebased after the external edit, so later manual edits and undo still save normally.

Disabling the switch closes the listener and rejects queued requests. An edit already committed to storage stays saved. The HTTP server binds only to `127.0.0.1`, requires the generated token, checks Host/Origin, bounds request sizes, and uses the official MCP SDK. Other computers cannot connect directly. AI clients can send the board data they read to their configured model provider; the MCP server itself does not contact one.

If a port is occupied, Settings shows the startup error. Choose another port and Apply. If a client reports a failed call after a disconnect, reread before retrying a mutation because its save might already have completed. Packaging replaces the executable directory: close AI clients/stdio connectors before rebuilding if Windows reports a file lock.

## Verification

`npm test` covers SDK interoperability, validation, media import/read, persistence, authentication, invalid origins/hosts, disabling queued operations and the stdio proxy. `node scripts/desktop-mcp.mjs` uses a disposable library and tests the actual packaged settings switch, HTTP client, packaged stdio executable, unsaved typing, live refresh, undo/redo, image upload and disabling. Never point test fixtures at the real Library.

Protocol/client references: [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [Codex MCP configuration](https://developers.openai.com/codex/mcp/), [Claude Desktop local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers).
