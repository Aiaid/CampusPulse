# Passport performance evaluation and transport comparison

Follow-up: [BLE ingress decoupling and actual upload workload](ble-ingress-decoupling.md)
records the subsequent implementation and full-pipeline rerun. Results below
remain the original measured cohorts.

Status: bounded physical full-application profiles and matched LAN transport
measurements complete on one ESP32-C3, 2026-10-28 (Asia/Shanghai). The normal
build without profiling has been flashed with protected Flash verified and
observed through startup, BLE and cloud persistence. Public-path timeouts and
collector losses remain unresolved; this is not stable field acceptance.
These results do not establish other-board, long-duration or field acceptance.

The main ten-second upload regression came from display rendering preempting
TLS. Clipping glyph work, reducing normal refresh to 0.5 FPS and sending only
changed four-row stripes remove that measured display cost. Memory-budgeted
HTTPS reuse then improves the full application's observed upload capacity and
CPU margin. Collection still loses reports when window closing waits for the
shared network/memory gate. The matched protocol experiment finds no order-of-
magnitude advantage from replacing reused HTTPS with MQTT/TLS.

## Evidence and measurement boundaries

All device data, source/build snapshots, Flash images and numeric observations
remain private under ignored `captures/`. Publish this report, not credentials,
observations or raw Flash. The relevant evidence sets are:

| Evidence | Scope |
| --- | --- |
| `https-10s-20261028/` | Separate original-power/UI A/B/A experiments; request stages and frozen source |
| `memory-queue-20261028/profile-1/` | First 606-second full-application profile; weighted CPU summary is separate from the median summary |
| `memory-queue-20261028/profile-2/` | Second 606-second profile, version `per-a712a7045ef7`, with actual connection-reuse events |
| `memory-queue-20261028/optimized-timed-cloud-safe.json` | Same-boot cloud statuses selected by item uptime at or below 606000 ms; its receipt totals also include later data and are not the 606-second count |
| `transport-compare-20261028/matched-no-cpu-experiment/` | Same-host HTTPS/MQTT-TLS, 30 synthetic verified RAM receipts; no task-CPU instrumentation |
| `transport-compare-20261028/cpu-experiment/cpu-safe-summary.json` | Separate paired task-CPU profile, 46/46 verified synthetic receipts |

Task CPU uses FreeRTOS runtime-counter deltas on the single-core C3, weighted by
valid measurement interval. Busy time is `100% - idle%`. Counters attribute
interrupt time according to FreeRTOS and have a current-running tail; these are
measured task shares, not instruction-level exclusive costs. Stack low-water
values are lifetime minimum remaining bytes for known application tasks.
Optional profiling has its own scheduler/query/logging cost and is disabled in
the intended normal build.

Operation wall timers include blocking, preemption and overlapping work. In
particular, window close includes waiting for a shared memory/network gate;
adding it to network wall time would double-count. A heap sample, largest free
block, historical per-heap low-water sum and failed-allocation callback count
answer different questions. SDK low-water sums can combine minima reached at
different instants and must not be called simultaneous minimum free heap or
peak transport-owned allocation.

## Display: isolated cause and local rendering correction

The original UI ran on priority 5, ahead of network/control at 4 and uploader at
3. Rendering repeatedly traversed the entire glyph bitmap for every four-row
DMA stripe. Pausing only presentation/sampling in an instrument-only A/B/A run
kept `WIFI_PS_MIN_MODEM`, networking and allocation behavior unchanged:

| Original display state | n | Median request stages | Median connection + TLS |
| --- | ---: | ---: | ---: |
| Running | 6 | 10.558 s | 8.7885 s |
| Paused | 6 | 4.017 s | 2.641 s |
| Restored | 6 | 10.5565 s | 8.7855 s |

This reversible experiment supports the display-preemption diagnosis. The
separate power A/B/A gave 10.662 s with modem sleep, 8.728 s without it and
10.580 s after restoration: power mode contributed but did not explain the
whole regression. The historical UI's functional cloud acceptance did not test
its CPU cost; see [the original record and correction](device-debug-ui.md).

