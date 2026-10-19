# Developing Terra Board

**For coding agents:** read the [LLM session memory and working guide](../LLM_MEMORY.md) for the verified build/test/reopen workflow, delivery preferences, implementation lessons and important limitations.

## Setup

Use Node 24.13 or later. Install with `npm ci`, then `npm run dev` for Electron or `npm run preview` for the browser test harness. The browser harness keeps a separate disposable library under `.local-test/browser-library`; it is not the production data location. After changing native image dependencies, restart the dev server.

```
npm test
npm run build
npm run test:desktop
npm audit --omit=dev --audit-level=high
npm run package
```

The packaging command writes to `release/win-unpacked` inside the repository. Keep this layout so direct executable launches find the repository's `Library` folder. Do not use AppData or OneDrive as project, build or library destinations.

In PowerShell, `$env:CANVAS_SCALE='1'; npm run test:desktop` generates a disposable 10,000-object / 1,000-image workload and measures first-canvas startup. `CANVAS_EXECUTABLE` can point to the packaged executable to verify that artifact. Remove those environment variables afterward in an interactive shell.

See [verification notes](verification.md) for evidence and open release gates, and [architecture/design](product-design.md) for the longer-term product direction.

## Where data lives

Installed copies keep each user's boards in `%LOCALAPPDATA%\Terra Board\Library`, outside the installation directory, so upgrading or uninstalling the app preserves the library.

Development and packaged repository builds share a repository-local `Library` folder (boards, original media, settings, browser caches, logs and temporary files), outside the replaceable `release` directory. `Library` and compiled builds are ignored by Git. `Open Terra Board.cmd` launches `release\win-unpacked\Terra Board.exe`; keep the executable's support files alongside it.

## Releasing

`npm run installer` builds a standalone Windows x64 installer (`release/installer/Terra-Board-Setup-x64.exe`) with the app and its offline resources. The file name has no version, so <https://github.com/AntonRylin/terra-board/releases/latest/download/Terra-Board-Setup-x64.exe> always serves the newest one. The installer is unsigned unless a signing certificate is configured.

To release a version:

1. Raise `version` in `package.json` and commit.
2. Run `npm run installer`, then `npm run test:update` with every Terra Board window closed. It installs the new installer into `.local-test`, serves a build of the next version from localhost and checks the update prompt, **Restart to update** (installs and reopens the app) and uninstalls again. Add `--installer <older installer> --feed release/installer` to update an older version to this one, `--close-first` to check that closing the prompt and quitting installs it, and `--source "release/win-unpacked/Terra Board.exe"` to check the from-source prompt. Run it from a normal terminal: the installer reopens the app through Explorer, which a sandboxed shell blocks.
3. Publish the installer, its blockmap and `latest.yml` as a GitHub release tagged `v<version>`:

   ```
   gh release create v0.1.27 release/installer/Terra-Board-Setup-x64.exe release/installer/Terra-Board-Setup-x64.exe.blockmap release/installer/latest.yml --title 0.1.27 --notes-file notes.md
   ```

   (`npm run release` with `GH_TOKEN` set does the same through electron-builder.)

Every packaged copy reads `latest.yml` from the newest release a few seconds after launch and every 4 hours. Installed copies download the new installer in the background and show a prompt with the new version: **Restart to update** installs it and reopens the app, closing the prompt leaves it to install when the app quits, and **What's new** opens the release. Builds from source show the same prompt with **Download**, which opens the installer link. A version is only announced once its release has `latest.yml`, so bumping `package.json` alone changes nothing for users.

To test the flow locally, set `TERRA_UPDATE_FEED` to a folder URL serving a newer installer and its `latest.yml` (installed-style updates from any build), or `TERRA_VERSION_URL` to a `latest.yml` URL (the source-build prompt).
