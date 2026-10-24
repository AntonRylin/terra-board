# Cloud sync

Design: [superpowers/specs/2026-10-14-cloud-sync-design.md](superpowers/specs/2026-10-14-cloud-sync-design.md).

Cloud sync keeps a library identical on several computers through Supabase. It is off by default and needs a sign-in (Settings → Account). Boards on a computer never need an account.

## Accounts

People sign in with an **email code** (6 digits, no passwords), **Google** or **Microsoft**. Supabase links the methods by verified email, so they all reach the same account. Settings → Account shows only the methods the server has turned on.

- **Email code:** `signInWithOtp` sends the code, `verifyOtp` signs in. The email templates (`supabase/templates/email-code.html`) show `{{ .Token }}`, never a link.
- **Google and Microsoft:** OAuth with PKCE in the **system browser** (Google refuses embedded sign-in windows). The provider sends the browser to `terraboard://auth/callback?code=…`; Windows and Linux hand that link to the running app (single-instance lock), which exchanges the code. A callback after Cancel, or with nothing waiting, is ignored. A development build only takes `terraboard://` links with `TERRA_DEV_PROTOCOL=1`.
- **One account, one personal workspace.** The first computer that syncs or shares creates it (`ensure_personal_workspace`); every other computer that signs in uses the same one. Its name is what people you share with see.
- **Your devices** (Settings → Account) lists `devices`. Each installation has an id in `<Library>/settings/device.json` and registers it on every start (`register_device`). Pushes carry that id, so an account's devices see each other's changes. **Sign out** calls `revoke_device`, which ends that device's session; it signs out on its next start and keeps its boards.
  - Each entry shows the platform (sent in `app_version` as `0.1.39 (win32)`), the address the server saw (`ip`, from the request headers), an approximate town (`location`, which the device looks up for its own address at get.geojs.io once per start), `first_seen` and `signed_in_at` (migration 20261024120000). Apps fall back to the older call and columns on a server without that migration.
  - If this device is missing from the list (its registration failed at start), `devices()` registers it again and otherwise lists it with the reason.
