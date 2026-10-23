# Prior work and reuse

## Initial public baseline

This baseline contains newly written project documentation and Git exclusions,
plus adapted project development rules. It contains no firmware, receiver, UI,
tests, runtime data, or third-party implementation code.

Pre-hackathon prototypes are design references. Useful lessons include preserving
the board's protected Flash regions, keeping BLE callbacks nonblocking, reporting
data loss, and distinguishing activity observations from exact people counts.
These lessons do not establish that the new implementation works.

Local pre-hackathon material is kept under the ignored `local-reference/`
directory. It must never be force-added or published as part of this baseline.

## 2026-10-23 — First web/API implementation

- `src/`, `worker/`, migrations and tests are newly written for this baseline;
  no pre-hackathon application or vendor renderer was copied.
- The browser tile adapter references the official CCNU GIS remote JPG endpoint
  and includes source attribution. No map images or POI datasets are bundled,
  mirrored, committed or uploaded. Public display/redistribution terms still
  require confirmation before wider publication.
- The library focus anchor is a manually recorded fact from the official UI;
  see [GIS research](../research/ccnu-gis.md). It is not a sensor position.
- Runtime dependencies: React and React DOM (MIT), Three.js (MIT), and Lucide
  React (ISC). Exact installed versions are recorded in `package-lock.json`;
  package license notices are retained by npm. The code uses their APIs without
  copying implementation into source files. Cloudflare Workers/D1 are the chosen
  runtime services. No school-map or concept-image license is inferred from those
  dependency licenses.

## Future reuse entries

Before committing reused code, add an entry with:

- Source repository or vendor, exact revision, and source paths.
- Destination paths and the reason for reuse.
- Applicable license, required notices, and modifications made.
- Validation performed for the new implementation and remaining limitations.

Reused board drivers must retain their upstream copyright and license. Record
any permitted reuse transparently; do not relabel prior code as newly written.

## 2026-10-23 — Prior visual concept

- Source: the user's pre-hackathon CampusPulse generated concept, locally saved
  as `local-reference/pre-hackathon/captures/gis-ui-spatial-20261021/selected-reference.png`.
  This material predates the new hackathon implementation; it has no source Git
  revision. The user explicitly authorized borrowing earlier design images.
- Destination: `docs/design/assets/campus-concept.png`; used as visual direction
  in the [hackathon plan](../design/hackathon-plan.md), not a real campus map.
- Reuse scope: image only. No prior application code or runtime data was copied.
  The campus, actors, and wait values in the concept are illustrative.
- Metadata: ExifTool inspected input and final PNG on 2026-10-23. An explicit
  metadata stripping pass found nothing to remove; the final file exposes only
  structural image fields and computed dimensions, without embedded EXIF, GPS,
  XMP, IPTC, comments, author, contact, device, or path fields.
- Final image: 1487 x 1058 pixels; final and source bytes are identical, retaining
  orientation, appearance, and color. SHA-256:
  `4e3fb661c3ec14402e5e6ab463ae3d5f5449573ea1dc274492e6aecf6fbd81df`.
- No blanket license for prior material or third-party map assets is inferred.
  The old GIS raster, sprites, screenshots, and third-party enclosure models
  have not been copied into this public baseline in this change.

## 2026-10-23 — Selected historical Markdown

The user requested carrying earlier observations into the new documentation.
`docs/upstream/pre-hackathon/vehicle-rules.md` retains the prior document body;
`wire-v0.md` retains the old contract with two internal links adapted.
Each wrapper records its source path and SHA-256. `observations.md` summarizes
selected device, storage, network, and GIS evidence with original Markdown hashes.
All three are explicitly historical and have not been rerun against new code.

Only documentation was migrated. Prior application code, captures, MAC lists,
databases, credentials, and deployment configuration remain excluded.
The current upload protocol and JSON examples were newly authored; examples
use synthetic identities/payloads/counters and are not field measurements.
An invited private Radar repository was cloned to ignored local reference storage;
its code, detailed review, and field data have not been copied into public docs.
