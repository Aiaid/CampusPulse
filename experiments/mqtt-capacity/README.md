# Offline MQTT capacity experiment

These tools encode synthetic inputs through the actual production C collector,
codec and ESP-IDF cJSON. They make no network calls, inject no cloud records and
do not change capture policies. Output contains aggregate safe metrics only.
No credentials, live addresses or raw observations are read or retained here.

Run from the repository root with ESP-IDF 5.5.3 installed:

```sh
mkdir -p captures/mqtt-capacity
IDF_PATH=/path/to/esp-idf-v5.5.3 bash experiments/mqtt-capacity/run-codec.sh \
  > captures/mqtt-capacity/current-codec.jsonl
node --test experiments/mqtt-capacity/*.test.mjs
node experiments/mqtt-capacity/model.mjs \
  captures/mqtt-capacity/current-codec.jsonl captures/mqtt-capacity/current-capacity
```

The compiler runs AddressSanitizer and UndefinedBehaviorSanitizer. Node emits
CSV and JSON with all inputs. Its optional final argument is a JSON object, e.g.
`'{"rpcMs":2100,"controlRpcsPerMinute":2,"retryMultiplier":1.05,"days":1}'`.
Changing these numbers is arithmetic only, not a policy change.
The default budget horizon is 30 days. Setting `days` shorter evaluates that
active period against the same full monthly allowance; it does not reset actual
consumption or establish the deployment's remaining quota.

For a byte-preservation comparison, set `CP_CAPACITY_EMIT_BODIES=1` and redirect
stderr to a temporary/ignored JSONL file; stdout remains aggregate metrics.
`CP_CAPACITY_CODEC_SOURCE=/path/to/old-codec.c` compiles a selected historical
codec in place of the current file. `CP_CAPACITY_UNKNOWN_CLOCK=1` adds the same
72 workloads with unknown UTC/uncertainty. Run `node
experiments/mqtt-capacity/compare-bodies.mjs OLD_BODIES.jsonl NEW_BODIES.jsonl`.
It compares ordered items as exact serialized strings and parsed structures,
plus every non-items envelope field except regenerated `batch_id`. This detects
changed nulls, counters, evidence, time fields, order and key/number formatting.
All bodies contain only synthetic fixtures; keep generated body files in the
ignored capture directory or a temporary directory.

## Inputs and provenance

The 72 cases cover 16/32/64 identities, 10/30/60-second windows, five-second
bins, 1/2/5/10 **received** reports per address per second, and raw off/on.
Synthetic addresses are local test identifiers. Each report has a valid,
31-byte legacy AD payload (flags and zero padding), RSSI -65 dBm and a monotonic
timestamp. Placement/config IDs each contain 36 ASCII characters. The clock is
known, with numeric UTC/epoch/uncertainty; sequence numbers have seven digits.
Actual encoding length depends on these values, field lengths, evidence and
counter digits. These cases are reproducible workloads, not worst-case sizes.
Reports are admitted directly to the collector without a BLE callback queue or
radio. A 640-report/s host case establishes no physical radio acceptance.

Raw-on selects the first four reports/window, with every other report marked
intentionally omitted. This matches the supported maximum of four selected raw
reports/window, not unlimited raw collection. The fixture encodes all four in
one batch; production age-triggered early flushes can split that batch and cost
additional RPCs. Intentional omission is separate from raw loss.

One window and one status record are emitted per window, matching normal sealed
window persistence. The status uses zero pending records and 50,000 B free heap
as **synthetic serialized values**, not measurements. Active/sealed C3 collection
RAM uses the documented static-core accounting `8192 + 2*N*B*4 + 780` B. The JSON
allocator measures requested host bytes only; host cJSON node sizes, allocator
metadata, C3 fragmentation, network buffers and stack cannot be inferred from it.
The CSV separately calculates the unchanged MQTT admission floor from
`mqtt_rpc.h`: before allocating the body, free bytes must cover `2*body + 22786`
and largest block must cover `max(17058, body+256, body+1)`. This includes the
immutable caller body plus the separate QoS1 outbox copy. Larger packed bodies
can lower encoder peak yet raise this publish-admission requirement. This floor
is source arithmetic, not proof of actual heap availability or a worst-case peak.