The renderer now clips text/digit work to the active stripe. Native real-font
checks preserve identical pixels on all five pages and reduce bitmap visits
from 6880000 to 86000, an 80-fold reduction. Host CPU time falls from
8.50–8.54 to 0.437–0.458 ms per full frame, approximately 19-fold. This host
microbenchmark is separate from the C3 physical task profile below. Normal
presentation is limited to 2000 ms between refreshes (0.5 FPS), with immediate
page/setup/critical-state changes. Four-row dirty stripes avoid transferring
unchanged regions while retaining the existing 3840-byte double DMA buffers;
there is no full framebuffer allocation.

## Full application: two adjacent 606-second profiles

Both profiles include real BLE, UI, collector/encoder, Flash journal, normal
control traffic, strict public HTTPS and verified application ACK handling.
They are adjacent physical runs with different backlog, radio observations and
implementation changes; this is an observational comparison, not a single-
variable randomized experiment. Both already contain the main display fix.
Use the original UI A/B/A above to isolate display causality.

| Metric | First profile | Second profile |
| --- | ---: | ---: |
| Observation duration | 606 s | 606 s |
| Weighted CPU busy | 42.430% | 31.113% |
| Supervisor/UI task | 1.512% | 1.575% |
| Network task | 8.614% | 8.796% |
| Upload task | 25.400% | 13.993% |
| Collector task | 0.832% | 0.841% |
| NimBLE task | 0.251% | 0.259% |
| Wi-Fi task | 2.177% | 2.148% |
| TCP/IP task | 0.453% | 0.431% |
| ESP timer task | 2.531% | 2.449% |
| HTTP completions | 126 | 158 |
| Actual reused sockets | 0 | 73 |
| Failed-allocation callback count | 0 | 0 |
| SDK historical 8-bit per-heap low-water sum | 12472 B | 18956 B |
| Observed crash | No | No |

The second run's valid CPU intervals total 540.891 s; startup/invalid samples
are excluded rather than assigned zero. The first profile uses its separate
`weighted-cpu-safe-summary.json`, not medians in the earlier baseline summary.
New control and USB tasks in the second profile account for 0.111% and 0.044%.
Network and upload tasks can execute different requests; their CPU shares are
not pure TLS costs. The 11.317 percentage-point busy reduction and increased
completion count describe these two cohorts only.

The second profile has 123 verified upload completions and one preserved
historical batch rejection. Its 158 HTTP completions include control requests;
HTTP success and verified ingest ACK are separate. Actual reused-request median
is 1331 ms versus 3985 ms for requests opening new sockets. A cached SDK handle
alone is not socket reuse. Reuse is bounded by memory/contiguous headroom,
verified ACK, completion count, lifetime and idle limits; control, encoding,
radio lifecycle or failures can release it safely.

Second-profile minimum remaining application stacks were supervisor 3748 B,
network 2144 B, upload 1688 B, collector 2304 B, control 7336 B and USB 4012 B.
No failed-allocation callback or memory pause was observed. This bounded result
supports improved operating margin, without proving allocation success under
all future fragmentation, radio reinitialization or enterprise reauthentication.

