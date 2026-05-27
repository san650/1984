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

// ──── conversion + hyphenation ──────────────────────────
//
// ISBN-13 ↔ ISBN-10 conversion only works for 978-prefixed codes;
// the 979 block has no ISBN-10 equivalent.
//
// Hyphenation accuracy depends on the ISBN registration agency's range
// tables. We embed proper rules for the English-language groups
// (978-0, 978-1) which cover the vast majority of books seen by this
// app. Other groups fall back to a simple prefix/group/body/check split,
// which is still readable even if not strictly canonical.

const isbn10Check = (nine) => {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += +nine[i] * (10 - i);
  const r = (11 - (sum % 11)) % 11;
  return r === 10 ? 'X' : String(r);
};

const isbn13Check = (twelve) => {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += +twelve[i] * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
};

export const toIsbn13 = (isbn) => {
  if (!isbn) return null;
  if (isbn.length === 13) return isbn;
  if (isbn.length !== 10) return null;
  const body = '978' + isbn.slice(0, 9);
  return body + isbn13Check(body);
};

export const toIsbn10 = (isbn) => {
  if (!isbn) return null;
  if (isbn.length === 10) return isbn;
  if (isbn.length !== 13 || !isbn.startsWith('978')) return null;
  const body = isbn.slice(3, 12);
  return body + isbn10Check(body);
};

// Registrant length rules for English-language groups.
// Each entry: [min, max, registrantLength] where min/max are the 7-digit
// number formed by the digits after the group identifier, left-aligned.
const REGISTRANT_RULES = {
  '0': [
    [0,       1999999, 2],
    [2000000, 6999999, 3],
    [7000000, 8499999, 4],
    [8500000, 8999999, 5],
    [9000000, 9499999, 6],
    [9500000, 9999999, 7],
  ],
  '1': [
    [0,        999999, 2],
    [1000000, 3999999, 3],
    [4000000, 5499999, 4],
    [5500000, 8649999, 5],
    [8650000, 9989999, 6],
    [9990000, 9999999, 7],
  ],
};

const registrantLen = (group, afterGroup) => {
  const rules = REGISTRANT_RULES[group];
  if (!rules) return null;
  const key = +((afterGroup + '0000000').slice(0, 7));
  for (const [min, max, len] of rules) {
    if (key >= min && key <= max) return len;
  }
  return null;
};

export const formatIsbn = (isbn) => {
  if (!isbn) return isbn;
  if (isbn.length === 13) {
    const prefix = isbn.slice(0, 3);
    const group = isbn[3];
    const rest = isbn.slice(4, 12);
    const check = isbn[12];
    const regLen = registrantLen(group, rest);
    if (regLen == null) return `${prefix}-${group}-${rest}-${check}`;
    return `${prefix}-${group}-${rest.slice(0, regLen)}-${rest.slice(regLen)}-${check}`;
  }
  if (isbn.length === 10) {
    const group = isbn[0];
    const rest = isbn.slice(1, 9);
    const check = isbn[9];
    const regLen = registrantLen(group, rest);
    if (regLen == null) return `${group}-${rest}-${check}`;
    return `${group}-${rest.slice(0, regLen)}-${rest.slice(regLen)}-${check}`;
  }
  return isbn;
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
