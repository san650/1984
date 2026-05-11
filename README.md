# ISBNGrab

Capture ISBN-10 and ISBN-13 codes from book covers using your phone's camera, store them on-device, and export the list as JSON.

Lives at **[isbn.42.uy](https://isbn.42.uy)**.

## How it works

Point the rear camera at a book's ISBN. The app continuously OCRs the framed region with [Tesseract.js](https://github.com/naptha/tesseract.js), parses out digit sequences, and validates them against the ISBN-10 and ISBN-13 checksum rules. Anything that passes the checksum is saved with a timestamp. Scans live in the device's IndexedDB and never leave the phone unless you export them. The list view shows every saved scan and lets you export the full set as a JSON file.

The app is an installable PWA: add it to the home screen and it works offline.

## License

[MIT](./LICENSE) — Copyright (c) 2026 Santiago Ferreira.