The normal SDK configuration sets `CONFIG_MBEDTLS_SSL_KEEP_PEER_CERTIFICATE=n`.
This releases retained peer-certificate copies after certificate-chain
verification; it does not disable trust, name or time checks. See the pinned
[ESP-IDF 5.5.3 Kconfig reference](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32c3/api-reference/kconfig-reference.html#config-mbedtls-ssl-keep-peer-certificate).
Full PEAP reauthentication under this configuration has not been verified.

## Remaining collection and queue bottleneck

At device uptime 592142 ms, the second profile's serial quality snapshot reports
10390 observed reports, 150 BLE callback queue drops, zero collector observer
rejections and queue high-water 64/64. These counters identify a bounded ingress
queue overflow, not an exact missed-radio count. Window close holds the
collector while it waits for network/memory admission and persists encoded
batches. Its 18 observed operations total 38.810 s wall time, with an 8.303 s
maximum. Its CPU task share is only 0.841%; faster CPU alone does not remove the
wait. The original priority/display regression and the remaining producer/
consumer backpressure are separate findings.

Same-boot cloud status items within the 606-second experiment show:

| Device uptime | Shared pending slots | Interpretation |
| --- | ---: | --- |
| 48.010 s | 195 | Early backlog sample |
| 380.581 s | 179 | Partial drain while collecting |
| 591.845 s | 171 | Last cloud status within the observation cutoff |

The last item contains one pending window and 170 address-summary batches,
44792 B sampled free heap, running scan and connected Wi-Fi. It reports zero
storage/window/upload/ACK failures, 138 aggregation drops and 3821 reports
omitted from the bounded 16-address table. The later serial callback count of
150 has a different sampling instant; address-table omissions are also a
separate metric and cannot be added as additional lost callbacks. Journal
used/unacknowledged physical-slot bytes fall from 2396160 to 2101248 B over these
samples. They are slot storage, not JSON body size. The retained historical 422
slot remains pending. Backlog decreases in this bounded cohort, but sustained
zero-loss equilibrium, complete backlog drain, storage-exhaustion recovery and
reboot behavior still need acceptance. Unknown growth-rate/time-to-full values
remain unknown.

Journal append/read/ACK operations in the second profile respectively total
2.743 s/0.249 s/0.023 s wall time. UI rendering totals 6.829 s over 266 renders,
maximum 44.090 ms. Submitted LCD data totals 11569920 B across 6026 stripes;
this counts transfers rather than synchronous SPI CPU time. These operation
intervals overlap task execution and must not be summed into a CPU utilization
percentage.

The historical HTTP422 is independently explained by one immutable 3831-byte
candidate with `last_offset_ms == duration_ms == 1970`, violating the half-open
window. Exact-byte local workerd/D1/R2 replay rejects it atomically. Original
online request/response correlation was not retained, so this is the unique
matching queued candidate plus a real local reproduction. The old slot stays
frozen and unACKed; current encoder batches use the corrected boundary. See
[rejection provenance and memory changes](memory-queue-recovery.md).

## Matched HTTPS versus MQTT/TLS

This experiment uses two listeners on the same physical LAN host, the same
ECDSA P-256 certificate/CA, TLS 1.2 cipher, strict name/date/trust checks,
`WIFI_PS_NONE`, passive BLE scanning 20 ms per 100 ms, and identical 1024/8192-
byte synthetic bodies and SHA-256 application receipts. MQTT uses native
ESP-MQTT 3.1.1, QoS1, one outstanding message and a 1024-byte output buffer;
HTTPS uses HTTP/1.1 keep-alive. TCP_NODELAY is aligned on the listeners. Neither
UI, production journal nor cloud ingestion runs in this diagnostic.

The receipt proves the server process checked bytes in RAM. It does not assert
disk, D1/R2 or durable delivery. MQTT PUBACK and the correlated application
receipt are both required. A production migration would still need the current
batch/hash/count durable-receipt invariant before reclaiming device storage.

| Payload | HTTPS new connection | MQTT new connection + SUBACK + message | HTTPS warm | MQTT warm |
| --- | ---: | ---: | ---: | ---: |
| 1 KiB | 1322.034 ms (n=1) | 1304.996 ms (n=1) | 71.798 ms (n=6) | 74.998 ms (n=6) |
| 8 KiB | 1231.332 ms (n=1) | 1326.394 ms (n=1) | 64.965 ms (n=6) | 79.926 ms (n=6) |

Values are medians. All 30 expected receipts succeeded, including the two HTTPS
priming requests excluded from the table. Fresh n=1 is exploratory, not a latency
distribution or evidence that either protocol wins a cold-connect comparison.
Lifecycle timing is slightly different: HTTP begins after client initialization;
MQTT includes native client task startup and SUBACK. The cleaner warm comparison
shows similar scales, with no measured MQTT advantage in this small cohort.

The active MQTT implementation consumes approximately 8.1–8.5 KiB more sampled
heap than the matched HTTPS connection, including its 6144-byte task stack and
1568-byte receipt queue. This is a configured implementation comparison under
concurrent BLE/Wi-Fi allocations, not MQTT's theoretical minimum memory or an
exact isolated allocation census. Transient per-heap low-water differences
cannot be reinterpreted as transport-owned peak heap.

Preserve earlier exploratory runs separately: `esp_mqtt_client_enqueue()` left
transmission waiting on the SDK worker's transport poll and added about one
second in that implementation; direct publish avoids that wait. Unaligned
Nagle behavior also added approximately 130 ms before TCP_NODELAY was matched.
Neither delay is an intrinsic MQTT wire cost. The pinned
[ESP-MQTT API documentation](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32c3/api-reference/protocols/mqtt.html)
distinguishes blocking direct publish from queued worker transmission and
documents MQTT/TLS, subscriptions, keepalive and QoS support.

The later [actual workload audit](ble-ingress-decoupling.md) finds historical
sampled-raw logical batches around 10.3–10.7 kB, whose original POST lengths
are unavailable. They fall outside this diagnostic's 8 KiB maximum. Current C3
raw-off traffic instead splits roughly 12.4 kB per 30-second window into five
requests. The table is a bounded per-request comparison, not acceptance of
that full cadence, backlog recovery or the older raw format.

### Separate instrumented task-CPU comparison

A separate 18.066-second profile completed 46/46 expected receipts, with ten
warm samples per protocol/size. The same profile is enabled for both protocols.
The observer reads main and native MQTT task runtime counters, with no heap
allocation, new observer task or stack walking. It yields main for one tick
before each snapshot to charge its running tail. These two yields are outside
the request-latency window but perturb scheduling and the CPU sample interval.

| Warm payload/protocol | Main-task CPU median | MQTT-task CPU median | Median per-request task sum |
| --- | ---: | ---: | ---: |
| HTTPS 1 KiB | 8.193 ms | Not applicable | 8.193 ms |
| MQTT 1 KiB | 5.066 ms | 8.3265 ms | 13.2345 ms |
| HTTPS 8 KiB | 14.865 ms | Not applicable | 14.865 ms |
| MQTT 8 KiB | 19.084 ms | 8.510 ms | 27.530 ms |

The rightmost column first sums the two task counters for each request, then
takes the median; adding the two independent medians is not equivalent. BLE,
Wi-Fi, TCP/IP, other tasks and complete system CPU are outside this sum. ISR
attribution and the small remaining current-task tail limit exclusive ownership
claims. The measured native MQTT implementation uses more of these tasks' CPU
in this run; this is not MQTT's theoretical minimum or a total-system estimate.
Fresh connections attribute roughly 953–963 ms to HTTPS main and 963–967 ms to
the MQTT task, consistent with TLS handshake work dominating cold connections.
Their fresh lifecycle coverage differs slightly and n=1 remains exploratory.

Two empty controls observe 14/24 microseconds of main-task CPU, 6/10 microseconds
of counter-read wall time and approximately one millisecond snapshot intervals
from the yields. They are observer controls under live BLE/Wi-Fi, not a value to
blindly subtract from every request. The profile sees 152 BLE reports received
and processed, zero queue drops/aggregation rejections/scan errors, queue
high-water 21 and no crash. This short isolated run does not supersede the
full-application ingress-loss result above.

Warm nearest-rank P50 wall latency in this CPU-profile cohort is HTTPS/MQTT
75.049/60.532 ms for 1 KiB and 83.670/108.511 ms for 8 KiB. Keep it separate from
the no-CPU-instrumentation n=6 table: scheduling, instrumentation and radio
conditions differ. Selecting the favorable 1 KiB MQTT result alone would not
establish a protocol winner. The no-CPU baseline remains the primary latency
comparison; this profile supplies the requested task-CPU evidence.

## Final normal image

The normal image `fix-ccdcdd467c0b` is 1553520 B, SHA-256
`7f2c840bca45c30ed81b2df97b63d778f3c7b0a2c06a0e56098fbe66671620bf`.
Only the app partition was written, followed by complete 8 MiB expected-image
verification; bootloader, partition table, NVS, `cardid` and the current journal
are preserved. Profiling, FreeRTOS trace and runtime statistics are disabled.
Peer-certificate retention is disabled while chain, date and hostname validation
remain enabled. Boot reports the expected version. Two observations of 156 and
155 seconds, separated by an unobserved interval in the same boot, confirm saved
credentials and display/input/battery initialization. There is no observed
crash, allocation failure, memory pause or active profiling output. Initial
cloud requests repeatedly time out at approximately 12 seconds with about
106 KB free heap. Policy fetch succeeds at uptime 147.6 seconds and BLE starts
at about 148 seconds. The two observers see 28 HTTP completions, one actual
socket reuse, four verified upload ACKs for preserved earlier-boot data, four
retry outcomes and the one preserved historical 422 rejection. Buffered UART
completions may precede observer attachment; these counts are not a throughput
estimate for a continuous 311-second interval.

Same-boot D1 independently contains two fresh windows and one status. Thus new
data reached durable cloud storage even though the observers did not see a
validated ACK for those current-boot batches. Their timeout/retry state must
not be treated as proof that the server rejected or failed to store them.
The status at uptime 189974 ms reports running scan, connected Wi-Fi, pending
170 slots and one upload failure. Later UART at 332660 ms reports 615 callback
queue drops, 3700 observed reports, zero collector rejections and high-water
64/64. This poor-path cohort clearly fails a zero-loss/stable-network criterion;
it does not replace the earlier two complete 606-second performance profiles.

Concurrent Mac controls bind physical Wi-Fi `en0`, bypass Stash and fix each
real Cloudflare IPv4 address: four health requests succeed in 0.997–5.480 seconds;
two existing-proxy requests take 0.832–0.865 seconds. This establishes variation
on the host's direct path, not the exact cause of every device timeout. Health
also excludes authenticated ingest/database work. Firmware configuration differs
from the optimized profile only in the profiling/FreeRTOS statistics flags;
no matched firmware A/B isolates this later deterioration. Evidence is private
under `memory-queue-20261028/final-normal/`, including
`acceptance-safe-summary.json`, the paired Mac control and `continued/` cloud
records. Physical navigation through every page has not been tested;
input/navigation coverage is native regression evidence. The device is left
running this normal image; the temporary benchmark server is stopped.

## Next decisions and acceptance

Keep memory-budgeted HTTPS reuse as the measured first optimization for this
application. MQTT becomes attractive when persistent subscriptions, server
push, broker routing or QoS/session behavior are required. It has not shown a
large performance benefit over reused HTTPS here. A domestic relay can change
network reachability independently of transport choice; validate both network
legs and durable receipts rather than attributing route improvements to MQTT.
Ordinary public Workers cannot directly act as a native MQTT TCP broker; see
[the existing Cloudflare capability review](cf-longlink-benchmark.md). MQTT would
need an additional broker/relay service. No production migration occurred.

Remaining field/reliability acceptance (future work beyond this performance
evaluation):

- Resolve the normal-image public-path timeout/recovery behavior and verify
  current-boot ACK/reclamation, interruption recovery and sustained operation;
  startup/BLE/cloud persistence and protected-Flash checks are recorded above.
- Remove the collector's multi-second admission wait from the ingress-drain
  path or otherwise bound it, then rerun callback losses, close duration,
  queue high-water and producer/ACK balance under matched load.
- Test network interruption, reconnect, full PEAP reauthentication, reboot and
  long-run journal reclamation; retain rejected historical data and explicit
  loss/error accounting throughout.
