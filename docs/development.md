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

`npm run installer` builds a standalone Windows x64 installer (`Terra-Board-Setup-<version>-x64.exe`) with the app and its offline resources. `npm run release` (with `GH_TOKEN` set) publishes a new version to GitHub Releases; installed copies download updates in the background and install them when the app closes. The installer is unsigned unless a signing certificate is configured.
