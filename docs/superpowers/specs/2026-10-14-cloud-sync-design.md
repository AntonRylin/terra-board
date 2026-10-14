# Cloud sync (Supabase)

Date: 2026-10-14. Status: in progress.

## Goal

Keep the whole library in sync across a person's own computers through Supabase, with no visible sign-up. The data model already supports teams so accounts, roles, sharing and live presence can follow as the next milestone without migrating data.

Out of scope here: email/Google sign-in, team invites with roles, live cursors, comments, billing, web client.

## Identity without sign-up

- Turning on sync signs the device in anonymously (Supabase anonymous auth) and creates a **workspace** owned by that device.
- Every device is a separate anonymous user. A second device joins with a short **pairing code** created on the first device (valid 15 minutes, single use). Redeeming it adds that device to the workspace as owner.
- This is the same membership model teams will use; a later milestone links an email to the anonymous user (recovery, sign-in on new devices) and adds invites with roles.
- Losing every device loses cloud access until email linking exists; Settings says so.

## Server (Supabase)

- `workspaces(id, name, created_by, created_at)`
- `workspace_members(workspace_id, user_id, role, device_name, joined_at)`; roles: owner, admin, editor, commenter, viewer.
- `entities(workspace_id, kind, board_id, id, data jsonb, deleted, seq, updated_by, updated_at)`; kinds: board, folder, object, asset. Objects use `board_id`; others use `''`. Primary key `(workspace_id, kind, board_id, id)`.
- `pairing_codes(code, workspace_id, role, created_by, expires_at, used_at)`.
- Storage bucket `assets`, private, path `<workspace>/<sha256>`; content-addressed, insert-only.
- RLS: members can read their workspace rows; nobody writes tables directly. Writes go through `security definer` RPCs that check the role: `create_workspace`, `push_entities`, `create_pairing_code`, `redeem_pairing_code`, `remove_member`.
- `push_entities` takes a per-workspace advisory lock, so `seq` values commit in order and a cursor never skips a row.

## Local store

- `sync_state(key, value)`: enabled, workspace, cursor, and a transient `applying` flag.
- `sync_outbox(kind, boardId, id, queued)`: SQLite triggers on boards (content columns only, not camera, revision or timestamps), folders, objects and assets record what changed while sync is enabled and not applying remote rows. Every write path (UI, MCP, import, duplicate) is covered without touching each method.
- Enabling sync queues the whole library.

## Sync loop (Electron main, `electron/cloud-sync.cjs`)

1. **Push**: take up to 200 outbox entries with their current state. Upload missing asset files first (409 = already there), then push rows via `push_entities`, then acknowledge entries whose `queued` stamp did not change meanwhile.
2. **Pull**: read rows with `seq > cursor` in order, 500 at a time. Download missing asset files and import them (same SHA-256 id). Apply rows in one local transaction under the `applying` flag, skipping entities that still have a local outbox entry (local unsent edits win; they push next and become newest).
3. Applying remote content uses the same prepare → apply → refresh handshake as AI edits, so unsaved typing is flushed first and the open board reloads. It shows "Syncing changes…" instead of the AI label.
4. Triggers: local writes (debounced 1.5 s), a realtime broadcast ping from other devices after they push, a 30 s poll, and coming back online.

Conflicts: per object, last write to reach the server wins. Different objects on the same board never conflict. Board deletion is only "trashed" and syncs as a field.

## Configuration

`SUPABASE_URL` and the public anon key come from `package.json` `terraCloud` (production) or `TERRA_CLOUD_URL` / `TERRA_CLOUD_KEY` (development, local Supabase). The anon key is public by design; security is in RLS and RPC checks. The session is stored in `Library/settings/cloud.json`, encrypted with Electron `safeStorage` when available.

## Settings → Cloud sync

- Off: "Turn on sync" and "Join with a code".
- On: status (Synced / Syncing N changes / Offline / error), last sync time, "Add a device" (shows a pairing code), list of devices with Remove, "Turn off sync on this device".

## Testing

- Unit: outbox triggers, take/ack, apply rules (local pending wins, applying flag suppresses outbox), asset ordering.
- Integration (`scripts/cloud-sync-check.mjs`, needs local Supabase): two libraries in temp folders sync boards, objects, deletions and an image both ways; pairing code; RLS denies a non-member.

## Local sharing without cloud (answer, not built here)

Possible. A "host" mode would let a friend edit a board that lives on your PC:
- Your app acts as the server, using the same push/pull protocol as cloud sync.
- On the same Wi-Fi this is easy and reliable.
- Over the internet both computers are usually behind routers, so a direct connection needs WebRTC. A tiny signaling step is needed to introduce the two (Supabase Realtime can do it, storing nothing). About 10–20% of connections need a TURN relay server, which costs a little bandwidth money.
- You approve each join.
- The board is only available while your PC is on and Terra Board is open.
- Images must be sent from your PC.

It is a good free tier feature ("live session, no account") next to paid always-on cloud, and should reuse the cloud sync protocol so it is not a second system.
