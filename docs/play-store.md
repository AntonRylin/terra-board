# Terra Board on Google Play

Everything the Play Console asks for, ready to paste, and how a release is built. The app itself
is described in [android.md](android.md).

- App ID: `com.socialartworks.terraboard` (fixed forever after the first upload)
- Privacy policy: https://antonrylin.github.io/terra-board/privacy/
- Account deletion (web): https://antonrylin.github.io/terra-board/privacy/#delete-account
- Contact email: montiesprache@gmail.com · Website: https://antonrylin.github.io/terra-board/
- Graphics: `docs/play-store/icon-512.png`, `docs/play-store/feature-1024x500.png`
  (`node scripts/play-store-graphics.mjs` makes them again)

## Building a release

1. The upload key lives outside the repository in `%USERPROFILE%\.terra-board-signing\`
   (`upload-key.jks` and `keystore.properties` with its password). Keep both in the password
   manager. If they are lost, Google Play support can reset the upload key, which takes days.
   `android/app/build.gradle` reads `keystore.properties` from there (or the path in
   `TERRA_ANDROID_SIGNING`) and refuses to build a release without it.
2. `npm run android:bundle` → `android/app/build/outputs/bundle/release/app-release.aab`.
3. The version comes from `package.json`: versionName `0.1.38`, versionCode
   `major·1000000 + minor·10000 + patch·100 + TERRA_ANDROID_BUILD`. Every upload needs a higher
   versionCode: a second upload of the same app version sets `TERRA_ANDROID_BUILD=1`, and so on.
4. Google Play signs the app for users (Play App Signing); the key above only signs uploads.

## Store listing

**App name** (30): `Terra Board`

**Short description** (80):
`Your whiteboards from your computer, on your phone. Notes, images, live sync.`

**Full description:**

```
Terra Board is a calm, fast whiteboard for your ideas, notes and study material. This app brings your Terra Board boards from your computer to your phone: sign in, and your boards and folders are there.

• Your boards, everywhere – everything you sync from the Terra Board desktop app (Windows and Linux) appears on your phone, and changes go both ways within seconds.
• Works offline – boards are kept on your phone, open without internet and sync when you're back online.
• Made for touch – pan and pinch-zoom with your fingers, long-press for menus, and add sticky notes, text, shapes, arrows and pen drawings.
• Pictures, PDFs and more – images and documents on your boards show on the phone too, and you can add photos from your gallery.
• Shared boards – open boards other people share with you, see who else is on the board and where they are looking, and edit together live.
• Landscape mode uses the whole screen; hide the toolbar when you only want to read.
• No ads, no tracking, no analytics. Sign in with Google or with a code sent by email; no password to remember.

Terra Board is open source (MIT). The desktop app is free and works fully offline; Terra Cloud keeps your boards in sync between your devices.
```

**Category:** Productivity · **Tags:** whiteboard, notes, mind map, study, productivity

**Screenshots:** `docs/play-store/screenshots/`: a board, view mode, the board list and
landscape, cut to Play's 2:1 limit. Taken on the emulator with a demo board ("Space & Stars");
its photos are public-domain NASA images from Wikimedia Commons (Blue Marble, Saturn by Cassini,
Curiosity on Mars, the Pillars of Creation by Webb, Earthrise, Bruce McCandless's 1984 spacewalk).
Board icons: public-domain/CC0 photos (Lisbon tram, Plaza Mayor Madrid, Vienna Palace of
Justice, dice). No third-party brands or logos, which Play rejects without permission.

## App content (Policy → App content)

- **Privacy policy:** the URL above.
- **Ads:** No ads.
- **App access:** "All or some functionality is restricted". Instructions:
  `Tap "Continue with email" and sign in with: Email: <review account> Password: <password>.`
  The review account has a password (set in the Supabase dashboard); everyone else signs in
  with an email code or Google, which reviewers cannot use.
- **Content rating:** questionnaire, category "Utility, productivity, communication or other".
  User content can be shared with other people (shared boards), no chat with strangers, no
  location, no purchases. Expected rating: Everyone / PEGI 3.
- **Target audience:** 13 and over (not designed for children, so the Families policy doesn't
  apply).
- **News app:** No. **Health app:** No. **Financial features:** none. **Government app:** No.
- **Data safety:**
  - Data collected: **Personal info → Email address** and **Name** (from Google sign-in or the
    display name); **Files and docs / Photos** and **Other user-generated content** (the boards
    and their files); **App info and performance:** none; **Device or other IDs:** the
    device's name (phone model) and an install ID, for the account's device list.
  - Purpose of all of it: **App functionality** and **Account management**. Not shared with
    third parties (Supabase and Brevo process it on our behalf, which Google does not count as
    sharing). Not used for ads or analytics.
  - Data is **encrypted in transit**: Yes. Users can **request deletion**: Yes, in the app
    (Settings → Account → Delete account) and at the web link above.
  - Collection is **required** (the app needs an account).

## Testing track, then production

Personal developer accounts created after 13 November 2023 need a **closed test with at least
12 testers opted in for 14 days in a row** before they can apply for production. Then:
Dashboard → Apply for production. Organization accounts skip this.

Closed testing → create track → upload the `.aab` → testers (email list or Google Group) →
send them the opt-in link; they install from the Play Store and stay opted in.
