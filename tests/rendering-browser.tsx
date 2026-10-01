import React from 'react';
import { createRoot } from 'react-dom/client';
import { Engine } from '../src/canvas/engine';
import { Text } from 'pixi.js';
import Whiteboard from '../src/components/Whiteboard';
import { invoke } from '../src/bridge';
import '../src/styles.css';

const tick = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
const check = (ok: unknown, message: string) => {
  if (!ok) throw Error(message);
};
let engine: any;
const draw = (Engine.prototype as any).draw;
(Engine.prototype as any).draw = function () {
  engine = this;
  return draw.call(this);
};
const board = await invoke<any>('createBoard', { name: 'Rendering regression fixture' });
const objects = [
  {
    id: 'text',
    type: 'text',
    x: 40,
    y: 30,
    width: 360,
    height: 80,
    z: 1,
    text: 'Sharp text at every zoom',
    fontSize: 24,
    color: '#29313b',
  },
  {
    id: 'frame',
    type: 'frame',
    x: 40,
    y: 200,
    width: 520,
    height: 360,
    z: 0,
    text: 'Frame title',
    fontSize: 14,
  },
  {
    id: 'note',
    type: 'note',
    x: 600,
    y: 40,
    width: 240,
    height: 200,
    z: 2,
    text: 'Note text',
    fontSize: 21,
    color: '#f8efd4',
  },
];
await invoke('patchBoard', { id: board.id, revision: 0, upserts: objects, deleted: [] });
const doc = await invoke<any>('loadBoard', { id: board.id });
createRoot(document.getElementById('root')!).render(
  <div className="app-shell">
    <Whiteboard
      document={doc}
      onSave={() => {}}
      onError={(message) => {
        throw Error(message);
      }}
    />
  </div>,
);

