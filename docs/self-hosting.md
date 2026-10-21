# Connect Terra Board to your own server

Terra Board syncs through Terra Cloud by default. A company can run its own Supabase and point the app at it instead. Local boards never need a server.

Accounts arrive in the next release. Until then a company server uses the same anonymous device sync as Terra Cloud, so enable **Anonymous sign-ins** (and CAPTCHA for production) as described in [cloud-sync.md](cloud-sync.md).

## Set up the server

1. Run Supabase: self-hosted, or a project at supabase.com.
2. Apply the schema from this repository:

   ```bash
   npx supabase link --project-ref <ref>
   ```

   ```bash
   npx supabase db push
   ```

   This includes `server_info()`. When someone connects from Settings, the app calls it first to check the server speaks a protocol it understands. A server without it shows "This server needs an update", and an app too old for the server shows "Update Terra Board to use this server".

3. Optionally set the server's own label (the app does not show it yet; people see the `name` from the description file below):

   ```sql
   update public.server_settings set name = 'Acme boards';
   ```

4. Serve a description at `https://<your address>/.well-known/terra-board.json`:

   ```json
   {
     "name": "Acme boards",
     "supabaseUrl": "https://supabase.acme.example",
     "publicKey": "<publishable or anon key>",
     "signIn": { "email": true, "google": false, "microsoft": false }
   }
   ```

   - `signIn` is optional. Email is on by default, Google and Microsoft are off.
   - The address must be `https://`. Only `localhost`, `127.0.0.1` and `[::1]` may use plain http. The same goes for `supabaseUrl`, which must be just the origin: no path, no trailing details.
   - The app does not follow redirects and ignores replies over 64 KB.
   - **Never put the service role or secret key here.** A key starting with `sb_secret_`, or a service_role JWT, is refused.

## Connect people

- Each person opens Settings → Cloud sync → Server → **Change**, types the address (`terra.example.com`), chooses **Check** (the app shows "Found <name> at <host>."), then **Connect**. **Advanced** takes a Supabase URL and public key directly, with no description file.
- Or send them a link: `terraboard://connect?address=<your address>`. It opens Settings → Cloud sync with the address filled in. The person still checks and confirms; a link never switches servers by itself. It does nothing on a computer whose server is locked, and only the installed app registers `terraboard://` (a development build does not).

If sync is on, the app warns first (with the number of changes not yet sent, if any) and then turns sync off. Boards other people shared with you are removed from that computer; your own boards stay. **Use Terra Cloud** switches back.

## Managed computers

IT can put the same JSON in `%ProgramData%\Terra Board\server.json`. This file may also carry an `"address"`.

```json
{
  "name": "Acme boards",
  "supabaseUrl": "https://supabase.acme.example",
  "publicKey": "<publishable or anon key>",
  "locked": true
}
```

With `"locked": true` people cannot change the server (Change is hidden). Without it, the file is only the default: a server the person chose themselves wins.

If the server changes between runs, for example IT edits the file, sync is turned off with a message, and people turn it on again for the new server. Boards stay on the computer.

## Which server the app uses

First match wins:

1. `TERRA_CLOUD_URL` and `TERRA_CLOUD_KEY` environment variables (development).
2. `%ProgramData%\Terra Board\server.json` with `"locked": true`.
3. The person's choice, saved in `<Library>/settings/server.json`.
4. `%ProgramData%\Terra Board\server.json` without `locked`.
5. The built-in Terra Cloud.

A missing or broken file is skipped, and the app moves to the next entry.
