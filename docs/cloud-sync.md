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
2. Authentication → Sign In / Providers: enable **Anonymous sign-ins**. For production also enable CAPTCHA (Turnstile or hCaptcha), because anonymous sign-up is otherwise open to abuse.
3. Link and push the schema:

   ```bash
   npx supabase link --project-ref <ref>
   ```

   ```bash
   npx supabase db push
   ```

4. Add the public values to `package.json`:

   ```json
   "terraCloud": { "url": "https://<ref>.supabase.co", "key": "<publishable or anon key>" }
   ```

   The key is public by design; access is enforced by row-level security and the database functions. Never put the service role or secret key in the app.

## Limits to know

- Free plan: 500 MB database, 1 GB file storage, 50 MB per uploaded file. Files above the plan limit fail to upload and sync reports an error.
- Each computer is its own anonymous user. If every paired computer is lost, the cloud copy cannot be reached until email sign-in is added (next milestone).
- When a computer joins, its existing boards are merged into the synced library, including the starter boards of a fresh install.

## What syncs

Boards (name, icon, colour, folder, order, background, trash state), folders, every object, and the media those reference. Board camera positions, the last opened board and app preferences stay per computer.
