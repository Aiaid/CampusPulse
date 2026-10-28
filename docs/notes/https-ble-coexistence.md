# BLE scanning and reused HTTPS coexistence

Status: the concurrent upload run completed; an unexpected reset occurred during
its original cleanup path. A revised cancellation-only completion passed a
separate short regression. Original full-Flash restoration and original-version
boot checks passed. This
extends the [isolated LAN baseline](https-lan-benchmark.md), without claiming
acceptance of the production Flash pipeline or full BLE deinitialization.

## Controlled workload

The user authorized a local experiment on 2026-10-26 to check connection reuse
while BLE collection and uploads overlap. The temporary diagnostic starts real
NimBLE passive scanning (100 ms interval, 50 ms window, duplicates unfiltered),
a bounded 64-report RAM queue and a worker using the existing `cp_collect` and
`cp_vehicle` aggregation/parser code. Ten-second windows, one-second bins,
64 addresses and disabled raw retention bound the aggregation state. The same
SDK and reduced NimBLE pools as the existing Passport reference are used.

Radio observations remain in RAM and are cleared during draining/window changes
and shutdown. No address, name, AD payload, address hash or real observation is
logged or uploaded. The HTTPS bodies are deterministic synthetic 1 KiB/8 KiB
buffers, independently verified by exact length and SHA256.

Each of four payload/connection groups has 20 POST slots. Target POST start
cadence is two seconds, with no catch-up burst after a slow request. Reuse is
primed by a separate health request and keeps its connection during the idle
intervals. Scanning and aggregation continue during TLS handshakes, requests
and idle time. Five seconds of real scanning precedes TLS measurements.

The client retains strict local CA, IP SAN and certificate-date checks and the
positive/negative trust controls. HTTP settings match the production reference:
12-second connection budget, one-second connected I/O, 20 ms asynchronous retry
interval and 1024-byte HTTP buffers. The server uses TLS 1.2, HTTP/1.1 persistent
connections and TCP_NODELAY. The application deadline remains cooperative.

## Evidence and boundaries

Per-request and per-phase counts distinguish received, enqueued, processed,
queue drops, aggregation rejection, omitted address summaries, window turnover,
scan errors and resets. A request may process reports queued before its start,
so endpoint deltas are not a one-to-one attribution of reports to that request.
After successful shutdown/draining, accounting should satisfy:

- received = enqueued + queue drops;
- enqueued = processed.

Positive radio activity during each phase establishes observed concurrent load,
not reception completeness. Address-table omission is distinct from losing an
entire report or window. Counter endpoints are captured before serial output.
Queue RAM clearing adds bounded diagnostic overhead.

This experiment does not initialize production UI, enrollment, control leases,
Flash journal, backlog reclamation or cloud ingestion. Settings initialization
uses a read-only NVS partition descriptor; Wi-Fi and NimBLE NVS persistence,
PHY calibration persistence and controller/HCI logs are disabled. A new complete
8 MiB backup is verified before app-only flashing, and the original application
and full Flash are checked on restoration. No merged image or whole-chip erase.

## Physical result

The main run's device summaries reported 80/80 verified POSTs. The local server
independently recorded 80 complete benchmark requests with HTTP 200 and response
writes in that first run (40 of each payload). One individual new-connection
8 KiB UART metric line was not retained by the strict observer; 79 individual
POST records survived, in addition to all four complete on-device summaries.
Do not invent the missing individual measurement or mix in later reboot data.
P50/P95 below are the device's nearest-rank sample summaries, 20 per group.

| Payload | Connection | Successful slots | P50 complete request | P95 complete request |
| --- | --- | ---: | ---: | ---: |
| 1 KiB | Fresh TCP/TLS | 20/20 | 1,241.163 ms | 1,401.916 ms |
| 1 KiB | Existing connection | 20/20 | 78.215 ms | 153.759 ms |
| 8 KiB | Fresh TCP/TLS | 20/20 | 1,371.118 ms | 1,518.948 ms |
| 8 KiB | Existing connection | 20/20 | 118.930 ms | 250.634 ms |

Both reuse groups reported zero connection events across all 20 POSTs, after
their separate successful initial health handshakes. All four phases reported
active scanning, no NimBLE reset/scan error, no application queue drops,
aggregation rejects or omitted address summaries. Their report counts were
1,075 / 1,108 / 1,167 / 1,101, totaling 4,451 over the measured phases; these
exclude warmup/control intervals. Queue highwater was two of 64 entries.
No conclusion about RF completeness follows from zero application drops.

