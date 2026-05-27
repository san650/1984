import { store } from './store.js';
import { makeCommand } from './commands.js';
import { IsbnScanner } from './ocr.js';
import { lookupIsbn } from './openlibrary.js';
import { toIsbn13, toIsbn10, formatIsbn } from './isbn.js';

const root = document.getElementById('view');

// The <video> element is kept as a singleton so it survives full re-renders
// (saving a scan, toast appearing). Replacing it would detach the MediaStream
// and the live preview would go dark.
let videoEl = null;
const getVideoEl = () => {
  if (!videoEl) {
    videoEl = document.createElement('video');
    videoEl.id = 'cam';
    // iOS Safari refuses inline autoplay of MediaStream sources unless
    // muted / autoplay / playsinline are present as HTML attributes
    // (not just JS properties). The legacy webkit-playsinline keeps
    // older iOS happy. Setting both the attribute and the property is
    // belt-and-suspenders for the various WebKit versions in the wild.
    videoEl.setAttribute('muted', '');
    videoEl.setAttribute('autoplay', '');
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('webkit-playsinline', '');
    videoEl.muted = true;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.controls = false;
    videoEl.disablePictureInPicture = true;
  }
  return videoEl;
};

const ui = {
  tab: 'scan',
  phase: 'idle', // idle | scanning | lookup | result
  scanner: null,
  status: 'TELESCREEN STANDBY',
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

const fmtDossierRef = (n) => String(n).padStart(4, '0');

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

// SVG builder for the all-seeing-eye brand mark.
const svgEye = () => {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'eye');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  const mk = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  svg.appendChild(mk('path', {
    d: 'M 6 50 Q 50 6, 94 50 Q 50 94, 6 50 Z',
    fill: 'none', stroke: 'currentColor', 'stroke-width': '5', 'stroke-linejoin': 'round',
  }));
  svg.appendChild(mk('circle', { cx: '50', cy: '50', r: '18', fill: 'currentColor' }));
  svg.appendChild(mk('circle', { cx: '50', cy: '50', r: '8', fill: 'var(--bg)' }));
  svg.appendChild(mk('circle', { cx: '50', cy: '50', r: '2.5', fill: 'var(--alert)' }));
  return svg;
};

const showToast = (msg) => {
  ui.toast = msg;
  render();
  setTimeout(() => {
    if (ui.toast === msg) { ui.toast = null; render(); }
  }, 2000);
};

const vibrate = (pattern) => {
  if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch {} }
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

  const existing = store.state.scans.find((s) => s.isbn === isbn);
  if (existing) {
    if (ui.scanner) await ui.scanner.stop();
    ui.lastCapture = existing;
    ui.lastWasDuplicate = true;
    ui.phase = 'result';
    showToast(`ON RECORD: ${existing.meta?.title || isbn}`);
    render();
    return;
  }

  ui.lastWasDuplicate = false;
  ui.phase = 'lookup';
  ui.status = `CROSS-REFERENCING ${isbn}...`;
  if (ui.scanner) await ui.scanner.stop();
  render();

  const meta = await lookupIsbn(isbn);
  const entry = meta ? { isbn, t: now, meta } : { isbn, t: now };

  store.dispatch(makeCommand('ADD_SCAN', { from: null, to: entry }));
  ui.lastCapture = entry;
  ui.phase = 'result';
  showToast(meta ? `FILED: ${entry.meta.title || isbn}` : `FILED: ${isbn}`);
  render();
};

const startScanning = async () => {
  if (ui.phase === 'scanning' || ui.phase === 'lookup') return;
  ui.phase = 'scanning';
  ui.status = 'INITIATING TELESCREEN...';
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
  ui.status = 'TELESCREEN OFFLINE';
  render();
};

const updateStatus = () => {
  const el = root.querySelector('.status');
  if (!el) return;
  el.textContent = ui.status;
  el.classList.toggle('flash', ui.status.startsWith('ACQUIRED'));
};

