# README screenshots

The bilingual README uses screenshots of the actual local CampusPulse frontend,
not generated mockups. Capture script: [`scripts/capture-readme.mjs`](../../scripts/capture-readme.mjs).

| Image | View | Data shown |
| --- | --- | --- |
| [Simulation overview](../images/simulation-desktop.png) | 1440 × 1000 desktop, evening simulation | Built-in synthetic activity, parking, waits and illustrative lighting |
| [Live timeline](../images/live-timeline-desktop.png) | 1440 × 1000 desktop, live edge | Browser-local synthetic public-API fixtures; place visibly named `图书馆（样例）` |
| [Mobile review](../images/replay-mobile.png) | 390 × 844 phone, fixed historical cursor | The same synthetic fixtures, paused at a covered window and scrolled to the observation card |

The field fixtures are fixed at 2026-10-25 14:00 Asia/Shanghai and contain an
intentional gap. `sample-node` and `sample-session` are invented identifiers.
There are no device credentials, raw BLE identities, personal captures or API
writes. These images explain the interface; they establish neither physical
collection nor campus coverage, hardware acceptance or deployment of this build.

## Capture again

Use Node.js 24 and the repository's locked dependencies. Install Chromium if it
is not already available, then run a local frontend:

```sh
npm ci
npx playwright install chromium
npm run dev -- --port 5186
```

In a second terminal:

```sh
node scripts/capture-readme.mjs
```

`README_URL` can select another loopback origin; remote app targets are rejected.
The script uses the installed Playwright Chromium; set `PLAYWRIGHT_BROWSERS_PATH`
only when your environment keeps browsers in a custom directory.
`README_ORIGINALS` can change the temporary originals directory, which defaults
to `/tmp/campuspulse-readme-originals`. The final copies go to `docs/images/`.
`README_VIEWS=mobile` captures only the phone view; `simulation` and `live` can
also be selected, or combined with commas. Night material preparation may take
a few minutes on a CPU renderer. The script waits for fonts, actual GIS images
and night materials, and checks
runtime errors, read-only API use and phone width before completing.

All `/api/v1/` reads are intercepted locally. GIS images are loaded from the
official HTTPS source, so network access is needed for screenshots. The script
uses an inherited HTTPS proxy and, when configured, pins its CA's public key for
Chromium; it does not globally disable TLS checks. It does not save tile files
or mirror the GIS dataset.

## Image provenance and metadata

Desktop screenshots retain the application's visible GIS attribution; this
note credits the same source for the phone view. The map pixels come
from [CCNU's official GIS](https://gis.ccnu.edu.cn/); screenshot inclusion does
not grant a new license to that underlying artwork. Original app assets and
external-source boundaries remain in the [reuse record](reuse.md) and
[GIS research](../research/ccnu-gis.md).

Original captures are preserved outside the repository. The capture script
parses PNG chunks, preserves pixel/color structure, removes other ancillary
chunks and re-reads the actual final copy. Its output reports final dimensions,
chunk types and SHA-256 hashes without printing private metadata. Final images
must be visually checked after capture for text readability, layout, colors,
map loading and visible sample/source labels before publication.

## Final image verification · 2026-10-25

All three final PNGs were re-read with the chunk parser and ImageMagick; only
`IHDR`, `IDAT` and `IEND` remain. There is no embedded EXIF/GPS, XMP, IPTC,
MakerNotes, thumbnail, comment, capture-time, author/contact, device or path
metadata. Visible dates belong to the fixed synthetic scenario, not a claim of
real capture time. Orientation, colors, complete map loading, readable source
labels and the desktop/mobile layouts were visually checked after processing.
The capture runs finished with zero API writes and zero page script errors.

## Administrator workspace screenshots · 2026-10-25

The additional bilingual README images use the actual local administrator UI:

| Image | View | Data shown |
| --- | --- | --- |
| [Administrator overview](../images/admin-overview.png) | 1440 × 1000 desktop | Two invented Passport registry entries and sample contact/configuration states |
| [Device diagnostics](../images/admin-device-diagnostics.png) | 1440 × 1000 desktop, scrolled to diagnostics | Synthetic contact/status evidence, memory and storage; further queue/counter panels continue below |

Reproduce with the local frontend above and
`node scripts/capture-readme-admin.mjs`. The script accepts `README_URL` and
`README_ORIGINALS`, and optionally `CHROMIUM_PATH`. It intercepts all API reads
inside an isolated browser, supplies a sample session without any real login or
credential, rejects API writes and external requests, and checks for script
errors and missing fixture routes. It does not use the production backend.
Device names and the administrator are visibly labelled “样例”. Values derive
from the repository's synthetic v2 status example and are not hardware results.

The screenshots show the working-copy UI, not deployment acceptance. The capture
script preserves originals outside the repository, strips nonessential PNG
chunks, re-reads the final files and reports dimensions, chunk types and hashes.
Visual checks and final metadata results are recorded after capture below.

Both final PNGs were visually checked for readable labels, correct colors and
complete painted viewports, and decoded with ImageMagick. Their only chunks are
`IHDR`, `IDAT` and `IEND`: no embedded EXIF/GPS, XMP, IPTC, MakerNotes, thumbnail,
comment, author/contact, capture-time, device or path metadata remains. The
visible clock is fixed sample data. The final run had zero page errors, API
writes or unmatched API routes. SHA-256 of the reviewed final copies:

- `admin-overview.png`: `047d0e0a38e967da7eace8e1c8fe7f819c726e39c47dc54add65560046379fee`
- `admin-device-diagnostics.png`: `3e13c92bddbd4d0fcfb475469dc66601dbc320a2ad1f8f879ad7875e9d112f7e`