Among captured POST records, the SDK internal-heap minimum metric stayed at
least 105,164 bytes, and the sampled largest internal block at least 94,208
bytes. This excludes any unavailable per-request minimum for the lost UART line
and does not represent production UI/journal/backlog memory pressure.

### Original cleanup reset and separate regression

The last main-run phase ended at observer time 166.126 s; another `LAN_BOOT`
appeared at 166.483 s, before `LAN_STOP` or `LAN_DONE`. The original observer
did not retain a raw reset reason/backtrace, so the cause is unproven. SDK
stop/deinitialization was in progress, but neither that attribution nor an
interrupt-watchdog cause is established. Subsequent reboot measurements are
preserved separately and excluded from the main-run table.

The diagnostic completion path was narrowed: seal callback ingress, cancel and
confirm inactive scanning, drain/acknowledge the aggregation worker and clear
application observation buffers. It deliberately does not call
`nimble_port_stop` or `nimble_port_deinit`; the host/controller remain allocated
idle until the subsequent hardware reset for original-app restoration.
Output explicitly records `runtime_retained=1 full_deinit=0`. This is a benchmark
completion strategy, not a production BLE teardown fix.

A separate two-slot-per-group regression verified 8/8 POSTs, all nine stop stages,
inactive scanning, stopped worker, cleared application buffers and no observed
unexpected reboot. Final counters reconciled: 499 received/enqueued/processed,
zero queue/aggregation/address-table drops, no scan errors/reset, queue highwater
two. The workload and request path were unchanged; only completion and diagnostic
reset/stage reporting changed. Short-regression timings are not substituted for
the main performance table.

The completed image contains only the custom settings/aggregation/vehicle
components; production pipeline/journal/network tasks are absent. Fresh BLE-on
and BLE-off builds passed. Effective configuration, source/object consistency
and independent read-only review passed before flashing. Private backup/build/
trust material and safe numeric traces remain under the ignored
`captures/https-lan-ble-20261026/` directory.

### Device restoration

A new complete 8 MiB backup was verified before this experiment, preserving any
new production data since the earlier baseline. Only app images at `0x10000`
were written; whole-Flash verification after the unexpected reset and again
after the final diagnostic confirmed unchanged non-application bytes.

The narrowed image was smaller than the earlier diagnostic; its now-unused
application tail sector was separately restored from the original backup before
the final run. On completion, 1,224,704 bytes of original application sectors
were restored, and whole-Flash verification matched the new original 8 MiB
backup exactly before boot. No bootloader/table, NVS, `cardid` or queue writes
were made. Original `cp-aa1b3ec36d40` was observed at boot, with two successful
USB status reads in the same boot, saved credentials present and no crash
marker. The initial post-restore network observation was still retrying Wi-Fi
authentication; restored startup is not proof of resumed field collection.
Later read-only snapshots advanced to repeated TLS connection attempts, so the
initial authentication failure was not the final observed stage. No successful
post-restoration public upload is established by these snapshots.
The local test listener has been stopped. No production code or protocol
migration was deployed by this experiment.

## Transport and relay follow-up

Persistent HTTPS already amortizes TCP/TLS setup. A domestic relay changes the
network path; choosing MQTT, WebSocket or Socket.IO is a separate transport and
delivery-contract decision. A relay may be useful without replacing the current
HTTPS batch protocol.

Socket.IO adds its own framing/Engine.IO behavior and is not wire-compatible
with plain WebSocket clients. ESP-IDF 5.5.3 includes an ESP-MQTT client with TLS,
keepalive and QoS support. For a device-oriented replacement, evaluate MQTT/TLS
before adding a Socket.IO implementation; neither removes the initial secure
connection or guarantees an arbitrary public route will work.
Sources: [Socket.IO introduction](https://socket.io/docs/v4/),
[ESP-MQTT](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32c3/api-reference/protocols/mqtt.html).

Transport receipt is separate from application durability. Socket.IO defaults
to at-most-once arrival; stronger persistence/replay needs application work.
MQTT QoS or a relay receipt alone does not prove that the intended batch is
durable in Cloudflare. Preserve immutable batch identity, body hash, idempotency
and explicit receipt validation. If the relay persists locally and later
forwards to Cloudflare, distinguish local durable acceptance from cloud durable
acceptance. Do not reclaim production device data on a new intermediate ACK
without an explicit revised custody/retention contract.
Source: [Socket.IO delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/).

No domestic relay, protocol migration or production connection-reuse change has
been deployed by this controlled experiment. Both network legs and the chosen
host/provider still require a separate measured decision.