The frozen `baseline-codec.jsonl`, `baseline-unknown-codec.jsonl` and derived
known-clock `baseline-capacity.csv` use commit
`33c12b9560881e70fa5f22beb1fd72a51fff4240`, before dynamic summary packing. Source
SHA-256:

| Input | SHA-256 |
| --- | --- |
| `firmware/components/cp_pipeline/codec.c` | `7bb106e6a2464591068969d846eee5aa9e2a92289772e88342f3a9b88815b6ae` |
| `firmware/components/cp_pipeline/codec_status.c` | `40130a88cc5d882a47dbe99ab92879fea08d0d339c61fe3d2c2459558cce9329` |
| `firmware/components/cp_collect/cp_collect.c` | `6570561f4168d22ae6665141fa25ecc73fd0afbbb9542321fa502ccfda2cd1cb` |
| ESP-IDF cJSON `cJSON.c` | `298581a04a36c0165da4b0aade235c23088cb2faa58651d720ea2f3706ed0b0d` |

ESP-IDF tag is `v5.5.3`; cJSON revision is
`c859b25da02955fef659d658b8f324b5cde87be3`. These sources are compiled in place;
the experiment copies no third-party source.

The packed working-tree snapshot is identified by codec SHA-256
`8fa7f029cd6fb4b714a4fe7b0d5e420f088af2bab0369d0cf59b3d398e93c565`.
`packed-codec.jsonl` and `packed-unknown-codec.jsonl` retain 72 cases each;
`packed-capacity.csv` contains both clock states (144 rows). Other source hashes
above are unchanged. ASAN/UBSAN pass for all four runs. Differential comparison
of the two clock states passes 504 workload/stream groups and 5952 exact items;
aggregate batch count changes from 1320 to 840. Ten Node tests validate arithmetic,
all baseline fixtures and rejection of deliberately corrupted comparisons.

## Frozen packing comparison

The following known-clock, raw-off, 1 Hz/address cases show observed codec output
and modeled service utilization. Service assumptions remain the historical warm
median 1958.5 ms + 1000 ms yield, no controls or retries. Bytes are total JSON body
bytes/window. Do not use this table as hardware acceptance.

| Addresses | Window | Old RPCs | Packed RPCs | Old bytes | Packed bytes | Packed utilization |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 16 | 10 s | 5 | 4 | 12133 | 11765 | 1.183 |
| 16 | 30 s | 5 | 4 | 12277 | 11909 | 0.394 |
| 16 | 60 s | 5 | 4 | 12469 | 12101 | 0.197 |
| 32 | 10 s | 8 | 5 | 21957 | 20853 | 1.479 |
| 32 | 30 s | 8 | 5 | 22245 | 21141 | 0.493 |
| 32 | 60 s | 8 | 5 | 22633 | 21529 | 0.247 |
| 64 | 10 s | 13 | 7 | 41237 | 39029 | 2.071 |
| 64 | 30 s | 13 | 7 | 41817 | 39609 | 0.690 |
| 64 | 60 s | 13 | 7 | 42585 | 40377 | 0.345 |

At 64/30 s, raw on adds one four-report batch in these fixtures (7 -> 8 RPCs).
The packed summary maximum is 14 items at 1 Hz/address and 13 at 2/5/10 Hz/address;
larger counter/evidence values or identifiers can change that grouping. For this
30-second fixture, host requested JSON peak falls 19100 -> 11631 B. Maximum body
increases 3692 -> 8124 B, so the unchanged MQTT pre-body free admission floor
increases 30170 -> 39034 B. Hardware must establish available headroom.

Every default packed case's traffic floor exceeds one full free 1 GiB allowance
over 30 days. At 64/30 s, 1 Hz/address and raw off, the floor is 7.545 GiB/month;
one fresh 1 GiB allowance therefore permits at most 95.43 sensor-hours, or 19.09 h
for five such sensors. These are optimistic upper bounds before replies/framing,
TLS/HTTP, controls, retries, other workloads and previous consumption. They say
nothing about the deployment's actual remaining allowance.

