# AI Passport firmware baseline

Date: 2026-10-24. Status: **historical source-import baseline**, recorded on
`codex/passport-firmware`. Validation below applies to that imported snapshot.
Current local provisioning/control/collection/upload code and its separate
acceptance are documented in [firmware chain](firmware-chain.md); neither record
is a deployed collector or hardware acceptance claim.

The pre-refactor source snapshot is now local commit `82549b0`. Subsequent
[runtime work](firmware-runtime.md) has separate verification and does not
inherit the baseline build's acceptance automatically.

## Source and scope

The user selected the privately shared `xiaoYan-bit/ai-passport-radar` application
as the starting point, rather than the neighboring Echo application or the old
CampusPulse binary-protocol collector. Upstream HEAD was checked directly and
matches revision `5fb8ab532414eb0029fc5ea131a03cb0993db180`. The original reference
checkout remains unchanged.

The import includes the compiled radar source closure, its BSP, ESP-IDF defaults,
dependency lock and MIT license. `firmware/ai-passport-radar/UPSTREAM.json` records
per-file source and destination hashes. Source agent rules, workflows, skills,
local credentials, captures, images, binaries, build caches and development diary
are excluded. Observed identifiers and field-session examples in source comments
are removed rather than treated as public fixtures.

At this historical import, independent redistribution rights for the upstream
Microsoft-derived raster fonts were unverified. The 2026-10-25 publication task
replaced the current arrays completely with licensed OFL-1.1 derivatives; see
[font provenance](../../firmware/fonts/README.md). The old import/stage-A glyph
snapshots remain historical local records and must not be published. A source
MIT notice never established licensing for the old Microsoft-derived arrays.

## Local adaptations

- Preserve the AI Passport's 3 MiB application at `0x10000` and protected
  `cardid` at `0x356000` / `0x4000`; do not use upstream's full-Flash app layout.
- Build without personal Wi-Fi configuration and omit identifying diagnostics.
- Disable default raw calibration logging and automatic stored-observation
  export/persistence. Keep unused audio uninitialized.
- Correct Bluetooth Appearance byte order with a synthetic wire-order fixture.
- Keep validation independent of upstream scripts that use bare Python or
  deliver merged full-Flash images. All Python operations use uv.

The exact adaptation list is recorded with source fingerprints after import.
Retained scanner/classifier behavior is inherited and requires its own review;
passing compilation does not establish radio coverage or classification accuracy.
If a local Wi-Fi header is deliberately supplied, the inherited configured path
uses ESP-IDF's default Wi-Fi Flash storage. Its credentials may therefore be
stored in NVS. The import-snapshot unconfigured build did not initialize Wi-Fi. The later
platform uses explicit RAM driver storage and validated application NVS settings;
see the current chain note rather than applying this legacy behavior to it.

## Integration directions recorded at import

The list below is preserved from the import review. Items 1–5 now have local
software implementations described in [firmware chain](firmware-chain.md); their
current verification must be assessed separately from this baseline build.

The [firmware platform design](../design/firmware-platform.md) now specifies
shared/board boundaries, administrator-panel Web Bluetooth setup, separate
registration/network/policy states and durable local-marker flows. These remain
planned changes; this baseline's runtime is unchanged by that design review.

1. Derive each node ID from its factory eFuse base MAC; retain separate device
   authentication and a readable management name.
2. Fetch the assigned capture configuration before collection, report activation,
   and define cached-policy expiry/offline behavior. Split windows on policy or
   placement changes; retain old provenance on queued batches.
3. Make per-address time summaries with MAC/address type the primary detailed
   data. Define time bins independently from upload batching. Aggregate before
   raw sampling, with bounded tables and visible overflow/loss.
4. Keep overall windows and health state; reduce full AD payload to an explicitly
   bounded evidence sample. Measure local bytes, ACK throughput and Flash usage
   rather than assuming a bandwidth saving.
5. Extend the server contract for address summaries, then implement frozen
   batches, per-stream durable ACK validation, retry and safe reclamation.
6. Validate one Passport on hardware, including reset and network interruption,
   before adapting the core to other board families.

At the import snapshot these were agreed directions, not upload capabilities.
MAC/address-type continuity does not establish permanent physical identity or an
actual person's elevator wait.

## Import-snapshot validation

- Source copy/provenance: 57 runtime/build files fingerprinted (33 unchanged,
  23 adapted and one authored); source checkout remains clean. README/manifest
  and validation helpers are separately authored. Source-comment examples were
  sanitized; no local credentials, image assets or observation files imported.
- Host checks: PASS. Actual imported AD parser, phone/vehicle heuristics and
  button wake guard compile and run with AddressSanitizer/UndefinedBehaviorSanitizer.
  Nine synthetic image checks cover protected layout, subtype, image boundaries,
  chip/Flash headers and unintended flash files.
- ESP-IDF build: PASS with ESP-IDF 5.5.3, target ESP32-C3, fresh sdkconfig and build
  directory. App: 583,680 bytes (`0x8e800`), below the `0x300000` partition limit.
  Separate bootloader (21,024 bytes), partition table (3,072 bytes) and app images
  pass `verify_images.py`. No merged image is produced.
- App SHA-256: `79d57b7fd9ee3e2d01b04b340e93235e806c2abf728ed7c3b2f8f3fb2d6bb924`.
- Local build evidence: `/tmp/campuspulse-passport-build.log`; the build's
  `verified-images.json` records all three offsets, sizes and SHA-256 hashes.
  The first sandboxed configure attempt failed because process inspection was
  restricted; the permitted host build completed successfully.
- Device tests: not run; no flashing, device erasure or configuration change.
- Cloud API integration/deployment: not run; not implemented by this import.
