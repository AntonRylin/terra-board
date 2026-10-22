// The home page as one board: every text block and image moves like an object
// in Terra Board, the toolbar's tools work on the page, and ⋯ holds the night board.
// No network requests and no tracking. Icons are Lucide (ISC licence).
(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const root = document.documentElement;
  const body = document.body;
  const canvas = $('#main');
  const ink = $('#ink');
  const SVG = 'http://www.w3.org/2000/svg';
  if (!canvas) return;

  // Pieces of the reused examples become objects too.
  $$('.chat, .mini-board, .dock, .preview', canvas).forEach((el) => el.classList.add('obj'));

  // --- Night board (⋯ menu) -------------------------------------------------
  const isNight = () =>
    root.dataset.theme
      ? root.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
  const menu = $('#menu'),
    more = $('#more'),
    night = $('#night');
  const syncNight = () => {
    night.setAttribute('aria-checked', String(isNight()));
    // Screenshots follow the night board, not only the system setting.
    $$('picture source[srcset*="dark"]').forEach((s) => (s.media = isNight() ? 'all' : 'not all'));
  };
  syncNight();
  more.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    more.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !e.target.closest('#menu, #more')) menu.hidden = true;
  });
  night.addEventListener('click', () => {
    root.dataset.theme = isNight() ? 'light' : 'dark';
    try {
      localStorage.setItem('terra-site.theme', root.dataset.theme);
    } catch {}
    syncNight();
  });

  // --- Zoom: the whole page scales, as the board does --------------------------
  let zoom = 1;
  const zoomValue = $('#zoom-value');
  const setZoom = (z) => {
    zoom = Math.min(1.6, Math.max(0.5, Math.round(z * 100) / 100));
    canvas.style.zoom = String(zoom);
    zoomValue.textContent = Math.round(zoom * 100) + '%';
  };
  $$('[data-zoom]').forEach((b) =>
    b.addEventListener('click', () => setZoom(zoom * (b.dataset.zoom === '1' ? 1.1 : 1 / 1.1))),
  );
  addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey || e.target.closest('iframe')) return;
      e.preventDefault();
      setZoom(zoom * Math.exp(-e.deltaY * 0.002));
    },
    { passive: false },
  );
  // Page point (unzoomed canvas units) under the pointer.
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  };

  // --- Tools ---------------------------------------------------------------------
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
    if (appOnly[tool]) return tell(`${appOnly[tool]} are in the app. Download it to try them.`);
    body.dataset.tool = tool;
    $$('.page-toolbar [data-tool]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.tool === tool)),
    );
  };
  $$('.page-toolbar [data-tool]').forEach((b) =>
    b.addEventListener('click', () => setTool(b.dataset.tool)),
  );
  $$('[data-soon]').forEach((b) =>
    b.addEventListener('click', () => tell(`${b.dataset.soon}: in the app.`)),
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
  };
  document.addEventListener('keydown', (e) => {
    if (
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      e.target.closest('input, textarea, [contenteditable="true"]')
    )
      return;
    const tool = keys[e.key.toLowerCase()];
    if (tool) setTool(tool);
    else if (e.key === 'Escape') select(null);
  });

  // --- Objects ---------------------------------------------------------------------
  let top = 60;
  const select = (o) => {
    $$('.obj.selected', canvas).forEach((x) => x !== o && x.classList.remove('selected'));
    o?.classList.add('selected');
  };
  const offset = (o) => ({ x: Number(o.dataset.ox || 0), y: Number(o.dataset.oy || 0) });
  const moveTo = (o, x, y) => {
    o.dataset.ox = x;
    o.dataset.oy = y;
    o.style.setProperty('--ox', x + 'px');
    o.style.setProperty('--oy', y + 'px');
  };
  const edit = (o) => {
    const text = o.matches('p, h1, h2') ? o : $('p', o);
    if (!text) return;
    text.contentEditable = 'true';
    text.focus();
    getSelection()?.selectAllChildren(text);
    text.addEventListener('blur', () => (text.contentEditable = 'false'), { once: true });
  };
  canvas.addEventListener('dblclick', (e) => {
    const o = e.target.closest('.obj');
    if (o && !e.target.closest('a, button, iframe')) edit(o);
  });
  // A drag never follows a link; a plain click does.
  canvas.addEventListener(
    'click',
    (e) => {
      if (canvas.dataset.dragged === '1') {
        e.preventDefault();
        e.stopPropagation();
        canvas.dataset.dragged = '';
      }
    },
    true,
  );

  const colours = ['yellow', 'blue', 'green', 'purple', 'rose'];
  let made = 0;
  const create = (tool, p) => {
    const o = document.createElement('div');
    o.className =
      'obj placed ' +
      (tool === 'note'
        ? 'note ' + colours[made++ % colours.length]
        : tool === 'rect'
          ? 'shape'
          : 'text-new');
    o.innerHTML =
      tool === 'note' ? '<p>New note</p>' : tool === 'rect' ? '<p>Shape</p>' : '<p>Text</p>';
    const w = tool === 'note' ? 220 : tool === 'rect' ? 180 : 0;
    const h = tool === 'note' ? 130 : tool === 'rect' ? 110 : 30;
    o.style.left = Math.round(p.x - w / 2) + 'px';
    o.style.top = Math.round(p.y - h / 2) + 'px';
    o.style.zIndex = String(++top);
    canvas.append(o);
    select(o);
    setTool('select');
    edit(o);
  };

  // --- Ink: pen, highlighter and arrows, anywhere on the page ----------------------------
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
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
    ink.append(el);
    return el;
  };
  const arrowPath = (a, b) => {
    const t = Math.atan2(b.y - a.y, b.x - a.x),
      l = 14;
    const p = (d) => `${b.x - l * Math.cos(t + d)} ${b.y - l * Math.sin(t + d)}`;
    return `M${a.x} ${a.y} L${b.x} ${b.y} M${p(0.45)} L${b.x} ${b.y} L${p(-0.45)}`;
  };
  new MutationObserver(() => {
    $$('path[data-pen="1"]', ink).forEach((p) => p.setAttribute('stroke', penInk()));
    syncNight();
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  // --- Pointer -----------------------------------------------------------------------------
  // Touch keeps scrolling the page; the board tools answer the mouse and the pen.
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && body.dataset.tool === 'select') return;
    if (e.target.closest('[contenteditable="true"], iframe, .run, .dock .app-icon')) return;
    const tool = body.dataset.tool;
    const start = { x: e.clientX, y: e.clientY };
    const p0 = at(e);
    let move, up;

    if (tool === 'hand' || e.button === 1) {
      const sx = scrollX,
        sy = scrollY;
      move = (ev) => scrollTo(sx - (ev.clientX - start.x), sy - (ev.clientY - start.y));
    } else if (e.button !== 0) {
      return;
    } else if (tool === 'select') {
      const o = e.target.closest('.obj');
      if (!o) return select(null);
      select(o);
      o.style.zIndex = String(++top);
      const from = offset(o);
      const placed = o.classList.contains('placed');
      const fromPos = placed ? { x: o.offsetLeft, y: o.offsetTop } : null;
      move = (ev) => {
        const dx = (ev.clientX - start.x) / zoom,
          dy = (ev.clientY - start.y) / zoom;
        if (Math.abs(dx) + Math.abs(dy) < 4) return;
        canvas.dataset.dragged = '1';
        o.classList.add('dragging');
        if (placed) {
          o.style.left = fromPos.x + dx + 'px';
          o.style.top = fromPos.y + dy + 'px';
        } else moveTo(o, Math.round(from.x + dx), Math.round(from.y + dy));
      };
      up = () => {
        o.classList.remove('dragging');
        // Let a plain click through (links, buttons).
        setTimeout(() => (canvas.dataset.dragged = ''), 0);
      };
    } else if (tool === 'pen' || tool === 'highlight') {
      const pen = tool === 'pen';
      const pts = [p0];
      const path = stroke({
        d: smooth(pts),
        stroke: pen ? penInk() : '#ffe14d',
        'stroke-width': pen ? '3' : '22',
        'stroke-opacity': pen ? '1' : '0.4',
        'data-pen': pen ? '1' : '',
      });
      move = (ev) => {
        const p = at(ev),
          last = pts[pts.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) < 1.5) return;
        if (ev.shiftKey) pts.splice(1, Infinity, p);
        else pts.push(p);
        path.setAttribute(
          'd',
          pen ? smooth(pts) : 'M' + pts.map((q) => `${q.x} ${q.y}`).join(' L'),
        );
      };
    } else if (tool === 'arrow') {
      const path = stroke({ d: arrowPath(p0, p0), stroke: '#66758a', 'stroke-width': '2.2' });
      move = (ev) => path.setAttribute('d', arrowPath(p0, at(ev)));
      up = () => setTool('select');
    } else {
      up = (ev) => {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) create(tool, p0);
      };
    }
    if (tool !== 'select') e.preventDefault();
    const onMove = (ev) => move?.(ev);
    const end = (ev) => {
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', end);
      up?.(ev);
    };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', end);
  });
  // Dragging an object must not start the browser's own image or text drag.
  canvas.addEventListener('dragstart', (e) => e.preventDefault());

  // --- Put everything back -----------------------------------------------------------------
  $('#reset').addEventListener('click', () => {
    $$('.obj', canvas).forEach((o) => {
      moveTo(o, 0, 0);
      o.classList.remove('selected');
    });
    $$('.placed', canvas).forEach((o) => o.remove());
    ink.replaceChildren();
    setZoom(1);
    menu.hidden = true;
  });

  // --- Launcher: sections as boards ---------------------------------------------------------
  const items = $$('.page-launcher .launch-item');
  const sections = items.map((a) => document.getElementById(a.dataset.section));
  const spy = () => {
    let current = 0;
    sections.forEach((s, i) => {
      if (s && s.getBoundingClientRect().top < innerHeight * 0.4) current = i;
    });
    items.forEach((a, i) => a.classList.toggle('active', i === current));
  };
  addEventListener('scroll', spy, { passive: true });
  spy();
})();