## Interpretation

The default RPC service input, 1958.5 ms, is the historical successful-warm-RPC
median from [the bounded C3 MQTT release](../../docs/notes/mqtt-production.md).
It includes gateway/backend/reply processing and is not a guaranteed service
bound or an arithmetic mean. The 1,000 ms uploader yield comes directly from
`pipeline.c`. Controls, retries and persistence costs are initially omitted.
Utilization is therefore an optimistic planning scenario, not a measured queue
slope, sustained throughput or acceptance decision. The 20-second RPC timeout
does not mean each RPC takes 20 seconds or guarantees one successful batch/20 s.
Unknown backend capacity is represented as null, not unlimited.

Five-second bins are within-window resolution. They do not cause five-second
uploads. Report freshness includes the full window, persistence/handoff, queued
RPC service, controls/retries and the frontend's own polling interval.

All cases obey 8192 B request/12288 B webhook/2048 B reply bounds. The per-node
600-attempt/4 MiB fixed-minute budgets are separate from a fleet-wide quota.
CSV rate fractions are averages: synchronization, startup, recovery and retries
can produce bursts. No-upload retention assumes an empty 341-slot Passport
journal and continuous generation to the configured critical threshold; actual
backlog, reserved control slots, pause/recovery and partial windows can make it
shorter. It is not a disconnect acceptance result.

## Broker and zero-spend budget

Official EMQX documentation was read on 2026-10-29. The
[Chinese pricing page](https://docs.emqx.com/zh/cloud/latest/price/pricing.html)
lists 1M session-minutes, 1 GiB public traffic and 1M rule actions/month; sessions
shorter than a minute round up, and public ingress and egress both count.
Spend limit zero stops the deployment when free quota is exhausted. This model
does not modify the retained zero-spend setting or assume unused monthly quota.

The reply publisher opens a new clean-session TLS connection for every RPC.
Each completed reply therefore adds at least one session-minute, in addition
to the sensor's continuously connected session. Control/retry RPCs also consume
resources. Traffic is a strict lower bound: request body into broker + exact
six-field Base64 webhook body out + the two-byte reply status into and out of
broker. Reply JSON, credentials, MQTT/HTTP/TLS framing, handshakes, keepalives,
probes, other workloads and previous consumption are omitted. `free_fleet_upper`
columns are optimistic arithmetic bounds, never guaranteed node counts or a bill.
The model does not divide the entire 1 GiB by a fictional 8192-byte batch.

The [current official Serverless restriction table](https://docs.emqx.com/zh/cloud/latest/create/restriction.html)
lists 1000 online clients, 100 new connections/s, 1000 total publish+subscribe
TPS, 10 publishes/s/client and 2000 authorization rows. Per successful RPC the
request publish, reply publish and device delivery imply approximately three
broker message operations. The one-shot publisher also consumes a new
connection. CSV broker columns give independent **average-rate upper bounds**;
online reply connections, synchronized bursts, shared credentials, ACL usage,
broker behavior and Cloudflare backend limits can tighten them. A 1000-connection
specification does not establish a 1000-sensor working deployment.

## Physical acceptance matrix

After a new firmware build, measure 32/30 s and 64/30 s raw off for at least
20 windows each after warmup. Then measure 64/10 s (stress), 64/60 s, and raw-on
with explicit sampling/cap settings. Keep the same boot and mark phase edges.
Record per-stream generated/ACK batches and body bytes, queue occupancy/slope,
unique identities/table omissions, received report rate, callback/input loss,
seal/persistence timing, heap/largest block/allocation failures, reconnects,
control traffic and failed/uncertain receipt recovery. A positive service margin
in this model is only a reason to run that test. Controlled RF transmission
counts are needed to validate reception completeness separately. Multiple boards
and a fleet require their own acceptance; one sensor cannot validate that scale.
