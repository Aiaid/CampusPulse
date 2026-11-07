# Automatic startup and continued upload integration — 2026-11-06

Status as of 2026-11-07: bounded Waveshare saved-startup and repeated same-boot
renewal/upload acceptance passed. Both T-Energy boards automatically started and
uploaded, but their planned-cycle continuation remains unaccepted. No board is
currently enumerated over USB and current capabilities have expired; further
physical diagnosis requires reconnecting the targets. All times are
Asia/Shanghai (UTC+8). A passing build or first upload alone does not establish
continued operation across renewal or restart boundaries.

## Scope and release

The user requested direct production flashing followed by automatic-startup and
continued-upload testing. The main API/frontend and MQTT gateway already carry
the `f3ede69` control release; later `ce97236` and `b5eaeb1` record bounded
acceptance and repair the OpenAPI test inventory. Presentation changes are
excluded from this hardware test and publication. An independent simulator-only
release subsequently published main Worker version
`8452a0e2-986f-4475-971e-6eb4faf5e05b`, retaining the same static assets and the
physical-device control interfaces. Its source is `9634e93`; simulator results
are not counted as hardware evidence below.
Historical records, credentials, durable queues and original grant cutoffs are
preserved.

Hardware work is coordinated by device identity with one serial owner at a
time. The integration observer independently reads production D1 and public
aggregate APIs, and later owns the second T-Energy diagnostic update described
below. Private snapshots contain actual boot identities and immutable ACK/receipt
rows; public summaries omit identities and credentials.

## Waveshare

