# Porting the shared chain to T-Energy-S3

Date: 2026-10-25. Status: **the shared chain now boots on real hardware**. One
physical board was identified over USB (§2a), the chain compiles and links for
`esp32s3` against a T-Energy board adapter (§3a), and that image was flashed and
booted: Octal PSRAM initialises, the journal opens on the Passport geometry, the
board reports its own profile, and the USB setup channel answers `begin` (§3b).
What is still missing is not porting work but an enrollment credential (§6), and
no observation has yet been collected or uploaded. This note records what the
shared chain requires from a second board, which seams are currently
Passport-specific, and the order in which they must be opened.

Related: [firmware platform design](firmware-platform.md),
[Passport chain and evidence](../notes/firmware-chain.md),
[device protocol v2](../specs/device-v2.md),
[short PIN and USB provisioning](../specs/local-provisioning-v2.md),
[T-Energy-S3 hardware research](../research/t-energy-s3-hardware.md),
[roadmap](ROADMAP.md).

## 1. What the team firmware is, and what it is not

The published firmware is one application (`ai-passport-radar`) over shared
components registered through `EXTRA_COMPONENT_DIRS`. Board choice is
compile-time; there is no runtime pin autodetection and no universal HAL.

| Evidence | Boundary |
| --- | --- |
| Local software chain: provisioning, enrollment, v2 policy/lease, canonical `(MAC, address_type)` aggregation, Flash journal, identity-checked upload receipts | Passed native/sanitizer, host, browser-fixture and four C3 image variants |
| One physical Passport | Application-only update with protected-region comparison, 60 s startup, native USB exchange |
| Wi-Fi join, real enrollment, field capture, sustained upload | **Not** established for any board |
| T-Energy-S3, Waveshare ePaper | **No profile, no driver mapping, no partition layout** |

Slice E of the platform design ("other-board collection") is exactly this task.
Its acceptance column already states the requirement: verified profile,
partitions and drivers per board, collection first, display optional.

## 2. What a second board must actually supply

`cp_board.h` is the whole contract — seven entry points plus one descriptive
profile struct:

```text
cp_board_profile()            board_id, revision, target_chip, capabilities,
                              max_addresses, ingress_queue_bytes, max_collection_lease_ms
cp_board_initialize()         peripherals + optional input callback, fills cp_board_health_t
cp_board_factory_mac()        factory base MAC for cp_node_id_from_base_mac()
cp_board_battery_percent()    -1/absent when the board cannot measure it
cp_board_present()            semantic status view; may be a no-op
cp_board_start_diagnostic_ui() inherited Radar UI; may be unsupported
cp_board_diagnostic_input()   input forwarding; may be a no-op
```

Everything else — BLE ingress and aggregation, policy and lease decisions,
journal, upload scheduler, provisioning transports — is already
board-independent. `cp_core_validate_policy()` rejects a policy whose
`required_capabilities` exceed the profile, so an honest capability word is a
safety mechanism, not cosmetics.

For T-Energy-S3 the honest profile is `CP_CAP_BLE_SCAN | CP_CAP_BATTERY` with no
`CP_CAP_DISPLAY`. The board has no panel. It carries one `BOOT-0` button on the
download strap (GPIO0), which is not a three-button UI: mapping it to
`CP_BUTTON_OK` would give setup entry via long-press, but that conflicts with the
strap's role at boot and is unverified, so `CP_CAP_INPUT` stays off until a
physical test exists. Absent display or input must remain a degraded-UI state,
never a collection gate.

## 2a. Measured board identity (2026-10-25)

Read over USB with `esptool flash_id`; no firmware was written.

