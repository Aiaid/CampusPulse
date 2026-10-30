# T-Energy-S3 USB-only and native MQTT acceptance

Date: 2026-10-29. Scope: the USB-identified T-Energy-S3 V1.0/R8 on this host;
not acceptance of every S3 board, a physical location or an exact people count.
Source layout and remaining work: [integration plan](../design/tenergy-s3-integration.md).

## Implementation

- Provisioning binds the selected runtime board profile and returns
  `tenergy_s3 / esp32s3`, with the application descriptor's actual version.
- `CP_PROVISION_USB_ONLY=y` removes BLE/SoftAP provisioning and Security 2/SRP
  setup code. Runtime rejects wireless setup requests before stopping the
  network, collector or lease. BLE observation remains available.
- Native MQTT/TLS uses an independent, already broker-verified pool identity.
  The device's own saved HTTP credential and Wi-Fi were retained; USB delivered
  the MQTT handoff and v2 settings migrated to v3 only after network validation.
- S3 alone enables `CP_UPLOAD_PREFER_CURRENT_BOOT`; current boot stream heads
  take priority over historical backlog. Historical frozen bytes and exact
  durable receipt requirements remain unchanged. C3 defaults retain their
  scheduler memory layout and ordering. Older pending data is serviced when no
  current head is ready.

No passwords, tokens, device identities, raw observations or Flash dumps are
included in this document. Private evidence is ignored under `captures/`.

## Flash and provisioning evidence

Before the first write, the exact factory/USB identity, S3 target, 16 MiB Flash,
unencrypted/unsecured Flash state and actual partition table were checked.
The complete 16 MiB backup was verified against the device. The existing layout
already matched the active S3 project, so only the application at `0x10000` was
updated; bootloader, partition table, NVS and journal were retained. Full Flash
verification matched the expected application-only change before boot.

The first USB-only image was `tenergy-usb-20261029-r1`, 1,288,816 bytes. Its
application SHA-256 is
`bae3e458b5c13960e285267fe2a22c09d3a004b2713c3d900be84abf0d1040b4`.
The compiled provisioning archive had no wireless provisioning/SRP/HTTP setup
references. Eight MB Octal PSRAM initialised and passed the startup memory test.

Physical USB returned the correct board, image version, USB transport and
`physical-usb` security. Candidate validation completed in 11,875 ms, reported
`saved`, and confirmed both saved device credentials and MQTT readiness. The
original device credential was reused rather than rotated. This is distinct
from later capture/receipt acceptance.

## First run: 128 addresses, 30-second windows

The immutable test policy used `controlled_test`, raw capture off, 30,000 ms
windows and 5,000 ms bins. Its existing registered placement was used only as a
transport-test association; no actual location was validated. The original
field policy and its queued provenance were preserved.

The bounded serial observation covered 300,951 ms of continuous collection,
with no observed crash, callback drops, window/storage/summary loss, allocation
pause, queue-pressure pause or ACK failure. At its last sample the boot had
seen 30,399 advertising reports. Minimum sampled internal free memory was
52,803 bytes and minimum largest internal block was 24,576 bytes. These
internal-memory measurements are separate from the status stream's roughly
8 MiB combined PSRAM/internal heap figure.

This was not a balanced-queue success: the device began with 277 historical
pending address-summary batches, and total pending reached 293 during the
bounded observation. The corresponding logs record four old summary 409
responses and 45 old summary batches receiving exact validated 200 receipts;
those are not failures of a newly generated batch. Current-boot windows and
status reached Cloudflare, but current summaries were delayed behind history.

A later pre-update snapshot contained 18 complete 30-second windows, zero
aggregation drops, and 63–87 visible address/type combinations per window.
That does not saturate or prove the 128-entry ceiling. No current-boot summary
receipt had arrived at that snapshot. Wider radio completeness is unknown.

One oldest rejected batch was examined by local CRC/hash checks and read-only
database metadata: there was no matching batch receipt, no v1 ID conflict and
no overlapping v2 sequence receipt; its existing private-window budget was
expired. The owning storage trigger maps a closed private window to
`window_evidence_conflict`. This explains a rejection path but does not replace
the unavailable original response body's exact error code. The old body remains
unaltered and unacknowledged.

