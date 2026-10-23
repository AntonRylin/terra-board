// Import from Miro: reads a board through Miro's REST API with the user's own
// access token and rebuilds it as a Terra board. Miro's .rtb backups can't be
// used for this: their board content (canvas.json) is encrypted.
//
// Kept on Miro's side: freehand pen drawings ("paint" has no data in the API)
// and connectors whose ends aren't attached to an item (the API gives no
// positions for loose ends). Both are counted in the report.
const API = 'https://api.miro.com/v2';
const widths = require('./miro-font-widths.json');

// ---------------------------------------------------------------- text sizing
const glyphs = {};
for (const [name, ranges] of Object.entries(widths)) {
  const map = new Map();
  for (const [start, list] of ranges) list.forEach((w, i) => map.set(start + i, w));
  glyphs[name] = map;
}
// Width of a string in Segoe UI at `size`, the font Terra draws board text with.
function textWidth(text, size, bold = false) {
  const map = glyphs[bold ? 'bold' : 'regular'];
  let w = 0;
  for (const ch of text) w += map.get(ch.codePointAt(0)) ?? (ch.codePointAt(0) > 0x2e80 ? 1000 : 560);
  return (w / 1000) * size;
}
// Lines `text` takes when wrapped at `width`, breaking at spaces like Terra.
function wrappedLines(text, size, width, boldShare = 0) {
  const scale = 1 + 0.06 * boldShare;
  let lines = 0;
  for (const paragraph of text.split('\n')) {
    lines++;
    let line = '';
    for (const word of paragraph.split(' ')) {
      const next = line ? line + ' ' + word : word;
      if (line && textWidth(next, size) * scale > width) {
        lines++;
        line = word;
      } else line = next;
    }
  }
  return lines;
}

// ------------------------------------------------------------------ rich text
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#')
      return String.fromCodePoint(
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10),
      );
    return entities[e.toLowerCase()] ?? m;
  });
}
const hex = (r, g, b) => '#' + [r, g, b].map((v) => (+v).toString(16).padStart(2, '0')).join('');
function cssColor(style) {
  const m = /(?:^|[;\s])color:\s*(rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)[^)]*\)|#[0-9a-f]{6})/i.exec(
    style || '',
  );
  if (!m) return undefined;
  return (m[2] ? hex(m[2], m[3], m[4]) : m[1]).toLowerCase();
}
// Ink close to black reads as the default text color in Terra (and flips in night mode).
const nearBlack = (c) => {
  const v = parseInt(c.slice(1), 16);
  return Math.max(v >> 16, (v >> 8) & 255, v & 255) <= 70;
};
// Miro's text HTML (p, strong, em, u, s, a, span color, br, ol/ul/li) as plain
// text plus Terra textMarks. Mark offsets are UTF-16 indexes, like JavaScript's.
function richText(html) {
  let out = '';
  const marks = [],
    stack = [],
    lists = [];
  const newline = () => {
    if (out && !out.endsWith('\n')) out += '\n';
  };
  const style = () => {
    const s = {};
    for (const { tag, attrs } of stack) {
      if (tag === 'strong' || tag === 'b') s.bold = true;
      else if (tag === 'em' || tag === 'i') s.italic = true;
      else if (tag === 'u') s.underline = true;
      else if (tag === 's' || tag === 'strike' || tag === 'del') s.strike = true;
      else if (tag === 'code') s.font = 'mono';
      if (tag === 'a') {
        s.underline = true;
        s.color = '#2563eb';
      } else {
        const c = cssColor(/style\s*=\s*"([^"]*)"/i.exec(attrs)?.[1]);
        if (c && !nearBlack(c)) s.color = c;
      }
    }
    return s;
  };
  const source = String(html || '').replace(/<span class="ql-ui"[^>]*><\/span>/g, '');
  for (const m of source.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi)) {
    if (m[4] !== undefined) {
      const text = decode(m[4]).replace(/ /g, ' ');
      if (!text) continue;
      const s = style(),
        start = out.length;
      out += text;
      if (Object.keys(s).length) marks.push({ start, end: out.length, ...s });
      continue;
    }
    const closing = m[1] === '/',
      tag = m[2].toLowerCase(),
      attrs = m[3] || '';
    if (closing) {
      if (tag === 'ol' || tag === 'ul') lists.pop();
      const i = stack.findLastIndex((x) => x.tag === tag);
      if (i >= 0) stack.splice(i, 1);
      continue;
    }
    if (tag === 'p' || tag === 'div' || tag === 'h1' || tag === 'h2' || tag === 'h3') newline();
    else if (tag === 'br') out += '\n';
    else if (tag === 'ol' || tag === 'ul') {
      newline();
      lists.push({ ordered: tag === 'ol', n: 0 });
    } else if (tag === 'li') {
      newline();
      const list = lists.at(-1);
      if (list) {
        list.n++;
        const ordered = /data-list="ordered"/.test(attrs) || (!/data-list=/.test(attrs) && list.ordered);
        out += '  '.repeat(lists.length - 1) + (ordered ? list.n + '. ' : '• ');
      }
    } else if (!attrs.trimEnd().endsWith('/')) stack.push({ tag, attrs });
  }
  const text = out.replace(/^\n+/, '').replace(/\n+$/, ''),
    lead = out.length - out.replace(/^\n+/, '').length;
  const merged = [];
  for (const mark of marks) {
    const start = Math.max(0, mark.start - lead),
      end = Math.min(text.length, mark.end - lead);
    if (end <= start) continue;
    const prev = merged.at(-1),
      same = (a, b) =>
        JSON.stringify({ ...a, start: 0, end: 0 }) === JSON.stringify({ ...b, start: 0, end: 0 });
    if (prev && prev.end === start && same(prev, mark)) prev.end = end;
    else merged.push({ ...mark, start, end });
  }
  return { text, marks: merged };
}