| Fact | Measured value | Consequence |
| --- | --- | --- |
| Chip | ESP32-S3 (QFN56), silicon revision v0.2 | Vendor-derived target confirmed |
| Flash | 16 MB, manufacturer/density `46`/`4018`; eFuse quad (4 data lines), 3.3 V | Matches `sdkconfig.defaults`; QIO retained |
| PSRAM | Embedded 8 MB (`AP_3v3`) | R8-class part; Octal mode assumption not yet proven by an init run |
| USB | Native **USB-Serial/JTAG** (`VID_303A` / `PID_1001`), enumerated on COM8 | Retires the largest S7 unknown: the `cp_usb` transport has a physical path |
| USB pins | GPIO19/20 consumed by the USB PHY ([hardware note](../research/t-energy-s3-hardware.md)) | Those pins are unavailable for anything else |
| UART | External UART on UART0 | Both consoles physically exist, so the console choice is a decision, not a capability limit |
| Buttons | One `BOOT-0` on GPIO0, a download strap | No UI buttons; `CP_CAP_INPUT` stays off |
| Factory base MAC | Read from eFuse | Node ID derives as `cp_` + twelve hex digits; recorded out of tree, not committed here |

Still unmeasured, and each can invalidate a step: battery divider resistor values
and ADC linearity (S2), whether `BOOT-0` is usable as a runtime input without
disturbing the download strap (S7), Octal PSRAM actually initialising under
`CONFIG_SPIRAM_MODE_OCT` (S5), and the second board's revision.


## 3. Blockers found in the current tree

| # | Blocker | Evidence | Consequence |
| --- | --- | --- | --- |
| 1 | Target gate refuses every non-C3 build | `components/cp_board/CMakeLists.txt:1-2` `FATAL_ERROR`; `components/cp_board/passport.c:3-4` `#error` | Cannot configure or compile the shared chain for `esp32s3` at all |
| 2 | Journal geometry is baked into a "shared" component | `components/cp_pipeline/pipeline.c:590` rejects any partition whose `address != 0x360000` or `size != 0x400000` | This is the Passport offset inside `cp_pipeline`. A board with a different layout reports `JOURNAL UNAVAILABLE` and never captures |
| 3 | Partition must be named and typed exactly | `pipeline.c:587-589`; type `0x40` named `cpqueue`, falling back to `blelog` | The existing S3 `partitions.csv` calls its data region `storage`, so it would not be found |
| 4 | Kconfig is Passport-named | `ai-passport-radar/main/Kconfig.projbuild` exposes only `CP_PASSPORT_DISPLAY`, `CP_PASSPORT_BUTTONS`; `tools/build-passport.sh:26-30` overrides only those | No board-selection symbol; a second board needs its own options or a neutral rename |
| 5 | Headless setup path needs a console it does not have chosen | `components/cp_usb/usb_console.c:48` returns `ESP_ERR_NOT_SUPPORTED` unless `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG`; S3 `sdkconfig.defaults` selects `CONFIG_ESP_CONSOLE_UART_DEFAULT` | Reduced to a configuration choice: §2a proves the native USB-Serial/JTAG path exists. Select that console and accept that `ESP_LOG` output shares the port — the `CPSETUP/1` frame prefix is `0x1E`, and framing restarts on any new `0x1E`, so log noise is tolerated by design rather than by luck |
| 6 | Toolchain is pinned to one exact version | `tools/build-passport.sh:15,20-21,33` require `ESP-IDF v5.5.3` | The local install is 5.5.6. Either install 5.5.3 or extend the gate explicitly — do not silently relax it |
| 7 | `uv` is assumed | `build-passport.sh:16-22`, `check-chain.sh:10` | Not installed locally; `AGENTS.md` mandates `uv` for Python, so install it rather than switching interpreters |
| 8 | An S3 sdkconfig cannot be derived from the vendor/PIO defaults | `components/cp_network/network.c:26-31` hard-fails without `CONFIG_MBEDTLS_HAVE_TIME_DATE`; the Passport `sdkconfig.defaults` also sets `FREERTOS_HZ=1000`, NimBLE Observer, `ESP_PROTOCOMM_SUPPORT_SECURITY_VERSION_2`, log-level caps and the certificate bundle | The board needs its own sdkconfig carrying the whole security/timing baseline, not a target swap |
| 9 | A non-ASCII repository path breaks absolute-path components | `cp_radar`/`cp_ui_passport` register sources via `${CMAKE_CURRENT_LIST_DIR}/../../ai-passport-radar/main`; on a path containing non-ASCII bytes ninja fails with `can't create …/C_/Users/<mangled>/…obj` | Every build on this machine must run from an ASCII path, or those components must stop referencing sources outside their own directory |
| 10 | The Panel UI component drags the Waveshare BSP into every build | `components/cp_ui_passport/CMakeLists.txt:6` `REQUIRES … bsp`; the component lives in `ai-passport-radar/components/bsp/idf_component.yml` | CMake fails during configuration with `component 'bsp' could not be found` even when nothing links the UI. The S3 project must `set(EXCLUDE_COMPONENTS cp_ui_passport)` before `project()`, or the BSP has to become optional |
| 11 | The chain needs NimBLE server services even on a scan-only board | `components/cp_pipeline/pipeline.c:697,700` call `ble_svc_gap_init()`/`ble_svc_gatt_init()` unconditionally; IDF only compiles those services when a peripheral or broadcaster role is enabled | An honest `BLE_SCAN`-only profile fails at link with `undefined reference to ble_svc_gap_init`. Keep `ROLE_PERIPHERAL=y` and `ROLE_BROADCASTER=y`; disabling them is not a size optimisation, it is a link error |

