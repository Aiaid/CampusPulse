# T-Energy-S3 integration on main

Date: 2026-10-29. Status: selective integration and USB-only/MQTT device update.
Initial ESP-IDF 5.5.3 compilation, image checks and physical settings migration
passed. Current capture/queue evidence is recorded in
[USB-only acceptance](../notes/tenergy-usb-mqtt-acceptance.md).
Source branch: `feat/tenergy-s3-port`, commit
`ca7bc9e6f4f1cb276128f9a216f3fdb34f8b3321`.

## Repository layout and ownership

The selected board work lives under `firmware/t-energy-s3/`. The root is the
shared-chain application; `bringup/` preserves the earlier standalone peripheral
diagnostic. A project-local `components/cp_board/` supplies the S3 adapter and
uses the shared board interface. Its component takes precedence only in this
application. The existing Passport component and build entry remain independent.

The application links the current `firmware/components/` implementation rather
than copying the branch's older provisioning, network, collection or journal
sources. This is a selective source integration, not a merge of the old branch's
shared files. See the [build instructions](../../firmware/t-energy-s3/README.md)
and [reuse record](../notes/reuse.md).

## Evidence

| Evidence | What it establishes | What remains open |
| --- | --- | --- |
| Branch's 2026-10-25 bring-up record | ESP32-S3 rev 0.2, 16 MB Flash, 8 MB Octal PSRAM, shared-chain boot, journal open and USB setup on the recorded boards | Current MQTT image, sustained scanning/upload, calibrated battery and failure recovery |
| 2026-10-29 physical USB status | Attached device identity matches a board in that branch's record; saved device credentials are reported | Exact installed image version, current MQTT credentials, applied policy and sustained durable receipts |
| Current-source build on 2026-10-29 | ESP-IDF 5.5.3 compiles and links the current core with the local S3 adapter; native MQTT/TLS, strict configuration and separate S3 images pass verification | Physical acceptance of this image remains separate |

The historical notes contain superseded statements about missing board support
and cloud enrollment. Their detailed chronology remains available in Git at the
source commit; the [historical summary](../upstream/tenergy-s3/README.md) records
which evidence is retained. USB diagnostic stages and retained HTTP 200 fields
do not prove a new upload or current cloud persistence.

## Adaptation decisions in this integration

1. Keep one current shared core. Do not bring the old HTTPS implementation or
   old settings layout back into main.
2. Use the selected compiled collector ceiling in each board profile: C3
   defaults to128; the new S3 trial explicitly selects512 with external banks.
   The historical384 declaration was not accepted as measured capacity. The
   [512 implementation and tests](../notes/tenergy-512-psram-acceptance.md)
   update allocation, protocol admission and the API together; PSRAM alone does
   not change those limits.
3. Use native MQTT/TLS with independently provisioned broker credentials,
   certificate/time validation and the current exact durable receipt handling.
   Broker delivery alone does not release journal data.
4. Keep the existing S3 shared-chain geometry: 16 MB Flash, a 3 MiB factory app
   at `0x10000`, and the 4 MiB `cpqueue` at `0x360000`. This satisfies the current
   shared pipeline's geometry check. There is no Passport `cardid` partition on
   this board. Its standalone bring-up layout is a different diagnostic layout
   and is not a firmware update recipe.
5. Keep display, UI input and inherited Radar diagnostics disabled. GPIO3 battery
   ADC is board-specific; neither Passport LCD/button pins nor its BSP belong
   in this image. Battery percentage remains an uncalibrated estimate.
6. Pin the new build helper to the repository's ESP-IDF 5.5.3 baseline, with an
   ESP32-S3 toolchain and separate S3 image verification. Historical builds used
   5.5.6; they do not validate this build environment.

## Next adaptation work, in order

| Priority | Work | Acceptance |
| --- | --- | --- |
| Done | Replace hardcoded Passport metadata in `firmware/components/cp_provision/cp_provision.c` with the selected runtime profile | Normal/USB-only module and runtime checks pass; physical S3 USB reports `tenergy_s3 / esp32s3` and its actual version |
| Done | Build the S3 application against current shared components and review resolved Kconfig, component paths, image headers and partition table | ESP-IDF 5.5.3 compiler/linker and image checks pass; local S3 adapter; USB-only/native MQTT/TLS; wireless setup security disabled |
| Done | Reconcile existing settings through the current Wi-Fi/MQTT migration path | Physical USB reuses the same device credential; v2→v3 save and independent MQTT readiness pass after network validation |
| Done | Prepare a board-specific update from a verified Flash backup and actual partition inventory | Verified 16 MiB backup and application-only update; NVS and unacknowledged journal bytes preserved before boot |
| Partial; P1 follow-up | Measure current-image internal heap, PSRAM, queue balance and reconnect behavior | Two physical USB/MQTT runs recorded; r2 queue301→271 and five reconciled windows; longer interruptions, power loss and allocation stress remain open |
| Bounded acceptance done | Test the 128-entry policy at recorded window/bin intervals | 30s run exposes history latency/growth; current-boot preference plus60s run passes five full windows with80–83 addresses, unsaturated128 |
| Done; bounded | Implement S3-specific512 address banks explicitly allocated in PSRAM |112KiB checked external banks;601.981s stable observation, queue36→4; synthetic512 saturation separate from89–120 observed addresses |
| P2 | Saturate the S3 radio workload, improve full512 upload efficiency and generalize board-owned queue geometry | Retain C3 defaults, frozen bodies and exact receipts; establish sustained throughput rather than infer it from PSRAM size |

PSRAM is additional memory, not proof of radio completeness, internal-memory
availability or throughput. Bluetooth address counts are not people counts.
The S3 allocator can serve ordinary large allocations from PSRAM, but task stacks
and DMA descriptors have separate placement constraints. See the pinned
[ESP-IDF external RAM guide](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32s3/api-guides/external-ram.html).
Expanding the address/bin banks and encoding workspace is a plausible S3 next
step; it does not make volatile PSRAM a replacement for the Flash journal or
increase the backend's durable receipt throughput.

## Local validation

In the initial import on 2026-10-29, the new build helper completed a fresh ESP-IDF 5.5.3 ESP32-S3 build
against main at `777f82e` plus the local integration. The official pinned Xtensa
compiler was installed in a temporary tools directory; the Passport tools and
active sessions' build directories were not replaced.

- Separate bootloader: 22,272 bytes at `0x0`.
- Separate partition table: 3,072 bytes at `0x8000`.
- Separate application: 1,372,288 bytes at `0x10000`, within the 3 MiB slot.
- S3 chip/16 MB headers, exact active partition geometry, local board component,
  native MQTT/TLS, TLS buffer lifecycle, Security 2, INFO logging and disabled
  Passport UI pass the resolved-build verifier.
- All 12 synthetic image-validator tests pass, including rejection of C3 or
  non-16 MB headers, unsafe TLS, wrong board selection, changed/overlapping
  partitions, oversized/extra images and path escapes. Shell syntax and changed
  tracked-file whitespace checks pass.

The application SHA-256 for that build is
`839fcd222bed8217b1c867207005a82522c17bae40ce17a4a9f9cb86397e2c7d`.
These are the initial import's local build facts, before the subsequent USB-only
update. The later application-only flash, settings migration, current-boot
scheduling and physical tests have separate evidence in the acceptance note.
