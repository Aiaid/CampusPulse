> **Historical target retired, 2026-10-31.** The V1/V2 application and protocol
> build entry have been removed. Retained board drivers, UI/fonts, algorithm
> sources, license/provenance and this historical documentation are reference
> assets only. Current firmware is [V3](../t-energy-v3-trial/README.md). This does not establish a
> Passport C3 V3 migration or device acceptance.

# T-Energy-S3 firmware entry points

The root project runs the **current shared CampusPulse chain** on the headless
LILYGO T-Energy-S3 V1.0/R8 profile. It calls `cp_app_start()`, uses the current
`../components/` services, native MQTT/TLS and physical USB provisioning, and excludes
the Passport UI. Display, buttons, legacy Radar diagnostics and profiling are off.
This source integration is separate from physical acceptance of its resulting image.

## Selected source and adaptations

Imported from CampusPulse `origin/feat/tenergy-s3-port` commit
`ca7bc9e6f4f1cb276128f9a216f3fdb34f8b3321`:

| Source path at that commit | Current path | Role |
| --- | --- | --- |
| `firmware/t-energy-s3-chain/` | This directory's root and `main/` | Active shared chain |
| `firmware/components/cp_board/tenergy_s3.c` | `components/cp_board/tenergy_s3.c` | Headless battery/identity adapter |
| `firmware/t-energy-s3/` | `bringup/` | Standalone vendor-facts diagnostic |

The imported adapter and bringup sources were CampusPulse code derived from
vendor pin/configuration facts, not a verbatim vendor application import. Vendor
reference: [Xinyuan-LilyGO/T-Energy-S3](https://github.com/Xinyuan-LilyGO/T-Energy-S3),
revision `68a74854ce0443377d186786bf3478484a0813e0` (GPIO3 / ADC1 channel2,
battery divider 2, QIO 16 MB Flash, Octal 8 MB PSRAM). Preserve existing repository
license/attribution and the shared components' existing notices. No vendor BSP,
font, screen or audio source is added here. See [reuse record](../../docs/notes/reuse.md).

The adapter uses `CP_COLLECT_ADDRESSES`: this S3 trial explicitly compiles 512,
while shared/default builds retain 128. The project-local `cp_board` component includes the current shared
header and declares its collector dependency. The Passport adapter and shared
pipeline's default C3 allocation path is preserved. IDF 5.5.3 `tools/cmake/project.cmake` registers extra
component directories before project components; `component.cmake` overrides
previous components of the same name. Root CMake and the image checker assert
that the resolved board component is this local S3 adapter.

`main/Kconfig.projbuild` imports the current shared application options.
`CP_PROVISION_USB_ONLY=y` excludes BLE/SoftAP provisioning and Security 2/SRP;
BLE observation stays enabled. The runtime rejects wireless setup requests
before interrupting a running collector or network session. USB setup starts
only after an explicit host `begin` command. Full CA bundle, certificate/time
validation, HTTPS support and native MQTT/TLS are explicit. The current
build-local transport SDK repair is included. Broker/device credentials come from
runtime provisioning; there are no endpoints, credentials or device identifiers
in this project.

The project excludes the unused SDK `wifi_provisioning` manager, whose headers
require at least one protocomm security version. No CampusPulse component
depends on that SDK manager; physical USB setup uses `cp_provision` directly.

`CP_PIPELINE_PSRAM_BANKS=y` allocates both collector core/bin banks as one
explicit PSRAM block, verifies external placement and replaces it transactionally
with ingress stopped. Allocation or placement failure retains the previous
owner and swapped bindings, with no internal-memory fallback. Frozen upload
read buffers also use verified PSRAM. TLS, DMA, RTOS stacks and radio admission
retain their internal-memory guards; cJSON allocators are unchanged. Numeric
`psram_banks` and `psram_upload` logs report allocation bytes and actual placement;
bank logs include free/minimum/largest PSRAM and internal heap.

The S3 upload item ceiling is 64 with the existing 8192-byte body limit. Actual
512-address, 120 s / 10 s-bin host replay persists 39 batches including status;
item bytes usually hit the body limit before 64 items. A fully occupied window
needs faster than 3.1 s per batch to keep up at 120 s, before control overhead.
Use measured latency and queue balance to select longer windows; physical
512-capacity acceptance must report occupancy, losses and durable receipts.

## Build and check

Activate an installed **ESP-IDF 5.5.3** environment with ESP32-S3 Xtensa tools,
`uv`, `IDF_PATH`, and `IDF_PYTHON_ENV_PATH`, then run:

```sh
./firmware/t-energy-s3/build.sh
# Optional explicit image descriptor version (1-31 ASCII token characters):
CP_TENERGY_VERSION=tenergy-usb-mqtt-001 ./firmware/t-energy-s3/build.sh
UV_CACHE_DIR=/tmp/campuspulse-uv-cache uv run --no-project \
  firmware/t-energy-s3/test_verify_images.py
```

The helper creates a fresh external temporary build directory and sdkconfig;
it builds and validates separate bootloader, partition table and application
images. It never flashes, opens a serial port or creates a merged image. The
checker rejects C3 image headers, non-16 MB images, changed geometry, wrong board
resolution, Passport UI, disabled security requirements and image path escapes.
A missing S3 compiler is a build prerequisite failure, not a successful build.
Build success alone does not verify board revision, ADC accuracy, BLE coverage,
MQTT recovery, queue durability or cloud persistence.

Active geometry: factory at `0x10000`, size `0x300000`; `cpqueue` at `0x360000`,
size `0x400000`, within 16 MB Flash. This deliberately retains the current shared
pipeline's geometry; unused gaps are not an authorization to overwrite data.
This S3 image/layout is not compatible with the Passport C3.

## Diagnostic and acceptance boundaries

`bringup/` retains the independent vendor-facts project. It reports chip,
Flash, PSRAM, its `storage` partition and battery samples; it has no BLE, Wi-Fi,
shared queue or cloud upload. It intentionally retains the historical UART0
console and **different 2 MiB app / `storage` layout**, so it is incompatible with
the active chain's image checker and layout. Do not interchange its images with
the root project. Its battery calibration and provisional threshold are not
validated operating limits.

The source branch recorded historical S3 builds/boots, memory and USB findings.
Those records do not establish acceptance of the current shared services or
native MQTT image. Provisioning binds its board information to the selected
runtime profile (`tenergy_s3 / esp32s3`); firmware version comes from the image
descriptor. The headless adapter has no display or buttons. Its USB-only
provisioning and independent broker credentials have
[bounded physical acceptance](../../docs/notes/tenergy-usb-mqtt-acceptance.md):
the r2 image passes USB migration/reuse and a five-minute128/60s controlled run,
with five complete windows/405 summary rows reconciled and a declining queue.
Further physical acceptance must cover saturated loads, ADC calibration,
long reconnections and power loss. A broker ACK alone does not prove Cloudflare
persistence. Eight MB PSRAM is verified. The installed
[512-address build](../../docs/notes/tenergy-512-psram-acceptance.md) confirms
112KiB external banks plus external frozen-upload workspace. Its601.981s stable
run has sampled internal free≥87071B and queue36→4. Later real windows reach142
addresses and reconcile with receipts; full512 saturation is separately tested
on host, not established for512 simultaneous radios. The older r2 record above
establishes only its measured128-address configuration.
