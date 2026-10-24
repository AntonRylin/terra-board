// App frames' pictures: Windows' own live previews of the app windows (DWM
// thumbnails), which Windows draws into Terra's window where each frame is.
// Pixel for pixel, at the screen's refresh rate, never with the mouse pointer
// in them, and almost free: nothing is captured or copied. A window keeps its
// preview current only while it is on a screen (hidden behind Terra counts).
// Windows draws previews over Terra's page, so the page sends each frame's
// picture as parts that leave out whatever of Terra lies over the frame.
'use strict';

const DESTINATION = 0x1,
  SOURCE = 0x2,
  OPACITY = 0x4,
  VISIBLE = 0x8,
  CLIENT_AREA_ONLY = 0x10;

// Windows' functions, loaded once (null: not available here).
let api;
function dwm(load) {
  if (api !== undefined) return api;
  api = null;
  try {
    const koffi = load();
    const lib = koffi.load('dwmapi.dll');
    koffi.struct('TerraRect', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    koffi.struct('TerraSize', { cx: 'int32', cy: 'int32' });
    koffi.struct('TerraThumbnailProperties', {
      dwFlags: 'uint32',
      rcDestination: 'TerraRect',
      rcSource: 'TerraRect',
      opacity: 'uint8',
      fVisible: 'int32',
      fSourceClientAreaOnly: 'int32',
    });
    api = {
      register: lib.func(
        'long __stdcall DwmRegisterThumbnail(intptr_t destination, intptr_t source, _Out_ intptr_t *thumbnail)',
      ),
      update: lib.func(
        'long __stdcall DwmUpdateThumbnailProperties(intptr_t thumbnail, const TerraThumbnailProperties *properties)',
      ),
      unregister: lib.func('long __stdcall DwmUnregisterThumbnail(intptr_t thumbnail)'),
      size: lib.func(
        'long __stdcall DwmQueryThumbnailSourceSize(intptr_t thumbnail, _Out_ TerraSize *size)',
      ),
    };
  } catch {
    api = null;
  }
  return api;
}

function createAppPictures({ platform = process.platform, load = () => require('koffi') } = {}) {
  if (platform !== 'win32') return null;
  const win = dwm(load);
  if (!win) return null;
  // Per frame: Terra's window, the app's window, and one preview per part.
  const frames = new Map();
  const drop = (entry, from = 0) => {
    for (const preview of entry.previews.splice(from)) {
      try {
        win.unregister(preview);
      } catch {}
    }
  };
  // Lays out a frame's parts for the app window's current size (the
  // preview shows what of the window is visible, without its invisible
  // resize border).
  const apply = (entry) => {
    if (!entry.previews.length) return false;
    const size = {};
    if (win.size(entry.previews[0], size) < 0 || size.cx <= 0 || size.cy <= 0) return false;
    const sx = size.cx / entry.whole[0],
      sy = size.cy / entry.whole[1];
    entry.previews.forEach((preview, i) => {
      const { dest, src } = entry.parts[i];
      win.update(preview, {
        dwFlags: DESTINATION | SOURCE | OPACITY | VISIBLE | CLIENT_AREA_ONLY,
        rcDestination: { left: dest[0], top: dest[1], right: dest[2], bottom: dest[3] },
        rcSource: {
          left: Math.round(src[0] * sx),
          top: Math.round(src[1] * sy),
          right: Math.round(src[2] * sx),
          bottom: Math.round(src[3] * sy),
        },
        opacity: 255,
        fVisible: 1,
        fSourceClientAreaOnly: 0,
      });
    });
    return true;
  };
  function hide(key) {
    const entry = frames.get(key);
    if (!entry) return;
    frames.delete(key);
    drop(entry);
  }
  // target: Terra's window; source: the app's; whole: the frame's picture
  // area in screen pixels; parts: where in Terra's window each part goes
  // (dest) and which part of the area it is (src), in screen pixels.
  function show(key, { target, source, whole, parts }) {
    let entry = frames.get(key);
    if (entry && (entry.target !== target || entry.source !== source)) {
      hide(key);
      entry = null;
    }
    if (!entry) {
      entry = { target, source, previews: [], whole, parts };
      frames.set(key, entry);
    }
    entry.whole = whole;
    entry.parts = parts;
    while (entry.previews.length < parts.length) {
      const out = [0];
      if (win.register(target, source, out) < 0 || !out[0]) break;
      entry.previews.push(out[0]);
    }
    // The window is gone, or Windows won't preview it.
    if (entry.previews.length < parts.length) {
      hide(key);
      return false;
    }
    drop(entry, parts.length);
    return apply(entry);
  }
  return {
    show,
    hide,
    hideWindow: (source) => {
      for (const [key, entry] of [...frames]) if (entry.source === source) hide(key);
    },
    hideAll: () => {
      for (const key of [...frames.keys()]) hide(key);
    },
    // The app window changed size: its previews follow.
    refresh: (source) => {
      for (const entry of frames.values()) if (entry.source === source) apply(entry);
    },
  };
}

module.exports = { createAppPictures };