const removeScan = (entry) => {
  const index = store.state.scans.findIndex(
    (x) => x.isbn === entry.isbn && x.t === entry.t,
  );
  if (index < 0) return;
  const label = entry.meta?.title || entry.isbn;
  if (!confirm(`REDACT "${label}" FROM RECORDS?`)) return;
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
  const a = h('a', { href: url, download: `1984-dossier-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const clearAll = () => {
  if (!store.state.scans.length) return;
  if (!confirm(`PURGE ALL ${store.state.scans.length} RECORDS FROM ARCHIVE?`)) return;
  store.reset();
  ui.lastCapture = null;
  ui.phase = 'idle';
  ui.status = 'TELESCREEN STANDBY';
  render();
};

const switchTab = async (next) => {
  if (next === ui.tab) return;
  if (ui.tab === 'scan' && ui.phase === 'scanning') await stopScanning();
  ui.tab = next;
  render();
};

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

const openDetail = (entry) => { ui.selectedScan = entry; render(); };
const closeDetail = () => { ui.selectedScan = null; render(); };

const deleteFromDetail = (entry) => {
  const label = entry.meta?.title || entry.isbn;
  if (!confirm(`REDACT "${label}" FROM RECORDS?`)) return;
  const index = store.state.scans.findIndex(
    (x) => x.isbn === entry.isbn && x.t === entry.t,
  );
  if (index >= 0) {
    store.dispatch(makeCommand('REMOVE_SCAN', { from: { ...entry, index }, to: null }));
  }
  closeDetail();
};

const renderModal = (entry) => {
  const m = entry.meta;
  const olUrl = m?.openLibraryKey ? `https://openlibrary.org${m.openLibraryKey}` : null;
  const isbn13 = toIsbn13(entry.isbn);
  const isbn10 = toIsbn10(entry.isbn);
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
      h('div', { class: 'title-lg' }, m?.title || 'Untitled Subject'),
      m?.authors?.length
        ? h('div', { class: 'authors-lg' }, m.authors.join(', '))
        : null,
      !m ? h('div', { class: 'no-record-stamp' }, 'No Ministry Record') : null,
      h('dl', { class: 'meta-list' },
        m?.publisher ? h('dt', {}, 'Publisher') : null,
        m?.publisher ? h('dd', {}, m.publisher) : null,
        m?.year ? h('dt', {}, 'First Published') : null,
        m?.year ? h('dd', {}, String(m.year)) : null,
        isbn13 ? h('dt', {}, 'ISBN-13') : null,
        isbn13 ? h('dd', { class: 'mono' }, formatIsbn(isbn13)) : null,
        isbn10 ? h('dt', {}, 'ISBN-10') : null,
        isbn10 ? h('dd', { class: 'mono' }, formatIsbn(isbn10)) : null,
        h('dt', {}, 'Intercepted'),
        h('dd', {}, fmtTime(entry.t)),
        olUrl ? h('dt', {}, 'Cross-Reference') : null,
        olUrl ? h('dd', {},
          h('a', { href: olUrl, target: '_blank', rel: 'noreferrer noopener' },
            m.openLibraryKey),
        ) : null,
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'ghost', onClick: closeDetail }, 'Dismiss'),
        h('button', { class: 'danger', onClick: () => deleteFromDetail(entry) }, 'Redact'),
      ),
    ),
  );
};

// ──── rendering ──────────────────────────────────────────

const renderBar = () =>
  h('div', { class: 'bar' },
    h('div', { class: 'brand' },
      svgEye(),
      h('h1', {}, '1984'),
      h('span', { class: 'cursor', 'aria-hidden': 'true' }),
    ),
    h('span', {}),
    h('div', { class: 'records' },
      h('strong', {}, fmtDossierRef(store.state.scans.length)),
      'On File',
    ),
  );

const renderSubtitle = () =>
  h('div', { class: 'subtitle' }, 'Big Brother Is Watching');

const renderTabs = () =>
  h('div', { class: 'tabs', role: 'tablist' },
    h('button', {
      class: ui.tab === 'scan' ? 'active' : '',
      onClick: () => switchTab('scan'),
    }, 'Telescreen'),
    h('button', {
      class: ui.tab === 'list' ? 'active' : '',
      onClick: () => switchTab('list'),
    }, 'Archive'),
  );

