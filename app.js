import { store } from './store.js';
import { makeCommand } from './commands.js';
import { IsbnScanner } from './ocr.js';
import { lookupIsbn } from './openlibrary.js';

const root = document.getElementById('view');

// The <video> element is kept as a singleton so it survives full re-renders
// (saving a scan, toast appearing). Replacing it would detach the MediaStream
// and the live preview would go dark.
let videoEl = null;
const getVideoEl = () => {
  if (!videoEl) {
    videoEl = document.createElement('video');
    videoEl.id = 'cam';
    videoEl.autoplay = true;
    videoEl.muted = true;
    videoEl.setAttribute('playsinline', 'true');
  }
  return videoEl;
};

// Scan-tab phases:
//   idle      – nothing happening, "Start camera" button
//   scanning  – camera live, OCR ticking, reticle drawn, "Stop" button
//   lookup    – ISBN captured, camera stopped, fetching Open Library metadata
//   result    – metadata resolved (or null), book card + "Scan another" button
const ui = {
  tab: 'scan',
  phase: 'idle',
  scanner: null,
  status: 'Tap Start to begin',
  lastCapture: null,
  lastWasDuplicate: false,
  selectedScan: null,
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

const ensureScanner = () => {
  if (!ui.scanner) {
    ui.scanner = new IsbnScanner({
      video: getVideoEl(),
      onStatus: (s) => { ui.status = s; updateStatus(); },
      onResult: (isbn) => onIsbnDetected(isbn),
    });
  }
  return ui.scanner;
};

const onIsbnDetected = async (isbn) => {
  if (ui.phase !== 'scanning') return;
  const now = Date.now();
  const last = ui.recent.get(isbn);
  if (last && now - last < DEBOUNCE_MS) return;
  ui.recent.set(isbn, now);

  vibrate(120);

  // Already in the list? Surface the existing entry, don't dispatch
  // or hit Open Library again.
  const existing = store.state.scans.find((s) => s.isbn === isbn);
  if (existing) {
    if (ui.scanner) await ui.scanner.stop();
    ui.lastCapture = existing;
    ui.lastWasDuplicate = true;
    ui.phase = 'result';
    showToast(`Already in list: ${existing.meta?.title || isbn}`);
    render();
    return;
  }

  ui.lastWasDuplicate = false;
  ui.phase = 'lookup';
  ui.status = `Looking up ${isbn}…`;
  if (ui.scanner) await ui.scanner.stop();
  render();

  const meta = await lookupIsbn(isbn);
  const entry = meta ? { isbn, t: now, meta } : { isbn, t: now };

  store.dispatch(makeCommand('ADD_SCAN', { from: null, to: entry }));
  ui.lastCapture = entry;
  ui.phase = 'result';
  showToast(meta ? `Saved ${entry.meta.title || isbn}` : `Saved ${isbn}`);
  render();
};

const startScanning = async () => {
  if (ui.phase === 'scanning' || ui.phase === 'lookup') return;
  ui.phase = 'scanning';
  ui.status = 'Starting camera…';
  render();
  const scanner = ensureScanner();
  try {
    await scanner.start();
  } catch {
    ui.phase = 'idle';
    render();
  }
};

const stopScanning = async () => {
  if (ui.scanner) await ui.scanner.stop();
  ui.phase = 'idle';
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
  const label = entry.meta?.title || entry.isbn;
  if (!confirm(`Delete "${label}"?`)) return;
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
      ...(s.meta ? { meta: s.meta } : {}),
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
  ui.phase = 'idle';
  ui.status = 'Tap Start to begin';
  render();
};

const switchTab = async (next) => {
  if (next === ui.tab) return;
  if (ui.tab === 'scan' && ui.phase === 'scanning') await stopScanning();
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

const renderCover = (meta, cls = 'cover', size = 'M') => {
  if (!meta) return null;
  const url = meta.coverId
    ? `https://covers.openlibrary.org/b/id/${meta.coverId}-${size}.jpg`
    : meta.coverUrl;
  if (!url) return null;
  const img = h('img', { class: cls, src: url, alt: '', loading: 'lazy' });
  img.onerror = () => img.remove();
  return img;
};

const openDetail = (entry) => {
  ui.selectedScan = entry;
  render();
};

const closeDetail = () => {
  ui.selectedScan = null;
  render();
};

const deleteFromDetail = (entry) => {
  const label = entry.meta?.title || entry.isbn;
  if (!confirm(`Delete "${label}"?`)) return;
  const index = store.state.scans.findIndex(
    (x) => x.isbn === entry.isbn && x.t === entry.t,
  );
  if (index >= 0) {
    store.dispatch(makeCommand('REMOVE_SCAN', {
      from: { ...entry, index },
      to: null,
    }));
  }
  closeDetail();
};

const renderModal = (entry) => {
  const m = entry.meta;
  const olUrl = m?.openLibraryKey ? `https://openlibrary.org${m.openLibraryKey}` : null;
  const stop = (e) => e.stopPropagation();
  return h('div', {
    class: 'modal-backdrop',
    role: 'dialog',
    'aria-modal': 'true',
    onClick: closeDetail,
  },
    h('div', { class: 'modal', onClick: stop },
      h('button', {
        class: 'modal-close',
        'aria-label': 'Close',
        onClick: closeDetail,
      }, '×'),
      renderCover(m, 'cover-lg', 'L'),
      h('div', { class: 'title-lg' }, m?.title || 'Untitled'),
      m?.authors?.length
        ? h('div', { class: 'authors-lg' }, m.authors.join(', '))
        : null,
      h('dl', { class: 'meta-list' },
        m?.publisher ? h('dt', {}, 'Publisher') : null,
        m?.publisher ? h('dd', {}, m.publisher) : null,
        m?.year ? h('dt', {}, 'First published') : null,
        m?.year ? h('dd', {}, String(m.year)) : null,
        h('dt', {}, 'ISBN'),
        h('dd', { class: 'mono' }, entry.isbn),
        h('dt', {}, 'Captured'),
        h('dd', {}, fmtTime(entry.t)),
        olUrl ? h('dt', {}, 'Open Library') : null,
        olUrl ? h('dd', {},
          h('a', { href: olUrl, target: '_blank', rel: 'noreferrer noopener' },
            m.openLibraryKey),
        ) : null,
        !m ? h('dt', {}, 'Metadata') : null,
        !m ? h('dd', { class: 'muted' }, 'Not available') : null,
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'ghost', onClick: closeDetail }, 'Close'),
        h('button', { class: 'danger', onClick: () => deleteFromDetail(entry) }, 'Delete'),
      ),
    ),
  );
};