The exact board is Waveshare ESP32-S3-PICO-1 V2, 8 MiB Flash / 8 MiB PSRAM,
as checked against the [official Wiki](https://docs.waveshare.com/ESP32-S3-ePaper-1.54).
The hardware owner backed up and verified Flash and wrote only the application.

Initial `0.5.0` signed-clock bootstrap succeeded, but the subsequent formal
Wi-Fi connection still had a 30-second single attempt. It failed before device
registration. `0.5.1` uses the existing transport API with a 180-second overall
Wi-Fi deadline and three retries, without relaxing MQTT/HTTPS certificate checks.
Its application SHA-256 is
`c3ab9379d8b7d81f8e2bcbad448f4efe2bba34102140b3abd967ccd784326405`.

The `0.5.1` observer started at 18:15:40 and recorded no host console commands.
The new boot automatically used saved PEAP NONE settings, registered real
capabilities and applied generation 14. Three new windows reached production.
At 18:22:17 the independent D1 observer confirmed generation 15 applied under
the same boot, with place `9th`, dataset `field` and the explicitly selected
`cp-v3-vehicle-candidates/1` ruleset. Grant revision 3 migrated its source to
generation 15 while retaining the original 2026-11-13 15:44:11.110 cutoff.
At 18:23:13 a first generation-15 window had reached production, alongside
the three preceding generation-14 windows. The earlier latest status reported
zero window/event drops, upload/ACK failures and retries; these counters do not
establish complete radio reception or classifier accuracy.

The later `0.5.2` same-boot renewal result is recorded below; it does not change
the failed continued-operation conclusion for this earlier `0.5.1` run.

At 18:30–18:32, D1 still contained only seven windows for this boot (three under
generation 14 and four field windows under generation 15). The last received
field window was at 18:25:44.450. The passive console remained in the same boot
and later reported `ONLINE PAUSE`; repeated requests returned error 259
(`ESP_ERR_INVALID_STATE`) immediately, with no HTTP status or I/O. This run
therefore does not pass continued-upload or recovery acceptance.

The subsequent `0.5.2` application is 1,745,008 bytes, SHA-256
`04ea48f7e4fc347f508634c81c44ef3b268eb853d21c3c4606f2abb56a8fd2f4`.
It adds owner-only Wi-Fi recovery at a closed boundary, explicit local-rejection
bits and enough internal RAM for the unchanged cold MQTT safety floor by moving
the CPU-side LVGL object pool to PSRAM. SPI/DMA buffers and task stacks retain
their memory requirements. Initial whole-Flash comparison detected NVS changes
after an intervening maintenance boot. The hardware owner preserved that current
NVS, reconstructed the comparison image and verified it; no old ledger/profile
was restored. Application, boot/partition/PHY and protected tail were checked.

The formal command-free observer began at 18:50:29.131. New generation 17
registered at 18:50:57.727 and its real applied ACK arrived at 18:51:30.386.
It retained the field scope, ruleset and original grant cutoff. A pending old
generation-15 window was recovered under its original boot/scope rather than
relabeled. The host USB observer then disconnected at device uptime 114,334 ms,
with no recorded panic/backtrace. Power/USB intent was queried separately.
D1 nevertheless recorded observations past that monotonic point and later
increasing lease contacts. By 19:04:59 this same boot had ten received windows
and contact sequence 12. Upload failures/retries remain reported; the temporary
pause is not relabeled as uninterrupted capture.

At **19:11:04.272**, the same boot registered its second capability snapshot
with registration sequence 2. Generation **18** received its actual applied ACK
at **19:11:18.908**. The independent observer first saw a generation-18 window
under clock epoch **2** at **19:13:29**, distinct from the old generation-17
terminal window. At 19:14:25 there were 17 old-generation windows and two new
generation-18 windows, with boot-global window sequence advancing to 19. The
last old observation ended at monotonic 1,220,205 ms and the first new window
began at 1,266,151 ms: a reported closed renewal gap of 45,946 ms, not an
unobserved continuous scan claim. Grant revision 3/source 15 and its original
cutoff remained unchanged. Latest status retained zero window/event drops and
ACK failures, with 20 upload failures and two retries reported honestly.

This establishes bounded automatic saved startup, resumed uploads and an actual
same-boot time/capability/policy renewal followed by new-epoch uploads across the
former 20-minute stop point. It does not establish indefinite outage recovery,
all-day capacity or a new physical power-cycle test after installing `0.5.2`.

The 2026-11-07 13:09 read-only snapshot extends this evidence: the same boot
has nine real capability registrations and applied generations 17–25, with
clock epochs 1–9 and **161 accepted windows**. This is eight same-boot renewals.
The first-to-last observation span is 165.67 minutes (about 2 hours 46 minutes,
including closed gaps), with the last observation at **2026-11-06 21:37:43.479**
and last window receipt at **21:38:48.725**. Latest retained status 160 reports
zero window/event drops and ACK failures, 36 upload failures and two retries.
Grant revision 3/source 15 and its original cutoff remain unchanged. The current
capability is expired, so this historical success is not a claim of current
online state. The subsequent stop is not attributed to power loss, depleted
battery or a software defect without device evidence.

The public `9th` statistics endpoint also returned `no_field_statistics` despite
the accepted field windows. An independent read-only query confirmed two active
receivers: the stable primary had no field windows, while this Waveshare was
second. The test did not close another node's placement, change stable receiver
selection or publish the paused presentation changes to manufacture a public
result. This projection boundary is separate from the committed upload receipts.

## T-Energy

The hardware owner reports application `0.3.8-te-budget-recovery`. Generation 6
applied its explicitly approved 192 MiB logical-storage / 8 MiB uplink daily
budget without resetting prior ledger usage. A safe restart recovered the old
pending window with its original body, then automatically registered a new boot
and applied generation 7. Independent D1 evidence records the applied ACK at
18:12:39.342 and ten new generation-7 windows by 18:23:13, with increasing lease
contacts. This demonstrates automatic restart, old-body recovery and a bounded
sequence of new uploads.

The independently observed sequence reached 13 windows, last received at
18:25:50.192, then stopped advancing. Both T-Energy USB ports later disappeared
from host enumeration; their power state was not established. The user reported
reconnecting them, and T-Energy USB ports reappeared. The hardware owner re-mapped
ports against device identities; port numbers alone do not identify a board.
Missing cloud receipts during that interval are not attributed to a firmware or network failure without
device evidence.

After reconnecting and diagnostic serial-open reset, the original board
automatically applied generation 8 and uploaded fifteen new windows. Its last
observed receipt was at 18:55:17.552; the following planned refresh has not yet
been established by a new boot and window.

This firmware still uses `TE_SMALL_REFRESH_MS=1200000`: its planned refresh
closes the capture cycle and performs a real reboot. It is not a same-boot
continuous runtime. The planned boundary and next automatic upload remain under
observation. Logical budget ceilings are not physical Flash-write or endurance
measurements.

## Second T-Energy clock diagnostic

The additional board initially uploaded two generation-1 windows, then after a
diagnostic USB reset repeatedly failed automatic clock bootstrap. Existing logs
could not distinguish Wi-Fi/IP acquisition from tentative SNTP or the signed
HTTPS probe; a roughly 24-second failure alone is not proof of an SNTP failure.

`bootstrap.c` now logs only fixed owner phases, numeric result/cleanup codes,
elapsed time, current IP/hint flags and disconnect counters/reason. It logs no
SSID, account, key, request body or response, and changes no network source,
timeout, trust or authority behavior. The existing executed mock-SDK bootstrap
suite passed. The diagnostic S3 image was built from the frozen 0.3.8 budget
source plus this file, with `PROJECT_VER=0.3.9-te-clock-diagnostics`; it is not a
claim that the entire concurrent working tree was flashed.

The integration owner matched USB and ROM identities privately, confirmed the
initial USB configuration handler was waiting with no collector running, made
and verified a fresh 16 MiB backup, and checked the real partition table. Only
the application at `0x10000` was written. A complete readback matched the app;
the protected prefix (including NVS) and everything from `0x310000` onward were
byte-identical to the backup. The application is 1,230,304 bytes, SHA-256
`571f7e7b91623915df4ecea8230f76e4474c7ff41656cd39fdc55618a83c95cf`.

The passive diagnostic observer started at 18:59:21 with zero console commands.
Saved configuration obtained an IP, tentative SNTP hint and verified signed
clock in 40,897 ms, with zero reported Wi-Fi disconnects and successful cleanup.
It then restored the queue, registered a fresh boot, applied generation 2 and
uploaded new windows. Three new windows were independently present by 19:04:02.
This success does not establish the cause of earlier timeouts or prove that
adding diagnostics fixed their underlying cause. The bounded 20-minute restart
mechanism is unchanged.

The run subsequently reached **18 accepted generation-2 windows**, last received
at **2026-11-06 19:19:01.354**, and contact sequence 23. No later boot or policy
was registered. The passive console's last data was at 19:18:12; its host reader
eventually reported `Device not configured`. No terminal panic, successful cycle
closure or deliberate software-restart marker was captured. This does not pass
the planned 20-minute restart/continued-upload test, and it does not identify
the reason for stopping. No queue was erased or ledger reset to force recovery.

## Source and current follow-up

The shared/Waveshare implementation was committed and pushed as `c2556ea`.
T-Energy queue-budget recovery and the diagnostic clock phases were committed
and pushed as `6ba9ec3`. Both commits' hosted Check and deploy workflows passed
(`42209227905` and `42212522912` respectively); the preceding simulator workflow
`42205630586` also passed. The `6ba9ec3` production release published main Worker
`620f2510-d751-4eb5-8bbb-b2989be69eb6` and MQTT gateway
`0f417dd1-c3c1-4ce2-9af6-1311d104e32a`, with no updated static assets. These
software/release results do not change the physical T-Energy boundary above.

At the November 7 follow-up, host enumeration found no development-board USB
ports. The operator was asked to reconnect and keep the target boards powered.
Until that physical precondition is restored, inspect neither a stale serial
path nor an assumed replacement board, do not clear pending data, and do not
claim the T-Energy cycle or all-day operation passed.

## Evidence limits

The observer snapshots are retained in ignored
`captures/v3-overall-integration-20261106/`; the hardware owners retain separate
Flash/readback and passive console records. This note includes no network name,
account, device identity or secret. No arbitrary-power-loss, all-day operation,
battery endurance or exact people/vehicle count acceptance is claimed.