Blocker 2 is the substantive design defect. `cp_core.h:25-26` states that no
protected partition offsets belong in the shared layers, and `cp_board_profile_t`
deliberately omits them — yet `cp_pipeline` enforces a Passport constant. Any
second board has to either adopt Passport's geometry or this seam has to be
opened. Both options are in §5; the recommendation is to open the seam.

Two couplings look worse than they are: `cp_board` and `cp_esp` add
`../../ai-passport-radar/main` to `PRIV_INCLUDE_DIRS` so `app.c` can include
`scan_ble.h`, and `cp_radar` compiles that scanner from its provenance path.
`scan_ble.c` includes only NimBLE, FreeRTOS and its own headers — it is board
agnostic and needs no change for S3.

## 3a. Compile-only result (2026-10-25)

A throwaway project outside the repository built the shared chain for
`esp32s3` against a T-Energy board adapter. **Result: compile and link passed,
1118 build steps, `EXIT=0`.**

| Item | Value |
| --- | --- |
| Target | `esp32s3`, ESP-IDF v5.5.6 with the xtensa-esp-elf 14.2.0 toolchain |
| Components | `cp_esp cp_board cp_core cp_radar cp_runtime cp_network cp_settings cp_provision cp_pipeline cp_collect cp_journal cp_usb` — no BSP, no LVGL, no display |
| Board adapter | New S3 profile, `CP_CAP_BLE_SCAN \| CP_CAP_BATTERY`, GPIO3 battery ADC |
| App image | 1,367,456 bytes (`0x14DDA0`); a 3 MiB factory partition leaves 57% free |
| Partition table | Passport geometry reproduced on 16 MB: `factory 0x10000/0x300000`, `cpqueue 0x360000/0x400000` — the hardcoded offsets **do** fit this part |

What this proves and what it does not:

- Proved: the adapter interface, the CMake target switch and the sdkconfig baseline are sufficient for the compiler and linker. `cp_pipeline`'s hardcoded geometry fits a 16 MB S3 layout, so §5 Option A is viable if the team prefers not to open that seam.
- Not proved: that the binary boots, initialises Octal PSRAM, brings up BLE or Wi-Fi, opens the journal, or uploads anything. A green link is not device validation.
- Built from a copy at an ASCII path (blocker 9) with ESP-IDF 5.5.6 rather than the pinned 5.5.3, and outside the repository tree. It is therefore evidence about *compilability*, not a repository build entry.
- The Kconfig warning `unknown symbol 'CP_LEGACY_RADAR_DIAGNOSTICS'` in that build is blocker 4 seen from the other side: the option the code depends on is declared in the Passport project's `main/Kconfig.projbuild`, so a second project silently loses it.

