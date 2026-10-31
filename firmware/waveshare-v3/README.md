# Waveshare v3 small-results collector

This separate ESP-IDF5.5.3 application targets the verified Waveshare
ESP32-S3-ePaper-1.54 V2 through the existing board/power/display adapters.
It boots into physical USB standby. A cable alone starts neither Wi-Fi nor BLE.
USB provides fresh nonce-bound identity/time and one-boot private settings.

The formal production path is native MQTT/TLS to the fixed Hangzhou EMQX broker
and the Cloudflare gateway bound to the real Worker/D1 service. No computer relay,
local proxy or direct production HTTPS fallback is used. The USB frame selects
`uplink_transport:"mqtt_tls"` and supplies `mqtt_uri`, `mqtt_username`,
`mqtt_password`, `mqtt_namespace`; the broker must equal the shared
`CP_MQTT_PRODUCTION_URI`. Missing/partial credentials, namespace injection,
custom CA fields and production HTTPS mode are rejected before networking.
The host defaults to MQTT and requires `--allow-production`, canonical
`CP_API_ORIGIN` and `tls:"public_ca_bundle"` in its private backend bundle.
Secrets are wiped after the run and are never logged or persisted by this app.

Nonproduction diagnostics may explicitly select `uplink_transport:"https"`
without MQTT fields. RFC1918 LAN tests retain the reviewed optional test CA;
public isolated tests require `--allow-public-test` and the system CA bundle.
Both transports retain strict certificate, hostname and date checks. Historical
HTTPS/DNS trials remain historical evidence and do not prove MQTT acceptance.

Capabilities declare only the actually selected uplink. A new policy's
`transport` must match both capability and runtime selection. The shared control
core exposes `mqtt_tls` to both board adapters; historical HTTP-authorized
frozen bodies may still recover their original receipts through MQTT without
changing their body, boot, sequence, policy hash or authority. Native transport
framing uses the existing request topic and a bounded CPV3 header internally;
MQTT PUBACK alone never grants collection or reclaims a durable queue record.
The full correlated Cloudflare receipt still passes the original strict matcher.
No synthetic HTTP Date is created for MQTT.

Registration freezes one body/sequence/uptime and permits at most three exact,
budgeted attempts with1s/2s backoff. Production selects the existing30s request
limit; isolated HTTPS retains15s. Explicit certificate flags and permanent4xx
responses terminate the exchange. Incomplete2xx and transient408/425/429/5xx
may retry exactly; complete2xx with an invalid receipt remains a strict failure.
Numeric failure logs include the selected transport, MQTT connection/PUBACK/
outbox/callback-stack state and transport errors, never credentials or payloads.

Persistent MQTT state/reply/frame buffers use explicit external memory. Before
capture allocation, the owner requests a transport memory phase: hot MQTT is
accepted only for an actually connected/subscribed session with an empty outbox.
Its internal floor retains20KiB plus the8200byte current frame and256byte margin,
and a17058byte largest block. Cold MQTT retains56KiB/20KiB, and isolated HTTPS
keeps its original56000/20000byte floors. The SDK IO gate is held only through
capture allocation, with no MQTT/transport calls while held, and always released.
Persistent external transport bytes count against the policy working budget;
PSRAM still needs512KiB free and a128KiB largest block after preparation. Phase
logs and real-device acceptance remain necessary; a build cannot prove headroom.

The first implementation applies one real small-statistics policy per boot:
30/60-second windows, 5-second bins, capacity up to512, and only
`cp-v3-stats/1` / `unclassified-v1`. All retained address/type keys are unknown;
no names, addresses, raw reports, or people estimates upload. Rolling history
is independent of window upload: up to10minutes/2second slices,512tracks,
64open events; terminal-only optional event uploads can outlive the history.
This runtime does not implement hot policy reallocation or revision scheduling;
unsupported policies receive a committed failed ACK, never fake application.

`cp_v3_capture` owns the nonblocking SDK callback and collector worker.
The storage task PEEKs handoffs, assigns UUID and boot-stream sequence once,
serializes at most2048bytes, commits the exact expiring queue body, then releases
that handoff. A full queue immediately pauses the collector and retains the same pending
identity. Resume requires every old handoff to be durable, matched against the
collector's actual last closed source sequence; it never uses a persisted count. Uncertain writes pause collection and retain the
original body/identity; they never regenerate or silently release data.
Backoff applies to each exact body identity. An older delayed or exhausted
request does not block later eligible batches. A recognized non-retryable
server rejection remains frozen and pending at its original TTL, with retries
deferred for this boot; it is neither reclaimed nor assigned a new identity.
The network owner copies frozen records under the TF mutex, releases it before
uplink, waits for conservative UTC aging, and requires exact durable receipts
before reclamation. Its first controlled window is retransmitted unchanged and
must return the same receipt. Attempts use bounded exponential delay and the
policy's persistent daily logical byte allowance. Separate node-scoped NVS
journals reserve storage and POST-body allowances before I/O, including retries
and control traffic. Uplink journal writes also consume the storage allowance;
its own metadata is conservatively included in its uplink reservation. Unused
reserved credit is consumed across reboot. Unknown time, an uncertainty interval
crossing midnight, quota exhaustion or uncertain journal commits stop admission.
Boot-local body/write counters remain diagnostics. Reboot replay preserves old boot/scope/body; historical
control receipts can reclaim records but cannot authorize this fresh boot.
Historical ACK/lease replay uses the transport's restricted
`X-Receipt-Only: 1` mode, so a missing original receipt produces a conflict
instead of creating a new ACK or lease. Live control requests do not use it.

