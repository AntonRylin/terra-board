const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { Readable } = require('node:stream');
const { assetResponse } = require('./document-assets.cjs');
const { referencedAssets } = require('./store-sync.cjs');

// Live sharing: this computer serves one board to guests' browsers on the same
// network (or a Tailscale network). No server in between: guests load the app
// from this PC and read and write through it. Nothing is opened to the internet.
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};
const iconAssetId = (icon) =>
  typeof icon === 'string' && /^asset-[a-f0-9]{64}$/.test(icon) ? icon.slice(6) : null;
const token = () => randomBytes(18).toString('base64url');
const sameSecret = (a, b) =>
  typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const permissionValue = (p) => (p === 'edit' ? 'edit' : 'view');

const privateLan = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip);
// Tailscale and other carrier-grade NAT style private networks.
const tailnet = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
// Only computers on the local network, a Tailscale network or this PC may connect.
function allowedPeer(address) {
  const ip = String(address || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || privateLan(ip) || tailnet(ip);
}

function lanAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const a of list || [])
      if (
        a.family === 'IPv4' &&
        !a.internal &&
        (privateLan(a.address) || tailnet(a.address)) &&
        !/vEthernet|VirtualBox|VMware|WSL|Hyper-V/i.test(name)
      )
        found.push({
          address: a.address,
          tailscale: tailnet(a.address) || /tailscale/i.test(name),
        });
  const rank = (a) =>
    a.tailscale ? 4 : a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : 2;
  return found.sort((a, b) => rank(a) - rank(b)).slice(0, 4);
}

class LiveShare {
  constructor({ call, distDir, onStatus, onGuestEdit }) {
    this.call = call;
    this.distDir = distDir;
    this.onStatus = onStatus;
    this.onGuestEdit = onGuestEdit;
    this.session = null;
  }

  status() {
    const s = this.session;
    if (!s) return { active: false };
    const link = (host) => `http://${host}:${s.port}/live?k=${s.key}`;
    return {
      active: true,
      boardId: s.boardId,
      permission: s.permission,
      ask: s.ask,
      port: s.port,
      links: lanAddresses().map((a) => ({
        label: a.tailscale ? 'Tailscale' : 'Same Wi-Fi',
        url: link(a.address),
      })),
      guests: [...s.guests.values()].map((g) => ({
        id: g.id,
        name: g.name,
        permission: g.permission,
        online: g.streams.size > 0,
      })),
      requests: [...s.requests.values()]
        .filter((r) => r.status === 'pending')
        .map((r) => ({ id: r.id, name: r.name })),
    };
  }

  emit() {
    this.onStatus?.(this.status());
  }

