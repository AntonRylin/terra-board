// The board at the top of the home page: a working copy of the app's board screen.
// Icons are Lucide (ISC licence), as in the app. No network requests, no tracking.
(() => {
  const shell = document.getElementById('board');
  if (!shell) return;
  const $ = (s, root = shell) => root.querySelector(s);
  const $$ = (s, root = shell) => [...root.querySelectorAll(s)];
  const root = document.documentElement;
  const workspace = $('#workspace');
  const world = $('#world');
  // The open board's ink layer; switching boards replaces it.
  let ink = $('#ink');
  const SVG = 'http://www.w3.org/2000/svg';

  // --- Night board, from the ⋯ menu (the whole page follows, as in the app) --
  const isNight = () =>
    root.dataset.theme
      ? root.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
  const menu = $('#menu');
  const more = $('#more');
  const night = $('#night');
  const syncNight = () => night.setAttribute('aria-checked', String(isNight()));
  syncNight();
  more.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    more.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !e.target.closest('#menu, #more')) {
      menu.hidden = true;
      more.setAttribute('aria-expanded', 'false');
    }
  });
  night.addEventListener('click', () => {
    root.dataset.theme = isNight() ? 'light' : 'dark';
    try {
      localStorage.setItem('terra-site.theme', root.dataset.theme);
    } catch {}
    syncNight();
  });

  // --- Layout: board units, laid out narrower on phones --------------------
  const phone = () => matchMedia('(max-width: 760px)').matches;
  // [selector, desktop x, y, phone x, y, phone width]
  const layout = [
    ['.title-obj', 0, 0, 0, 0],
    ['.sub-obj', 2, 92, 2, 84],
    ['.frame-obj', 0, 222, 0, 268, 420],
    ['.note.yellow', 26, 248, 16, 290, 186],
    ['.note.green', 270, 248, 218, 290, 186],
    ['.note.blue', 26, 400, 16, 430, 186],
    ['.note.purple', 270, 400, 218, 430, 186],
    ['.link-card', 600, 10, 0, 620, 420],
    ['.picture-obj', 600, 110, -9999, 0],
  ];
  const design = () => (phone() ? { w: 420, h: 700 } : { w: 1160, h: 640 });
  const place = (o, x, y) => {
    o.dataset.x = x;
    o.dataset.y = y;
    o.style.setProperty('--ox', x + 'px');
    o.style.setProperty('--oy', y + 'px');
  };
  const arrange = () => {
    for (const [sel, x, y, px, py, pw] of layout) {
      const o = $(sel, world);
      if (!o || o.dataset.moved) continue;
      place(o, phone() ? px : x, phone() ? py : y);
      // Phones get narrower objects; desktop keeps the width from the page.
      o.dataset.width ??= o.style.width;
      o.style.width = phone() && pw ? pw + 'px' : o.dataset.width;
      if (o.matches('.frame-obj')) o.style.height = phone() ? '310px' : '330px';
      if (o.matches('.picture-obj')) o.hidden = phone();
    }
  };

  // --- Camera ---------------------------------------------------------------
  const camera = { x: 0, y: 0, z: 1 };
  const zoomValue = $('#zoom-value');
  const apply = () => {
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.z})`;
    zoomValue.textContent = Math.round(camera.z * 100) + '%';
  };
  const fit = () => {
    const d = design();
    const w = workspace.clientWidth;
    if (phone()) shell.style.height = Math.round(d.h * Math.min(1, (w - 32) / d.w) + 190) + 'px';
    else shell.style.height = '';
    const h = workspace.clientHeight;
    const top = 70,
      bottom = phone() ? 120 : 92;
    camera.z = Math.min(1, (w - 48) / d.w, (h - top - bottom) / d.h);
    camera.x = Math.max(24, (w - d.w * camera.z) / 2);
    camera.y = top;
    apply();
  };
  const zoomAt = (factor, sx, sy) => {
    const z = Math.min(4, Math.max(0.1, camera.z * factor));
    camera.x = sx - ((sx - camera.x) * z) / camera.z;
    camera.y = sy - ((sy - camera.y) * z) / camera.z;
    camera.z = z;
    apply();
  };
  $$('[data-zoom]').forEach((b) =>
    b.addEventListener('click', () =>
      zoomAt(
        b.dataset.zoom === '1' ? 1.2 : 1 / 1.2,
        workspace.clientWidth / 2,
        workspace.clientHeight / 2,
      ),
    ),
  );
  $('#fit').addEventListener('click', () => {
    fit();
    menu.hidden = true;
  });
  workspace.addEventListener(
    'wheel',
    (e) => {
      // Plain wheel scrolls the page; Ctrl+wheel zooms the board, as on a trackpad pinch.
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = workspace.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false },
  );
  const toWorld = (e) => {
    const r = workspace.getBoundingClientRect();
    return {
      x: (e.clientX - r.left - camera.x) / camera.z,
      y: (e.clientY - r.top - camera.y) / camera.z,
    };
  };

  // --- Tools ------------------------------------------------------------------
  const toast = $('#toast');
  let toastTimer;
  const tell = (text) => {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 2600);
  };
  const appOnly = { frame: 'Frames', link: 'Link cards', media: 'Images, videos and PDFs' };
  const setTool = (tool) => {
    if (appOnly[tool]) {
      tell(`${appOnly[tool]} work in the app. Download it to try them.`);
      return;
    }
    shell.dataset.tool = tool;
    $$('.canvas-toolbar [data-tool]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.tool === tool)),
    );
  };
  $$('.canvas-toolbar [data-tool]').forEach((b) =>
    b.addEventListener('click', () => setTool(b.dataset.tool)),
  );
  $$('[data-soon]').forEach((b) =>
    b.addEventListener('click', () =>
      tell(`${b.dataset.soon}: in the app. Download it to try them.`),
    ),
  );
  const keys = {
    v: 'select',
    h: 'hand',
    t: 'text',
    n: 'note',
    r: 'rect',
    a: 'arrow',
    p: 'pen',
    m: 'highlight',
    f: 'frame',
    l: 'link',
  };
  document.addEventListener('keydown', (e) => {
    if (
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      e.target.closest('input, textarea, [contenteditable="true"]')
    )
      return;
    const rect = shell.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight) return;
    const tool = keys[e.key.toLowerCase()];
    if (tool) setTool(tool);
    else if (e.key === 'Escape') select(null);
  });

  let z = 10;
  const select = (o) => $$('.obj', world).forEach((x) => x.classList.toggle('selected', x === o));
  const edit = (o) => {
    const text = $('p', o);
    if (!text) return;
    text.contentEditable = 'true';
    text.focus();
    getSelection()?.selectAllChildren(text);
    text.addEventListener('blur', () => (text.contentEditable = 'false'), { once: true });
  };
  const colours = ['yellow', 'blue', 'green', 'purple', 'rose'];
  let made = 0;
  const create = (tool, at) => {
    const o = document.createElement('div');
    if (tool === 'note') {
      o.className = 'obj note ' + colours[made++ % colours.length];
      o.innerHTML = '<p>New note</p>';
      at = { x: at.x - 111, y: at.y - 64 };
    } else if (tool === 'rect') {
      o.className = 'obj shape';
      o.innerHTML = '<p>Shape</p>';
      at = { x: at.x - 90, y: at.y - 55 };
    } else {
      o.className = 'obj text-obj text-new';
      o.innerHTML = '<p>Text</p>';
      at = { x: at.x, y: at.y - 16 };
    }
    o.dataset.moved = '1';
    o.style.zIndex = String(++z);
    world.insertBefore(o, ink);
    place(o, Math.round(at.x), Math.round(at.y));
    wire(o);
    select(o);
    setTool('select');
    edit(o);
  };

  // --- Moving objects -----------------------------------------------------------
  const wire = (o) => {
    o.addEventListener('dblclick', () => edit(o));
    o.addEventListener('click', (e) => {
      // A drag never follows the download link; a plain click does.
      if (o.dataset.dragged === '1') e.preventDefault();
      o.dataset.dragged = '';
    });
  };
  $$('.obj', world).forEach(wire);

  // --- Pointer handling ---------------------------------------------------------
  const smooth = (pts) => {
    let d = `M${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const to =
        i === pts.length - 1 ? p : { x: (p.x + pts[i + 1].x) / 2, y: (p.y + pts[i + 1].y) / 2 };
      d += ` Q${p.x} ${p.y} ${to.x} ${to.y}`;
    }
    return pts.length === 1 ? d + ` L${pts[0].x + 0.01} ${pts[0].y}` : d;
  };
  const penInk = () => (isNight() ? '#e4eaf2' : '#1f2328');
  const stroke = (attrs) => {
    const el = document.createElementNS(SVG, 'path');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    ink.append(el);
    return el;
  };
  const arrowHead = (from, to, w) => {
    const a = Math.atan2(to.y - from.y, to.x - from.x),
      l = 12 * w;
    const p = (da) => `${to.x - l * Math.cos(a + da)} ${to.y - l * Math.sin(a + da)}`;
    return `M${from.x} ${from.y} L${to.x} ${to.y} M${p(0.45)} L${to.x} ${to.y} L${p(-0.45)}`;
  };

  workspace.addEventListener('contextmenu', (e) => e.preventDefault());
  workspace.addEventListener('pointerdown', (e) => {
    if (
      e.target.closest(
        '.canvas-toolbar, .canvas-zoom, .board-head, .fullscreen-toggle, [contenteditable="true"]',
      )
    )
      return;
    const tool = shell.dataset.tool;
    const start = { x: e.clientX, y: e.clientY };
    const w0 = toWorld(e);
    const target = e.target.closest('.obj');
    let move,
      up = () => {};

    if (e.button === 1 || e.button === 2 || tool === 'hand') {
      // Pan: the Pan tool, or a right- or middle-drag, as in the app.
      const from = { ...camera };
      move = (ev) => {
        camera.x = from.x + ev.clientX - start.x;
        camera.y = from.y + ev.clientY - start.y;
        apply();
      };
    } else if (e.button !== 0) {
      return;
    } else if (tool === 'select') {
      if (!target) {
        select(null);
        return;
      }
      select(target);
      target.style.zIndex = String(++z);
      const from = { x: Number(target.dataset.x), y: Number(target.dataset.y) };
      move = (ev) => {
        const dx = (ev.clientX - start.x) / camera.z,
          dy = (ev.clientY - start.y) / camera.z;
        if (Math.abs(dx) + Math.abs(dy) > 3) target.dataset.dragged = '1';
        target.dataset.moved = '1';
        place(target, Math.round(from.x + dx), Math.round(from.y + dy));
      };
    } else if (tool === 'pen' || tool === 'highlight') {
      const pen = tool === 'pen';
      const pts = [w0];
      const path = stroke({
        d: smooth(pts),
        stroke: pen ? penInk() : '#ffe14d',
        'stroke-width': String((pen ? 3 : 22) / camera.z),
        'stroke-opacity': pen ? '1' : '0.4',
        'data-pen': pen ? '1' : '',
      });
      move = (ev) => {
        const p = toWorld(ev),
          last = pts[pts.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) * camera.z < 1.5) return;
        if (ev.shiftKey) pts.splice(1, Infinity, p);
        else pts.push(p);
        path.setAttribute(
          'd',
          pen ? smooth(pts) : 'M' + pts.map((q) => `${q.x} ${q.y}`).join(' L'),
        );
      };
    } else if (tool === 'arrow') {
      const width = 2 / camera.z;
      const path = stroke({
        d: arrowHead(w0, w0, width),
        stroke: '#66758a',
        'stroke-width': String(width),
      });
      move = (ev) => path.setAttribute('d', arrowHead(w0, toWorld(ev), width));
      up = () => setTool('select');
    } else {
      // Note, text and shape go where you click.
      up = (ev) => {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) create(tool, w0);
      };
    }
    e.preventDefault();
    workspace.setPointerCapture(e.pointerId);
    const end = (ev) => {
      workspace.removeEventListener('pointermove', onMove);
      up(ev);
    };
    const onMove = (ev) => move?.(ev);
    workspace.addEventListener('pointermove', onMove);
    workspace.addEventListener('pointerup', end, { once: true });
    workspace.addEventListener('pointercancel', end, { once: true });
  });
  new MutationObserver(() => {
    $$('path[data-pen="1"]', ink).forEach((p) => p.setAttribute('stroke', penInk()));
    syncNight();
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  // --- Launcher: other boards -----------------------------------------------------
  const home = world.innerHTML;
  const others = {
    1: {
      name: 'Website relaunch',
      glyph: null,
      notes: [
        ['yellow', 'Say what we do in one line'],
        ['green', 'Real photos, no stock images'],
        ['blue', 'Opening hours on every page'],
        ['purple', 'Replace the contact form'],
      ],
    },
    2: {
      name: 'Lisbon trip',
      glyph: 'img/boards/trip.webp',
      notes: [
        ['yellow', 'Tram 28 early'],
        ['rose', 'Pastéis de Belém'],
        ['blue', 'Flights 12–18 May'],
        ['green', 'Sintra day trip'],
      ],
    },
    3: {
      name: 'Q4 launch',
      glyph: null,
      notes: [
        ['yellow', 'Press kit by 20 Nov'],
        ['blue', 'Beta feedback call'],
        ['rose', 'Launch 1 December'],
        ['green', 'Thank-you post'],
      ],
    },
    4: {
      name: 'Work',
      glyph: null,
      notes: [
        ['blue', 'Clients'],
        ['green', 'Hiring'],
        ['purple', 'Retros'],
        ['yellow', 'Invoices'],
      ],
    },
  };
  const showBoard = (i) => {
    $$('.launch-item').forEach((b) => b.classList.toggle('active', b.dataset.board === String(i)));
    const glyph = $('#board-glyph');
    if (i === 0) {
      world.innerHTML = home;
      $('#board-title').textContent = 'Terra Board';
      glyph.src = 'img/boards/terra.webp';
      glyph.hidden = false;
      glyph.parentElement.className = 'app-icon small shape-circle picture';
      glyph.parentElement.dataset.letter = '';
    } else {
      const b = others[i];
      $('#board-title').textContent = b.name;
      glyph.parentElement.className = 'app-icon small ' + (b.glyph ? 'picture' : 'blue');
      // Boards without a picture show their first letter, as in the app.
      glyph.parentElement.dataset.letter = b.glyph ? '' : b.name[0];
      if (b.glyph) glyph.src = b.glyph;
      glyph.hidden = !b.glyph;
      const title = document.createElement('div');
      title.className = 'obj text-obj title-obj';
      title.innerHTML =
        "<p style=\"font:700 56px/1.15 'Segoe UI Variable Display','Segoe UI',sans-serif;margin:0;white-space:nowrap\"></p>";
      $('p', title).textContent = b.name;
      world.replaceChildren(title);
      place(title, 0, 0);
      b.notes.forEach(([colour, text], n) => {
        const o = document.createElement('div');
        o.className = 'obj note ' + colour;
        o.innerHTML = '<p></p>';
        $('p', o).textContent = text;
        world.append(o);
        place(o, phone() ? (n % 2) * 202 : n * 250, phone() ? 110 + Math.floor(n / 2) * 150 : 130);
        if (phone()) o.style.width = '186px';
      });
      const svg = document.createElementNS(SVG, 'svg');
      svg.setAttribute('class', 'ink');
      svg.id = 'ink';
      world.append(svg);
    }
    // The world was rebuilt: pick up its ink layer and objects again.
    ink = $('#ink', world);
    $$('.obj', world).forEach(wire);
    if (i === 0) arrange();
    select(null);
  };
  $$('.launch-item').forEach((b) =>
    b.addEventListener('click', () => showBoard(Number(b.dataset.board))),
  );

  arrange();
  fit();
  let wasPhone = phone();
  addEventListener('resize', () => {
    if (phone() !== wasPhone) {
      wasPhone = phone();
      $$('.obj', world).forEach((o) => delete o.dataset.moved);
      arrange();
    }
    fit();
  });
})();
