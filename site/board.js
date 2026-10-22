// The live board, the board dock and the Claude example on the home page.
// No tracking, no network requests; the night choice is remembered on this device only.
(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const store = {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {}
    },
  };

  // Night board: the whole page follows it, like the app.
  const root = document.documentElement;
  const saved = store.get('terra-site.theme');
  if (saved === 'dark' || saved === 'light') root.dataset.theme = saved;
  const isNight = () =>
    root.dataset.theme
      ? root.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;

  // The dock: each board opens a small preview.
  const boards = {
    terra: {
      name: 'Terra Board',
      objects: [
        ['note yellow', 6, 12, 22, 34, 'Website copy'],
        ['note blue', 32, 18, 22, 34, 'Pen in 0.1.36'],
        ['frame', 60, 14, 34, 70, '', 'Roadmap'],
        ['note green', 63, 24, 13, 22, 'Accounts'],
        ['note purple', 79, 24, 13, 22, 'Team server'],
      ],
    },
    trip: {
      name: 'Lisbon trip',
      objects: [
        ['img', 6, 10, 34, 46, 'img/boards/trip.webp'],
        ['note yellow', 44, 12, 22, 32, 'Tram 28 early'],
        ['note rose', 70, 16, 22, 32, 'Pastéis de Belém'],
        ['note blue', 46, 56, 24, 30, 'Flights 12–18 May'],
      ],
    },
    sea: {
      name: 'Surf spots',
      objects: [
        ['img', 8, 12, 40, 52, 'img/boards/sea.webp'],
        ['note green', 54, 14, 20, 30, 'Ericeira'],
        ['note blue', 76, 20, 18, 30, 'Peniche'],
        ['note yellow', 56, 56, 30, 28, 'Tide app link'],
      ],
    },
    mood: {
      name: 'Brand moodboard',
      objects: [
        ['img', 6, 10, 30, 42, 'img/boards/mood.webp'],
        ['img', 38, 26, 26, 36, 'img/boards/trip.webp'],
        ['img', 66, 8, 28, 40, 'img/boards/sea.webp'],
        ['note purple', 18, 60, 30, 28, 'Soft, hand-made, calm'],
      ],
    },
    reading: {
      name: 'Reading list',
      objects: [
        ['note purple', 6, 12, 26, 30, 'The Design of Everyday Things'],
        ['note purple', 36, 12, 26, 30, 'Shape Up'],
        ['note yellow', 66, 12, 26, 30, 'Deep Work'],
        ['note green', 20, 54, 26, 30, 'Finished: Atomic Habits'],
      ],
    },
    q4: {
      name: 'Q4 launch',
      objects: [
        ['frame', 5, 12, 56, 76, '', 'This week'],
        ['note yellow', 9, 22, 22, 30, 'Press kit'],
        ['note blue', 35, 22, 22, 30, 'Beta call'],
        ['note rose', 68, 14, 26, 34, 'Launch 1 Dec'],
      ],
    },
    recipes: {
      name: 'Recipes',
      objects: [
        ['note orange', 8, 14, 24, 34, 'Lemon pasta'],
        ['note yellow', 36, 20, 24, 34, 'Shakshuka'],
        ['note green', 64, 14, 24, 34, 'Pesto (no nuts)'],
      ],
    },
    work: {
      name: 'Work (folder, 6 boards)',
      objects: [
        ['note blue', 6, 14, 26, 30, 'Clients'],
        ['note green', 36, 14, 26, 30, 'Hiring'],
        ['note purple', 66, 14, 26, 30, 'Retros'],
        ['note orange', 6, 56, 26, 30, 'Invoices'],
        ['note rose', 36, 56, 26, 30, 'Ideas'],
        ['note gray', 66, 56, 26, 30, 'Archive'],
      ],
    },
  };
  const canvas = $('#preview-canvas');
  if (canvas) {
    const show = (id) => {
      const b = boards[id];
      $('#preview-name').textContent = b.name;
      $('#preview-count').textContent = b.objects.length + ' objects';
      canvas.replaceChildren(
        ...b.objects.map(([kind, x, y, w, h, text, label]) => {
          const el = document.createElement('div');
          el.className = 'p-obj ' + kind;
          el.style.cssText = `left:${x}%;top:${y}%;width:${w}%;height:${h}%`;
          if (kind === 'img') {
            const img = document.createElement('img');
            img.src = text;
            img.alt = '';
            el.append(img);
          } else if (kind === 'frame') {
            const t = document.createElement('b');
            t.textContent = label;
            el.append(t);
          } else {
            el.textContent = text;
            el.style.background = `var(--t-${kind.split(' ')[1]})`;
          }
          return el;
        }),
      );
    };
    const tabs = $$('.dock .app-icon');
    for (const tab of tabs) {
      const pick = () => {
        tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
        show(tab.dataset.preview);
      };
      tab.addEventListener('click', pick);
      tab.addEventListener('mouseenter', pick);
      tab.addEventListener('focus', pick);
    }
    show('terra');
  }

  // Claude adds a small web page to the board.
  const run = $('#run-prompt');
  if (run) {
    const log = $('#chat-log');
    const embed = $('#embed');
    const frame = $('#embed-frame');
    const page = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;font:14px/1.4 "Segoe UI",system-ui,sans-serif;color:#27303d;background:#fff;padding:14px}
      .days{font-size:40px;font-weight:700;letter-spacing:-.02em}
      .lbl{color:#7c8695;font-size:12px}
      .bars{display:flex;align-items:flex-end;gap:10px;height:110px;margin-top:14px}
      .bar{flex:1;background:#387aca;border-radius:6px 6px 2px 2px;position:relative;cursor:default;transition:background .15s}
      .bar:hover{background:#5d97dd}
      .bar span{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);font-size:11px;color:#59636f;padding-bottom:3px}
      .weeks{display:flex;gap:10px;margin-top:6px}.weeks i{flex:1;text-align:center;font-style:normal;font-size:11px;color:#7c8695}
    </style>
    <div class="lbl">Days until 1 December</div><div class="days" id="d"></div>
    <div class="lbl">Tasks done per week</div>
    <div class="bars">${[4, 7, 5, 9, 11]
      .map(
        (n) =>
          `<div class="bar" style="height:${n * 9}px" title="${n} tasks"><span>${n}</span></div>`,
      )
      .join('')}</div>
    <div class="weeks"><i>W40</i><i>W41</i><i>W42</i><i>W43</i><i>W44</i></div>
    <script>
      const t=new Date(new Date().getFullYear(),11,1);
      const n=Math.max(0,Math.ceil((t-new Date())/864e5));
      document.getElementById('d').textContent=n+(n===1?' day':' days');
    <\/script>`;
    const say = (html, cls) => {
      const el = document.createElement('div');
      el.className = cls;
      el.innerHTML = html;
      log.append(el);
      return el;
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));
    run.addEventListener('click', async () => {
      run.disabled = true;
      $$('.tool, .msg.claude', log).forEach((x) => x.remove());
      embed.hidden = true;
      await wait(400);
      const read = say('Using Terra Board: <code>read_board</code> “Q4 launch”', 'tool');
      await wait(900);
      read.insertAdjacentHTML('beforeend', ' <span class="ok">✓</span>');
      const add = say('Using Terra Board: <code>html_embed</code> “Launch dashboard”', 'tool');
      await wait(1100);
      add.insertAdjacentHTML('beforeend', ' <span class="ok">✓</span>');
      frame.srcdoc = page;
      embed.hidden = false;
      embed.classList.remove('arrive');
      void embed.offsetWidth;
      embed.classList.add('arrive');
      await wait(500);
      say(
        'I added a <strong>Launch dashboard</strong> next to your notes. It counts the days until 1 December and shows tasks done per week; hover a bar for its number.',
        'msg claude',
      );
      run.textContent = 'Run it again';
      run.disabled = false;
    });
  }
})();