## 3b. Flash and boot result (2026-10-25)

The repository now carries a real build entry, `firmware/t-energy-s3-chain/`, and
its image was written to the first physical board.

Preconditions, because a flash overwrites whatever the board shipped with:

- Full 16 MiB dump taken first: `C:\dev\backup\tenergy-s3-full-16mb-20261025.bin`,
  16777216 bytes, app magic `0xE9` at `0x10000`, valid partition table at `0x8000`.
  Restore with `esptool -p COM8 -b 921600 write_flash 0 <dump>`.
- The previous layout was `nvs 24K + phy_init + factory 16320K`, so the old image
  occupied the region the new `cpqueue` claims. That region was erased after
  flashing, otherwise the journal would have found stale firmware bytes.

| Item | Value |
| --- | --- |
| Build entry | `firmware/t-energy-s3-chain/` — `EXTRA_COMPONENT_DIRS ../components`, `EXCLUDE_COMPONENTS cp_ui_passport` (blocker 10) |
| Toolchain | ESP-IDF v5.5.6, xtensa-esp-elf 14.2.0, `esp32s3` |
| App image | 1,368,240 bytes inside a 3 MiB factory partition |
| Bootloader | 21,920 bytes |
| Console | USB-Serial-JTAG, so logs and `CPSETUP/1` frames share the port |
| Layout | `nvs 0x9000/24K`, `phy_init 0xf000/4K`, `factory 0x10000/3M`, `cpqueue 0x360000/4M` |

Boot log, first reset after flashing:

```
I (25) boot: chip revision: v0.2
I (25) boot.esp32s3: SPI Mode : QIO   SPI Flash Size : 16MB
I (256) octal_psram: vendor id : 0x0d (AP)   density : 0x03 (64 Mbit)
I (260) esp_psram: Found 8MB PSRAM device
I (693) esp_psram: SPI SRAM memory test OK
I (2544) cp_pipeline: Journal ready: pending=0 quarantined=0
I (2545) cp_board_s3: T-Energy-S3 adapter ready; battery=1
I (2545) cp_app: Node=cp_94a990e5a820 board=tenergy_s3 revision=v1.0
I (2545) cp_app: Optional peripherals display=0 input=0 battery=1
I (2546) cp_app: Runtime initialized; provisioning and assigned policy control collection
I (12546) cp_usb: USB worker minimum free stack: 5116 bytes
```

What this settles:

- Octal PSRAM at 80 MHz really initialises on this chip revision, so the PSRAM
  claim in §2a moves from vendor-derived to measured.
- The journal opens on the Passport geometry with `pending=0 quarantined=0` and no
  `JOURNAL UNAVAILABLE`, so §5 Option A is workable: the hardcoded
  `0x360000`/`0x400000` does not have to move before this board can store data.
- The adapter reports exactly the capability set it declared — `display=0
  input=0 battery=1` — and the runtime treats absent display as a degraded UI, not
  as a collection gate.
- The USB setup transport starts and answers a host: `tools/check-usb-device.py
  --begin` returned `{"usb_reply": "passed", "setup_begin": true,
  "credentials_sent": false}`.

What this does not settle:

- Nothing has been collected. Without enrollment there is no lease, and without a
  lease the runtime never starts the pipeline or the scanner.
- Wi-Fi, DNS, TLS and ingest are untested. BLE scanning is configured but never
  started in this run, so the radio is still unproven.
- Battery percent is an ADC reading over vendor resistor values, not a calibrated
  measurement.
- The queue geometry is still a Passport constant. This test shows it *fits* a
  16 MB part; it does not make the constant correct.

## 3c. Second board: flashing a unit that still has factory firmware (2026-10-25)

