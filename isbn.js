// ISBN extraction and validation.
// OCR text is noisy: common confusions (O↔0, I/l↔1, S↔5, B↔8, Z↔2) and
// stray whitespace/hyphens. We normalize, then scan for digit runs that
// pass the ISBN-13 or ISBN-10 checksum.

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

// Find the first valid ISBN-13 or ISBN-10 in OCR text.
// Tries ISBN-13 first (more specific, more common on modern books).
export const extractIsbn = (raw) => {
  if (!raw) return null;
  const text = normalize(raw);

  // ISBN-13: 13 consecutive digits (after stripping non-digits between them
  // within a window). Easiest: collapse non-alphanumeric to spaces and scan.
  const digitsOnly = text.replace(/[^0-9]/g, '');
  for (let i = 0; i + 13 <= digitsOnly.length; i++) {
    const slice = digitsOnly.slice(i, i + 13);
    if (isValidIsbn13(slice)) return slice;
  }

  // ISBN-10: 10 chars, last may be X. Scan windows of length 10 in a string
  // that keeps digits + uppercase X.
  const ten = text.toUpperCase().replace(/[^0-9X]/g, '');
  for (let i = 0; i + 10 <= ten.length; i++) {
    const slice = ten.slice(i, i + 10);
    // Avoid matching slices that are actually inside a longer digit run that
    // already produced a valid ISBN-13 (rare in practice; accept either).
    if (isValidIsbn10(slice)) return slice;
  }

  return null;
};
