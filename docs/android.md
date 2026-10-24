# Terra Board for Android

Status: debug APK. The app is a **Terra Cloud client**: it connects to the person's cloud library
first and keeps a copy on the phone (see Terra Cloud below). Desktop builds are unchanged: the
Android code is compiled only into `vite build --mode android`.

## Approach

Electron does not run on Android, so the Android app is a **Capacitor** shell around the same
Vite/React/Pixi renderer the desktop app uses. The renderer already ran without Electron in the
browser harness (`npm run preview`), where `window.canvas` is absent and storage commands go
through `invoke()`. Android keeps that path and changes where `invoke()` goes.

The main decision is **where the library lives**. Rewriting `electron/store.cjs` for mobile would
fork its validation, revision, history and sync logic, and every later storage change would need
doing twice. Instead the Android build runs the real `store.cjs`, unchanged, inside a Web Worker
(`src/mobile/store-worker.ts`), with small stand-ins for the Node modules it requires:

| Node module the store uses                        | Android replacement (`src/mobile/shims/`)                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `node:sqlite` `DatabaseSync`                      | SQLite compiled to WebAssembly (`@sqlite.org/sqlite-wasm`) on the **OPFS SAH-pool** VFS: synchronous, persistent, in the app's private storage  |
| `node:fs` (asset files, settings)                 | A small synchronous file system kept in a second SQLite database (`files.sqlite`) on the same VFS. OPFS itself only opens files asynchronously. |
| `sharp` (previews, thumbnails, tiles, PNG export) | `createImageBitmap` + `OffscreenCanvas` (WebP/PNG/JPEG encoding)                                                                                |
| `node:crypto`                                     | `crypto.randomUUID` and SHA-256 from `@noble/hashes`                                                                                            |
| `Buffer`, `node:path`, `node:os`, `node:stream`   | `buffer` package, a POSIX `path`, small stubs                                                                                                   |

The board database has exactly the desktop schema (`library.sqlite`), and portable `.canvas`
export/import is the same format as on desktop. `tests/android-store.test.mjs` runs the real store
through these shims in Node, so a storage change that breaks Android fails `npm test`.

Pictures are drawn from URLs: `mediaUrl()` → `/__local/asset/<id>/<variant>`, the same URLs the
browser harness uses. On Android a **service worker** (`src/mobile/terra-sw.js`, copied to the
build root as `terra-sw.js`) answers those requests: it asks the page, which asks the storage
worker for the bytes (`src/mobile/host.ts`). Range requests are answered for video. Capacitor
resolves service-worker requests on Android by default (`android.resolveServiceWorkerRequests`).

The target is chosen at build time. Renderer code imports `src/mobile/platform.ts`, which is the
desktop/browser version (everything off). `vite.config.ts` replaces it with `src/mobile/index.ts`
and installs the shims only for `--mode android`, so the desktop bundle contains no Android code
and the Electron path (`window.canvas`) is untouched.

Opening the library safely: if SQLite-WASM's `installOpfsSAHPoolVfs()` cannot open one of the
pool's files (still held by the previous worker during a reload, or by another tab), it deletes
the pool's whole directory, which is every board. The storage worker therefore first takes the
`terra-board-library` Web Lock (released when its worker ends) and then waits until every pool
file can be opened (`src/mobile/pool-guard.ts`); if either stays busy for 15 s it stops with an
error and leaves the files alone.

Not kept from desktop on Android: SQLite WAL (the pool VFS has no shared memory, so SQLite keeps a
rollback journal) and the daily `VACUUM INTO` backup in `backups/` (it would double the library on
the phone every day).

Backups: the library on the phone is a copy of the cloud library, so the cloud and the person's
computers hold every board. Edits made offline live only on the phone until they upload; Settings →
Account shows how many are waiting. Export / share a copy… still saves a single board as a portable
`.canvas` file through the share sheet.

## Terra Cloud

