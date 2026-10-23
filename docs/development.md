# Developing Terra Board

**For coding agents:** read the [LLM session memory and working guide](../LLM_MEMORY.md) for the verified build/test/reopen workflow, delivery preferences, implementation lessons and important limitations.

## Setup

Use Node 24.13 or later. Install with `npm ci`, then `npm run dev` for Electron or `npm run preview` for the browser test harness. The browser harness keeps a separate disposable library under `.local-test/browser-library`; it is not the production data location. After changing native image dependencies, restart the dev server.

```
npm test
npm run build
npm run test:desktop
npm audit --audit-level=high
npm run package
```

**Where a package goes**

- `dependencies`: only packages the main process or the storage worker `require()` (`electron/**`). electron-builder copies these into `app.asar`.
- `devDependencies`: packages only the renderer imports (React, Pixi, pdf.js, lucide and so on). Vite bundles them into `dist`, so listing them under `dependencies` would ship them twice.

Because renderer libraries still ship inside `dist`, audit without `--omit=dev`. Findings in build-only tools don't reach users: electron-builder and its download chain, the Supabase CLI, TypeScript, Vite. Findings in renderer libraries do.

**Licenses**

- Settings → About → Open-source licenses comes from three sources:
  - the main-process packages in `node_modules`;
  - `dist/licenses.json`, which the build writes from the modules Vite bundled;
  - notices for the bundled model, yt-dlp and the Visual C++ runtime.
- The list is assembled in `electron/licenses.cjs`.
- If you bundle a new non-npm file, add its notice there.

The packaging command writes to `release/win-unpacked` inside the repository. Keep this layout so direct executable launches find the repository's `Library` folder. Do not use AppData or OneDrive as project, build or library destinations.

In PowerShell, `$env:CANVAS_SCALE='1'; npm run test:desktop` generates a disposable 10,000-object / 1,000-image workload and measures first-canvas startup. `CANVAS_EXECUTABLE` can point to the packaged executable to verify that artifact. Remove those environment variables afterward in an interactive shell.

See [verification notes](verification.md) for evidence and open release gates, and [architecture/design](product-design.md) for the longer-term product direction.

## Extensions

Background removal (the u2net model and onnxruntime), Song links (yt-dlp) and Office files (LibreOffice) are not in the app package. People install them from Settings → Extensions (`electron/extensions.cjs`).

**Building them**
- `scripts/build-extensions.mjs` runs as part of `npm run package`, `installer` and `release`.
- It writes the payloads into `release/extensions` and the catalog the app embeds into `electron/generated/extensions.json`. The catalog holds each file's address, size and SHA-256.
- The onnxruntime zip, with the Visual C++ runtime, comes out the same on every build, so its name changes only when its contents do.
- The pinned third-party files are listed in `scripts/payloads.mjs`.

**Where they install**
- Repository builds, including `npm run dev`, install from `release/extensions` into `release/installed-extensions`. Nothing is downloaded.
- Installed copies download into `%LOCALAPPDATA%\Terra Board\Extensions`:
  - the model and yt-dlp from their projects' GitHub releases;
  - the onnxruntime zip from this project's release of the same version;
  - LibreOffice from The Document Foundation.
- `TERRA_EXTENSIONS_DIR` and `TERRA_EXTENSIONS_SOURCE` override the install folder and the local source; the desktop checks use them.
- `scripts/desktop-extensions.mjs` installs and removes through the Settings tab.

## Linux

Terra Board also builds for Linux x64 as an AppImage and a .deb (`electron-builder.linux.cjs`). Build it on Linux: sharp and onnxruntime need their Linux binaries, and npm installs those only on Linux, so a Linux package made on Windows would not start.

**With GitHub Actions** (the usual way)
1. Push the branch, or a `v<version>` tag.
2. On GitHub, open Actions → **Linux build** → **Run workflow** and pick the branch. A pushed `v*` tag runs it on its own.
3. When it finishes, download the **terra-board-linux-x64** artifact at the bottom of the run's page. It holds `Terra-Board-x86_64.AppImage`, `terra-board_<version>_amd64.deb`, `latest-linux.yml` and the Linux onnxruntime zip.