Config ACK and explicit lease requests are durably frozen before HTTP. Both the
live control state machine and stateless frozen-body matcher must accept their
receipt, and queue reclamation must succeed before scanner start/deadline update.
GET/config, status, and replayed ACKs never renew authority. Workers only copy an
immutable trusted time anchor; they never call the owner-only transport clock.
Drift rounds once from that anchor. Unknown clock pauses upload/expiry decisions.
Initial small-window admission reserves future end-time uncertainty growth
before starting: an extra16ms for30s or31ms for60s windows, including integer-ms
rounding. A newly opened lease span repeats this guard. Repeated stop at a
completed boundary cannot create an extra partial window.

The private durable journal is `/sdcard/cpv3small`, with4window/4event/2status/
2control slots ×2048body bytes (24,576body bytes;262,144filesystem budget).
Old `/cpraw` and `/cpv3queue` directories remain untouched. Policies with events
off omit their event reserve; unused physical event slots remain reserved.
The exclusive `.logical-lifecycle-v1` marker binds the queue namespace to this
node and profile. An unmarked nonempty directory is rejected. Each new exact
CRC/SHA-validated record prepays creation and eventual ACK/TTL cleanup; that
bounded idempotent cleanup can finish after reboot or midnight without new
general credit. This is logical lifecycle authorization on the creation day,
not a physical Flash-write or wear guarantee for each calendar day.
Optional policy-controlled TF raw uses the independent `local_raw` adapter,
shared TF mutex and `/sdcard/cpraw-v3` only. Raw quotas, failures and counters
stay separate from aggregation; raw bytes never enter either uplink. Host clock alone
never produces a claimed verified RTC anchor: the board must set/read back its
RTC, and second-resolution quantization remains in the UTC uncertainty. Battery
voltage and a coarse percentage are displayed; ETA stays unknown without a
validated capacity/load model. Maximum supported raw segment is
1MiB, managed total32MiB, minimum free1MiB, sync interval1second.
After raw stops, the runtime reports final enqueued/written/synced counters
and verifies closed managed files with the read-only CRC API before unmount.
The aggregate verification includes older managed files and creates no probe
or metadata writes. CRC success establishes readable file integrity, not
arbitrary power-loss safety or radio completeness.

The screen restores the prior four-page layout: device diagnostics, BLE activity,
vehicle clues and elevator observation. Vehicle/wait predictions remain disabled.
The original native typography, occupancy bars, large rate, dots and RSSI plot
are retained. Rate bars show display samples, and the RSSI plot shows the latest
ten durable windows; captions do not claim a fabricated60second history.
SSID/IP/AP RSSI are local display snapshots only. Displayed RTC does not seed
the transport clock or grant collection authority.

BOOT short press cycles the four normal pages; USB standby adds a fifth page.
Hold BOOT2seconds to
stop to USB; PWR requests shutdown. Cleanup pauses and drains collection,
freezes outstanding handoffs, stops/drains raw, stops network, checks media sync
and unmounts before safe power release. An uncertain/unfinished writer blocks
safe power release. A new allocation/policy requires reboot; safe USB standby
shows this explicitly: HELLO returns `restart_required`, V3START is rejected,
and physical USB `RESTART` reboots only after safe unmount. PWR remains available after safe completion.
Bounded-test completion stays in USB standby; only an explicit PWR request
releases the power latch. The runner can request one safe restart before a new
nonce-bound bootstrap.

`max_windows=0` is continuous until stop/authority expiry;1..60 is an explicit
bounded trial. The shared capture worker enforces the final full-window boundary
before opening another window. The parent session owns `run_small.py`, hardware
review and actual controlled tests. This app has no device validation from a
passing build; interrupted writes, saturated RF/TF, prolonged offline operation,
lease gaps, hot reconfiguration and power-loss recovery still need acceptance.

Build with the existing `build.sh`, activated IDF5.5.3, and
`RAW_LVGL_PATH` pointing at the already installed LVGL component. For offline
bundled components set `IDF_COMPONENT_MANAGER=0`. Verify the separate app,
bootloader and partition images with `uv run verify_images.py BUILD`; never erase
or flash a padded image. Python tests use `uv run --with pyserial python -m unittest discover
-s firmware/waveshare-v3/localtests`. Tests are synthetic and perform no device,
serial, or network operations.

The runtime aging/retention/clock helpers have ASan/UBSan tests against the same
IDF cJSON parser. Board adapter implementations and redistributable fonts are
reused from this repository's Waveshare raw application; that source's existing
notices and provenance apply. No upstream source or font was imported here.
