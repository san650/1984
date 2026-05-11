// Look up a book by ISBN against the Open Library search API.
// Returns a normalized metadata object, or null if nothing was found
// or the network call failed. The caller stores ISBN + meta on success
// and ISBN-only on null.

const SEARCH_URL = 'https://openlibrary.org/search.json';
const COVER_BASE = 'https://covers.openlibrary.org/b/id';
const COVER_SIZE = 'M'; // S | M | L
const TIMEOUT_MS = 10000;

const firstOf = (v) => (Array.isArray(v) ? v[0] : v) ?? null;

export const lookupIsbn = async (isbn) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = `${SEARCH_URL}?isbn=${encodeURIComponent(isbn)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    // search.json returns work-level data and does not enumerate ISBNs
    // in the doc, so don't try to verify by ISBN. Trust numFound + first
    // doc — invalid-checksum ISBNs are filtered upstream in isbn.js.
    if (!data?.numFound) return null;
    const doc = data.docs?.[0];
    if (!doc) return null;
    const coverId = doc.cover_i ?? null;
    return {
      title: doc.title ?? null,
      authors: Array.isArray(doc.author_name) ? doc.author_name : [],
      publisher: firstOf(doc.publisher),
      year: doc.first_publish_year ?? null,
      coverId,
      coverUrl: coverId ? `${COVER_BASE}/${coverId}-${COVER_SIZE}.jpg` : null,
      openLibraryKey: doc.key ?? null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