An attempted diagnostic replay of that complete old batch was rejected by
automatic approval review because it could transmit historical BLE evidence
and write production data. It was not executed. The subsequent checks sent
only metadata queries and did not replay its payload or device credential.

## Second run and remaining acceptance

The second image, `tenergy-usb-20261029-r2`, retains the same saved MQTT settings
and exact journal bytes, with current-boot upload preference enabled. Its
1,288,992-byte application has SHA-256
`975583f2f28844328949eaf55dc1cbacacd5f206dedc0a2c15ebd9717ad7db39`.
It was installed application-only and passed whole-Flash comparison before
boot. The linked ELF contains USB exchange/current-boot scheduling symbols and
none of the checked wireless provisioning/SRP/HTTP server entry symbols.

USB Wi-Fi reconfiguration was repeated without sending either the saved device
token or the saved MQTT credentials. Existing MQTT readiness was confirmed
before submission; network validation and the save completed in 16,522 ms.
This tests reuse of the v3 settings across an application update/reboot, as
well as the initial v2→v3 migration above.

The second controlled policy uses 128 entries, 60,000 ms windows and 5,000 ms
bins. The serial observation covers 301,030 ms of continuous collection in one
boot. Its sampled pending count falls from 301 to 271 while collecting; a later
cloud status reports 267. No crash, callback/observer rejection, window/storage/
summary loss, memory/pressure pause or ACK failure is observed. Internal free
memory reaches a sampled minimum of 47,991 bytes; the minimum largest internal
block is 21,504 bytes. At the last serial sample, 40,470 reports had been seen.

The matching Cloudflare snapshot confirms the same firmware, boot and applied
test version, with committed receipts for all three streams:

| Stream | Batches | Items |
| --- | ---: | ---: |
| BLE windows | 5 | 5 |
| Address summaries | 35 | 405 |
| Node status | 6 | 6 |

All five complete 60-second windows reconcile with their address summary rows:
80, 81, 83, 81 and 80 address/type combinations, totaling 405 summaries. The
windows contain 38,515 advertising reports and zero aggregation drops. The
latest stored loss totals are zero, including address overflow and unpersisted
window reports. This is a bounded workload at 80–83 addresses, not a saturated
128-address acceptance result.

The serial sample also records exact ACKs for 299 historical items while new
items advance. Four historical 409 responses remain retained and unacknowledged;
only the one metadata case described above was individually diagnosed. No
original body was rewritten and no failed response was treated as an ACK.

The device remains running this USB-only image on the 128/60-second
`controlled_test` policy, excluded from public field summaries. Its original
field policy remains immutable and recorded for a later deliberate return to
the appropriate physical placement. This task does not assert that the bench
test establishes that location.

The second backup reads the currently mutable NVS and journal, reconstructs a
complete image from the earlier verified Flash, then verifies all 16 MiB against
the device before another write. A reconstruction mismatch falls back to a new
full read; it is never accepted as a verified backup.

Long interruptions, power-loss recovery, calibrated battery accuracy and a
saturated 128-address radio workload remain separate acceptance work.
Larger S3-specific 256/512-address banks are a possible PSRAM design direction;
the current shared collector/parser/API ceiling is still 128, and sustained
throughput must be measured separately from available memory.

## Software checks

- Normal and USB-only provisioning module/controller tests pass under
  ASan/UBSan, covering MQTT migration, saved credentials, nonce, expiry,
  concurrency, status and correct C3/S3 metadata.
- 142 runtime scenarios pass across normal/USB-only and HTTPS/MQTT modes.
- 23 scheduler groups pass across undefined, disabled and enabled preference;
  the default scheduler size is unchanged. Pipeline host and literal codec
  acceptance pass in both modes, including 153 codec validations per mode.
- Fifteen S3 image-verifier tests pass. Resolved image checks include USB-only,
  disabled wireless setup security, native MQTT/TLS, strict TLS settings,
  selected board, exact geometry and current-boot preference.

The optional S3 build excludes the SDK's unused `wifi_provisioning` component:
that component otherwise refuses a build with all wireless protocomm security
versions disabled. No wireless security version was re-enabled to work around
that compile error.
