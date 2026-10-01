import type { Asset, Board } from './model';
interface DesktopBridge {
  invoke(command: string, args?: unknown): Promise<any>;
  pickMedia(): Promise<Asset[]>;
  importPortable(): Promise<Board | null>;
  exportPortable(id: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  dataDirectory(): Promise<string>;
  onClose(callback: () => void): () => void;
  closeReady(): void;
  rendererReady(): void;
}
declare global {
  interface Window {
    canvas?: DesktopBridge;
  }
}
export const desktop = !!window.canvas;
function base64(bytes: Uint8Array) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768)
    text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}
export async function invoke<T = any>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (window.canvas) return window.canvas.invoke(command, args);
  const input = { ...args };
  if (input.bytes) input.bytes = base64(new Uint8Array(input.bytes as ArrayBuffer));
  const response = await fetch('/__local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, args: input }),
  });
  const data = await response.json();
  if (data.error) throw Error(data.error);
  return data.result;
}
export const mediaUrl = (id: string, variant = 'preview') =>
  desktop ? `canvas-media://asset/${id}/${variant}` : `/__local/asset/${id}/${variant}`;
export async function importFiles(files: File[]) {
  const result: Asset[] = [];
  for (const file of files) {
    if (file.size > 256 * 1024 * 1024) throw Error(`${file.name} exceeds 256 MB`);
    result.push(
      await invoke<Asset>('importAsset', { bytes: await file.arrayBuffer(), name: file.name }),
    );
  }
  return result;
}
export function chooseFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files || [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}
export async function pickMedia() {
  return window.canvas
    ? window.canvas.pickMedia()
    : importFiles(await chooseFiles('image/*,video/mp4,video/webm', true));
}
export async function importPortable() {
  if (window.canvas) return window.canvas.importPortable();
  const [file] = await chooseFiles('.canvas');
  return file ? invoke<Board>('importBoard', { bytes: await file.arrayBuffer() }) : null;
}
export async function exportPortable(id: string) {
  if (window.canvas) return window.canvas.exportPortable(id);
  const data = await invoke<string>('exportBoard', { id });
  download(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))]), 'Board.canvas');
  return true;
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function openLink(url: string) {
  if (!/^https?:\/\//i.test(url)) throw Error('Only web links can be opened');
  if (window.canvas) await window.canvas.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}