// ------------------------------------------------------------------ geometry
// Miro positions are item centers, relative to the board or to the parent frame's top-left.
function centers(items) {
  const byId = new Map(items.map((i) => [i.id, i])),
    cache = new Map();
  const center = (item, depth = 0) => {
    if (cache.has(item.id)) return cache.get(item.id);
    const p = item.position || { x: 0, y: 0 };
    let c = { x: +p.x || 0, y: +p.y || 0 };
    const parent = item.parent?.id && byId.get(item.parent.id);
    if (p.relativeTo === 'parent_top_left' && parent && depth < 20) {
      const pc = center(parent, depth + 1),
        g = parent.geometry || {};
      c = { x: pc.x - (g.width || 0) / 2 + c.x, y: pc.y - (g.height || 0) / 2 + c.y };
    }
    cache.set(item.id, c);
    return c;
  };
  return center;
}
const rotation = (g) => {
  const r = ((+g?.rotation || 0) % 360 + 360) % 360;
  return r ? { rotation: r } : {};
};
const stickyColors = {
  gray: '#f5f6f8',
  light_yellow: '#fff9b1',
  yellow: '#f5d128',
  orange: '#ff9d48',
  light_green: '#d5f692',
  green: '#c9df56',
  dark_green: '#93d275',
  cyan: '#67c6c0',
  light_pink: '#ffcee0',
  pink: '#ea94bb',
  violet: '#c6a2d2',
  red: '#f0939d',
  light_blue: '#a6ccf5',
  blue: '#6cd8fa',
  dark_blue: '#9ea9ff',
  black: '#1a1a1a',
};
const hexColor = (c, fallback) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c.toLowerCase() : fallback);

