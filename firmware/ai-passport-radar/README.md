# AI Passport firmware entry and Radar provenance

Local source import of `xiaoYan-bit/ai-passport-radar`, revision
`5fb8ab532414eb0029fc5ea131a03cb0993db180`, verified against upstream HEAD on
2026-10-24. The original repository is private; on 2026-10-25 the user authorized
publication of the selected current CampusPulse firmware, excluding upstream
private history, observations and credentials. Source fingerprints and local changes are in `UPSTREAM.json`.

The import is committed locally as `82549b0`. The historical
[stage A refactor](../../docs/notes/firmware-runtime.md), local commit `8018d17`,
introduced shared components. The [current local chain](../../docs/notes/firmware-chain.md)
now includes setup, policy, collection and durable upload. Enable `--diagnostic`
with the build helper to run the inherited scanner. Import fingerprints describe that initial snapshot,
not the later modifications.

The imported application provides active BLE scanning, an address table,
heuristic classifications, a radar display, buttons and optional Wi-Fi time
synchronization. Its labels and heuristics are inherited behavior, not validated
people counts, vehicle counts, elevator waits or CampusPulse field measurements.

## Integration boundary

The imported snapshot did not implement the current CampusPulse protocol. The
local application now launches shared components implementing protected BLE/AP
setup, network/strict-TLS control, current-boot v2 activation, canonical
MAC/address-type summaries and frozen Flash batches reclaimed only after exact
durable ACKs. Normal collection is policy-gated; the inherited heuristic table
is confined to diagnostics. Local native, browser-mock, workerd and build evidence
are recorded separately in the [chain note](../../docs/notes/firmware-chain.md).
Final local acceptance passed on 2026-10-25, including four fresh C3 image
variants from one frozen firmware source manifest. No physical radio, Flash,
phone setup or production acceptance is implied. Normal headless needs existing
validated enrollment or physical USB setup through the administrator wizard.
As of2026-10-29, setup is [USB only](../../docs/notes/usb-only-provisioning.md)
for display and headless builds; Bluetooth and device-hotspot setup are retired.

Wi-Fi credentials are not included. Runtime credentials are provisioned locally and saved only after network/cloud
validation. Any optional legacy local diagnostic configuration must remain
ignored; it is not the normal network owner.
Raw calibration logging and automatic historical observation export/persistence
are disabled by default. No device was flashed by this import.

## Protected device layout

The app is limited to `0x10000` / `0x300000`; `cardid` remains at `0x356000` /
`0x4000`. The upstream full-Flash application layout is replaced. The local
queue declaration is `cpqueue`, subtype `0x40`, at `0x360000` / `0x400000`; the
journal quarantines unknown existing bytes instead of automatically erasing them. Deliver the
bootloader, partition table and application separately; writing the partition
table itself still requires comparison with the actual device layout. No
whole-chip erase or padded merged-image flashing is permitted.

## Source and font licenses

The imported application declares MIT; its FoloToy copyright and license are
retained in `LICENSE`. On 2026-10-25 the inherited Microsoft-derived bitmap
arrays were replaced completely with CampusPulse Raster Text / Digits, generated
from official Noto Sans CJK SC Bold 2.004 under SIL OFL 1.1. The font data remain
OFL-1.1 with notices and reproducible hashes in [font provenance](../fonts/README.md).
Historical import/stage-A hashes refer to the old local-only glyph snapshot;
do not merge or publish that history to reintroduce it. No screenshots, capture logs,
credentials or development diary are included.