A phone without the person's boards is of little use, so the Android app has no local-only mode.
Its first screen connects it to Terra Cloud; after that the home screen lists the cloud library (the
person's boards and folders, plus folders and boards other people share with them), cached on the
phone so it opens offline and syncs when back online.

**One sync engine.** `electron/cloud-sync.cjs` runs unchanged inside the storage worker
(`src/mobile/cloud-worker.ts`), like `store.cjs`. It needs `fs` (its session file and asset
uploads, from the files shim), `os.hostname()` (the device name: the phone model) and supabase-js,
which runs in a worker as it is (fetch, and WebSocket for Realtime). The worker plays the part of
`electron/main.cjs`:

- sync's store calls go through the same queue as the page's commands, so the two never interleave;
- the page's writes that change synced content (`createBoard`, `patchBoard`, …) call
  `localChanged()`, which uploads them 1.5 s later, as on desktop;
- changes from the cloud run as an _external transaction_: the worker asks the page to pause the
  board (`prepare`: save pending edits, make the board inert), applies them, then asks it to reload
  what changed (`finish`). The page answers with `externalReady`, the desktop's `mcpReady`. Before
  the board is on screen the page answers at once;
- status and presence events are posted to the page.

The renderer gets the same `cloud` API as the desktop's `window.canvas.cloud`
(`src/mobile/cloud.ts`), exported from `bridge.ts` as `cloudApi` together with `onExternalSync` /
`externalReady`. So the presence layer (other people's pictures and cursors on a board), the board
info card, the share dialog and the sync status work on Android without Android-specific code. The
server is always Terra Cloud (`package.json` → `terraCloud`); there is no server choice on the phone.

**Signing in.** The sign-in screen (`src/mobile/ui/SignIn.tsx`) uses the accounts code shared
with the desktop (`electron/cloud-auth.cjs` inside `CloudSync`, which runs in the worker like the
rest): **Continue with Google** (and Microsoft when the server offers it), **Continue with
email** (email and password, for accounts that have one, such as the store review account) and
**Email me a sign-in code** (no password, no browser). Only the methods the server enables are shown
(`/auth/v1/settings`). Google refuses sign-in inside an app's WebView, so the provider page opens in
a Custom Tab (`@capacitor/browser`): the worker cannot open it, so it posts `open-url` to the page.
Supabase then redirects to `terraboard://auth/callback?code=…`; the intent filter in
`android/app/src/main/AndroidManifest.xml` hands that link to the app (`singleTask`), Capacitor's `appUrlOpen` (or `getLaunchUrl` on a cold start) passes it to
`finishOAuth`, and the PKCE verifier kept in the worker's session file makes the code useless to
any other app that registers the same scheme. While the browser is open the screen says "Finish in
your browser" with Cancel. After signing in, the gate attaches the phone to the account's personal
workspace with the whole library synced (`setLibrary(true)`), and the phone registers as one of the
account's devices (its model name). Invite codes for someone's shared board are entered in
Settings → Account. Pairing codes are gone (accounts replace them); the first version of this
screen used them, see Verified.

**First start.** `src/mobile/ui/MobileGate.tsx` wraps the app: no cloud identity → the sign-in
screen; connected but nothing on the phone yet → "Getting your boards" until the first sync ends
(offline or an error offers Try again); boards on the phone → the app, at once, online or not. An
empty cloud library gets one "Ideas" board, which syncs like any other. Android no longer creates
a starter board on its own.

**Files that fail to download.** A picture or file a synced board uses that the server refuses,
that is gone or that cannot be read is remembered (`sync_fetch` in `store-sync.cjs`) and tried
again on later syncs, 30 s after the failure and then twice as long each time, at most every
6 hours; the open board reloads when it arrives. Losing the connection mid-download stops the
round instead, so the whole pull is redone. Each start also scans the synced boards for files
the library lacks (from before failures were remembered) and queues them. This is shared with
the desktop app.

**Keeping up.** Realtime pings from the workspace make the phone pull within a second while the app
is open; it also syncs every 30 s, when the app comes back to the foreground (Capacitor `resume`),
and when the network returns (`online`). Chromium reports a lost network as "Failed to fetch",
which `cloud-sync.cjs` now counts as offline (it knew only Node's "fetch failed").

**Settings → Account** (`src/mobile/ui/AccountSettings.tsx`, in place of the desktop's Account page
and listed first on Android): the account's email and the name others see, sync status with Sync
now, boards shared with you (Leave) and Join with a code for invites, **Switch account** and **Sign
out**. Signing out signs out of the account (`cloud.signOut()`: this phone leaves the account's
devices), then deletes the phone's whole library: every
file of the SQLite pool (boards, pictures, settings, the session), so the next account starts empty
and nothing of the previous one stays on the phone. A marker file outside the pool
(`terra-board-wipe`) makes a wipe that was cut short finish at the next start. If changes have not
uploaded yet, Sign out says how many and offers Sync now or Sign out anyway. Switch account is the
same step followed by connecting again.

Not on the phone: turning library sync off (the phone always syncs the whole library), server
choice, editing the profile picture and entrance song, the device list and deleting the account
(all in the desktop app).

Requirements: Android 8+ (minSdk 26) with an up-to-date Android System WebView (Chromium 109+ for
OPFS synchronous access handles in workers). Application ID: `com.socialartworks.terraboard`
(fixed for Google Play; the Java namespace stays `terra.board.android`). Builds with the earlier ID
`terra.board.android` install as a separate app. Releasing to Google Play (signing, `.aab`,
versions, listing): [play-store.md](play-store.md).

## Bridge mapping

Every call the renderer makes through `src/bridge.ts` / `window.canvas`, and what Android does.

### Core board experience (works on Android)

| Call                                                                                                                                       | Android                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `invoke('library' / 'createBoard' / 'updateBoard' / 'duplicateBoard' / 'restoreBoard' / 'createFolder' / 'updateFolder' / 'removeFolder')` | `store.cjs` in the storage worker                                                                                        |
| `invoke('loadBoard' / 'patchBoard' / 'saveCamera' / 'setLastBoard' / 'searchContent')`                                                     | same                                                                                                                     |
| `invoke('boardHistory' / 'boardInfo' / 'boardSyncs' / 'assetInfo' / 'assetLinks')`                                                         | same                                                                                                                     |
| `invoke('importAsset')`, `importFiles`, `pickMedia`, `chooseFiles`                                                                         | Android's file / photo picker through `<input type=file>` (the WebView shows the system chooser); bytes go to the worker |
| `mediaUrl`, `assetDimensions`                                                                                                              | service worker → storage worker (`readAsset`, including tiles and PNG export variants)                                   |
| `invoke('exportBoard' / 'importBoard')`, `exportPortable`, `importPortable`                                                                | worker; exports go to the Android share sheet (`@capacitor/share`), imports through the file picker                      |
| `downloadAsset`, `download` (image/PDF exports)                                                                                            | the share sheet (the WebView has no downloads)                                                                           |
| `openLink`                                                                                                                                 | `@capacitor/browser` (in-app browser tab)                                                                                |
| `cloudApi` (desktop: `window.canvas.cloud`), `onExternalSync`, `externalReady`                                                             | `electron/cloud-sync.cjs` in the storage worker (see Terra Cloud)                                                        |

App lifecycle: Android has no window close, so pending edits are saved when the app is hidden or
paused (`visibilitychange`, Capacitor `pause`). The system back button first hides the keyboard
(Android does that), then finishes text being edited on the board (keeping it, like tapping
elsewhere; Escape would discard it), then closes the open menu, dialog or full page such as
Settings (as Escape), and otherwise saves and moves the app to the background.

### Stubbed or disabled on Android

The renderer already hid these when `window.canvas` is absent; Android keeps that, and the places
that remain show "Available in the desktop app."

| Call                                                            | Why                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `invoke('removeBackground')`                                    | ONNX runtime extension, desktop only                                            |
| `recognizeAsset`, `recognizeImage`                              | Windows OCR engine                                                              |
| `convertOffice`, `onOfficeProgress`, `printDocument`            | LibreOffice / Microsoft Office conversion                                       |
| `linkPreview`                                                   | Fetched by the main process with network guards; Android shows plain link cards |
| `htmlPage`, `htmlSnapshot`, `browserSnapshot`, `browserCapture` | Offscreen BrowserWindows and `<webview>` (web cards)                            |
| `songFromLink`                                                  | yt-dlp extension                                                                |
| `live.*`                                                        | Local web server for live sharing                                               |
| `miro.*`                                                        | Miro import runs in the main process                                            |
| `copyObjects`, `clipboardObjects`, `cancelCopy`                 | Native multi-format clipboard; the renderer's web clipboard path is used        |
| `exportImage`, `openExport`, `copyExport`                       | Native save dialogs; the share sheet is used                                    |
| `locateAsset`, `importAlbumFiles` (linking), `filePath`         | Linking to files elsewhere on disk                                              |

### Desktop only (hidden on Android)

`mcpStatus`, `mcpUpdate` (MCP server for AI tools), `extensions.*`,
`updates.*`, `setOpenAtLogin`, `openFolder`, `dataDirectory`, `appInfo`, `exportLibrary`,
`fullscreenState` / `toggleFullscreen` / `setFullscreenKeys`, `onClose` / `closeReady`,
`rendererReady`, `licenses`, `platform`. Settings on Android shows only Account, Appearance
and Canvas; Keyboard shortcuts and the full-screen button are hidden.

## Screen and layout

- Landscape gives the board the whole screen: `MainActivity.java` hides the status bar and the
  navigation buttons (a swipe from an edge shows them for a moment) and lets the page use the
  side with the camera hole. Portrait keeps both bars. Capacitor's own inset padding is off
  (`plugins.SystemBars.insetsHandling: "disable"` in `capacitor.config.json`); the activity pads
  for the bars in portrait and for the keyboard in both orientations.
- There is no board panel: the app opens on a home screen (`MobileHome.tsx`) that lists every
  board and folder, as phones and tablets expect. Recent boards come first once there are more
  than four; folders open in place and stay open; "⋯" or a long press on a row opens the same
  menu as on desktop (rename, icon, move, share, Trash); New offers a board, a folder or Join
  with a code. A board fills the screen, with a back button beside its name; Android's back
  gesture also returns to the list, and on the list it leaves the app.
- The canvas toolbar can be hidden: + → Hide toolbar (also in the canvas "…" menu). A Show
  toolbar button then sits in the zoom bar. This works on desktop too.
- Toolbar tools are rearranged by touch with a long press (450 ms, a short vibration, then drag
  into the + menu or along the bar). A touch drag used to be cancelled at once: the button's
  own pointer capture ending was taken for the drag's.

## Touch input

The canvas engine (`src/canvas/engine.ts`) knew mouse and pen only. Finger gestures are switched
on only in the Android app (`engine.setTouchGestures(android)` in `Whiteboard.tsx`) and only for
`pointerType === 'touch'`, so mouse, pen and desktop touchscreens behave exactly as before.
Enabling them on Windows/Linux touchscreens is a one-line change, to make after testing there.
On Android:

- One finger on empty board with the Select tool pans (a tap still clears the selection). One
  finger on an object selects and drags it; resize, rotate and arrow handles take a finger with
  twice the mouse's hit radius.
- A second finger cancels what the first started (a half-drawn stroke is discarded, a drag snaps
  back) and starts a pinch: zoom around the midpoint and pan with it. A pan in progress hands its
  camera to the pinch.
- Drawing tools draw with one finger; two fingers still pinch.
- Long-press (550 ms, under 8 px of movement) opens the context menu with the other tools. Double-tap
  acts as a double-click (edit text, open a frame); Chromium's own tap `dblclick` is ignored so it
  runs once.
- With the Select tool a long-press selects instead (a short vibration): held on empty board it
  starts a selection box to drag out (lifting without dragging still opens the board menu), held
  on an object it adds that object to the selection, or takes it out again. Panning keeps the
  selection; a tap on empty board clears it. The selection toolbar then offers Lock and the rest.
- A tap inside a frame selects the frame, and a finger then drags it from anywhere inside; its
  edges are wider for a finger (20 px on screen). A frame's name is edited on the line above it,
  growing upward and kept within the screen; a new frame's "Untitled frame" is selected so
  typing replaces it.
- New text, notes, shapes and frames made while zoomed out are made larger, so they show at a
  readable size on screen (text at least 16 px).
- Outside the canvas (the rows of the home screen), `src/mobile/index.ts` turns a
  long-press into the `contextmenu` a right-click sends, replacing the WebView's own long-press.

## Build and run

```bash
npm run build:android     # tsc, vite build --mode android, cap sync android
npm run android:apk       # build:android, then Gradle assembleDebug
npm run android:open      # open android/ in Android Studio
node scripts/android-icons.mjs   # regenerate launcher icons and splash from assets/icon.png
```

The debug APK is `android/app/build/outputs/apk/debug/app-debug.apk`. `scripts/android-gradle.mjs`
finds a JDK (JAVA_HOME, or Android Studio's bundled `jbr`) and the SDK (ANDROID_HOME, or the
default Android Studio location), so no environment variables are needed on a machine with Android
Studio.

To run it on an emulator you need a system image and a virtual device (Android Studio → Device
Manager → Create device, any Pixel with an x86_64 image, API 34+), then:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

The WebView can be inspected from desktop Chrome at `chrome://inspect` (debug builds only).

To try the Android web bundle without a device: `npx vite build --mode android --outDir dist-android`,
then `npx vite preview --mode android --outDir dist-android --port 4174` and open it in Chrome with
phone emulation. Storage, pictures, touch and settings behave as in the app; Capacitor plugins
(share sheet, browser, back button) fall back to their web versions.

CI: `.github/workflows/android.yml` (manual `workflow_dispatch` only) runs the Android storage test,
builds the debug APK and uploads it as the `terra-board-android-debug` artifact. It never signs for
release, publishes or creates releases.

## Verified

2026-10-23, Chromium with phone emulation (390×844, touch), Android bundle served by `vite preview`:
create, rename and trash boards; sticky notes with typed text; text; rectangles; pen strokes; image
import (JPEG through the sharp shim and the service worker); one-finger pan, pinch zoom (100% → 35%);
long-press menus on the canvas and the board panel; Settings; reload keeps every object, the
picture and the camera. Debug APK built locally with Gradle (JDK 21).

2026-10-23, the debug APK on an Android 16 emulator (Pixel 7, `system-images;android-36;google_apis;x86_64`,
WebView 133), driven with real touches (`adb shell input`) and CDP touch events: startup ~1 s with
the service worker active; notes, text, rectangles and pen strokes by touch; one-finger pan and
two-finger pinch; long-press menus on the canvas, board icons and the board panel; create, rename
and trash boards (keyboard resizes the page, dialogs stay visible); a photo picked through the system
file picker; export to the Android share sheet (`<board>.canvas`); Settings; the back button;
everything kept after Home + force-stop + relaunch and after installing a new APK over the old one.
Fixed along the way: toolbar labels stuck on screen after a tap (now shown only for hover-capable
pointers), Back from Settings leaving the app, Back while editing discarding the text, and a click
reaching a menu that opened under the finger after a long-press.

2026-10-23, Terra Cloud on the emulator (same device), against the real Terra Cloud with a
throwaway workspace ("Test PC") made by a script that runs the desktop's `store.cjs` and
`cloud-sync.cjs` in Node on a scratch library, and a second throwaway person ("Friend") sharing one
board: first start shows the sign-in screen; a pairing code typed by touch connects the phone and
downloads the folder and boards; a note added by touch reaches the computer; notes added on the
computer appear on the open board within seconds; presence both ways (the computer's picture and
moving cursor on the phone, the phone listed with its model name on the computer); an invite code in
Settings → Account brings the friend's board with its shared badge; offline: an edit, force-stop,
relaunch offline opens the cached library with the edit, and it uploads once back online; Sign out
with an unsent change warns and offers Sync now; Sign out removes the phone from the workspace's
devices and leaves no board text or session token in the phone's storage (checked by reading the
pool files); connecting again downloads the library cleanly. Startup to the board: ~1.8–2.4 s
(sign-in gate and cloud add ~50 ms). Seen once on the emulator: after the app came back from the
background the WebView stayed blank until the first touch, though the page was fully rendered.

**Accounts (stage 2), 2026-10-23**, on the emulator with the accounts branch merged: the sign-in
screen shows the methods production offers today (email only; Google is off there); with Google
forced on in a throwaway build, Continue with Google opened the browser through the worker →
page → Custom Tab path and the screen switched to "Finish in your browser"; a
`terraboard://auth/callback?error=access_denied` link sent with `adb shell am start` reached the
app through the intent filter and ended the waiting sign-in ("Signing in was cancelled."); the
email step rejects a malformed address. **Not tested yet**, because it needs the accounts
migration (`supabase/migrations/20261023120000_accounts.sql`) on a server and production must not
be changed: sending and entering a real email code, a real Google sign-in and code exchange, the
phone in the account's device list, and syncing as an account. There is no Docker on this PC for a
local Supabase. The first test above (pairing codes) ran on the build before the merge.

## What's next

- Test account sign-in end to end once the accounts migration is on a test server (or on
  Terra Cloud): email code, Google (needs Google enabled and `terraboard://auth/callback` on the
  redirect allow-list), the phone in the device list, Sign out revoking it. A phone killed while
  the Custom Tab is open loses the waiting sign-in (the callback is then ignored, and the person
  taps Continue again).
- Try it on a physical phone (performance with large boards, older WebViews, tablets).
- Large libraries: the first download shows no progress (the status has no download count), and
  every picture in the library is downloaded, not only the open board's.
- Link previews through a native HTTP plugin with the guards in `electron/link-preview.cjs`.
- Android share target (add images and links from other apps), release signing, Play Store listing.
