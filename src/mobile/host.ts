// Android: the page side of the storage worker and the media service worker.
// bridge.ts sends every storage command here instead of to Electron or the
// browser harness.
let worker: Worker | null = null;
let next = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function storage() {
  if (worker) return worker;
  worker = new Worker(new URL('./store-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const call = pending.get(data.id);
    if (!call) return;
    pending.delete(data.id);
    if (data.error) call.reject(Error(data.error));
    else call.resolve(data.result);
  };
  worker.onerror = (e) => {
    const error = Error('Storage stopped: ' + (e.message || 'unknown error'));
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  };
  return worker;
}

export function call<T = any>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    const transfer: Transferable[] = [];
    let message = args;
    // Bytes move to the worker instead of being copied.
    if (args.bytes instanceof ArrayBuffer) transfer.push(args.bytes);
    else if (ArrayBuffer.isView(args.bytes)) {
      const copy = new Uint8Array(args.bytes.buffer.slice(0));
      message = { ...args, bytes: copy.buffer };
      transfer.push(copy.buffer);
    }
    storage().postMessage({ id, command, args: message }, transfer);
  });
}

// The service worker answers /__local/asset/<id>/<variant> requests by asking
// this page, which asks the storage worker.
function serveMedia() {
  navigator.serviceWorker.addEventListener('message', async (event) => {
    const port = event.ports[0];
    if (event.data?.type !== 'terra-asset' || !port) return;
    const [, , , id, variant] = String(event.data.path).split('/');
    try {
      const { contentType, bytes } = await call<{ contentType: string; bytes: Uint8Array }>(
        'asset',
        { id, variant: variant || 'preview' },
      );
      port.postMessage({ contentType, bytes }, [bytes.buffer]);
    } catch (e) {
      port.postMessage({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}

let started: Promise<void> | null = null;
// Resolves when media URLs work: the service worker controls this page.
export function startMobile() {
  started ??= (async () => {
    storage();
    navigator.storage?.persist?.().catch(() => {});
    if (!('serviceWorker' in navigator))
      throw Error('This WebView cannot show pictures (no service workers).');
    serveMedia();
    navigator.serviceWorker.startMessages();
    await navigator.serviceWorker.register('./terra-sw.js', { scope: './' });
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        });
        setTimeout(resolve, 5000);
      });
    await call('ping');
  })();
  return started;
}