- **Boards** (Settings → Boards) lists every board as local, cloud or shared with you (`src/components/settings/board-places.ts`, the share dialog's `boardPlace`). A cloud board you own opens to the people who have access, with role changes, removal and Stop sharing. Removing someone deletes their share membership at once, so the server stops serving the board, and their app deletes its copy on its next sync (`reconcile` → `syncReconcile`).
- **Signing out** turns sync off, removes copies of boards other people shared, and keeps your own boards. With changes not yet uploaded, Settings offers **Sync now** first. **Turn off** in Cloud sync stops syncing on this computer but keeps you signed in.
- **Turning sync on against a library that may already be in the cloud** (signing in again, a second computer, a claim) pulls first and then uploads only what the server doesn't have (`rejoin` in `sync_state`, `sync_seen`). Edits made while signed out to boards and objects that are in the cloud are replaced by the cloud's version; board history (Ctrl+H) keeps them. Boards, folders and objects made while signed out upload.
- **Delete account** (Settings → Account; "Delete my cloud data" on a computer from before accounts) removes your cloud library with its files, your shares, your computers and the sign-in: `my_deletable_workspaces`, then the Storage API for the files, then `delete_my_cloud_data`. People you shared with lose those boards; boards on your computers stay. If the database refuses to delete the sign-in itself, the data is still deleted and the request is recorded in `deletion_requests` for an admin.

The code lives in `electron/cloud-auth.cjs`, which uses no Node or Electron API so the Android app shares it, and `electron/cloud-sync.cjs`, which connects it to the library.

### Computers set up before accounts (0.1.28 to 0.1.38)

Those computers are anonymous Supabase users. They keep syncing until the person signs in; Settings → Account and a one-time prompt say "Add a sign-in so you can't lose your cloud boards". The new app never creates anonymous users.

Signing in runs the **claim**:

1. Right before the sign-in replaces the anonymous session, the app keeps that session aside (encrypted, next to the normal one) and pauses sync.
2. After the sign-in, a throwaway client restores the anonymous session and calls `begin_claim()` (a one-time secret, stored hashed for 15 minutes); the account calls `finish_claim(secret)`.
3. The server moves the anonymous computer's workspace onto the account, then deletes the anonymous user:
   - **moved**: the account had no library yet, so this workspace becomes it. Shares, the people in them, the name, picture and song stay.
   - **joined**: this computer was paired with one that claimed first; nothing changes.
   - **combine**: sync was turned on separately on two computers. This computer moves its library to the account's workspace and uploads it, then `retire_workspace` moves the old workspace's shares over and deletes it. People it shared with keep the same boards; their app follows each board to the new workspace.
   - **none**: the anonymous workspace belongs to another account (a family computer paired long ago), so this account gets its own.
4. If the claim fails (offline), it is retried on the next start or **Sync now**.

Pairing codes are gone from the app; you sign in on the other computer instead. The server keeps the pairing functions for apps from before accounts.

## Run it locally

Requires Docker Desktop.

```bash
npx supabase start
```

Applies `supabase/migrations` to a local stack. Check the stack with:

```bash
node scripts/cloud-sync-check.mjs
```

Two temporary libraries sync through it: pairing, images, live updates, a stranger being refused, and a removed device being cut off. (That check still uses anonymous users from before accounts, which a local stack allows.)

Without Docker, `npm test` runs the migrations in PGlite: `tests/supabase-db.mjs` stands in for Supabase's `auth`, `storage` and `realtime` schemas, and `tests/accounts-migration.test.mjs` covers the claim, combining, devices and deleting cloud data.

To try it in the app, start Terra Board with `TERRA_CLOUD_URL` and `TERRA_CLOUD_KEY` set to the `API_URL` and `ANON_KEY` from `npx supabase status`. Use a separate `CANVAS_DATA_DIR` per window to act as two computers. Sign-in codes land in the local mail catcher (Mailpit, http://127.0.0.1:54324).

## Connect a real Supabase project

1. Create a project at supabase.com (the free tier works for testing).
2. Authentication:
   - **Sign In / Providers → Email**: on, with the email OTP length set to 6. Leave **Anonymous sign-ins** off on a new project (Terra Cloud keeps it on for a while for apps from before accounts).
   - **Emails → SMTP Settings**: a real mail service; the built-in sender allows only a few emails an hour. **Emails → Templates**: "Magic Link" and "Confirm signup" show the code, as in `supabase/templates/email-code.html`.
   - **Rate Limits**: emails sent per hour about 100.
   - **URL Configuration → Redirect URLs**: add `terraboard://auth/callback`.
   - **Google** (optional): a Google Cloud OAuth client of type "Web application" with the redirect URI `https://<ref>.supabase.co/auth/v1/callback`. Its consent screen needs a homepage and a privacy policy URL.
   - **Microsoft** (optional): the Azure provider with tenant `common`; in the Azure app registration add the optional claims `email` and `xms_edov`.
   - Don't turn on CAPTCHA: the app doesn't send a CAPTCHA token, so every sign-in would fail.
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

Settings → Account → Server shows the current server and **Change**. The app picks one in this order:

1. `TERRA_CLOUD_URL` and `TERRA_CLOUD_KEY` environment variables.
2. `%ProgramData%\Terra Board\server.json` with `"locked": true`.
3. The person's choice, in `<Library>/settings/server.json`.
4. `%ProgramData%\Terra Board\server.json` without `locked`.
5. `terraCloud` in `package.json` (Terra Cloud).

On Linux the managed file is `/etc/terra-board/server.json`.

When someone connects to a server from Settings, the app first calls its `server_info()` function. The app needs a server with the accounts migration (`schema` 2 or later) and says "This server needs an update" otherwise. Servers from the environment, a managed file, a saved choice or the built-in Terra Cloud are not checked at start-up, so a server must get the migration before people update the app. An account belongs to one server, so changing the server signs out first (after asking). Boards other people shared are removed from the computer, your own boards stay.

## Limits to know

- Free plan: 500 MB database, 1 GB file storage, 50 MB per uploaded file. Files above the plan limit fail to upload and sync reports an error.
- A computer from before accounts that never signs in is still its own anonymous user: if every such computer is lost, its cloud copy can't be reached.
- When a computer turns on sync for an account, its existing boards are merged into the synced library, including the starter boards of a fresh install.
- After a combine, a computer from before accounts that was paired with the retired workspace stops syncing until someone signs in on it. Changes it pushed after the combining computer's last pull are only on that computer; when it signs in, the account's version wins for things both have (board history keeps the rest).
- Signing out while a claim is still waiting (it failed offline) drops the claim: the old workspace stays on the server without an owner who can reach it. Sign in again first, or use "Delete my cloud data" before signing in.
- Removing a computer ends its session only if the database allows deleting from `auth.sessions`; otherwise it is signed out on its next start.
- Each of an account's computers announces itself on a shared board, so the same person can appear twice.

## What syncs

Boards (name, icon, colour, folder, order, background, trash state), folders, every object, and the media those reference. Board camera positions, the last opened board and app preferences stay per computer.

## Live edits on an open board

People on the same cloud board see each other's edits as they happen, like cursors, instead of waiting for sync:

- Each edit (and, while someone drags, resizes or turns objects, those objects up to 20 times a second) goes over the private Realtime channel `edits:<board id>` (`src/canvas/live-edits.ts`, `CloudSync.sendEdit`). Like cursors, it is only sent while someone else is on the board.
- The receiving app checks the objects with the store's validator (`syncLiveObjects`) and shows them without saving. Sync still uploads and stores the same edit a moment later; until the stored copy has it, a sync that brings an older copy does not move the object back (`LiveReceiver.merge`, up to 20 seconds).
- Objects that bring a picture or file this computer may not have yet, edits over about 100 KB and drags of more than 200 objects wait for sync, which downloads the files first.
- What someone is typing into or dragging here is left alone: their own version wins.
- Everyone who can see the board may join `edits:`, but only people who may change it (workspace owners and editors, people with an edit share) may send on it, checked by Realtime when the channel is joined (migration `20261024150000_live_edits.sql`). A server without that migration refuses the channel; edits then arrive through sync alone.

Sync itself uploads 0.4 seconds after the board saved (the board saves 0.35 seconds after the last change), tells the other computers right after uploading, and they download 50 ms after hearing it.

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
