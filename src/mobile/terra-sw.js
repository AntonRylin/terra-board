// Android: serves the library's pictures and files at /__local/asset/<id>/<variant>,
// the URLs the renderer uses outside Electron. The bytes come from the storage
// worker through the page that asked (src/mobile/host.ts). Copied to the build
// root by vite.config.ts in Android builds only.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function pageFor(event) {
  const own = event.clientId && (await self.clients.get(event.clientId));
  if (own && own.type === 'window') return own;
  const [page] = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return page;
}

async function serve(event, url) {
  const page = await pageFor(event);
  if (!page) return new Response('No page to read from', { status: 503 });
  const channel = new MessageChannel();
  const answer = new Promise((resolve) => {
    channel.port1.onmessage = (message) => resolve(message.data);
    setTimeout(() => resolve({ error: 'Timed out reading the file' }), 120000);
  });
  page.postMessage({ type: 'terra-asset', path: url.pathname }, [channel.port2]);
  const result = await answer;
  if (result.error) return new Response(result.error, { status: 404 });
  const total = result.bytes.byteLength;
  const headers = {
    'Content-Type': result.contentType,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  };
  // Video seeks with ranges.
  const range = /^bytes=(\d*)-(\d*)$/.exec(event.request.headers.get('Range') || '');
  if (range && total) {
    const start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    if (start <= end && start < total)
      return new Response(result.bytes.slice(start, end + 1), {
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}` },
      });
  }
  return new Response(result.bytes, { headers: { ...headers, 'Content-Length': String(total) } });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/__local/asset/')) return;
  event.respondWith(serve(event, url));
});