The workflow (`.github/workflows/linux.yml`) runs `npx tsc --noEmit`, `npm test` under Xvfb, `npm run installer:linux`, then checks both packages the way people use them, with Ubuntu's sandbox restriction back on: the AppImage once with `--smoke-test`, then `scripts/app-smoke.mjs` on the AppImage and on the installed .deb. That script starts the app with an empty library in a throwaway `XDG_DATA_HOME`, adds a board with a note and an image through the app's bridge, closes the window like the user does, starts it again and checks that everything came back, installs Background removal and Song links from `release/extensions` and runs them, and connects with the MCP stdio entry Settings shows for Claude Desktop. For the AppImage it also checks the applications-menu entry it writes. Screenshots of the reopened board are uploaded as **terra-board-linux-screenshots**. The workflow only uploads workflow artifacts; it never creates or changes a release.

`scripts/app-smoke.mjs` works on any built copy: `node scripts/app-smoke.mjs <executable> [args]` with `CANVAS_DATA_DIR` (or `XDG_DATA_HOME` for an installed Linux copy) pointing at a throwaway folder; on Windows `node scripts/app-smoke.mjs node_modules/electron/dist/electron.exe .` after `vite build` checks the development build. Its environment variables are described at the top of the file.

**On a Linux machine**: Node 24.13 or later, then `npm ci` and `npm run installer:linux`. Output goes to `release/linux`. Set `ONNXRUNTIME_NODE_INSTALL=skip` before `npm ci` to stop onnxruntime downloading CUDA libraries it doesn't need. `npm test` needs a display (`xvfb-run -a npm test` without one): two tests print PDFs through Electron. Ubuntu 24.04 blocks the user namespaces Chromium's sandbox needs for an unpacked Electron, so tests that start Electron may need `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.

**Running it**
- AppImage: `chmod +x Terra-Board-x86_64.AppImage`, then run it. It needs FUSE 2 (`libfuse2`, `libfuse2t64` on Ubuntu 24.04). Where the system blocks the user namespaces Chromium's sandbox uses (Ubuntu 24.04 and later), its launcher starts it with `--no-sandbox`. On each start it writes `~/.local/share/applications/terra-board.desktop` pointing at wherever the file now is (and copies its icon to `~/.local/share/Terra Board/terra-board.png`), so it shows in the applications menu and receives `terraboard://` links; it leaves that alone when the .deb's system entry exists (`electron/linux-desktop.cjs`). Programs it starts from the system (LibreOffice) get `PATH`/`LD_LIBRARY_PATH` without the AppImage's own folders (`systemEnv`).
- .deb: `sudo apt install ./terra-board_<version>_amd64.deb`. It adds Terra Board to the applications menu and registers `terraboard://` links.

