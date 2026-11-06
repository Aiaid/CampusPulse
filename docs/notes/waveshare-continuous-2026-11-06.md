# Waveshare 0.5.2 continuous-control delivery

Status:0.5.2 flashed and running with saved configuration. Real same-boot scope
change, renewed clock/capabilities, applied ACK and subsequent field windows are
verified across the old20-minute stop point. A deliberate post-run power cycle,
all-day operation and arbitrary-power-loss acceptance remain separate.

## Current0.5.2 evidence

Application size is1,745,008bytes; SHA-256 is
`04ea48f7e4fc347f508634c81c44ef3b268eb853d21c3c4606f2abb56a8fd2f4`.
The complete current Flash image was verified after app-only writing. Startup,
partition, PHY and protected tail match the preserved pre-update image. A USB
reenumeration allowed an intermediate maintenance boot to update NVS; that
difference is recorded rather than described as byte-identical. The latest NVS
was read, retained and included in the verified whole image, without writing it
back or resetting ledger usage.

The formal observer began at10:50:29UTC on2026-11-06. Capabilities registered
at10:50:57UTC and generation17 received real applied ACK at10:51:30UTC. Its
9th/field/vehicle policy was derived from the existing approved generation15,
without another USB setup or grant extension. By11:01:11UTC, six field windows
and six statuses had committed under that same boot; lease contact advanced
from1 to7 after an interruption. Status6 retained18upload failures and2retries,
with zero reported window/event drops or ACK failures. These counters are not
RF-completeness evidence.

At11:11:04UTC the same boot registered capability sequence2, then received real
generation18 applied ACK at11:11:18UTC. By11:13:51UTC, its total19windows/statuses
comprised17from generation17 and2from generation18. The latter use clock epoch2
and the vehicle ruleset; the latest was a real60000ms field window ending at
monotonic1386151ms. Generation18 lease contact reached3. The startup grant
remained revision3/source15 with its original13November07:44:11UTC cutoff.
Status19 retained20upload failures and2retries; reported window/event drops and
ACK failures were zero. This establishes bounded same-boot renewal and continued
delivery, not uninterrupted RF coverage or a zero-failure network.

The USB observer disconnected after uptime114334ms without a captured panic.
Later received windows ended after that timestamp, establishing continued
collection beyond USB observer loss. Whether the USB cable was intentionally
removed and whether the device was battery-only is still awaiting operator
confirmation. No serial reopen/reset was used to recover this run.

The0.5.2 Wi-Fi recovery API preserves owner, EAP configuration, MQTT RPC
highwater, trusted clock and frozen bytes; it requires confirmed MQTT stop.
Numeric rejection diagnostics distinguish owner/cancellation/init/link/clock
gates. The existing64KiB LVGL CPU pool now allocates once in PSRAM: measured
initial internal free increased from181723to247259bytes; after capture
preparation98603bytes free and31744largest remained. SPI/DMA/stacks and the
56KiB cold-MQTT admission floor are unchanged. Target build and the relevant
host gates, including the existing T-Energy host suite with explicit vehicle
library linkage, passed.

## Historical0.5.0 maintenance checkpoint

- Actual target: Waveshare ESP32-S3-PICO-1 V2, 8MiB Flash and 8MiB PSRAM.
  Board reference: [official Wiki](https://docs.waveshare.com/ESP32-S3-ePaper-1.54).
- ESP-IDF5.5.3 target build passed, application version `0.5.0`.
- App size: 1,743,856 bytes, within the existing 3MiB application partition.
- App SHA-256: `34f56ca468cc6b353dbe406766ccb0fd9d762f1341e28333c0c21c491e69cfb3`.
- Fresh 8MiB pre-update backup retained privately; only app offset `0x10000`
  written. Full readback matches the candidate. Bootloader prefix, NVS,
  partition table and protected tail are byte-identical to the fresh backup.
- Saved device and MQTT material both reported ready before the update.
  Their contents, Flash images and console captures remain ignored/private.

The maintenance serial open itself caused `USB_UART_CHIP_RESET` on the previous
image. Holding the connection open allowed a fresh `restart_required` safe-USB
HELLO before backup. Do not infer a periodic firmware reset from this maintenance
event, or reopen the port during collection without accounting for that reset.

## Included behavior and software evidence

The normal-run 20-minute completion/restart path is removed. New code uses a
same-boot storage park, signed-clock refresh, capability renewal, real policy
application and committed ACK before resuming. Placement/rules changes use a
bounded administrator intent, durable Ready evidence and unchanged frozen old
bodies. The interface and authority design is in
[continuous V3 control](../design/v3-continuous-control.md).

`cp-v3-vehicle-candidates/1` adds conservative e-bike/car candidates from the
existing reviewed rules. Unclassified history remains unchanged; unknown and
exclusions remain meaningful and `estimated_total` stays null. This build does
not enable raw cloud upload or change the selected profile's local raw setting.

The control, statistics, clock and capture slices passed their targeted host
checks. Backend transitions passed 14 new real workerd/D1 cases; the relevant
backend suites passed 21 cases together. Online-binding admission/receipt tests
passed 18 cases. The isolated real React/Chromium flow and the existing USB setup
browser regression both passed with synthetic peers. These are software checks,
not physical radio, classifier-accuracy or prolonged-operation acceptance.

## Explicit remaining boundaries

- A frozen renewal candidate that expires during a prolonged outage is retained
  and stays paused. Its sequence is not guessed/reused and it does not trigger
  an automatic reboot. A separate bounded recovery design remains needed.
- A cancelled intent after the device parks but before it freezes Ready can
  currently leave the device parked. Cancellation preserves old placement,
  grant and historical bytes; it does not establish automatic device resume.
- The original exactly-20-window terminal failure has no preserved terminal
  console trace and is not attributed to a specific old cleanup operation.
- Field binding to `9th`, a real generation15 applied ACK, original grant-cutoff
  preservation and field-window receipts are now verified. The public V3 place
  projection still selects another earlier active receiver with no field data;
  it returns `no_field_statistics`. Other placements and stable source selection
  were deliberately preserved. Uploaded device data and public-map selection
  are separate acceptance boundaries.