// Turns Miro items and connectors into Terra board objects.
// `assets` maps a Miro image item id to an imported Terra asset id.
function convertBoard({ items, connectors = [], assets = new Map() }) {
  const center = centers(items),
    objects = [],
    boxes = new Map(),
    skipped = { drawings: 0, arrows: 0, images: 0, other: 0 };
  const layer = { frame: 0, image: 100000, shape: 200000, note: 300000, text: 400000, arrow: 500000 };
  const z = (kind) => ++layer[kind];
  const id = (miroId, suffix = '') => 'miro-' + miroId + suffix;
  // Bigger frames sit below smaller ones that may be nested in them.
  const ordered = [...items].sort((a, b) => {
    const area = (i) => (i.type === 'frame' ? -(i.geometry?.width || 0) * (i.geometry?.height || 0) : 0);
    return area(a) - area(b);
  });
  const box = (c, w, h) => ({ x: c.x - w / 2, y: c.y - h / 2, width: Math.max(1, w), height: Math.max(1, h) });
  for (const item of ordered) {
    const g = item.geometry || {},
      d = item.data || {},
      s = item.style || {},
      c = center(item);
    let o = null;
    switch (item.type) {
      case 'frame':
        o = {
          id: id(item.id),
          type: 'frame',
          ...box(c, g.width || 100, g.height || 100),
          z: z('frame'),
          text: decode(d.title || '').slice(0, 1000),
        };
        break;
      case 'image': {
        const assetId = assets.get(item.id);
        if (!assetId) {
          skipped.images++;
          continue;
        }
        o = {
          id: id(item.id),
          type: 'image',
          ...box(c, g.width || 100, g.height || 100),
          z: z('image'),
          assetId,
          ...(d.title ? { imageTitle: decode(d.title).slice(0, 500) } : {}),
          ...rotation(g),
        };
        break;
      }
      case 'text': {
        const { text, marks } = richText(d.content);
        if (!text.trim()) continue;
        // Miro reports whole-number font sizes; small text keeps its box and Terra fits the font to it.
        const size = Math.max(0.5, +s.fontSize || 14),
          width = g.width || textWidth(text, size) + 4,
          bold = marks.filter((m) => m.bold).reduce((n, m) => n + m.end - m.start, 0) / text.length;
        const lines = wrappedLines(text, size, width, bold);
        const w = width + 0.28 * size + 2,
          h = lines * 1.3 * size + 0.38 * size + 1.5;
        o = {
          id: id(item.id),
          type: 'text',
          ...box(c, w, h),
          z: z('text'),
          text,
          fontSize: Math.round(Math.max(8, size) * 100) / 100,
          textBox: true,
          ...(marks.length ? { textMarks: marks } : {}),
          ...(s.textAlign === 'center' ? { centerX: true } : {}),
          ...(hexColor(s.color) && !nearBlack(hexColor(s.color)) ? { color: hexColor(s.color) } : {}),
          ...rotation(g),
        };
        break;
      }
      case 'sticky_note': {
        const { text, marks } = richText(d.content);
        o = {
          id: id(item.id),
          type: 'note',
          ...box(c, g.width || 200, g.height || g.width || 200),
          z: z('note'),
          text,
          color: stickyColors[s.fillColor] || hexColor(s.fillColor, '#fff9b1'),
          ...(marks.length ? { textMarks: marks } : {}),
          ...rotation(g),
        };
        break;
      }
      case 'shape': {
        const { text, marks } = richText(d.content);
        const transparent = s.fillOpacity !== undefined && +s.fillOpacity === 0;
        o = {
          id: id(item.id),
          type: /circle|ellipse/.test(d.shape || '') ? 'ellipse' : 'rect',
          ...box(c, g.width || 100, g.height || 100),
          z: z('shape'),
          text,
          color: transparent ? '#ffffff' : hexColor(s.fillColor, '#ffffff'),
          centerX: s.textAlign !== 'left',
          centerY: true,
          ...(marks.length ? { textMarks: marks } : {}),
          ...(+s.fontSize ? { fontSize: Math.min(300, Math.max(8, +s.fontSize)) } : {}),
          ...rotation(g),
        };
        break;
      }
      case 'card':
      case 'app_card': {
        const title = richText(d.title || ''),
          body = richText(d.description || '');
        const text = [title.text, body.text].filter(Boolean).join('\n');
        o = {
          id: id(item.id),
          type: 'note',
          ...box(c, g.width || 320, g.height || 120),
          z: z('note'),
          text,
          color: '#ffffff',
          ...(title.text ? { textMarks: [{ start: 0, end: title.text.length, bold: true }] } : {}),
        };
        break;
      }
      case 'code': {
        const code = decode(d.code || '')
          .replace(/\r\n?/g, '\n')
          .replace(/\t/g, '    ')
          .trimEnd();
        if (!code) continue;
        const w = g.width || 400,
          h = g.height || 200,
          rows = code.split('\n'),
          longest = Math.max(...rows.map((r) => r.length));
        const size = Math.min((h - 4) / (rows.length * 1.3 + 0.28), (w - 4) / (longest * 0.55 + 0.28));
        objects.push({
          id: id(item.id, '-bg'),
          type: 'rect',
          ...box(c, w, h),
          z: z('shape'),
          color: '#f4f4f2',
        });
        o = {
          id: id(item.id),
          type: 'text',
          ...box(c, w, h),
          z: z('text'),
          text: code,
          fontSize: Math.round(Math.max(8, size) * 100) / 100,
          textBox: true,
          textMarks: [{ start: 0, end: code.length, font: 'mono' }],
        };
        break;
      }
      case 'embed':
      case 'document': {
        const url = d.url || d.documentUrl;
        if (!/^https?:\/\//i.test(url || '')) {
          skipped.other++;
          continue;
        }
        o = {
          id: id(item.id),
          type: 'link',
          ...box(c, g.width || 360, g.height || 120),
          z: z('note'),
          url,
          text: decode(d.title || url).slice(0, 500),
        };
        break;
      }
      case 'paint':
        skipped.drawings++;
        continue;
      default:
        skipped.other++;
        continue;
    }
    boxes.set(item.id, o);
    objects.push(o);
  }
  const pct = (v) => (v === undefined ? 0.5 : parseFloat(v) / 100);
  for (const k of connectors) {
    const ends = [k.startItem, k.endItem];
    if (!ends.every((e) => e && boxes.has(e.id))) {
      skipped.arrows++;
      continue;
    }
    const points = ends.map((e) => {
      const b = boxes.get(e.id);
      return { x: b.x + b.width * pct(e.position?.x), y: b.y + b.height * pct(e.position?.y) };
    });
    const x = Math.min(points[0].x, points[1].x),
      y = Math.min(points[0].y, points[1].y),
      w = Math.max(1, Math.abs(points[0].x - points[1].x)),
      h = Math.max(1, Math.abs(points[0].y - points[1].y));
    const st = k.style || {},
      cap = (v) => (!v || v === 'none' ? 'none' : 'arrow');
    objects.push({
      id: id(k.id),
      type: 'arrow',
      x,
      y,
      width: w,
      height: h,
      z: z('arrow'),
      color: hexColor(st.strokeColor, '#333333'),
      arrow: {
        points: points.map((p) => ({ x: (p.x - x) / w, y: (p.y - y) / h })),
        line: k.shape === 'curved' ? 'curve' : k.shape === 'elbowed' ? 'elbow' : 'straight',
        start: cap(st.startStrokeCap),
        end: cap(st.endStrokeCap),
        dash: st.strokeStyle === 'dashed' ? 'dashed' : st.strokeStyle === 'dotted' ? 'dotted' : 'solid',
        thickness: Math.min(40, Math.max(0.5, +st.strokeWidth || 2)),
      },
    });
  }
  return { objects, skipped };
}
// A camera that shows every object in a 1600 x 900 window.
function fitCamera(objects) {
  if (!objects.length) return { x: 0, y: 0, zoom: 1 };
  const x0 = Math.min(...objects.map((o) => o.x)),
    y0 = Math.min(...objects.map((o) => o.y)),
    x1 = Math.max(...objects.map((o) => o.x + o.width)),
    y1 = Math.max(...objects.map((o) => o.y + o.height));
  const zoom = Math.min(16, Math.max(0.01, 0.9 * Math.min(1600 / (x1 - x0 || 1), 900 / (y1 - y0 || 1))));
  return { x: 800 - ((x0 + x1) / 2) * zoom, y: 450 - ((y0 + y1) / 2) * zoom, zoom };
}

