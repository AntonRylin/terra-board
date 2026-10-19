# Terra Board

A free, open-source whiteboard for Windows. Drop in images, videos, PDFs, notes and links, and arrange them on an infinite canvas. Everything stays on your computer — no account, no server, no telemetry.

## Install

1. Download **`Terra-Board-Setup-x.x.x-x64.exe`** from the [latest release](https://github.com/AntonRylin/terra-board/releases/latest).
2. Run it and follow the installer.
3. Open **Terra Board** from the Start menu or desktop.

That's it. The app updates itself when new versions come out.

> Windows may show a SmartScreen warning because the installer isn't code-signed yet. Click **More info → Run anyway**.

Your boards are saved in `%LOCALAPPDATA%\Terra Board\Library`, so updating or uninstalling the app never deletes them.

## What it does

- **Infinite canvas** — pan, zoom, text, sticky notes, shapes, frames, arrows, highlighter, undo/redo.
- **Images and video** — paste or drag them in; full-resolution viewer, cropping, rotation.
- **PDFs and documents** — read PDFs, reorder and merge pages, convert to images or text, preview Word files.
- **Copy text from images** — select and copy text from screenshots and scanned PDFs (uses Windows' built-in OCR).
- **Links** — pasted links become preview cards; YouTube videos play right on the board.
- **Organize** — boards with custom icons and colors, folders, search, trash and restore.
- **Share** — export a board as a `.canvas` file, or as PNG, JPG or PDF.
- **AI access** — let Claude or Codex read and edit your boards over [MCP](docs/MCP.md) (off by default).

## Basic controls

| Action | How |
| --- | --- |
| Move around | Right-drag, or hold **Space** and drag |
| Zoom | Mouse wheel |
| Select / text / note / shape / arrow / frame | **V** / **T** / **N** / **R** / **A** / **F** |
| Fit the board | **0** |
| Search | **Ctrl+K** |
| Undo / redo | **Ctrl+Z** / **Ctrl+Shift+Z** |
| Full screen | **F11** |

The full list of features and shortcuts is in the [user guide](docs/user-guide.md).

## Build from source

You need [Node.js](https://nodejs.org/) 24.13 or newer and Windows.

```bash
git clone https://github.com/AntonRylin/terra-board.git
cd terra-board
npm ci
npm run dev
```

To build your own installer, run `npm run installer`. Tests, packaging and release details are in [docs/development.md](docs/development.md).

## Community

Questions, ideas or bugs? Open an [issue](https://github.com/AntonRylin/terra-board/issues) or join the [Discord](https://discord.gg/GNJX5y9tux). Pull requests are welcome.

## License

[MIT](LICENSE) © 2026 AntonRylin. Bundled third-party packages keep their own licenses; the app lists them under Settings → About → Open-source licenses.
