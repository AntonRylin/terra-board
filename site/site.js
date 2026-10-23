// Every .obj behaves like a Terra Board object: select, move, resize, edit.
(() => {
  const sel = document.getElementById('selection');
  const selName = document.getElementById('sel-name');
  let current = null;
  let top = 20;
  const num = (el, k) => parseFloat(el.style.getPropertyValue(k)) || 0;

  const frame = () => {
    if (!current) return sel.classList.remove('on');
    const r = current.getBoundingClientRect();
    sel.style.left = r.left + scrollX - 4 + 'px';
    sel.style.top = r.top + scrollY - 4 + 'px';
    sel.style.width = r.width + 8 + 'px';
    sel.style.height = r.height + 8 + 'px';
    selName.textContent = current.dataset.name || 'Object';
    sel.classList.add('on');
  };
  const select = (o) => {
    document.querySelectorAll('.obj.selected').forEach((x) => x.classList.remove('selected'));
    current = o;
    if (o) o.classList.add('selected');
    frame();
  };
  addEventListener('resize', frame);

  // The board grid fades in while someone is working on the board.
  let quiet;
  const board = () => {
    document.body.classList.add('boarding');
    clearTimeout(quiet);
  };
  const rest = () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => !current && document.body.classList.remove('boarding'), 1600);
  };

  // Move: mouse drags right away; touch first selects, then drags.
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.selection i')) return;
    const o = e.target.closest('.obj');
    if (!o) {
      if (current && !e.target.closest('[contenteditable="true"]')) {
        select(null);
        rest();
      }
      return;
    }
    if (o.querySelector('[contenteditable="true"]') || o.isContentEditable) return;
    if (e.pointerType === 'touch' && o !== current) {
      select(o);
      board();
      return;
    }
    select(o);
    board();
    o.style.zIndex = String(Math.min(++top, 900));
    const start = { x: e.clientX, y: e.clientY, ox: num(o, '--x'), oy: num(o, '--y') };
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - start.x,
        dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      o.classList.add('dragging');
      o.style.setProperty('--x', start.ox + dx + 'px');
      o.style.setProperty('--y', start.oy + dy + 'px');
      frame();
    };
    const up = () => {
      o.classList.remove('dragging');
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (moved) o.dataset.dragged = '1';
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
  // A drag never follows a link; a plain click does.
  document.addEventListener(
    'click',
    (e) => {
      const o = e.target.closest('.obj');
      if (o && o.dataset.dragged === '1') {
        e.preventDefault();
        o.dataset.dragged = '';
      }
    },
    true,
  );

  // Resize from a corner, keeping the proportions, as images and text scale in the app.
  sel.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('i');
    if (!h || !current) return;
    e.preventDefault();
    e.stopPropagation();
    const o = current;
    const r = o.getBoundingClientRect();
    const s0 = num(o, '--s') || 1;
    const w0 = r.width;
    const sx = e.clientX;
    const east = h.dataset.h.includes('e');
    const move = (ev) => {
      const dx = (ev.clientX - sx) * (east ? 1 : -1);
      const s = Math.max(0.3, Math.min(3, s0 * (1 + dx / w0)));
      o.style.setProperty('--s', s.toFixed(3));
      frame();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });

  // Double-click to edit text in place, like a title on a board.
  document.addEventListener('dblclick', (e) => {
    const o = e.target.closest('.obj');
    if (!o) return;
    const target = o.hasAttribute('data-edit-label') ? o.querySelector('span') : o.hasAttribute('data-edit') ? o : null;
    if (!target) return;
    target.contentEditable = 'true';
    target.focus();
    getSelection()?.selectAllChildren(target);
    target.addEventListener(
      'blur',
      () => {
        target.contentEditable = 'false';
        frame();
      },
      { once: true },
    );
  });
  document.addEventListener('input', frame);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.activeElement?.blur();
      select(null);
      rest();
    }
  });
})();
// Scale the grammar map's fixed 780x520 layout to the scene's width.
(() => {
  const scene = document.querySelector('.gscene');
  if (!scene) return;
  const fit = () => scene.style.setProperty('--k', scene.clientWidth / 780);
  new ResizeObserver(fit).observe(scene);
  fit();
})();
// Buttons answer a click: a ripple from the click point, and a short message while
// the download starts or Discord opens.
(() => {
  const buttons = '.button, .nav .get, .nav .social, .nav .mcp-link';
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  document.addEventListener('click', (e) => {
    const b = e.target.closest(buttons);
    if (!b || e.defaultPrevented) return;
    if (!still.matches) {
      const r = b.getBoundingClientRect();
      const dot = document.createElement('i');
      dot.className = 'ripple';
      dot.style.left = (e.clientX || r.left + r.width / 2) - r.left + 'px';
      dot.style.top = (e.clientY || r.top + r.height / 2) - r.top + 'px';
      dot.style.setProperty('--grow', String(Math.ceil((Math.hypot(r.width, r.height) * 2) / 12)));
      b.append(dot);
      dot.addEventListener('animationend', () => dot.remove());
    }
    const label = b.matches('.button') && b.querySelector('span');
    if (!label || b.classList.contains('working')) return;
    const download = /\.exe$/.test(b.getAttribute('href') || '');
    const text = download ? 'Starting download…' : /discord/.test(b.href) ? 'Opening Discord…' : '';
    if (!text) return;
    const before = label.textContent;
    const show = (t) => {
      label.textContent = t;
      label.classList.remove('label-swap');
      void label.offsetWidth;
      label.classList.add('label-swap');
    };
    b.classList.add('working');
    show(text);
    setTimeout(() => {
      b.classList.remove('working');
      show(before);
    }, 3200);
  });
})();
