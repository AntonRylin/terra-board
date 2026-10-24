# Folder frames: a live view of a folder on the board

Date: 2026-10-24. Asked for: "a frame that mirrors the Windows desktop, with its apps, where I can drag a file or icon into the board and it actually does the Windows action", plus "multiple desktops". The user chose the folder approach over a screen mirror and asked for it to be "as usable and generic as possible".

## What it is

A new board object, type `file`: a live link to a folder or a file on this computer.

- **A folder** shows as a window-like frame: its name, a back button, and the folder's items as icons (or a list), sorted, updating as soon as anything changes on disk. The Desktop frame also shows the shortcuts every user shares (`C:\Users\Public\Desktop`), as Windows does.
- **A file or app** shows as a desktop-style icon tile that opens it.

Nothing the folder contains is ever saved in the board. The board stores only which folder to show and how (view, sort, icon size). The listing is read live on each computer, so it never reaches the cloud, other people, exports or AI tools.

## Multiple desktops

Windows virtual desktops all share one Desktop folder, so their icons are identical. "Multiple desktops" on the board therefore means multiple folder frames: Desktop, Downloads, any project folder. A view of the windows open on each virtual desktop needs an undocumented Windows interface for switching and is left as a later step (see the end).

## Where the folder lives

`file.root` names a folder every computer has (`desktop`, `downloads`, `documents`, `pictures`, `music`, `videos`, `home`) and `file.path` is then relative to it (`''` for the folder itself). Otherwise `file.path` is a full path. A path picked or dropped that lies inside a known folder is stored relative to it, so a board synced to another of the user's computers shows the same folder there (OneDrive desktops, Cyrillic folder names and redirected folders resolve through Electron's `app.getPath`).

A frame whose folder is missing on this computer shows "Not found on this computer" with Choose folder…. A frame on Android, in a browser guest or in an export shows a placeholder: the folder's name and a folder picture, never its contents.

## Windows actions it mirrors

| Action                                                | Result                                                                                                                                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Double-click / Enter                                  | Opens the file or app with Windows; a folder opens inside the frame (Back returns)                                                                                                                         |
| Drag an item out to the board                         | Pictures, videos and documents are copied onto the board as today. Folders become a new folder frame, apps and shortcuts become icon tiles. Alt makes a tile for anything (Windows' "create shortcut" key) |
| Drag an item to Explorer, mail, other apps            | A real Windows file drag (copy)                                                                                                                                                                            |
| Drag an item onto a folder in a frame / another frame | Move on the same drive, copy across drives; Ctrl copies, Shift moves, Alt makes a shortcut. Nothing is ever overwritten: a clash becomes "name (2)"                                                        |
| Drop files from Explorer into a frame                 | Same rules                                                                                                                                                                                                 |
| Drag a board picture or document into a frame         | Saves a copy of its original there; the card returns to where it was                                                                                                                                       |
| Drop on an app icon                                   | Opens the dropped files with that app                                                                                                                                                                      |
| F2 / click the name of a selected item                | Rename (bad characters and reserved names refused with a message)                                                                                                                                          |
| Delete                                                | Moves to the Recycle Bin (never a permanent delete)                                                                                                                                                        |
| Ctrl+C / Ctrl+X / Ctrl+V                              | Windows file clipboard, interchangeable with Explorer                                                                                                                                                      |
| Ctrl+Z                                                | Undoes the last rename, move, copy or new folder made in a frame                                                                                                                                           |
| Right-click                                           | Open, Show in Explorer, Copy path, Rename, Delete, New folder, view and sort                                                                                                                               |

Deleting the frame from the board never touches the folder.

## Edge cases decided

- Huge folders: up to 5000 items listed, the rest summarised with "Open in Explorer". Only visible rows are rendered; icons load for visible items only.
- Hidden and system files (desktop.ini, Thumbs.db, ~$ lock files) are hidden unless "Show hidden items" is on.
- Locked or administrator-owned items (Public Desktop) report the Windows error in plain words instead of failing silently.
- Moving a folder into itself or a folder below it is refused.
- A folder that is renamed, deleted or on a disconnected drive turns into the not-found state and recovers when it reappears (polling every 5 s).
- Watching: one watcher per folder shared by every frame showing it; network and removable drives fall back to polling.
- Online-only OneDrive files keep their state: listing and icons never download them; opening or copying does, as in Explorer.
- Keys typed while a frame has focus go to the frame, so Delete removes files there and the frame itself only when the frame (not an item) is selected on the board.
- Read-only boards and live-share visitors can browse and open but not change the frame's settings.

## Icons

Explorer's own icons and thumbnails (256 px, with transparency) come from the Windows shell (`IShellItemImageFactory`) through one long-running PowerShell helper, compiled on first use (about 0.2 s, then 10–30 ms per icon). If PowerShell is blocked, Electron's 32 px file icons are used. On Linux, Electron's file icons and Sharp thumbnails for pictures. Icons are requested at the size they appear on screen (64, 128 or 256 px).

## Later

- A "Desktops" frame listing the windows open on each virtual desktop (window titles and app icons, grouped by desktop name from the registry; clicking one focuses it, which switches desktop). Window-to-desktop mapping uses the documented `IVirtualDesktopManager`; moving windows between desktops needs undocumented interfaces and is out.
- Free icon placement remembered per frame, like the desktop's own arrangement.
