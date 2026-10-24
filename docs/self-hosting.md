# Connect Terra Board to your own server

Terra Board syncs through Terra Cloud by default. A company can run its own Supabase and point the app at it instead. Local boards never need a server.

The quickest way is the Docker package in [`ee/server`](../ee/server/README.md): it sets up Supabase, the schema, email codes, company sign-in and HTTPS in one go. This page describes the same setup by hand.

The company features (server admin panel, audit log, the Docker package) are in [`ee/`](../ee) under the [Terra Board Enterprise License](../ee/LICENSE): free for a server with up to 10 people, and a license key above that. The app and everything else stay MIT.

People sign in with an email code, Google or Microsoft ([cloud-sync.md](cloud-sync.md#accounts)). Anyone who can sign in can create an account and upload files, so if only your staff should use the server, turn off sign-ups for new email addresses in Supabase (Authentication → Sign In / Providers → "Allow new users to sign up") and create the accounts yourself (Authentication → Users → Invite), or keep the server behind your VPN.

## Set up the server

1. Run Supabase: self-hosted, or a project at supabase.com.
2. Set up sign-in (Supabase dashboard → Authentication, or `supabase/config.toml` for a self-hosted stack):
   - **Email** provider on, email OTP length 6. **Anonymous sign-ins** off: apps since accounts never use them.
   - **SMTP**: your mail server. The built-in sender allows only a few emails an hour.
   - **Email templates** "Magic Link" and "Confirm signup": show the code (`{{ .Token }}`), not a link. `supabase/templates/email-code.html` is ready to paste.
   - **Redirect URLs**: add `terraboard://auth/callback`.
   - **Google** or **Microsoft** (Azure, tenant `common`) if you want them, and set `signIn` in the description file below to match.
3. Apply the schema from this repository:

   ```bash
   npx supabase link --project-ref <ref>
   ```

   ```bash
   npx supabase db push
   ```

   This includes `server_info()`. When someone connects from Settings, the app calls it first to check the server speaks a protocol it understands. A server without it, or without the accounts migration, shows "This server needs an update", and an app too old for the server shows "Update Terra Board to use this server".

   `delete_my_cloud_data()` and `finish_claim()` delete users from `auth.users`. If your database refuses that, the claim still works (the old anonymous user is left behind) and a deletion is recorded in `public.deletion_requests`; remove those users in Authentication → Users.

4. Optionally set the server's own label (the app does not show it yet; people see the `name` from the description file below):

   ```sql
   update public.server_settings set name = 'Acme boards';
   ```

5. Serve a description at `https://<your address>/.well-known/terra-board.json`:

   ```json
   {
     "name": "Acme boards",
     "supabaseUrl": "https://supabase.acme.example",
     "publicKey": "<publishable or anon key>",
     "signIn": { "email": true, "google": false, "microsoft": false, "sso": false }
   }
   ```

   - `signIn` is optional. Email is on by default, Google, Microsoft and company sign-in (`sso`) are off. The app also asks the server which providers are on and shows only buttons that work.
   - The address must be `https://`. Only `localhost`, `127.0.0.1` and `[::1]` may use plain http. The same goes for `supabaseUrl`, which must be just the origin: no path, no trailing details.
   - The app does not follow redirects and ignores replies over 64 KB.
   - **Never put the service role or secret key here.** A key starting with `sb_secret_`, or a service_role JWT, is refused.

## Connect people

- Each person opens Settings → Account → Server → **Change**, types the address (`terra.example.com`), chooses **Check** (the app shows "Found <name> at <host>."), then **Connect**, and signs in. **Advanced** takes a Supabase URL and public key directly, with no description file.
- Or send them a link: `terraboard://connect?address=<your address>`. It opens Settings → Account with the address filled in. The person still checks and confirms; a link never switches servers by itself. On a computer whose server is locked, it still opens Settings → Account but fills nothing in. Only the installed app registers `terraboard://` (a development build does not).

If the person is signed in or sync is on, the app warns first (with the number of changes not yet sent, if any), then signs out and turns sync off. Boards other people shared with you are removed from that computer; your own boards stay. **Use Terra Cloud** switches back.

## Managed computers

IT can put the same JSON in `%ProgramData%\Terra Board\server.json` (on Linux, `/etc/terra-board/server.json`). This file may also carry an `"address"`.

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

On Linux the managed file is `/etc/terra-board/server.json` instead. A missing or broken file is skipped, and the app moves to the next entry.

## Company sign-in (SSO)

Company sign-in is part of the company edition: the server needs the migrations in `ee/supabase/migrations` (the app asks the server's `company_info()` and shows the button only when it answers). Admins can turn it off in Server admin → Server settings.

People can sign in with their company account through SAML 2.0: Microsoft Entra ID, Okta, Google Workspace, Keycloak, JumpCloud or any other SAML identity provider. In the app they choose **Continue with company sign-in** and type their work email; its domain picks your identity provider, and the sign-in page opens in the browser.

1. Turn SAML on in Supabase Auth:
   - **supabase.com project:** SAML SSO needs the Pro plan. Dashboard → Authentication → Sign In / Providers → SAML 2.0.
   - **Self-hosted:** set `GOTRUE_SAML_ENABLED=true` and `GOTRUE_SAML_PRIVATE_KEY` (a base64 DER RSA key, `openssl genrsa 2048 | openssl rsa -outform DER | base64 -w0`) on the auth service. The Docker package does this for you.
2. In your identity provider, create a SAML app with
   - Entity ID / metadata: `https://<supabase host>/auth/v1/sso/saml/metadata`
   - Reply (ACS) URL: `https://<supabase host>/auth/v1/sso/saml/acs`
   - Name ID: the email address; send an `email` attribute too.
3. Register it with Supabase, with the domains whose people should use it:

   ```bash
   npx supabase sso add --type saml --project-ref <ref> --metadata-url "https://login.microsoftonline.com/<tenant>/federationmetadata/2007-06/federationmetadata.xml?appid=<app id>" --domains acme.eu
   ```

   On a self-hosted server use the auth admin API instead (see [`ee/server/README.md`](../ee/server/README.md)).
4. Add `"sso": true` to `signIn` in `terra-board.json`. The app also checks that the server has SAML on and the company edition.

Accounts made through SSO are ordinary accounts: the same person's email code and SSO sign-ins reach the same account. To make SSO the only way in, turn off the email provider (and Google/Microsoft) in Supabase and set them to `false` in the description file.

## Server admin and license

Apply the company migrations in `ee/supabase/migrations` after the core ones (the Docker package does this). Then name the first admin:

```sql
insert into public.server_admins (email) values ('it@acme.eu') on conflict do nothing;
```

Admins see **Server admin** in Settings → Account:

- **License**: the key, and how many people are on the server.
- **Server settings**: whether new people join as members or guests, and company sign-in on or off.
- **People**: disable or enable a sign-in, make someone an admin, a member or a guest.
- **Teams**: create teams and choose who is in them.
- **Audit log**: who shared, unshared, created or deleted which board, devices, and every admin action, with CSV export.

### Roles

- **Admin**: everything below, plus Server admin.
- **Member**: shares boards and folders with people and teams.
- **Guest**: only views what is shared with them. Guests can't invite anyone or share with teams, and edit access given to a guest becomes view access. The server enforces this, not only the app.

### Teams

In the Share dialog, members choose **Share with a team…**. Everyone in the team gets access, and so does anyone added to the team later; people removed from the team lose it (unless they were also invited directly). Anyone can leave a board or folder a team gave them, and the owner can remove one person from it; either way the team doesn't give it back until the owner invites them again.

A server is free for up to 10 people (accounts that can sign in). Above that, an admin pastes the license key into Server admin → License. Nothing stops working without one: the app tells the people on the server that it's over the free limit.