  async start({ boardId, permission = 'view', ask = true, port = 47900 }) {
    if (this.session) await this.stop();
    const board = (await this.call('loadBoard', { id: boardId })).board;
    if (board.trashed) throw Error('Restore this board before sharing it.');
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) this.json(res, 400, { error: String(e.message || e) });
        else res.destroy();
      });
    });
    server.headersTimeout = 20000;
    let bound = null;
    // Port 0 lets the system choose (tests); otherwise try the next few ports.
    for (let p = port; p < port + (port ? 10 : 1) && !bound; p++) {
      bound = await new Promise((resolve) => {
        const fail = () => resolve(null);
        server.once('error', fail);
        server.listen(p, '0.0.0.0', () => {
          server.off('error', fail);
          resolve(server.address().port);
        });
      });
    }
    if (!bound) throw Error('No free network port near ' + port + '. Close other apps using it.');
    this.session = {
      server,
      port: bound,
      boardId,
      permission: permissionValue(permission),
      ask: ask !== false,
      key: token(),
      guests: new Map(),
      byToken: new Map(),
      requests: new Map(),
      assets: null,
    };
    this.emit();
    return this.status();
  }

  async stop() {
    const s = this.session;
    if (!s) return { active: false };
    this.session = null;
    for (const g of s.guests.values()) this.send(g, 'ended', {});
    for (const g of s.guests.values()) for (const r of g.streams) r.end();
    await new Promise((resolve) => {
      s.server.close(() => resolve());
      s.server.closeAllConnections?.();
    });
    this.emit();
    return { active: false };
  }

  configure({ permission, ask }) {
    const s = this.requireSession();
    if (permission !== undefined) s.permission = permissionValue(permission);
    if (ask !== undefined) s.ask = !!ask;
    this.emit();
    return this.status();
  }

  answer(requestId, allow, permission) {
    const s = this.requireSession();
    const r = s.requests.get(requestId);
    if (!r || r.status !== 'pending') throw Error('That request is no longer waiting.');
    if (allow) this.admit(r, permission || s.permission);
    else r.status = 'denied';
    this.emit();
    return this.status();
  }

  setGuestPermission(guestId, permission) {
    const g = this.requireSession().guests.get(guestId);
    if (!g) throw Error('Guest not found');
    g.permission = permissionValue(permission);
    this.send(g, 'permission', { permission: g.permission });
    this.emit();
    return this.status();
  }

  removeGuest(guestId) {
    const s = this.requireSession();
    const g = s.guests.get(guestId);
    if (!g) return this.status();
    this.send(g, 'removed', {});
    for (const r of g.streams) r.end();
    s.guests.delete(guestId);
    s.byToken.delete(g.token);
    this.emit();
    return this.status();
  }

  // Someone other than `by` changed the shared board: tell the other guests.
  changed(boardId, by = 'host') {
    const s = this.session;
    if (!s || boardId !== s.boardId) return;
    s.assets = null;
    for (const g of s.guests.values()) if (g.id !== by) this.send(g, 'changed', {});
  }

  requireSession() {
    if (!this.session) throw Error('Live sharing is off.');
    return this.session;
  }

  admit(request, permission) {
    const s = this.session;
    const g = {
      id: randomUUID(),
      name: request.name,
      permission: permissionValue(permission),
      token: token(),
      streams: new Set(),
    };
    s.guests.set(g.id, g);
    s.byToken.set(g.token, g);
    request.status = 'approved';
    request.guest = g;
  }

  send(guest, event, data) {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const r of guest.streams) r.write(line);
  }

  json(res, status, body, headers = {}) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(JSON.stringify(body));
  }

  guestFrom(req) {
    const cookie = /(?:^|;\s*)terra_live=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '')?.[1];
    return (cookie && this.session?.byToken.get(cookie)) || null;
  }

  async body(req, limit) {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > limit) throw Error('Request too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  }

  async handle(req, res) {
    const s = this.session;
    if (!s) return this.json(res, 503, { error: 'Not sharing' });
    if (!allowedPeer(req.socket.remoteAddress)) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname;
    if (req.method === 'POST') {
      // Browsers send Origin on POST; it must be this server, never another site.
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw Error('Origin rejected');
    }

    if (route === '/' || route === '/index.html') {
      res.writeHead(302, { Location: '/live' + url.search });
      return res.end();
    }
    if (route === '/live') return this.serveFile(res, 'index.html');

    if (route === '/__guest/join' && req.method === 'POST') {
      const { key, name } = await this.body(req, 4096);
      if (!sameSecret(key, s.key))
        return this.json(res, 403, { error: 'This link is not valid any more.' });
      const clean = String(name || '')
        .trim()
        .slice(0, 40);
      if (!clean) throw Error('Enter your name');
      const waiting = [...s.requests.values()].filter((r) => r.status === 'pending').length;
      if (waiting >= 30) throw Error('Too many people are waiting. Try again in a minute.');
      const request = { id: randomUUID(), name: clean, status: 'pending', created: Date.now() };
      s.requests.set(request.id, request);
      if (!s.ask) this.admit(request, s.permission);
      this.emit();
      return this.json(res, 200, { id: request.id });
    }
    const joinStatus = /^\/__guest\/join\/([0-9a-f-]{36})$/.exec(route);
    if (joinStatus && req.method === 'GET') {
      const r = s.requests.get(joinStatus[1]);
      if (!r) return this.json(res, 404, { status: 'expired' });
      if (r.status === 'approved' && r.guest) {
        const g = r.guest;
        s.requests.delete(r.id);
        return this.json(
          res,
          200,
          { status: 'approved' },
          { 'Set-Cookie': `terra_live=${g.token}; HttpOnly; SameSite=Strict; Path=/` },
        );
      }
      if (Date.now() - r.created > 10 * 60 * 1000) r.status = 'denied';
      return this.json(res, 200, { status: r.status });
    }

    const guest = this.guestFrom(req);
    if (route === '/__guest/me') {
      if (!guest) return this.json(res, 401, { error: 'Not joined' });
      return this.json(res, 200, {
        id: guest.id,
        name: guest.name,
        permission: guest.permission,
        boardId: s.boardId,
      });
    }
    if (route.startsWith('/__local')) {
      if (!guest) return this.json(res, 401, { error: 'You are no longer in this session.' });
      if (route === '/__local/events') return this.events(req, res, guest);
      const assetPath = /^\/__local\/asset\/([a-f0-9]{64})\/(original|preview|thumb)$/.exec(route);
      if (assetPath) return this.serveAsset(req, res, assetPath[1], assetPath[2]);
      if (route === '/__local' && req.method === 'POST') {
        const { command, args = {} } = await this.body(req, 96 * 1024 * 1024);
        return this.json(res, 200, { result: await this.command(guest, command, args) });
      }
      return this.json(res, 404, { error: 'Not found' });
    }
    return this.serveFile(res, route.slice(1));
  }

  async command(guest, command, args) {
    const s = this.session;
    const shared = (id) => {
      if (id !== s.boardId) throw Error('Only the shared board is available.');
    };
    const editor = () => {
      if (guest.permission !== 'edit') throw Error('You can view this board but not change it.');
    };
    switch (command) {
      case 'loadBoard':
        shared(args.id);
        return this.call('loadBoard', { id: s.boardId });
      case 'library': {
        const { board } = await this.call('loadBoard', { id: s.boardId });
        const { camera, revision, ...meta } = board;
        return { boards: [meta], folders: [], lastBoard: s.boardId, backupError: null };
      }
      case 'saveCamera':
      case 'setLastBoard':
        return true;
      case 'patchBoard': {
        editor();
        shared(args.id);
        const result = await this.call(
          'patchBoard',
          { ...args, protectLocked: true, source: 'guest' },
          'guest',
        );
        s.assets = null;
        this.changed(s.boardId, guest.id);
        this.onGuestEdit?.(s.boardId);
        return result;
      }
      case 'importAsset': {
        editor();
        if (typeof args.bytes !== 'string' || args.bytes.length > 90 * 1024 * 1024)
          throw Error('Files up to 64 MB can be added while visiting.');
        return this.call(
          'importAsset',
          {
            bytes: Buffer.from(args.bytes, 'base64'),
            name: String(args.name || 'file').slice(0, 240),
          },
          'guest',
        );
      }
      case 'searchContent':
        return { results: [], truncated: false };
      default:
        throw Error('That is not available while visiting.');
    }
  }

  // Guests may fetch only media the shared board uses.
  async serveAsset(req, res, id, variant) {
    const s = this.session;
    if (!s.assets) {
      const { board, objects } = await this.call('loadBoard', { id: s.boardId });
      s.assets = new Set([
        ...referencedAssets('board', { ...board, icon: board.icon }, iconAssetId),
        ...objects.flatMap((o) => referencedAssets('object', o, iconAssetId)),
      ]);
    }
    if (!s.assets.has(id)) return this.json(res, 404, { error: 'Not found' });
    const a = await this.call('asset', { id, variant });
    const response = await assetResponse(a, req.headers.range);
    const headers = Object.fromEntries(response.headers);
    headers['Cache-Control'] = 'private, max-age=3600';
    res.writeHead(response.status, headers);
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  }

  events(req, res, guest) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    guest.streams.add(res);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
    req.on('close', () => {
      clearInterval(beat);
      guest.streams.delete(res);
      this.emit();
    });
    this.emit();
  }

  serveFile(res, relative) {
    const file = path.resolve(this.distDir, decodeURIComponent(relative || 'index.html'));
    if (
      !(file === this.distDir || file.startsWith(this.distDir + path.sep)) ||
      !fs.existsSync(file)
    ) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': relative.startsWith('assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  }
}

module.exports = { LiveShare, lanAddresses, allowedPeer };
