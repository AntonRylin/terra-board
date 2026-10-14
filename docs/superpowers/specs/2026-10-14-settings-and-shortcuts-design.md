# Settings page and custom shortcuts

Date: 2026-10-14. Status: implemented.

## Goal

Replace the single-column Settings page with a full-page settings app (Codex-style layout, Terra look) and make board/app keyboard shortcuts rebindable. Accounts and cloud are out of scope.

## Layout

- Full-window page. Left sidebar: "Settings" title, search, grouped sections. Right: page title + subtitle, then rounded cards of rows (title, grey description, control on the right).
- Controls: switch, dropdown with optional per-option descriptions, button, shortcut chips.
- Search matches row titles and descriptions across sections; choosing a result opens its section and briefly highlights the row.
- Escape or "Back to board" closes. Light and dark themes use Terra tokens.

## Sections

| Group | Section | Contents |
|---|---|---|
| App | General | Open last board on start (on), ask before moving a board to Trash (off), launch at login (packaged only) |
| App | Appearance | Existing theme, panel transparency + preview, night glow |
| App | Launcher | Hide / minimal / centered launcher, reset toolbar layouts |
| Board | Canvas | Mouse wheel zooms or pans (Ctrl+wheel zooms in pan mode), zoom speed, snap to objects |
| Board | Radial menu | Wheel preview with 7 slots, pick a tool per slot, reset |
| Board | Keyboard shortcuts | Rebinding editor |
| Data | Storage | Library folder + open, backups folder + open, export all boards to a folder |
| Data | AI connections | Existing MCP settings as rows |
| Other | About | Version, open-source licenses |

## Preferences store

`src/settings/preferences.ts`: one typed, validated object in `localStorage` (`terra-board.preferences`) with `get`, `update`, `subscribe` and a `usePreferences` hook (`useSyncExternalStore`). It holds the new preferences (general, canvas, radial layout, shortcut overrides). Existing appearance, glass, launcher and toolbar keys keep their current storage so nothing resets; the radial layout migrates from its old key. Invalid stored values fall back to defaults per field.

## Shortcuts

- `src/shortcuts/keys.ts`: a binding is a physical key (`KeyboardEvent.code`) plus Ctrl/Shift/Alt (Meta counts as Ctrl). Exact modifier matching. Labels derive from the code (`KeyV` → `V`), so shortcuts work on any keyboard layout.
- `src/shortcuts/commands.ts`: ~24 rebindable commands with id, name, group (Tools, Edit, View, App), scope (`board` or `app`) and up to two default bindings. Locked reference rows for copy/cut/paste, pan, finish text and viewer keys.
- Saved preferences store only overrides; defaults evolve for untouched commands.
- Rules: Escape, Enter, arrows, Space, Tab with modifiers, lone modifiers and Ctrl+C/X/V are reserved. App-scope commands (search, fullscreen, settings) need Ctrl, Alt or a function key because they fire while typing. A combo used by another command offers Replace or Cancel.
- Consumers: Whiteboard command handler, inline text bold, radial menu trigger, App search/fullscreen/settings handlers. Electron main receives the fullscreen bindings over IPC for its `before-input-event` handler. Tool repeat events do not retrigger.
- The Help dialog list and toolbar tooltips are generated from the registry.
- Fix: click-to-place cancel now also handles Ctrl+Shift+Z / Caps Lock.

## Desktop additions (IPC)

Login item get/set, open library or backups folder, export all boards (folder picker, one `.canvas` per non-trashed board, unique names), app version, bundled open-source license list (production dependency tree read from `node_modules`).

## Testing

- Unit (`node --test`): preference validation and migration, binding parse/format/match, conflicts, reserved keys, command lookup.
- Desktop checks updated to navigate to the Appearance and AI sections; type check and build must pass.
- Manual: packaged app screenshots of each section in light and dark, rebinding a tool key, wheel pan mode.