// ----------------------------------------------------------------- Miro API
// A board link (miro.com/app/board/<id>/…) or a bare id.
function boardIdFrom(input) {
  const s = String(input || '').trim();
  const m = /miro\.com\/app\/board\/([^/?#\s]+)/i.exec(s);
  const raw = m ? m[1] : s;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
class MiroClient {
  constructor(token, { fetch = globalThis.fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.token = String(token || '').trim();
    this.fetch = fetch;
    this.wait = wait;
  }
  async request(url, { json = true, auth = true } = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, {
        headers: auth ? { Authorization: 'Bearer ' + this.token, Accept: 'application/json' } : {},
      });
      if (res.status === 429 && attempt < 5) {
        await this.wait(Math.min(60, +res.headers.get('retry-after') || 2 ** attempt) * 1000);
        continue;
      }
      if (res.status === 401) throw Error('Miro did not accept this access token.');
      if (res.status === 403) throw Error('This token cannot read that board. Install the Miro app in the team that owns it.');
      if (res.status === 404) throw Error('Miro could not find that board.');
      if (!res.ok) throw Error('Miro answered ' + res.status + '.');
      return json ? res.json() : Buffer.from(await res.arrayBuffer());
    }
  }
  // Boards in the token's own team plus `known` teams. Miro lists one team at a
  // time and only Enterprise plans can list a user's teams, so other teams are
  // learned from a board link (teamOf) and passed back in here.
  async boards(known = []) {
    const me = await this.request('https://api.miro.com/v1/oauth-token').catch((e) => {
      if (/access token/.test(e.message)) throw e;
      return null;
    });
    const teams = new Map();
    if (me?.team?.id) teams.set(String(me.team.id), me.team.name || 'Team');
    for (const t of known) if (t?.id) teams.set(String(t.id), t.name || 'Team');
    const found = new Map();
    for (const [teamId, team] of teams.size ? teams : new Map([['', '']])) {
      for (let offset = 0; offset < 5000; ) {
        const page = await this.request(
          `${API}/boards?limit=50&offset=${offset}&sort=last_modified${teamId ? '&team_id=' + encodeURIComponent(teamId) : ''}`,
        );
        for (const b of page.data || [])
          found.set(b.id, { id: b.id, name: b.name || 'Untitled', modifiedAt: b.modifiedAt, team });
        offset += (page.data || []).length;
        if (!page.data?.length || offset >= (page.total ?? 0)) break;
      }
    }
    return {
      boards: [...found.values()].sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt))),
      teams: [...teams].map(([id, name]) => ({ id, name })),
    };
  }
  async teamOf(boardId) {
    const b = await this.board(boardId);
    return b.team?.id ? { id: String(b.team.id), name: b.team.name || 'Team' } : null;
  }
  board(id) {
    return this.request(`${API}/boards/${encodeURIComponent(id)}`);
  }
  async all(id, kind) {
    const out = [];
    let cursor = '';
    for (let n = 0; n < 2000; n++) {
      const page = await this.request(
        `${API}/boards/${encodeURIComponent(id)}/${kind}?limit=50${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
      );
      out.push(...(page.data || []));
      cursor = page.cursor;
      if (!cursor) break;
    }
    return out;
  }
  // The original file behind an image item.
  async image(item) {
    const url = String(item.data?.imageUrl || '').replace('format=preview', 'format=original');
    if (!url.startsWith(API)) throw Error('Unexpected image address');
    const meta = await this.request(url.includes('redirect=') ? url : url + '&redirect=false');
    if (!/^https:\/\//.test(meta.url || '')) throw Error('Image has no download address');
    const bytes = await this.request(meta.url, { json: false, auth: false });
    const ext = { 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' }[meta.type] || 'png';
    return { bytes, name: (decode(item.data?.title || '') || 'Miro image').replace(/[\\/:*?"<>|]/g, '').slice(0, 80) + '.' + ext };
  }
}

// Reads one Miro board and saves it as a new Terra board through the storage `call`.
async function importBoard({ client, boardId, call, onProgress = () => {}, concurrency = 10 }) {
  const meta = await client.board(boardId);
  const name = String(meta.name || 'Miro board').slice(0, 120);
  onProgress({ board: name, phase: 'reading' });
  const [items, connectors] = await Promise.all([client.all(boardId, 'items'), client.all(boardId, 'connectors')]);
  const images = items.filter((i) => i.type === 'image'),
    assets = new Map();
  let done = 0,
    next = 0;
  onProgress({ board: name, phase: 'images', done, total: images.length });
  await Promise.all(
    Array.from({ length: Math.min(concurrency, images.length) }, async () => {
      while (next < images.length) {
        const item = images[next++];
        try {
          const file = await client.image(item);
          const asset = await call('importAsset', { bytes: file.bytes, name: file.name });
          assets.set(item.id, asset.id);
        } catch (e) {
          // A missing picture is reported; a rejected token stops the import.
          if (/access token|cannot read/.test(e.message)) throw e;
        }
        onProgress({ board: name, phase: 'images', done: ++done, total: images.length });
      }
    }),
  );
  onProgress({ board: name, phase: 'saving' });
  const { objects, skipped } = convertBoard({ items, connectors, assets });
  const board = await call('createBoard', { name });
  await call('patchBoard', { id: board.id, revision: 0, upserts: objects, camera: fitCamera(objects) });
  return { board, objects: objects.length, skipped };
}

module.exports = { MiroClient, boardIdFrom, convertBoard, fitCamera, importBoard, richText, textWidth, wrappedLines };