The second T-Energy-S3 was flashed the same day and is a different starting state
from §3b, which is why this is recorded separately: the first board had already
been re-partitioned during bring-up, the second still carried LILYGO's factory
image with a standard OTA layout.

| Item | Value |
| --- | --- |
| Port | COM9, native USB-Serial/JTAG (`VID_303A`/`PID_1001`) |
| Chip | ESP32-S3 (QFN56) rev v0.2, 16 MB quad flash, 8 MB embedded PSRAM — identical to §2a |
| Factory layout | `nvs 0x9000/20K`, `otadata 0xe000/8K`, `app0 0x10000/6400K`, `app1 0x650000/6400K`, `spiffs 0xc90000/3456K`, `coredump 0xff0000/64K` |
| Pre-flash dump | `C:\dev\backup\tenergy-s3-full-16mb-20261025-board2.bin`, 16777216 bytes, `0xE9` at `0x10000`, `0xAA50` at `0x8000` |
| App image | 1,368,208 bytes at `0x10000`; bootloader 21,920 bytes at `0x0` |

Two erases were required beyond §3b, and the second one is not obvious:

1. `cpqueue` `0x360000`/`0x400000` — on this board that range sits inside factory
   `app0`, so stale application bytes occupy the journal.
2. `0x9000`/`0x7000` — the factory `otadata` partition lives at `0xe000`, while the
   new table defines `nvs` as `0x9000`–`0xf000` and `phy_init` as
   `0xf000`–`0x10000`. Half of the factory `otadata` therefore lands inside the new
   **RF calibration** partition. Leaving it means `phy_init` reads otadata bytes as
   calibration data. Erasing lets ESP-IDF recalibrate on first boot and write a
   valid block back.

The MAC differs from the first unit, so this is a **separate node** with its own
identity; it needs its own enrollment record in the admin backend before it can
receive a lease. Boot log after flashing:

```
I (26) boot: Partition Table:
I (26) boot:  0 nvs              WiFi data        01 02 00009000 00006000
I (27) boot:  1 phy_init         RF data          01 01 0000f000 00001000
I (27) boot:  2 factory          factory app      00 00 00010000 00300000
I (27) boot:  3 cpqueue          Unknown data     01 40 00360000 00400000
I (255) boot: Loaded app from partition at offset 0x10000
I (260) esp_psram: Found 8MB PSRAM device
I (686) esp_psram: SPI SRAM memory test OK
I (2524) cp_pipeline: Journal ready: pending=0 quarantined=0
I (2525) cp_board_s3: T-Energy-S3 adapter ready; battery=1
I (2525) cp_app: Node=<derived from this unit's base MAC> board=tenergy_s3 revision=v1.0
I (2527) cp_app: Runtime initialized; provisioning and assigned policy control collection
I (12527) cp_usb: USB worker minimum free stack: 5104 bytes
```

`tools/check-usb-device.py --begin` on this unit returned
`{"usb_reply": "passed", "setup_begin": true, "credentials_sent": false}`, the same
result as §3b. This is still a boot-and-transport check only: no lease, no scan,
no upload.

## 4. The existing `firmware/t-energy-s3/` project

Local, untracked, and **bring-up only** — its own header says so: no BLE scan,
no Wi-Fi upload, no queue. It reports chip/flash/PSRAM/partition facts and reads
the battery ADC, then loops.

| File | Disposition |
| --- | --- |
| `main/board.c`, `main/board.h` | **Reusable.** GPIO3 = ADC1 channel 2, ×2 divider, curve-fitting calibration, 16-sample average. Becomes the battery half of the S3 board adapter |
| `sdkconfig.defaults` | **Reusable facts.** 16 MB QIO 80 MHz flash, Octal PSRAM (quad mode fails), custom partition table |
| `main/main.c` | **Retire.** Its bring-up loop is replaced by `cp_app_start()` |
| `partitions.csv` | **Redesign.** `storage` at `0x220000` / `0xDE0000` is not what `cp_pipeline` looks for; see §5 |
| `CMakeLists.txt`, `main/CMakeLists.txt` | **Rework.** Add `EXTRA_COMPONENT_DIRS` and depend on `cp_esp` |

