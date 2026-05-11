import { store } from './store.js';
import { makeCommand } from './commands.js';
import { IsbnScanner } from './ocr.js';

const root = document.getElementById('view');

const ui = {
  tab: 'scan',
  scanner: null,
  status: 'Tap Start to begin',
  lastCapture: null,
  active: false,
  toast: null,
  recent: new Map(),
};

const DEBOUNCE_MS = 4000;

const fmtTime = (t) => {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Tiny DOM builder. No innerHTML; all dynamic strings become text nodes.
const h = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k in el) {
      el[k] = v;
    } else {
      el.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number'
      ? document.createTextNode(String(c))
      : c);
  }
  return el;
};

const showToast = (msg) => {
  ui.toast = msg;
  render();
  setTimeout(() => {
    if (ui.toast === msg) { ui.toast = null; render(); }
  }, 1800);
};

const vibrate = (pattern) => {
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch {}
  }
};

const acceptIsbn = (isbn) => {
  const now = Date.now();
  const last = ui.recent.get(isbn);
  if (last && now - last < DEBOUNCE_MS) return;
  ui.recent.set(isbn, now);
  const entry = { isbn, t: now };
  store.dispatch(makeCommand('ADD_SCAN', { from: null, to: entry }));
  ui.lastCapture = entry;
  vibrate(120);
  showToast(`Saved ${isbn}`);
};

const startScanning = async () => {
  if (ui.active) return;
  const video = root.querySelector('#cam');
  if (!video) return;
  ui.scanner = new IsbnScanner({
    video,
    onStatus: (s) => { ui.status = s; updateStatus(); },
    onResult: (isbn) => acceptIsbn(isbn),
  });
  try {
    await ui.scanner.start();
    ui.active = true;
    render();
  } catch {
    ui.active = false;
    ui.scanner = null;
    render();
  }
};

const stopScanning = async () => {
  if (ui.scanner) {
    await ui.scanner.stop();
    ui.scanner = null;
  }
  ui.active = false;
  ui.status = 'Stopped';
  render();
};

const updateStatus = () => {
  const el = root.querySelector('.status');
  if (!el) return;
  el.textContent = ui.status;
  el.classList.toggle('flash', ui.status.startsWith('Found'));
};

const removeScan = (entry) => {
  const index = store.state.scans.findIndex(
    (x) => x.isbn === entry.isbn && x.t === entry.t,
  );
  if (index < 0) return;
  store.dispatch(makeCommand('REMOVE_SCAN', {
    from: { ...entry, index },
    to: null,
  }));
};

const exportJson = () => {
  const data = {
    exported: new Date().toISOString(),
    count: store.state.scans.length,
    scans: store.state.scans.map((s) => ({
      isbn: s.isbn,
      capturedAt: new Date(s.t).toISOString(),
    })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `isbngrab-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const clearAll = () => {
  if (!store.state.scans.length) return;
  if (!confirm(`Delete all ${store.state.scans.length} scans?`)) return;
  store.reset();
  ui.lastCapture = null;
};

const switchTab = async (next) => {
  if (next === ui.tab) return;
  if (ui.tab === 'scan' && ui.active) await stopScanning();
  ui.tab = next;
  render();
};

// ---------- rendering ----------

const renderBar = () =>
  h('div', { class: 'bar' },
    h('h1', {}, 'ISBNGrab'),
    h('span', { class: 'muted' }, `${store.state.scans.length} saved`),
  );

const renderTabs = () =>
  h('div', { class: 'tabs', role: 'tablist' },
    h('button', {
      class: ui.tab === 'scan' ? 'active' : '',
      onClick: () => switchTab('scan'),
    }, 'Scan'),
    h('button', {
      class: ui.tab === 'list' ? 'active' : '',
      onClick: () => switchTab('list'),
    }, 'List'),
  );

const renderScan = () =>
  h('section', { class: 'scan' },
    h('div', { class: `viewfinder ${ui.active ? '' : 'idle'}` },
      h('video', { id: 'cam', autoplay: true, playsinline: true, muted: true }),
      ui.active ? h('div', { class: 'reticle' },
        h('span', { class: 'hint' }, 'Aim ISBN here'),
        h('span', { class: 'corner tl' }),
        h('span', { class: 'corner tr' }),
        h('span', { class: 'corner bl' }),
        h('span', { class: 'corner br' }),
      ) : null,
    ),
    h('div', {
      class: `status ${ui.status.startsWith('Found') ? 'flash' : ''}`,
    }, ui.status),
    h('div', { class: 'controls' },
      ui.active
        ? h('button', { id: 'stop', class: 'ghost', onClick: stopScanning }, 'Stop')
        : h('button', { id: 'start', onClick: startScanning }, 'Start camera'),
    ),
    ui.lastCapture ? h('div', { class: 'last-capture' },
      h('span', { class: 'label' }, 'Last capture'),
      h('span', { class: 'isbn' }, ui.lastCapture.isbn),
      h('span', { class: 'muted', style: 'font-size:0.8rem' }, fmtTime(ui.lastCapture.t)),
    ) : null,
  );

const renderList = () => {
  const scans = [...store.state.scans].sort((a, b) => b.t - a.t);
  const body = scans.length
    ? scans.map((s) =>
        h('div', { class: 'row' },
          h('div', { class: 'info' },
            h('span', { class: 'code' }, s.isbn),
            h('span', { class: 'time' }, fmtTime(s.t)),
          ),
          h('button', {
            class: 'x',
            'aria-label': 'Remove',
            onClick: () => removeScan(s),
          }, '×'),
        ))
    : [h('div', { class: 'empty' }, 'No scans yet. Switch to the Scan tab to start.')];

  return [
    h('section', { class: 'list' }, body),
    h('div', { class: 'list-actions' },
      h('button', { id: 'export', disabled: !scans.length, onClick: exportJson }, 'Export JSON'),
      h('button', { id: 'clear', class: 'danger', disabled: !scans.length, onClick: clearAll }, 'Clear all'),
    ),
  ];
};

const render = () => {
  const children = [renderBar(), renderTabs()];
  if (ui.tab === 'scan') children.push(renderScan());
  else children.push(...renderList());
  if (ui.toast) children.push(h('div', { class: 'toast' }, ui.toast));
  root.replaceChildren(...children);
};

const onKeyDown = (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;
  const t = e.target;
  const editable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  if (editable) return;
  if (e.key === 'z' || e.key === 'Z') {
    e.preventDefault();
    if (e.shiftKey) store.redo(); else store.undo();
  } else if (e.key === 'y' || e.key === 'Y') {
    e.preventDefault();
    store.redo();
  }
};

document.addEventListener('visibilitychange', async () => {
  if (document.hidden && ui.active) await stopScanning();
});

const start = async () => {
  await store.ready;
  store.subscribe(() => render());
  window.addEventListener('keydown', onKeyDown);
  render();
};

start();
