// Camera + Tesseract.js orchestration.
//
// One OCR pass at a time. Each pass:
//   1. Grab a frame from the <video>.
//   2. Crop to the reticle band (where the user has aimed the ISBN).
//   3. Run Tesseract with a digit/X whitelist and single-line PSM.
//   4. Pipe text through extractIsbn(). Emit on match.
//
// We assume the global `Tesseract` is loaded via UMD by index.html.

import { extractIsbn } from './isbn.js';

const VENDOR = './vendor/tesseract';

const CROP = {
  // Match the .reticle band in styles.css (centered horizontally,
  // 22% tall at mid-height, 8% side margins).
  xPct: 0.08, yPct: 0.39, wPct: 0.84, hPct: 0.22,
};

const SCAN_INTERVAL_MS = 800;

export class IsbnScanner {
  constructor({ video, onStatus, onResult }) {
    this.video = video;
    this.onStatus = onStatus ?? (() => {});
    this.onResult = onResult ?? (() => {});
    this.stream = null;
    this.worker = null;
    this.running = false;
    this.busy = false;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.timer = null;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.onStatus('Requesting camera…');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (err) {
      this.running = false;
      this.onStatus(`Camera blocked: ${err.message || err.name}`);
      throw err;
    }
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', 'true');
    this.video.muted = true;
    await this.video.play().catch(() => {});

    this.onStatus('Loading OCR engine…');
    await this.#ensureWorker();

    this.onStatus('Point at the ISBN');
    this.timer = setInterval(() => this.#tick(), SCAN_INTERVAL_MS);
  }

  // stop() releases the camera but keeps the Tesseract worker alive
  // so the next start() is instant. Use destroy() to fully tear down.
  async stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
  }

  async destroy() {
    await this.stop();
    if (this.worker) {
      try { await this.worker.terminate(); } catch {}
      this.worker = null;
    }
  }

  async #ensureWorker() {
    if (this.worker) return;
    // Tesseract.js v5 UMD: createWorker(lang, oem, options)
    this.worker = await Tesseract.createWorker('eng', 1, {
      workerPath: `${VENDOR}/worker.min.js`,
      corePath: `${VENDOR}`,
      langPath: VENDOR,
      gzip: true,
    });
    await this.worker.setParameters({
      // Allow the letters "ISBN" + check digit X so Tesseract can read
      // the "ISBN" prefix the user is aiming at. Lowercase + look-alike
      // letters (l, O, etc.) are intentionally excluded so the engine
      // prefers digits where the glyph is ambiguous.
      tessedit_char_whitelist: 'ISBNX0123456789-: .',
      tessedit_pageseg_mode: '6', // uniform block of text — handles multi-line
    });
  }

  // The <video> uses object-fit: cover, so the reticle (positioned in
  // CSS container space) maps to a different rectangle in the source
  // frame. We compute that mapping every tick so the OCR sees exactly
  // what the user has framed inside the box.
  #grabCrop() {
    const v = this.video;
    if (!v || !v.videoWidth || !v.videoHeight) return null;
    const W = v.videoWidth, H = v.videoHeight;
    const rect = v.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    if (!w || !h) return null;

    const scale = Math.max(w / W, h / H);
    const visW = w / scale;
    const visH = h / scale;
    const offX = (W - visW) / 2;
    const offY = (H - visH) / 2;

    const sx = offX + (CROP.xPct * w) / scale;
    const sy = offY + (CROP.yPct * h) / scale;
    const sw = (CROP.wPct * w) / scale;
    const sh = (CROP.hPct * h) / scale;

    this.canvas.width = Math.round(sw);
    this.canvas.height = Math.round(sh);
    this.ctx.drawImage(v, sx, sy, sw, sh, 0, 0, this.canvas.width, this.canvas.height);
    return this.canvas;
  }

  async #tick() {
    if (!this.running || this.busy || !this.worker) return;
    const img = this.#grabCrop();
    if (!img) return;
    this.busy = true;
    try {
      const { data } = await this.worker.recognize(img);
      if (!this.running) return;
      const isbn = extractIsbn(data.text || '');
      if (isbn) {
        this.onStatus(`Found ${isbn}`);
        this.onResult(isbn);
      } else if (data.text?.trim()) {
        this.onStatus(`Reading: ${data.text.trim().slice(0, 32)}…`);
      } else {
        this.onStatus('Point at the ISBN');
      }
    } catch (err) {
      console.error('OCR error', err);
    } finally {
      this.busy = false;
    }
  }
}
