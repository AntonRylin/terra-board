# Cloud sync

Design: [superpowers/specs/2026-10-14-cloud-sync-design.md](superpowers/specs/2026-10-14-cloud-sync-design.md).

Cloud sync keeps a library identical on several computers through Supabase. It is off by default and hidden behind "This build is not connected to a sync service" until a Supabase project is configured.

## Run it locally

Requires Docker Desktop.

```bash
npx supabase start
```

Applies `supabase/migrations` to a local stack. Check the stack with:

```bash
node scripts/cloud-sync-check.mjs
```

Two temporary libraries sync through it: pairing, images, live updates, a stranger being refused, and a removed device being cut off.

To try it in the app, start Terra Board with `TERRA_CLOUD_URL` and `TERRA_CLOUD_KEY` set to the `API_URL` and `ANON_KEY` from `npx supabase status`. Use a separate `CANVAS_DATA_DIR` per window to act as two computers.

## Connect a real Supabase project

1. Create a project at supabase.com (the free tier works for testing).
2. Authentication → Sign In / Providers: enable **Anonymous sign-ins**. Anonymous sign-up is open to anyone who has the server address, so keep its limit low: Authentication → Rate Limits → anonymous sign-ins, for example 30 an hour per IP address. Don't turn on CAPTCHA yet: the app doesn't send a CAPTCHA token, so every sign-in would fail.
3. Link and push the schema:

   ```bash
   npx supabase link --project-ref <ref>
   ```

   ```bash
   npx supabase db push
   ```

4. Add the public values to `package.json` to make it the built-in Terra Cloud:

   ```json
   "terraCloud": { "url": "https://<ref>.supabase.co", "key": "<publishable or anon key>" }
   ```

   The key is public by design; access is enforced by row-level security and the database functions. Never put the service role or secret key in the app.

For a company server, leave `package.json` alone and follow [self-hosting.md](self-hosting.md): people connect from Settings, and IT can pre-set the server.

## Which server the app uses

Settings → Cloud sync → Server shows the current server and **Change**. The app picks one in this order:

1. `TERRA_CLOUD_URL` and `TERRA_CLOUD_KEY` environment variables.
2. `%ProgramData%\Terra Board\server.json` with `"locked": true`.
3. The person's choice, in `<Library>/settings/server.json`.
4. `%ProgramData%\Terra Board\server.json` without `locked`.
5. `terraCloud` in `package.json` (Terra Cloud).

When someone connects to a server from Settings, the app first calls its `server_info()` function, so a server connected this way needs the latest migrations. Servers from the environment, a managed file, a saved choice or the built-in Terra Cloud are not checked at start-up. A server can only be changed while sync is off; the app turns it off first. Boards other people shared are removed from the computer, your own boards stay.

## Limits to know

- Free plan: 500 MB database, 1 GB file storage, 50 MB per uploaded file. Files above the plan limit fail to upload and sync reports an error.
- Each computer is its own anonymous user. If every paired computer is lost, the cloud copy cannot be reached until email sign-in is added (next milestone).
- When a computer joins, its existing boards are merged into the synced library, including the starter boards of a fresh install.

## What syncs

Boards (name, icon, colour, folder, order, background, trash state), folders, every object, and the media those reference. Board camera positions, the last opened board and app preferences stay per computer.

## Offline edits

Changes made without internet wait in a local outbox (`sync_outbox`) and upload when the connection is back; nothing is lost. Merging is per object: edits to different objects all survive, and for an object changed on two computers the one that syncs last wins. A pending local change is never overwritten by an incoming one.

## Removing a board from the cloud

**Remove from cloud** in the share dialog ends the board's share, deletes its objects from the server (a `{ removed: true }` marker row goes first) and keeps the board on this computer as a local board (`sync_local`) that never syncs, even with whole-library sync on. This person's other computers keep their copy and stop syncing it too. Media files stay in storage because other boards may use them. Creating an invite code for the board puts it back in the cloud.

## Live sharing on the same network

Separate from cloud sync: **Share over Wi-Fi…** in a board's menu lets people on the same Wi-Fi open that board in their browser, served directly by this computer (`electron/live-share.cjs`, guest page `src/GuestApp.tsx`).

- The host approves each guest (unless "Ask me before someone joins" is off) and chooses View or Edit per guest; guests can be removed at any time.
- Guests reach only the shared board and the media it uses. Requests from public internet addresses are refused; only private network ranges, Tailscale (100.64.0.0/10) and this computer are accepted.
- Nothing is opened on the router. To share with someone elsewhere, both install Tailscale; the share window then shows a Tailscale link.
- Windows asks once whether Terra Board may accept connections on private networks.
- Traffic on the local network is plain HTTP; Tailscale encrypts it end to end.
