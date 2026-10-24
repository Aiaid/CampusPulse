# Firmware runtime refactor, stage A

> Historical snapshot, superseded for current normal-boot behavior by the
> [complete local firmware chain](firmware-chain.md). The build sizes and test
> counts below belong to stage A at local commit `8018d17`; they do not describe
> the later provisioning/network/collector image. Keep this record as evidence.

Date: 2026-10-24. Status: implemented locally, with build/test results below.
The user requested a commit before refactoring: `82549b0` records the imported
Radar baseline and platform design on `codex/passport-firmware`. The code
in this note is the stage-A snapshot committed locally as `8018d17` before
end-to-end integration. No push, device flash or cloud deployment is part
of this stage.

## Behavior and scope

The project already uses ESP-IDF's FreeRTOS. This change separates ownership
within that runtime; it does not introduce another OS.

Normal boot reads the factory eFuse base MAC and derives `cp_` plus twelve
lowercase hex digits. It creates the application supervisor and initializes
optional Passport peripherals through a board adapter. A working screen shows
node/board identity and explicit network, enrollment, policy and collection
states. No credentials or runtime policy client have been implemented yet, so
the default state is **needs setup, collection stopped**. No field scanner is
started just because a page opens or a button is pressed.

The inherited scanner remains available through the explicit
`CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS=y` build option. This is local-only diagnostic
behavior, with no Cloudflare upload or field-policy claim. The diagnostic page
is labeled DIAG; raw calibration exports/persistence stay disabled by default.
It can also run in a headless build without LCD/buttons.

Only the Passport ESP32-C3 board adapter is implemented. It preserves imported
pins and protected partitions, labels physical revision verification as pending,
and rejects other chip targets. The profile's address/queue/lease values are
compiled ceilings for compatibility validation, not measured capture capacity,
allocated persistent storage or an active authorization lease. S3 board drivers
and board-specific Flash layouts remain pending.

## Component and task ownership

| Component | Implemented responsibility |
| --- | --- |
| `firmware/components/cp_core` | Portable factory-derived identity, independent lifecycle facts, bounded desired-policy compatibility/application and same-boot authorization decisions |
| `firmware/components/cp_board` | Passport pins/drivers, optional peripheral health, timestamped semantic input and display adapter |
| `firmware/components/cp_esp` | Application startup and one supervisor/input queue; normal startup cannot grant enrollment or collection policy |
| `firmware/components/cp_radar` | Imported diagnostic scanner/parser/table under an explicit component boundary |
| `firmware/components/cp_ui_passport` | Radar and status renderers at original provenance paths; normal status rendering and diagnostic UI are mutually exclusive |

The original project entry remains under `firmware/ai-passport-radar/`; its
`main.c` is a small launcher. No source files were moved out of their provenance
paths yet. Main no longer owns BSP initialization or calls a page to start BLE.

The scanner has an independent 100 ms maintenance task. It owns table aging,
dwell/confirmation ticks and cached diagnostic projections, including periods
with no reports or UI reads. Snapshot consumers copy a bounded projection with
an explicit validity flag. The page no longer supplies a clock or schedules
calibration storage/dumps. Maintenance task and NimBLE task teardown use explicit
completion acknowledgements before deletion/deinitialization; actual hardware
restart/coexistence behavior still needs device testing.

The diagnostic UI task owns focus, confirmations, smoothing and rendering.
Button callbacks enqueue events without formatting or drawing. Initial event
time is preserved through both the supervisor queue and page queue; delayed
delivery cannot shorten the interval between physical button actions. A missing
snapshot is shown as unavailable, not zero observed activity. Queue/table-lock
losses and maintenance skips are observable.

The inherited diagnostic table still filters repeated reports and performs
fingerprint association. It is not the canonical MAC/address-type summary
pipeline. Callbacks still perform its bounded legacy parsing/classification;
the independent report queue and summary worker are later work.

## Policy logic boundary