const renderBookCard = (entry) => {
  const m = entry.meta;
  if (!m) {
    return h('div', { class: 'book-card no-meta' },
      h('div', { class: 'info' },
        h('div', { class: 'title' }, entry.isbn),
        h('div', { class: 'authors muted' }, 'No metadata found'),
      ),
    );
  }
  const pubBits = [m.publisher, m.year].filter(Boolean).join(' · ');
  return h('div', { class: 'book-card' },
    renderCover(m, 'cover'),
    h('div', { class: 'info' },
      h('div', { class: 'title' }, m.title || entry.isbn),
      m.authors?.length
        ? h('div', { class: 'authors' }, m.authors.join(', '))
        : null,
      pubBits ? h('div', { class: 'pub muted' }, pubBits) : null,
      h('div', { class: 'isbn-line muted' }, `ISBN ${entry.isbn}`),
    ),
  );
};

const renderScan = () => {
  if (ui.phase === 'lookup') {
    return h('section', { class: 'scan' },
      h('div', { class: 'lookup-box' },
        h('div', { class: 'spinner' }),
        h('div', { class: 'status' }, ui.status),
      ),
    );
  }

  if (ui.phase === 'result' && ui.lastCapture) {
    return h('section', { class: 'scan' },
      ui.lastWasDuplicate
        ? h('div', { class: 'duplicate-banner' }, 'Already in your list')
        : null,
      renderBookCard(ui.lastCapture),
      h('div', { class: 'controls' },
        h('button', { onClick: startScanning }, 'Scan another'),
      ),
    );
  }

  // idle or scanning
  const active = ui.phase === 'scanning';
  return h('section', { class: 'scan' },
    h('div', { class: `viewfinder ${active ? '' : 'idle'}` },
      getVideoEl(),
      active ? h('div', { class: 'reticle' },
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
      active
        ? h('button', { class: 'ghost', onClick: stopScanning }, 'Stop')
        : h('button', { onClick: startScanning }, 'Start camera'),
    ),
  );
};

const renderList = () => {
  const scans = [...store.state.scans].sort((a, b) => b.t - a.t);
  const body = scans.length
    ? scans.map((s) =>
        h('div', { class: 'row clickable', onClick: () => openDetail(s) },
          renderCover(s.meta, 'cover-sm'),
          h('div', { class: 'info' },
            h('span', { class: 'code' }, s.meta?.title || s.isbn),
            s.meta?.authors?.length
              ? h('span', { class: 'time' }, s.meta.authors.join(', '))
              : null,
            h('span', { class: 'time' }, `${s.isbn} · ${fmtTime(s.t)}`),
          ),
          h('button', {
            class: 'x',
            'aria-label': 'Remove',
            onClick: (e) => { e.stopPropagation(); removeScan(s); },
          }, '×'),
        ))
    : [h('div', { class: 'empty' }, 'No scans yet. Switch to the Scan tab to start.')];

  return [
    h('section', { class: 'list' }, body),
    h('div', { class: 'list-actions' },
      h('button', { disabled: !scans.length, onClick: exportJson }, 'Export JSON'),
      h('button', { class: 'danger', disabled: !scans.length, onClick: clearAll }, 'Clear all'),
    ),
  ];
};

const render = () => {
  // Resync the selected entry from the store so the modal reflects the
  // latest data, and auto-close if the entry was deleted elsewhere.
  if (ui.selectedScan) {
    const cur = store.state.scans.find(
      (x) => x.isbn === ui.selectedScan.isbn && x.t === ui.selectedScan.t,
    );
    ui.selectedScan = cur ?? null;
  }
  const children = [renderBar(), renderTabs()];
  if (ui.tab === 'scan') children.push(renderScan());
  else children.push(...renderList());
  if (ui.toast) children.push(h('div', { class: 'toast' }, ui.toast));
  if (ui.selectedScan) children.push(renderModal(ui.selectedScan));
  root.replaceChildren(...children);
  if (ui.phase === 'scanning' && videoEl && videoEl.paused) {
    videoEl.play().catch(() => {});
  }
};

const onKeyDown = (e) => {
  if (e.key === 'Escape' && ui.selectedScan) {
    e.preventDefault();
    closeDetail();
    return;
  }
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
  if (document.hidden && ui.phase === 'scanning') await stopScanning();
});

const start = async () => {
  await store.ready;
  store.subscribe(() => render());
  window.addEventListener('keydown', onKeyDown);
  render();
};

start();
