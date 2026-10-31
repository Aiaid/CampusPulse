# Waveshare V3 Chinese UI — 2026-10-31

Status: the initial three-page replacement was physically confirmed (Chinese
and4.07V), but the user preferred the original four-page layout. That original
layout is restored and app-only installed as0.3.2-original-ui. USB standby and
the initial full panel refresh are verified; restored-page physical appearance
remains available for the user to inspect.
Prior bounded data acceptance remains documented separately in
[small-statistics acceptance](waveshare-small-statistics-acceptance-2026-10-30.md).

## Initial three-page replacement (superseded layout)

`firmware/waveshare-v3/` version0.3.1-chinese-ui replaces the temporary English
screen with three native200×200 monochrome pages:

- Collection/upload: SDK report totals and sampled rate/trend, last durable
  window reports/losses, confirmed windows, current/historical backlog, retained
  history and local TF raw written/synced counters.
- Device/battery: calibrated ADC voltage, coarse percentage, explicitly pending
  ETA, memory, TF, queue, software losses and upload failures/retries.
- USB: initial computer configuration, stopping, safe restart and unsafe error
  states. A failed run that nevertheless safely unmounted remains an error but
  correctly permits shutdown; it does not falsely imply unsynced storage.

The display owner copies a scalar metrics structure under a lock. Source queue
reads and bounded TF free-space sampling share the existing TF mutex; only the
display task uses LVGL. Unknown values remain `--`, legitimate zero values stay
zero, and paused/stopped states do not display a live sampling rate. Trends are
the latest display samples, not a claimed fixed60-second series. BLE keys are
not represented as a number of people. Raw/control/statistics formats, receipt
semantics and the actual collection pipeline are unchanged.

TF mounted state is published explicitly and cleared after successful unmount.
Wi-Fi state is cleared after successful transport shutdown. Last-window counts
become visible only after its exact body has committed to the durable queue.

The USB page describes the existing physical V3 debug bootstrap; it does not
claim that the ordinary web setup wizard has been integrated. BOOT short press
cycles pages, BOOT2seconds requests safe USB stop, and PWR requests safe shutdown.

## Software validation

The actual LVGL9.5 renderer produced33 synthetic frames at200×200, including
known/unknown/zero/max counters, startup, recording, paused, stopping, safe,
unsafe-error, safe-error and raw-disabled states. Checks cover glyph presence,
label/object bounds, overlaps, intact numeric values and safe-error wording.
These are software previews, not photographs of the ePaper panel. Final PNGs
were checked with ExifTool and contain no EXIF/XMP/IPTC/comments; previews are
kept outside the repository.

The327-glyph12/14/16px font subset has deterministic source-hash, coverage scan
and regeneration checks. OFL notices and in-repository reuse provenance are
recorded in [reuse](reuse.md). The20 board-local host tests and complete S3 build
and image-boundary checks passed. This does not repeat or extend the previous
physical RF/upload/endurance acceptance.

## Board installation

The prior1517392byte accepted app hash and actual partition table matched their
known references. A private table/NVS/full-app backup was saved before flashing.
Only the application at0x10000 was written; bootloader, partition table, NVS and
TF data were preserved. The installed1598576byte image has SHA-256
`0a1295fc6d7d367cabf7f6678df68a111b17d8c1c3763ad2535ab7eb8ecb5df8`.
USB HELLO returned the correct physical board identity. Boot logs show SSD1681
ready and the first full200×200 refresh completing in1909ms, with no assert or
panic during the observation. No network configuration or collection was started
for this screen check; the board waits for physical USB bootstrap.

## Battery boundary

The V2's existing GPIO4 calibrated ADC voltage reader is reused. Percentage
remains a coarse voltage estimate; the circuit does not identify USB charging,
battery presence or actual discharge current. The official
[FAQ](https://docs.waveshare.net/ESP32-S3-ePaper-1.54/FAQ/) gives low-power example
durations, which are not a continuous BLE/Wi-Fi/TF load model. No measured
capacity/discharge model has been established for this battery/workload, so
remaining-time ETA stays pending calibration rather than extrapolating voltage.

The initial three-page screen was confirmed by the user, including4.07V. The
restored original pages keep the same voltage reader. A later battery-only
workload measurement is required before showing a calibrated remaining-time
estimate.

## Restored original layout

The user clarified that the previous four-page UI was already preferred. The
three-page redesign is superseded rather than kept as the default. Version
0.3.2-original-ui adapts the existing raw UI's original geometry and hierarchy:
device diagnostics with dual-column memory/storage bars and battery; BLE activity
with the28px rate and ten bars; vehicle clues with unanalysed fields; and elevator
observation with three RSSI statistics and its curve. The footer dots, badge,
native font sizes and spacing are restored. A fifth USB page retains the real
V3 bootstrap/stopping/safe-restart behavior.

Only captions and bindings that would otherwise misstate V3 behavior change.
The activity counters show the last durable window and confirmed windows, not
invented60second raw writes. The RSSI chart contains the last ten durably frozen
window means, with unknown gaps; the rate chart contains actual display samples.
No vehicle count or elevator prediction is inferred. Root publishes last-window
RSSI under the existing UI lock and reads RTC solely for display; TLS and capture
continue to require their independent trusted anchor. SSID/IP/AP RSSI are local
network-owner snapshots and are never added to the uploaded statistics.

Fifty-five actual-LVGL frames (eleven states across five pages) passed glyph,
200×200 bounds, label/unknown/zero and USB safety wording checks. The exact
327glyph font scan/regeneration check and complete S3 build passed. Final PNG
metadata was checked; all preview figures use synthetic values. The user's
4.07V observation refers to the actual board, not those software previews.

The installed restoration image is1640368bytes, SHA-256
`1e9f199566216a8985e1c63b99602e907480b02dbfa2aac24b40afef4114d652`.
The prior0.3.1 image, table and NVS were backed up and checked before the
application-only write. Board identity/USB standby and a full-screen refresh
were verified afterwards. Twenty board-local host tests still pass. Neither
network configuration nor a new collection run was started during this UI check.