The vendor-derived facts are unmeasured on physical boards; keep that caveat in
whatever profile ships.

## 5. Partition geometry on a 16 MB part

Two ways to satisfy `cp_pipeline`. Only one of them is a fix.

**Option A — adopt the Passport geometry.** `factory` at `0x10000` sized
`0x300000`, `cpqueue` at `0x360000` sized `0x400000`. Installs today with no
component change, costs a 3 MiB application slot on a board with no such
constraint, and leaves the shared layer permanently Passport-shaped. `cardid` is
*not* required on this board and must not be reserved or reused — those offsets
are protected device data on Passports only.

**Option B — move geometry to the board (recommended).** Let the board supply the
queue region instead of `cp_pipeline` asserting it. Either extend `cp_board.h`
with a storage-geometry accessor, or add a neutral Kconfig pair
(`CP_QUEUE_OFFSET`/`CP_QUEUE_SIZE`) with Passport's values as the C3 default. Then
a compact S3 layout is available, for example:

```text
nvs        data nvs   0x9000   0x6000
phy_init   data phy   0xf000   0x1000
factory    app  factory 0x10000 0x200000
cpqueue    data 0x40  0x210000 0x400000   # 4 MiB, same journal size, new offset
```

A 4 MiB journal is a Passport-derived budget. Whether S3 needs it, or needs a
larger raw region, is a throughput decision to make during slice-E acceptance,
not by copying the number. Option B touches a component covered by the existing
C3 acceptance, so it needs the team's agreement and a re-run of the C3 build and
image checks — do not land it as a silent local change.

## 6. What "joining the other devices" means operationally

The nodes do not talk to each other. There is no peer mesh, no device-to-device
radio protocol. Each board is an independent client of the deployed Worker:

1. `cp_` + twelve lowercase hex digits of the **factory base MAC**
   (`cp_core.c`) — never an interface or random BLE address.
2. Administrator registers it: `POST /api/v1/admin/devices` `{id,name,board}`,
   returning an independent `cpd_` device bearer exactly once. A lost response is
   reconciled by reading the device and explicitly rotating, never by blind retry.
3. Local protected setup delivers the Wi-Fi profile and that bearer to the device
   over BLE (Security 1 / protocomm) or over USB. Credentials stay on the
   browser→device path and never in cloud registration payloads or logs.
4. Device contacts `/api/v2/device/config`, receives desired policy, validates it
   against its own profile, applies at a window boundary, reports activation.
5. Uploads go to `/api/v2/ingest` as `campuspulse/2` with
   `Authorization: Bearer <cpd_…>`, frozen bytes on retry, matched ACK before
   reclamation.

So "接入其他设备" means: your board becomes another registered, placed node whose
windows land in the same D1/R2 dataset and show up next to the Passports. It does
**not** mean your board reads their radios. BLE-visible identifiers are also not
a people count.

Three facts stay separate in the console and on screen: **registered**,
**network/cloud reachable**, **policy applied**. A configuration GET is not a
contact receipt.

## 7. Port sequence

Each step is independently checkable; none of them claims hardware validation.

