# Terra Board for Android

Status: first working version (debug APK). Desktop builds are unchanged: the Android code is
compiled only into `vite build --mode android`.

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
the phone every day; Android's own app backup applies instead).

Requirements: Android 8+ (minSdk 26) with an up-to-date Android System WebView (Chromium 109+ for
OPFS synchronous access handles in workers). Application ID: `terra.board.android` (change it in
`capacitor.config.json` and `android/app/build.gradle` before any store release, since it can't
change afterwards).

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

App lifecycle: Android has no window close, so pending edits are saved when the app is hidden or
paused (`visibilitychange`, Capacitor `pause`). The system back button closes the open dialog,
menu or editor (as Escape), and otherwise saves and moves the app to the background.

### Stubbed or disabled on Android

The renderer already hid these when `window.canvas` is absent; Android keeps that, and the places
that remain show "Available in the desktop app."

| Call                                                                                     | Why                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `window.canvas.cloud.*` (sign-in, sync, sharing, presence, profile), `Join with a code…` | Cloud sync runs in Electron's main process (`electron/cloud-sync.cjs` with a transaction protocol in `main.cjs`); not wired to the storage worker yet. See What's next. |
| `invoke('removeBackground')`                                                             | ONNX runtime extension, desktop only                                                                                                                                    |
| `recognizeAsset`, `recognizeImage`                                                       | Windows OCR engine                                                                                                                                                      |
| `convertOffice`, `onOfficeProgress`, `printDocument`                                     | LibreOffice / Microsoft Office conversion                                                                                                                               |
| `linkPreview`                                                                            | Fetched by the main process with network guards; Android shows plain link cards                                                                                         |
| `htmlPage`, `htmlSnapshot`, `browserSnapshot`, `browserCapture`                          | Offscreen BrowserWindows and `<webview>` (web cards)                                                                                                                    |
| `songFromLink`                                                                           | yt-dlp extension                                                                                                                                                        |
| `live.*`                                                                                 | Local web server for live sharing                                                                                                                                       |
| `miro.*`                                                                                 | Miro import runs in the main process                                                                                                                                    |
| `copyObjects`, `clipboardObjects`, `cancelCopy`                                          | Native multi-format clipboard; the renderer's web clipboard path is used                                                                                                |
| `exportImage`, `openExport`, `copyExport`                                                | Native save dialogs; the share sheet is used                                                                                                                            |
| `locateAsset`, `importAlbumFiles` (linking), `filePath`                                  | Linking to files elsewhere on disk                                                                                                                                      |

### Desktop only (hidden on Android)

`mcpStatus`, `mcpUpdate`, `onMcpSync`, `mcpReady` (MCP server for AI tools), `extensions.*`,
`updates.*`, `setOpenAtLogin`, `openFolder`, `dataDirectory`, `appInfo`, `exportLibrary`,
`fullscreenState` / `toggleFullscreen` / `setFullscreenKeys`, `onClose` / `closeReady`,
`rendererReady`, `licenses`, `platform`. Settings on Android shows only Appearance, Board panel
and Canvas; Keyboard shortcuts and the full-screen button are hidden.

## Touch input

The canvas engine (`src/canvas/engine.ts`) knew mouse and pen only. Touch, for
`pointerType === 'touch'` only, so mouse and pen behave exactly as before:

- One finger on empty board with the Select tool pans (a tap still clears the selection). One
  finger on an object selects and drags it; resize, rotate and arrow handles take a finger with
  twice the mouse's hit radius.
- A second finger cancels what the first started (a half-drawn stroke is discarded, a drag snaps
  back) and starts a pinch: zoom around the midpoint and pan with it. A pan in progress hands its
  camera to the pinch.
- Drawing tools draw with one finger; two fingers still pinch.
- Long-press (550 ms, under 8 px of movement) opens the context menu. Double-tap acts as a
  double-click (edit text, open a frame); Chromium's own tap `dblclick` is ignored so it runs once.
- Outside the canvas (board icons, folders, the board panel), `src/mobile/index.ts` turns a
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
picture and the camera. Debug APK built locally with Gradle (JDK 21). Not yet run on an Android
device or emulator.

## What's next

- Run the APK on a device/emulator and fix what differs from Chromium (WebView OPFS, service
  worker, keyboard resizing, back button).
- Cloud sync on Android: construct `CloudSync` inside the storage worker (it needs only `fs`, `os`
  and supabase-js, all available there), port main.cjs's cloud transaction / board refresh
  messages, and expose a `cloud` object to the renderer in place of `window.canvas.cloud`.
- Phone layout: default the board panel to minimal or bottom on narrow screens; a larger toolbar.
- Link previews through a native HTTP plugin with the guards in `electron/link-preview.cjs`.
- Android share target (add images and links from other apps), release signing, Play Store listing.