(window as any).runRenderingChecks = async () => {
  const results: { name: string; error?: string }[] = [];
  const test = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      results.push({ name });
    } catch (error) {
      results.push({ name, error: String(error) });
    }
  };
  const edit = async (id: string) => {
    engine.callbacks.activate(engine.objects.get(id));
    await tick();
    return document.querySelector<HTMLTextAreaElement>('.text-editor')!;
  };
  const cancel = async (el: HTMLTextAreaElement) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
  };
  await test('text is redrawn at device resolution at 800% zoom', async () => {
    engine.camera = { x: -250, y: -150, zoom: 8 };
    engine.callbacks.camera(engine.camera);
    engine.invalidate();
    await tick();
    const label = engine.views
      .get('text')
      .container.children.find((c: any) => c instanceof Text || c.label === 'board-text');
    const resolution = label?.resolution ?? label?.texture?.source?.resolution;
    check(
      resolution >= 8 * devicePixelRatio,
      `text resolution ${resolution} is below ${8 * devicePixelRatio}`,
    );
    check(
      !label.texture ||
        (label.texture.source.pixelWidth <= 8192 && label.texture.source.pixelHeight <= 8192),
      'text allocated an unbounded texture',
    );
  });
  await test('large text stays bounded by screen pixels when zoomed out', async () => {
    engine.apply({
      upserts: [
        {
          id: 'large-text',
          type: 'text',
          x: 0,
          y: 0,
          width: 100000,
          height: 100000,
          z: -2,
          fontSize: 300,
          text: ('Long line '.repeat(200) + '\n').repeat(40),
        },
      ],
      deleted: [],
    });
    engine.camera = { x: 0, y: 0, zoom: 0.17 };
    engine.callbacks.camera(engine.camera);
    engine.invalidate();
    await tick();
    const label = engine.views
      .get('large-text')
      .container.children.find((c: any) => c.label === 'board-text');
    check(
      label.texture.source.pixelWidth <= (innerWidth + 128) * devicePixelRatio * 2,
      'zoomed-out text allocates world-size pixels',
    );
    check(
      label.texture.source.pixelHeight <= (innerHeight + 128) * devicePixelRatio * 2,
      'zoomed-out text allocates world-size height',
    );
    engine.apply({ upserts: [], deleted: ['large-text'] });
  });
  engine.camera = { x: 0, y: 0, zoom: 1 };
  engine.callbacks.camera(engine.camera);
  engine.invalidate();
  await tick();
  await test('frame editing stays on the title with a transparent background', async () => {
    const el = await edit('frame');
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    try {
      check(
        style.backgroundColor === 'rgba(0, 0, 0, 0)',
        `editor background is ${style.backgroundColor}`,
      );
      check(box.height < 70, `frame editor covers ${box.height}px of the board`);
      check(
        style.borderTopWidth === '0px' && style.outlineStyle === 'none',
        'editor has popup chrome',
      );
      check(parseFloat(style.fontSize) === 14, 'frame editor changed the title font size');
    } finally {
      await cancel(el);
    }
  });
  await test('editing hides the original glyphs, preserves geometry, and Escape restores text', async () => {
    const before = JSON.stringify(engine.objects.get('note'));
    const el = await edit('note');
    const label = engine.views
      .get('note')
      .container.children.find((c: any) => c instanceof Text || c.label === 'board-text');
    try {
      check(!label || !label.visible, 'original text is still drawn beneath the editor');
    } finally {
      await cancel(el);
    }
    check(JSON.stringify(engine.objects.get('note')) === before, 'cancel changed the object');
  });
  const type = (el: HTMLTextAreaElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  await test('clicking back onto the board commits exactly one undoable text edit', async () => {
    const before = engine.objects.get('text').text;
    const el = await edit('text');
    type(el, 'Edited directly on the board');
    await tick();
    document.querySelector<HTMLElement>('.canvas-surface')!.focus();
    await tick();
    check(!document.querySelector('.text-editor'), 'editor did not close on board focus');
    check(engine.objects.get('text').text === 'Edited directly on the board', 'blur lost the edit');
    engine.undo();
    await tick();
    check(engine.objects.get('text').text === before, 'one undo did not restore the previous text');
    engine.redo();
    await tick();
    check(engine.objects.get('text').text === 'Edited directly on the board', 'redo lost the edit');
  });
  await test('Ctrl+Enter commits while Escape cancels typed changes', async () => {
    let el = await edit('text');
    type(el, 'Committed with keyboard');
    await tick();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await tick();
    check(engine.objects.get('text').text === 'Committed with keyboard', 'keyboard commit failed');
    el = await edit('text');
    type(el, 'Discard me');
    await tick();
    await cancel(el);
    check(
      engine.objects.get('text').text === 'Committed with keyboard',
      'Escape committed the cancelled draft',
    );
  });
  return results;
};
(window as any).runNoteChecks = async () => {
  engine.camera = { x: 0, y: 0, zoom: 1.5 };
  engine.callbacks.camera(engine.camera);
  engine.invalidate();
  await tick();
  const original = { ...engine.objects.get('note') };
  engine.callbacks.activate(original);
  await tick();
  const el = document.querySelector<HTMLTextAreaElement>('.text-editor')!;
  const text =
    'Keep it simple.\n\nPaste an image.\nDrop a reference.\nMake room for ideas. ' +
    'Extra words to fit within this note. '.repeat(20);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
  const fittedFontSize = getComputedStyle(el).fontSize;
  const box = el.getBoundingClientRect(),
    host = document.querySelector('.canvas-surface')!.getBoundingClientRect();
  check(
    box.bottom <= host.top + (original.y + original.height) * 1.5 + 1,
    'editor text flows beyond the note',
  );
  check(parseFloat(getComputedStyle(el).fontSize) < 21 * 1.5, 'long text did not shrink');
  check(el.scrollHeight <= el.clientHeight + 1, 'fitted note still has hidden text overflow');
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await tick();
  check(engine.objects.get('note').height === original.height, 'typing grew the note');
  check(engine.objects.get('note').width === original.width, 'typing resized the note width');
  check(engine.objects.get('note').text === text, 'fit discarded text');
  const label = engine.views
    .get('note')
    .container.children.find((c: any) => c.label === 'board-text');
  check(label.y + label.height <= original.height + 1, 'saved text overflows its note');
  engine.callbacks.activate(engine.objects.get('note'));
  await tick();
  const reopened = document.querySelector<HTMLTextAreaElement>('.text-editor')!;
  check(reopened.scrollHeight <= reopened.clientHeight + 1, 'reopened note no longer fits');
  reopened.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  engine.undo();
  await tick();
  check(engine.objects.get('note').text === original.text, 'note fit broke undo');
  return { fittedFontSize, originalHeight: original.height, savedTextLength: text.length };
};
(window as any).runSelectionChecks = async () => {
  document.querySelector<HTMLElement>('.canvas-surface')!.focus();
  engine.setSelection(['text', 'frame']);
  await tick();
  const data = new DataTransfer();
  window.dispatchEvent(
    new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
  );
  const copied = JSON.parse(data.getData('application/x-local-canvas-objects'));
  check(
    copied.length === 2 &&
      copied.some((o: any) => o.id === 'text') &&
      copied.some((o: any) => o.id === 'frame'),
    'copy omitted selected objects',
  );
  check(engine.selection.size === 2, 'copy cleared the selection');
  window.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
  );
  await tick();
  const ids = [...engine.selection];
  check(
    ids.length === 2 && ids.every((id) => id !== 'text' && id !== 'frame'),
    'paste did not select the complete copy',
  );
  document
    .querySelector<HTMLElement>('.canvas-surface')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  await tick();
  check(
    ids.every((id) => !engine.objects.has(id)),
    'Delete omitted part of the selection',
  );
  check(
    engine.objects.has('text') && engine.objects.has('frame'),
    'Delete affected unselected originals',
  );
  return { copied: copied.length, pasted: ids.length, deleted: ids.length };
};
(window as any).runNoteEdgeChecks = async () => {
  const results = [];
  for (const [name, text] of [
    ['trailing lines', 'A\n'.repeat(20)],
    ['long word', 'abcdefghijklmnop'.repeat(70)],
    ['unicode', '🌍 中文 café فكرة '.repeat(45)],
  ]) {
    for (const zoom of [0.25, 1, 8]) {
      const o = {
        id: 'edge-note',
        type: 'note',
        x: 20,
        y: 20,
        width: 260,
        height: 200,
        z: 8,
        text,
        fontSize: 21,
      };
      engine.apply({ upserts: [o], deleted: [] });
      engine.camera = { x: 0, y: 0, zoom };
      engine.callbacks.camera(engine.camera);
      engine.invalidate();
      engine.callbacks.activate(o);
      await tick();
      const el = document.querySelector<HTMLTextAreaElement>('.text-editor')!;
      const size = parseFloat(getComputedStyle(el).fontSize) / zoom;
      check(
        el.scrollHeight <= el.clientHeight + 1,
        `${name} overflows at ${zoom}: ${el.scrollHeight}/${el.clientHeight}`,
      );
      check(el.scrollWidth <= el.clientWidth + 1, `${name} overflows horizontally at ${zoom}`);
      check(size > 3, `${name} shrank unnecessarily to ${size}px`);
      results.push({ name, zoom, fontSize: size });
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await tick();
    }
  }
  engine.apply({ upserts: [], deleted: ['edge-note'] });
  return results;
};
(window as any).runObjectTitleChecks = async () => {
  const results = [];
  for (const type of ['rect', 'ellipse', 'link', 'video']) {
    const o = {
      id: 'editable-' + type,
      type,
      x: 10,
      y: 10,
      width: 240,
      height: 160,
      z: 8,
      text: 'Original title',
    };
    engine.apply({ upserts: [o], deleted: [] });
    engine.callbacks.activate(o);
    await tick();
    const el = document.querySelector<HTMLTextAreaElement>('.text-editor');
    check(el, `${type} did not offer an in-place title editor`);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      el,
      'Renamed ' + type,
    );
    el!.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    el!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await tick();
    check(engine.objects.get(o.id).text === 'Renamed ' + type, `${type} title was not saved`);
    results.push(type);
    engine.apply({ upserts: [], deleted: [o.id] });
  }
  return results;
};
(window as any).runImageChecks = async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(0,100,200,0.5)';
  ctx.fillRect(0, 0, 2048, 1024);
  const png = await new Promise<Blob>((resolve) =>
    canvas.toBlob((blob) => resolve(blob!), 'image/png'),
  );
  const asset = await invoke<any>('importAsset', {
    name: 'transparent-detail.png',
    bytes: await png.arrayBuffer(),
  });
  engine.apply({
    upserts: [
      {
        id: 'alpha-image',
        type: 'image',
        assetId: asset.id,
        x: 0,
        y: 0,
        width: 480,
        height: 240,
        z: 9,
      },
    ],
    deleted: [],
  });
  engine.camera = { x: 0, y: 0, zoom: 4 };
  engine.callbacks.camera(engine.camera);
  engine.invalidate();
  await tick();
  const deadline = performance.now() + 20000;
  while (
    performance.now() < deadline &&
    [...engine.textures.wanted].some((key) => !engine.textures.entries.has(key))
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  await tick();
  const tiles = [...engine.textures.entries.keys()].filter((key: string) => key.includes('/tile-'));
  check(tiles.length > 0, 'no detail tiles were loaded');
  check(
    [...engine.textures.wanted].every((key) => engine.textures.entries.has(key)),
    'visible tile loading stalled',
  );
  const capture = await engine.screenshot();
  const pixel = [...capture.getContext('2d').getImageData(100, 100, 1, 1).data];
  check(
    Math.abs(pixel[0] - 126) < 4 && Math.abs(pixel[1] - 176) < 4 && Math.abs(pixel[2] - 227) < 4,
    `alpha was composited incorrectly: ${pixel}`,
  );
  check(engine.textures.bytes <= 192 * 1024 * 1024, 'GPU image cache exceeded budget');
  for (const key of tiles) {
    const source = engine.textures.entries.get(key).texture.source;
    check(source.pixelWidth <= 512 && source.pixelHeight <= 512, 'oversized detail texture');
  }
  return { tiles: tiles.length, pixel, textureBytes: engine.textures.bytes };
};
(window as any).fixtureEngine = () => engine;
(window as any).startCropFixture = async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;
  for (const [color, x, y] of [
    ['#e33b36', 0, 0],
    ['#2ab06a', 1024, 0],
    ['#366cdc', 0, 512],
    ['#f1bf30', 1024, 512],
  ] as const) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 1024, 512);
  }
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!)));
  const asset = await invoke<any>('importAsset', {
    name: 'Crop quadrants.png',
    bytes: await blob.arrayBuffer(),
  });
  const o = {
    id: 'crop-image',
    type: 'image',
    assetId: asset.id,
    x: 120,
    y: 100,
    width: 480,
    height: 240,
    z: 99,
  };
  engine.apply({ upserts: [o], deleted: [] });
  engine.camera = { x: 0, y: 0, zoom: 1 };
  engine.callbacks.camera(engine.camera);
  engine.invalidate();
  const deadline = performance.now() + 10000;
  while (!engine.textures.entries.has(asset.id + '/preview') && performance.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  await tick();
  const host = document.querySelector('.canvas-surface')!.getBoundingClientRect();
  engine.app.canvas.dispatchEvent(
    new MouseEvent('contextmenu', {
      clientX: host.left + 360,
      clientY: host.top + 220,
      bubbles: true,
      button: 2,
      cancelable: true,
    }),
  );
  await tick();
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((el) =>
    el.textContent?.includes('Crop image'),
  );
  check(button, 'image right-click did not offer Crop image');
  button!.click();
  await tick();
  check(document.querySelector('.crop-overlay'), 'Crop image did not open directly on the board');
  check(!document.querySelector('.modal-backdrop'), 'crop opened a popup');
  return o;
};
(window as any).runCropChecks = async () => {
  const original = await (window as any).startCropFixture();
  const key = async (selector: string, key: string, shiftKey = false) => {
    const el = document.querySelector<HTMLElement>(selector)!;
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
    await tick();
  };
  // Move the left edge right by half the source width with keyboard handles.
  for (let i = 0; i < 24; i++) await key('[data-edge="w"]', 'ArrowRight', true);
  check(
    engine.objects.get(original.id).crop === undefined,
    'draft crop modified the saved image before Apply',
  );
  await key('.crop-window', 'Enter');
  const cropped = engine.objects.get(original.id);
  check(
    Math.abs(cropped.crop.x - 0.5) < 1e-6 && Math.abs(cropped.width - 240) < 1e-6,
    'Apply did not retain the right half',
  );
  check(cropped.assetId === original.assetId, 'crop replaced the original media');
  const sample = async (zoom: number) => {
    engine.camera = { x: -cropped.x * zoom + 80, y: -cropped.y * zoom + 80, zoom };
    engine.callbacks.camera(engine.camera);
    engine.invalidate();
    await tick();
    const deadline = performance.now() + 10000;
    while (
      [...engine.textures.wanted].some((k) => !engine.textures.entries.has(k)) &&
      performance.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 50));
    await tick();
    const canvas = await engine.screenshot(),
      ctx = canvas.getContext('2d');
    const p = [...ctx.getImageData(130 * devicePixelRatio, 130 * devicePixelRatio, 1, 1).data];
    check(
      Math.abs(p[0] - 42) < 8 && Math.abs(p[1] - 176) < 8 && Math.abs(p[2] - 106) < 8,
      `wrong cropped image pixels at zoom ${zoom}: ${p}`,
    );
    check(engine.textures.bytes <= 192 * 1024 * 1024, 'crop exceeded the image cache budget');
    return p;
  };
  const preview = await sample(1),
    detail = await sample(8);
  engine.undo();
  await tick();
  check(
    !engine.objects.get(original.id).crop &&
      engine.objects.get(original.id).width === original.width,
    'undo did not restore full image',
  );
  engine.redo();
  await tick();
  check(engine.objects.get(original.id).crop, 'redo lost crop metadata');
  // Re-enter from the actual context menu; reset can reveal the complete source.
  engine.setSelection([original.id]);
  engine.callbacks.context({ x: 200, y: 150 });
  await tick();
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((el) => el.textContent?.includes('Crop image'))!
    .click();
  await tick();
  [...document.querySelectorAll<HTMLButtonElement>('.crop-toolbar button')]
    .find((el) => el.textContent?.includes('Reset'))!
    .click();
  await tick();
  await key('.crop-window', 'Escape');
  check(engine.objects.get(original.id).crop, 'Cancel committed the reset');
  engine.callbacks.context({ x: 200, y: 150 });
  await tick();
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((el) => el.textContent?.includes('Crop image'))!
    .click();
  await tick();
  [...document.querySelectorAll<HTMLButtonElement>('.crop-toolbar button')]
    .find((el) => el.textContent?.includes('Reset'))!
    .click();
  await tick();
  [...document.querySelectorAll<HTMLButtonElement>('.crop-toolbar button')]
    .find((el) => el.textContent?.includes('Apply'))!
    .click();
  await tick();
  check(
    !engine.objects.get(original.id).crop &&
      Math.abs(engine.objects.get(original.id).width - original.width) < 1e-6,
    'Reset failed to restore the original',
  );
  return {
    menu: 'in place',
    preview,
    detail,
    undo: 'restored',
    redo: 'cropped',
    cancel: 'preserved',
    reset: 'original',
  };
};