The pure core is ready for a future validated transport adapter, not a new wire
schema. It rejects unsupported capability/budget requests, requires explicit
successful application of the desired version, and blocks collection on local
pause, definitive auth rejection, missing required clock or lease expiry.
Historical-policy validation and backlog activity cannot renew authorization.
The upload cutoff remains separate from the collection lease; same config IDs
cannot silently change the projected cutoff. Reboot/init does not restore a
grant. Missing/degraded UI does not revoke an otherwise valid authorization.

The current supervisor has no enrollment/config client, so none of those grants
are created in normal firmware. These host-tested decisions do not establish
server compatibility, actual remote revocation or hardware application of policy.

## Build and verification

Activate the installed ESP-IDF 5.5.3 tools, then use:

```bash
firmware/tools/check-passport.sh
firmware/tools/build-passport.sh
firmware/tools/build-passport.sh --diagnostic
firmware/tools/build-passport.sh --diagnostic --headless
```

Python commands inside the helpers use uv. Each build uses an independent
sdkconfig/build directory and verifies separate bootloader, partition and app
images. No merged image or flash command is executed. Preserve app size
`0x300000` and `cardid` NVS at `0x356000` / `0x4000`; the current device layout
must still be checked before any future partition-table write.

Final verification passed for all three build variants and their separate images.
The actual imported parser/classifier/key guard, portable core (10 groups),
independent table-clock regressions, real UI code under a finite scheduler, and
actual supervisor in normal/diagnostic configurations (five groups each) pass
with AddressSanitizer/UndefinedBehaviorSanitizer and warnings-as-errors. Nine
synthetic image-guard tests also pass. Host stubs exercise real application/UI
code; they do not prove FreeRTOS scheduling, LCD behavior, memory margin or radio
performance on a board. Independent static review findings on lock-time sampling,
two-queue input timestamps and loss visibility were resolved before final builds.

| Build | LCD/buttons | Scanner | App bytes |
| --- | --- | --- | ---: |
| Normal | Enabled, optional on failure | Stopped, awaiting setup/configuration | 305,152 |
| Diagnostic | Enabled, optional on failure | Explicit local-only Radar | 592,080 |
| Headless diagnostic | Disabled | Explicit local-only Radar | 481,040 |

Local evidence: `/tmp/campuspulse-refactor-host.log`,
`/tmp/campuspulse-refactor-<variant>-final.log`, the three
`/tmp/campuspulse-refactor-<variant>-images.json` files and
`/tmp/campuspulse-refactor-acceptance.json`. Image records contain offsets, sizes
and SHA-256 values. Hardware tests, flash, sustained radio/queue acceptance and
cloud end-to-end acceptance are **not run**.

## Remaining work at the stage-A snapshot

Items 1–3 below have since received a local software implementation; see the
[current chain and verification boundaries](firmware-chain.md). Hardware and
other-board acceptance remain pending, and USB provisioning is still planned.

1. Implement one network/BLE owner and protected provisioning: administrator Web
   Bluetooth on supported browsers; device-hosted SoftAP page for iOS; USB recovery
   into the same settings validation/storage. PWA alone adds no hardware API.
2. Implement runtime secret/profile storage, enrollment delivery recovery,
   desired config fetch/application/ACK and an explicit tested offline policy.
3. Add the versioned MAC/address-type summary contract, canonical aggregation,
   bounded raw evidence and durable independent ACK journals.
4. Verify the two S3 board families and all five collectors before adding
   durable manual markers and ePaper cards. Hardware tests remain separate.

See [platform design](../design/firmware-platform.md) for the full flow and
[reuse record](reuse.md) for inherited code/font boundaries. The original import
hashes in `UPSTREAM.json` refer to commit `82549b0`; later refactors are traceable
as changes from that snapshot. This stage-A snapshot still contains the old unverified font data and must not
be published. Current arrays were replaced under OFL-1.1 on 2026-10-25; see
[font replacement](../../firmware/fonts/README.md).
