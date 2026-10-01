import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

class Window extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.bounds = { x: 100, y: 100, width: 900, height: 700 };
    this.visible = false;
    this.destroyed = false;
    this.webContents = new EventEmitter();
    this.webContents.setWindowOpenHandler = () => {};
  }
  getBounds() {
    return this.bounds;
  }
  getContentBounds() {
    return {
      x: this.bounds.x + 8,
      y: this.bounds.y + 31,
      width: this.bounds.width - 16,
      height: this.bounds.height - 39,
    };
  }
  setBounds(bounds) {
    this.bounds = bounds;
  }
  isVisible() {
    return this.visible;
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }
  isMaximized() {
    return this.maximized;
  }
  isFullScreen() {
    return this.fullscreen;
  }
  isSnapped() {
    return this.snapped;
  }
  isFocused() {
    return true;
  }
  setIgnoreMouseEvents(value) {
    this.ignoresMouse = value;
  }
  setOpacity(value) {
    this.opacity = value;
  }
  showInactive() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  loadURL() {
    return Promise.resolve();
  }
  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }
}
test('external shadow follows its owner without intercepting input or surviving it', async () => {
  let attach;
  try {
    attach = require('../electron/window-shadow.cjs').attachWindowShadow;
  } catch {}
  assert.equal(typeof attach, 'function', 'window shadow support is available');
  const owner = new Window();
  const shadow = attach(owner, { BrowserWindow: Window }, 'win32');
  assert.equal(shadow.options.parent, owner);
  assert.equal(shadow.options.focusable, false);
  assert.equal(shadow.options.skipTaskbar, true);
  assert.equal(shadow.ignoresMouse, true);
  shadow.emit('ready-to-show');
  assert.equal(shadow.visible, false, 'hidden owner has no shadow');
  owner.visible = true;
  owner.emit('show');
  assert.equal(shadow.visible, true);
  const original = { ...shadow.bounds };
  owner.bounds.x += 50;
  owner.bounds.width += 100;
  owner.emit('move');
  assert.equal(shadow.bounds.x, original.x + 50);
  assert.equal(shadow.bounds.width, original.width + 100);
  for (const [property, event, restore] of [
    ['maximized', 'maximize', 'unmaximize'],
    ['minimized', 'minimize', 'restore'],
    ['fullscreen', 'enter-full-screen', 'leave-full-screen'],
    ['snapped', 'resize', 'resize'],
  ]) {
    owner[property] = true;
    owner.emit(event);
    assert.equal(shadow.visible, false, property);
    owner[property] = false;
    owner.emit(restore);
    assert.equal(shadow.visible, true, `${property} restored`);
  }
  owner.destroy();
  assert.equal(shadow.destroyed, true);
  assert.equal(owner.listenerCount('move'), 0);
});

test('shadow renderer failure removes only the decoration', async () => {
  let attach;
  try {
    attach = require('../electron/window-shadow.cjs').attachWindowShadow;
  } catch {}
  assert.equal(typeof attach, 'function');
  const owner = new Window();
  const shadow = attach(owner, { BrowserWindow: Window }, 'win32');
  shadow.webContents.emit('render-process-gone');
  assert.equal(shadow.destroyed, true);
  assert.equal(owner.destroyed, false);
  assert.equal(owner.listenerCount('resize'), 0);
  assert.equal(attach(owner, { BrowserWindow: Window }, 'darwin'), null);
});