| Step | Work | Acceptance |
| --- | --- | --- |
| S0 | Verify the two physical boards: 16 MB QIO flash, Octal PSRAM, GPIO3 divider resistor values, USB-C path, any usable button | **Mostly done (§2a, §3b)** for one board: chip, flash, PSRAM capacity *and* initialisation, USB mode, and 8 MB of PSRAM passing a memory test. Still open: divider values, buttons, second board |
| S1 | Replace the C3 gate with an explicit board selector (CMake target switch + Kconfig board choice); keep the Passport path byte-identical | **Implemented on branch `board/tenergy-s3`**; the C3 arm is textually unchanged but its build has not been re-run here |
| S2 | Add `components/cp_board/tenergy_s3.c` implementing the seven entry points; profile `board_id="tenergy_s3"`, honest `revision`, `target_chip="esp32s3"`, `CP_CAP_BLE_SCAN\|CP_CAP_BATTERY`; battery from the existing ADC code; `present`/diagnostic UI return unsupported | **Implemented and compiled (§3a)**. Still owed: a host test proving a `CP_CAP_DISPLAY` policy is rejected `CP_POLICY_UNSUPPORTED` |
| S3 | Open the journal-geometry seam (§5 Option B) | C3 chain tests and four image variants still pass with Passport's values. **§3a shows Option A fits 16 MB, so this can wait for team agreement** |
| S4 | New S3 partition table with a real type-`0x40` queue partition; decide console (USB setup vs UART0 debug) explicitly | **Done and observed (§3b)**: `Journal ready: pending=0 quarantined=0`; console is USB-Serial-JTAG, chosen by the measured USB path in §2a |
| S5 | Second build entry: `EXTRA_COMPONENT_DIRS`, `main` calling `cp_app_start()`, reused `sdkconfig.defaults` | **Done**: `firmware/t-energy-s3-chain/`, built from an ASCII path, flashed as separate bootloader/partition/app images, boot log recorded in §3b |
| S6 | Install and pin an ESP-IDF version the chain accepts; install `uv` | `build-passport.sh`-equivalent S3 script version-checks and passes |
| S7 | Headless setup path over the confirmed native USB-Serial/JTAG; no buttons exist to select a mode, so USB entry is the only implemented path | **Transport verified (§3b)**: the board answers the host's `begin`. Still open: nothing on this machine can complete a `configure`, because that op needs a device credential the backend issues |
| S8 | Cloud join: register, place, publish policy, confirm contact → activation → first accepted window | Server shows this node's own contact/activation and one reconciled batch |

S7 is the step with the most non-code risk. §3b removes the transport question:
the board boots to `awaiting_usb_setup` and answers `{"op":"begin"}` over the same
USB-C port it is powered from. What remains is authority, not plumbing.
`components/cp_usb/controller.c:59` accepts `configure`, and `cp_provision.c:218`
turns such a request into a stored candidate — but it wants a `device_token`,
which only the admin side can issue for `cp_94a990e5a820`. So the next action is
not a firmware change: it is registering this node and obtaining its credential.
`tools/check-usb-device.py` deliberately never sends one, which is why it reports
`credentials_sent: false` even on a healthy board.

## 8. Non-goals and prohibitions

- Do not copy Passport pins, its `cardid` region, or its protected offsets onto
  this board.
- Do not add an unverified S3 profile to make a support matrix look complete.
- Do not erase whole Flash or flash a padded merged image across protected data.
- Do not claim radio, Wi-Fi, upload or hardware validation from a passing build.
- Do not relax the ESP-IDF pin or skip image verification to get a green build.
- Raw samples must not consume the whole queue; report ingress loss, sequence
  gaps, storage exhaustion and upload failure instead of hiding them.

## 9. Verification boundary

This note mixes reading, measurement and one full flash cycle, and the boundary
between them matters:

- **Measured on hardware:** chip revision, 16 MB quad flash, 8 MB Octal PSRAM
  capacity *and* initialisation, USB-Serial/JTAG enumeration, boot of this image,
  journal open on the Passport geometry, the reported capability set, and the USB
  setup transport answering `begin`. See §2a and §3b.
- **Only read from the tree:** every blocker in §3, the provisioning handshake
  beyond `begin`, and the whole upload path.
- **Never exercised:** Wi-Fi, DNS, TLS, ingest, BLE scanning, a lease, an
  observation, battery calibration, and the second board.

Line references were checked against `main` at `5a44b50`; the board probe, the
compile check and the flash ran on 2026-10-25, recorded in §2a, §3a and §3b
without the device MAC. The board currently holds this S3 image, not its factory
firmware; the pre-flash dump needed to undo that is named in §3b.
