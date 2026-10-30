# T-Energy-S3 512-address PSRAM acceptance

Date: 2026-10-29. Status: installed and tested on one identified S3 board.
This is a 512-entry memory/configuration test with real radio observations and
separate synthetic saturation tests; it is not 512 simultaneous physical radios.

## Installed profile and source

| Item | Value |
| --- | --- |
| Firmware | `tenergy-512-psram-r1` |
| Application | 1,289,936 bytes, application-only write at `0x10000` |
| App SHA-256 | `c3289d10988416da77892cfb0f2c032dca4080d6dc53eee16c04106d7e2b6883` |
| Policy | `controlled_test`, 512 addresses, 120,000 ms windows, 10,000 ms bins |
| Upload | At most 64 items / 8192 bytes; original exact durable ACK rules |
| Setup | Physical USB only; existing Wi-Fi/device/MQTT credentials reused |
| Flash | Existing 16 MiB layout and 4 MiB journal retained; NVS/queue verified |

The build freezes the verified USB-only r2 source and overlays this task's
collector/protocol/PSRAM/S3 changes and numeric memory logging. It excludes a
different session's concurrent general USB-only cleanup. Both implementations
provide USB-only setup; the frozen source manifest identifies the actual image.
Private manifests, original Flash, settings and radio logs remain ignored under
`captures/`; no operational identifiers or credentials are published here.

The collector uses `CONFIG_CP_COLLECT_MAX_ADDRESSES`: C3 defaults to128, S3
explicitly selects512. `CONFIG_CP_NETWORK_MAX_BATCH_ITEMS` defaults to16; S3
selects64. These do not raise the wire/ACK batch ceiling128, raw limit4 or bin
ceiling16. The server's per-window protocol ceiling is512; firmware still
rejects a policy above its own compiled board limit.

## Explicit PSRAM placement

S3 uses `CP_PIPELINE_PSRAM_BANKS`, allocating the active/sealed core and bin
banks through `MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT`. Placement is checked; there
is no internal-memory fallback. A failed resize retains the old owner and
swapped bindings. Flash handoff and frozen upload reads use checked PSRAM too.
Callbacks retain their bounded internal queue; TLS/DMA/task-stack protections
are unchanged. C3 keeps its original static core path.

The physical allocation log confirms capacity512, bins12 and `external=1`:

- Both core banks: 65,536 bytes.
- Both bin banks: 49,152 bytes.
- Combined: **114,688 bytes / 112 KiB** in PSRAM.
- All captured complete upload-allocation events report external placement.

## Stable physical observation

The initial USB validation timed out at DHCP without overwriting saved settings.
Retry succeeded in12,522ms. The firmware then intentionally restarted after
saving; an initial observer incorrectly included that expected transition.
The accepted observation starts in the post-save stable boot and does not reset
or reconfigure the board.

| Measurement | Accepted stable interval |
| --- | ---: |
| Continuous sampled collection | 601,981 ms, same boot |
| New reports between first/last samples | 77,683 |
| Pending queue | 36 → 4, with normal window-seal bursts |
| Minimum sampled internal free | 87,071 bytes / approximately85.0 KiB |
| Minimum sampled largest internal block | 31,744 bytes /31 KiB |
| Minimum sampled PSRAM free | 8,262,432 bytes |
| PSRAM total | 8,388,608 bytes |
| SDK boot-lifetime internal low water | 62,771 bytes |
| SDK boot-lifetime PSRAM low water | 8,253,844 bytes |

No crash, callback/observer loss, window/storage/summary loss, memory pause,
queue-pressure pause or ACK failure was observed during that stable interval.
Sample minima and SDK boot-lifetime low water are different measurements.
The four remaining historical rejected batches remain unacknowledged and stored;
they were not erased or treated as successful receipts.

Cloudflare confirms this image, boot and applied policy, and committed receipts
for windows, address summaries and status. Stored windows report an actual
`unique_table_capacity` of512, with observed occupancy89–142 address/type
combinations in the same-boot snapshots. Later windows therefore exceed the old
128-entry ceiling. Atomic per-window SQL compares each
window's declared count with stored summaries, avoiding live multi-query races.
The final atomic snapshot reconciles15 complete120s windows /1,630 summaries,
plus one101,107ms partial window /117 summaries. Its newest window is still
uploading and is excluded from those completed-window totals.

## Server rollout and recovery

Server commit `c808f4a` contains only the512 validator/OpenAPI and API tests;
it is pushed to main and its
[check/deploy workflow](https://github.com/Aiaid/CampusPulse/actions/runs/40832218125)
passed. The subsequent documentation commit `384dc2b` retains the512 code.
Firmware and the capacity-form UI changes remain uncommitted for coordinated
integration with the other firmware work.

After the stable interval, a previously queued128-server CI deployment briefly
replaced the manual512 deployment. The device accumulated42 retryable upload
failures; policy renewal/capture continuity across this rollout must not be
counted as part of the uninterrupted stable interval. The new512 CI deployment
restored service, and the same boot resumed fresh receipts without credential
rotation or queue deletion. Post-CI USB sampling confirms collecting1, no
memory/pressure pause, zero window/storage/summary loss and zero ACK failures;
the upload-failure counter remains42 rather than being cleared. A later same-boot
USB sample reports pending5 (four history plus normal work), internal free86,651
bytes, largest31,744, and unchanged42 upload failures. No old128 CI remains
pending; the subsequent main documentation commit also contains the512 server.

Local frozen backend checks passed1,046 tests initially and1,049 after including
the latest committed USB-only website and onboarding defaults. Deployment
prechecks passed. Final14 served image files were inspected with ExifTool;
no private metadata was found and original images were not changed. No database
migration or changes to other devices' policies/credentials were required.

## Saturation evidence and limits

Host sanitizer checks cover128/512 collector limits, the513th address overflow,
repeated reports/bins, transactional PSRAM placement/failure/resize/stop and
unchanged frozen bytes. The actual512 producer fixtures pass the strict wire
validator. Backend tests commit512 distinct summaries in bounded batches and
reject the513th record atomically, retaining exact retry ACK behavior.

Full512 address windows with12 bins need approximately38–39 frozen bodies and
about294KB of JSON at the8KiB body bound. Selecting64 items does not make eight
requests sufficient: the byte limit binds first. This is synthetic producer
evidence, not a measured full512 radio/drain rate. A longer window or further
encoding/transport work may be needed at full occupancy; the real trial did
not saturate512. Larger PSRAM does not remove receipt latency or replace Flash
durability. Independent vehicle inference retains its existing64-address sample
boundary; this task expands collection/ingestion, not inference accuracy.

See [initial USB/MQTT acceptance](tenergy-usb-mqtt-acceptance.md) and the
[integration plan](../design/tenergy-s3-integration.md) for earlier evidence.
