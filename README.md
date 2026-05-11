# 1984

Big Brother is watching every ISBN you own. Point your phone's telescreen at a book, the Ministry of Truth files it under its proper subject, and the dossier joins your local archive — exportable, redactable, and never transmitted unbidden.

Lives at **[1984.42.uy](https://1984.42.uy)**.

## How it works

Point the rear camera at a book's ISBN. The app continuously OCRs the framed region with [Tesseract.js](https://github.com/naptha/tesseract.js), looks for an `ISBN` marker plus a 10- or 13-digit code that passes checksum, then halts the telescreen and queries [Open Library](https://openlibrary.org) for title, author, publisher, year, and cover. The dossier is filed in the device's IndexedDB; the lookup result lives only on your phone. The archive view lists every captured subject, opens a confidential dossier modal on tap, and transmits the whole archive as JSON on demand.

The app is an installable PWA. Add it to the home screen and the telescreen works offline; the Ministry of Truth query needs a connection.

## License

[MIT](./LICENSE) — Copyright (c) 2026 Santiago Ferreira.