const renderBookCard = (entry, { stamp } = {}) => {
  const m = entry.meta;
  if (!m) {
    return h('div', { class: 'book-card no-meta' },
      stamp ? h('div', { class: 'filed-stamp' }, stamp) : null,
      h('div', { class: 'info' },
        h('div', { class: 'title' }, formatIsbn(entry.isbn)),
        h('div', { class: 'authors' }, 'No Ministry record on file.'),
      ),
    );
  }
  const pubBits = [m.publisher, m.year].filter(Boolean).join(' · ');
  return h('div', { class: 'book-card' },
    stamp ? h('div', { class: 'filed-stamp' }, stamp) : null,
    renderCover(m, 'cover'),
    h('div', { class: 'info' },
      h('div', { class: 'title' }, m.title || entry.isbn),
      m.authors?.length ? h('div', { class: 'authors' }, m.authors.join(', ')) : null,
      pubBits ? h('div', { class: 'pub' }, pubBits) : null,
      h('div', { class: 'isbn-line' }, `REF · ${formatIsbn(entry.isbn)}`),
    ),
  );
};

const renderScan = () => {
  if (ui.phase === 'lookup') {
    return h('section', { class: 'scan' },
      h('div', { class: 'lookup-box' },
        h('div', { class: 'ministry' }, 'Ministry of Truth · Archive Query'),
        h('div', { class: 'spinner' }),
        h('div', { class: 'status' }, ui.status),
      ),
    );
  }

  if (ui.phase === 'result' && ui.lastCapture) {
    return h('section', { class: 'scan' },
      ui.lastWasDuplicate
        ? h('div', { class: 'duplicate-banner' }, 'Subject Already On Record')
        : null,
      renderBookCard(ui.lastCapture, {
        stamp: ui.lastWasDuplicate ? 'On Record' : 'Filed',
      }),
      h('div', { class: 'controls' },
        h('button', { onClick: startScanning }, 'Next Subject'),
      ),
    );
  }

  const active = ui.phase === 'scanning';
  return h('section', { class: 'scan' },
    h('div', { class: `viewfinder ${active ? '' : 'idle'}` },
      active ? getVideoEl() : null,
      active ? h('div', { class: 'rec' }, 'REC') : null,
      active ? h('div', { class: 'reticle' },
        h('span', { class: 'hint' }, 'Focus Target'),
        h('span', { class: 'corner tl' }),
        h('span', { class: 'corner tr' }),
        h('span', { class: 'corner bl' }),
        h('span', { class: 'corner br' }),
      ) : null,
      !active ? h('div', { class: 'idle-mark' },
        h('span', {}, 'Telescreen Idle'),
        h('span', {}, 'Awaiting Orders'),
      ) : null,
    ),
    h('div', {
      class: `status ${ui.status.startsWith('ACQUIRED') ? 'flash' : ''}`,
    }, ui.status),
    h('div', { class: 'controls' },
      active
        ? h('button', { class: 'ghost', onClick: stopScanning }, 'Cease')
        : h('button', { onClick: startScanning }, 'Engage Telescreen'),
    ),
  );
};

const renderList = () => {
  const scans = [...store.state.scans].sort((a, b) => b.t - a.t);
  const body = scans.length
    ? scans.map((s, idx) =>
        h('div', { class: 'row clickable', onClick: () => openDetail(s) },
          h('span', { class: 'ref' }, `№ ${fmtDossierRef(scans.length - idx)}`),
          renderCover(s.meta, 'cover-sm'),
          h('div', { class: 'info' },
            h('span', { class: 'code' }, s.meta?.title || formatIsbn(s.isbn)),
            s.meta?.authors?.length
              ? h('span', { class: 'time' }, s.meta.authors.join(', '))
              : null,
            h('span', { class: 'time' }, `${formatIsbn(s.isbn)} · Intercepted ${fmtTime(s.t)}`),
          ),
          h('button', {
            class: 'x',
            'aria-label': 'Remove',
            onClick: (e) => { e.stopPropagation(); removeScan(s); },
          }, '×'),
        ))
    : [h('div', { class: 'empty' },
        'Archive Empty',
        h('span', { class: 'sub' }, 'Awaiting first subject'),
      )];

  return [
    h('section', { class: 'list' }, body),
    h('div', { class: 'list-actions' },
      h('button', { disabled: !scans.length, onClick: exportJson }, 'Transmit Dossier'),
      h('button', { class: 'danger', disabled: !scans.length, onClick: clearAll }, 'Purge Archive'),
    ),
  ];
};

const render = () => {
  if (ui.selectedScan) {
    const cur = store.state.scans.find(
      (x) => x.isbn === ui.selectedScan.isbn && x.t === ui.selectedScan.t,
    );
    ui.selectedScan = cur ?? null;
  }
  const children = [renderBar(), renderSubtitle(), renderTabs()];
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