**What differs from Windows**
- Text recognition (Copy text from images, reading scanned PDF pages) uses the Windows OCR engine, so it is off. The image menu shows Copy text disabled with "Text recognition is available on Windows."; PDFs with their own text still copy.
- Office files uses the LibreOffice installed in the system (`/usr/bin/soffice` and the usual other places, see `officeLocation`). There is no LibreOffice download; without one, Settings → Extensions says to install it with the package manager.
- Background removal and Song links work: the build packs onnxruntime's Linux library and the Linux yt-dlp (`scripts/payloads.mjs`).
- Launch at login writes an XDG autostart entry, `~/.config/autostart/terra-board.desktop` (the AppImage's entry starts the AppImage file). Turning it off in the desktop's own startup settings (`Hidden=true`) shows as off in Terra Board.
- AI access via MCP: an AppImage runs from a new `/tmp/.mount_*` folder every launch, so its stdio entry for Claude Desktop is a `/bin/sh -c` script that mounts the AppImage file (`--appimage-mount`) and runs `mcp-stdio.cjs` from it as Node, skipping the AppImage's launcher, whose `--no-sandbox` Node would reject (`stdioLauncher` in `electron/mcp-server.cjs`); the .deb's entry is `/opt/Terra Board/terra-board`. Claude Desktop's config on Linux is `~/.config/Claude/claude_desktop_config.json`.
- The window keeps the desktop's own title bar; the extra Windows shadow window is Windows only.
- IT can lock the server with `/etc/terra-board/server.json` (Windows: `%ProgramData%\Terra Board\server.json`).

**Updates**: the AppImage updates itself like the Windows installer, from `latest-linux.yml` in the newest GitHub release. The .deb does not replace itself: it announces new versions, and its Download button fetches the new AppImage named in `latest-linux.yml`. Both read `latest-linux.yml`, so Linux copies hear of a version only once its release carries the Linux files.

**Publishing a Linux build** (not automatic): after the Windows release of `v<version>` exists, upload the four files from the workflow artifact to it:

```
gh release upload v<version> Terra-Board-x86_64.AppImage terra-board_<version>_amd64.deb latest-linux.yml onnxruntime-<ort-version>-linux-x64-<hash>.zip
```

The onnxruntime zip must be there, or installed Linux copies cannot install Background removal. Check with `node scripts/check-extension-downloads.mjs` on a machine that built the Linux catalog, or by installing the extension.

## Where data lives

Installed copies keep each user's boards in `%LOCALAPPDATA%\Terra Board\Library`, outside the installation directory, so upgrading or uninstalling the app preserves the library. On Linux that is `$XDG_DATA_HOME/Terra Board/Library`, normally `~/.local/share/Terra Board/Library`.

Development and packaged repository builds share a repository-local `Library` folder (boards, original media, settings, browser caches, logs and temporary files), outside the replaceable `release` directory. `Library` and compiled builds are ignored by Git. `Open Terra Board.cmd` launches `release\win-unpacked\Terra Board.exe`; keep the executable's support files alongside it.

## Releasing

`npm run installer` builds a standalone Windows x64 installer (`release/installer/Terra-Board-Setup-x64.exe`) with the app and its offline resources. The file name has no version, so <https://github.com/AntonRylin/terra-board/releases/latest/download/Terra-Board-Setup-x64.exe> always serves the newest one. The installer is unsigned unless a signing certificate is configured.

To release a version:

1. Raise `version` in `package.json` and commit.
2. Run `npm run installer`, then `npm run test:update` with every Terra Board window closed. It installs the new installer into `.local-test`, serves a build of the next version from localhost and checks the update prompt, **Restart to update** (installs and reopens the app) and uninstalls again. Add `--installer <older installer> --feed release/installer` to update an older version to this one, `--close-first` to check that closing the prompt and quitting installs it, and `--source "release/win-unpacked/Terra Board.exe"` to check the from-source prompt. Run it from a normal terminal: the installer reopens the app through Explorer, which a sandboxed shell blocks.
3. Publish the installer, its blockmap, `latest.yml` and the onnxruntime zip of the Background removal extension as a GitHub release tagged `v<version>`. Installed copies download that zip from this release:

   ```
   gh release create v0.1.29 release/installer/Terra-Board-Setup-x64.exe release/installer/Terra-Board-Setup-x64.exe.blockmap release/installer/latest.yml release/extensions/onnxruntime-1.30.0-win32-x64-<hash>.zip --title 0.1.29 --notes-file notes.md
   ```

   `npm run release` with `GH_TOKEN` set publishes the first three through electron-builder. Add the zip afterwards with `gh release upload v<version> release/extensions/onnxruntime-*.zip`. Then run `node scripts/check-extension-downloads.mjs` (`npm run release` runs it last). It fails if any extension file cannot be downloaded.

Every packaged copy reads `latest.yml` from the newest release a few seconds after launch and every 4 hours. Installed copies download the new installer in the background and show a prompt with the new version: **Restart to update** installs it and reopens the app, closing the prompt leaves it to install when the app quits, and **What's new** opens the release. Builds from source show the same prompt with **Download**, which opens the installer link. A version is only announced once its release has `latest.yml`, so bumping `package.json` alone changes nothing for users.

To test the flow locally, set `TERRA_UPDATE_FEED` to a folder URL serving a newer installer and its `latest.yml` (installed-style updates from any build), or `TERRA_VERSION_URL` to a `latest.yml` URL (the source-build prompt).
