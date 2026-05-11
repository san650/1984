// ISBN extraction and validation.
//
// Strategy: a book page usually prints "ISBN" right before the code.
//   1. Find every "ISBN" marker in the OCR text.
//   2. For each, take a short window of the chars that follow it
//      (possibly across newlines) and try to extract a valid
//      ISBN-13 or ISBN-10 from there.
//   3. If no "ISBN" marker exists anywhere (e.g. the camera is framed
//      on the bare barcode digits), fall back to scanning the whole
//      text — but only for ISBN-13, because a 13-digit slice starting
//      with 978/979 has tight checksum constraints, whereas random
//      10-digit slices collide too easily.
//   4. If markers DO exist but none of their windows produced a valid
//      ISBN, return null. Better to retry than to guess.
//
// OCR text is noisy: letters that look like digits (O↔0, I/l↔1, S↔5,
// B↔8) are mapped to digits before checksum validation.

const CONFUSIONS = {
  O: '0', o: '0', Q: '0', D: '0',
  I: '1', l: '1', i: '1', '|': '1',
  Z: '2', z: '2',
  S: '5', s: '5',
  G: '6',
  T: '7',
  B: '8',
  g: '9', q: '9',
};

const normalize = (raw) => {
  let out = '';
  for (const ch of raw) out += CONFUSIONS[ch] ?? ch;
  return out;
};

const PREFIX_RE = /ISBN/gi;
const WINDOW_CHARS = 40;

const isValidIsbn13 = (digits) => {
  if (!/^\d{13}$/.test(digits)) return false;
  if (!digits.startsWith('978') && !digits.startsWith('979')) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    const d = +digits[i];
    sum += i % 2 === 0 ? d : d * 3;
  }
  return sum % 10 === 0;
};

const isValidIsbn10 = (code) => {
  if (!/^[0-9]{9}[0-9X]$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = code[i];
    const v = ch === 'X' ? 10 : +ch;
    sum += v * (10 - i);
  }
  return sum % 11 === 0;
};

const scanForValidIsbn = (raw, { allowTen = true } = {}) => {
  const text = normalize(raw);

  const digits = text.replace(/[^0-9]/g, '');
  for (let i = 0; i + 13 <= digits.length; i++) {
    const s = digits.slice(i, i + 13);
    if (isValidIsbn13(s)) return s;
  }

  if (!allowTen) return null;

  const tenStr = text.toUpperCase().replace(/[^0-9X]/g, '');
  for (let i = 0; i + 10 <= tenStr.length; i++) {
    const s = tenStr.slice(i, i + 10);
    if (isValidIsbn10(s)) return s;
  }
  return null;
};

export const extractIsbn = (raw) => {
  if (!raw) return null;

  const markers = [...raw.matchAll(PREFIX_RE)];
  if (markers.length > 0) {
    for (const m of markers) {
      const start = m.index + m[0].length;
      const window = raw.slice(start, start + WINDOW_CHARS);
      const isbn = scanForValidIsbn(window);
      if (isbn) return isbn;
    }
    return null;
  }

  return scanForValidIsbn(raw, { allowTen: false });
};
