# Address capacity, upload pressure and public-path evidence

Status: compact 64-address implementation and a bounded C3 collection run
verified on 2026-10-28 (Asia/Shanghai). Sustained queue balance, larger report
rates and direct-route 64-address operation remain unverified. The user's
retained default is **16 addresses, 30 s windows, 5 s bins, raw off**; the
temporary 64-address policy was restored afterward. MQTT/WSS validation is a
separate transport experiment and is not established by these HTTP results.

This extends [BLE ingress decoupling](ble-ingress-decoupling.md) and the
[memory/422 investigation](memory-queue-recovery.md). The ignored evidence root
is `captures/address-capacity-20261028/`. Only aggregate measurements are
reported here; credentials, identities and observation bodies remain private.

## What the former 16-address limit omitted

The limit admitted the first 16 unique `(address,address_type)` pairs in each
window. Further reports for those admitted identities still updated their
summaries. Reports from additional identities still contributed to global
report/RSSI aggregates, but their per-address details were omitted and overflow
accounted. It was not a limit of 16 received packets or 16 physical devices.
Address rotation can make one device occupy multiple identities.

CRC-valid frozen windows from the first temporary 64-address run contain
42 and 39 identities in complete 30 s windows, with table capacity 64 and no
table overflow. Thus the old 16-address setting omitted address detail under
the observed surroundings. These are BLE-visible identities, not a people or
vehicle census. No result establishes complete reception of over-the-air
advertisements, or eliminates the new finite limit of 64.

## Compact storage and the failed first trial

The collector retains separate active/sealed banks and swaps ownership at a
window boundary. The callback/collector performs no JSON encoding, Flash I/O,
TLS wait or dynamic allocation. Address cores use typed storage; actual-bin
counters are 32-bit and sized to the selected policy. Legacy codec interfaces
retain their original behavior. Local lifecycle/OOM checks and all 69 literal
pipeline fixtures remain byte-identical; passing host tests alone does not
establish radio or C3 memory acceptance.

The first implementation allocated both cores and bins dynamically. At 64
addresses/6 bins it reserved 11,264 B of bank payload. The board had roughly
39 KiB free but only a 13,824 B largest internal block, below the unchanged
admission guard. Collection paused for memory despite zero actual allocation
failures. This trial fails memory acceptance; total free heap did not describe
the contiguous allocation margin.

After that observer ended, the continuing background run exhausted the finite
journal. Its retained status records one dropped window containing 638
unpersisted reports, 18 storage drops and 52 dropped address summaries. These
counters describe overlapping loss categories, not 18+52 distinct windows.
They are preserved as a failed trial, not folded into the later zero-loss run.

The replacement reserves both maximum-capacity core arrays in BSS, avoiding
large late core allocations, while allocating only actual-bin counters under
the existing apply/memory gate. On C3, the core arrays total 8,192 B; active,
sealed and owner state add 780 B. For capacity `N` and bin count `B`, this group
reserves `8192 + 2*N*B*4 + 780` B before allocator metadata/linker alignment.

| Selected capacity, 6 bins | Fixed cores | Dynamic bins | Group total | Change from old 16-address group |
| --- | ---: | ---: | ---: | ---: |
| 16 | 8192 B | 768 B | 9740 B | -1236 B |
| 32 | 8192 B | 1536 B | 10508 B | -468 B |
| 64 | 8192 B | 3072 B | 12044 B | +1068 B |

The comparison baseline is the previous 10,976 B window/sealed/bank group,
not the entire application. It does not include a new transport's task, TLS
buffers or client state. The earlier private refresh-matrix report's
`2*N*(64+4*B)` dynamic-layout RAM table is superseded by this static-core
accounting; its byte-generation and queue arithmetic remain separate models.

## Bounded static-core 64-address device run

The tested image is `apm-185fb4d23aae`, 1,565,728 B, SHA-256
`4f7c831e5fdbb82f21d058f4024231c3a1b86f8515d5558968b3e56a284c2110`.
Only the application partition was written after full 8 MiB backup and digest
verification. Full-Flash comparison before boot confirmed the expected app
overlay with NVS, identity area and the latest journal preserved.

This profiling-enabled image uses the explicitly controlled opaque TCP route
through the Mac's Stash connection. The device still verifies Cloudflare's
TLS chain, hostname and date end to end. The relay neither terminates TLS nor
creates a domestic MQTT service. **This is not direct mainland-to-Cloudflare
64-address acceptance.** A temporary maintenance phase first drains preserved
backlog before starting the measured scanner; maintenance time is not active
collection time.

| Measurement | Result and cohort |
| --- | --- |
| Whole observer span | 246 s, one boot, no crash |
| Continuous active state span | 180672 ms between sampled active states |
| Report count | 155 -> 4080 during that span: 3925 reports, approximately 21.72 received reports/s; 4080 is cumulative |
| Journal queue | Whole run begins at 205; first active sample 196; last active sample 218 |
| Callback / observer / window / storage / summary / raw loss | All zero in the retained run |
| Sealed overflow / ACK failures | Zero |
| Actual failed allocations | Zero in per-request allocation monitoring |
| Callback queue / sealed handoff high-water | 7/64 reports / 1 sealed window |
| Longest handoff persistence wait / persistence work | 5718 ms / 438 ms |
| Collector minimum remaining stack | 2472 B |
| Validated upload ACKs | 41 / 87303 JSON-body B across the whole 246 s, including old backlog |
| Last active sampled free / largest internal block | 24400 B / 16384 B |

The 41 ACKs must not be divided by 180.672 s: their cohort includes startup
and pre-scan recovery. Nor does the 4080 cumulative count describe exactly
180.672 s of reception. Whole-observer ACK rate is about 354.9 B/s and
0.1667 batches/s; it mixes payload types, old boots and changing queue state,
so it is not a steady-state 64-address capacity measurement.

The bounded run passes ingress and allocation checks at its observed load,
but its active queue increases 196 -> 218. It therefore does not pass sustained
upload-balance acceptance. Zero software ingress loss while scanning also does
not prove complete radio reception. After observation, the normal USB setup
transition drained the final handoff, and the desired policy returned to the
original 16-address version. Existing immutable policy versions and queued
bodies were retained.

## Why HTTPS still performs TLS handshakes

The previous HTTP implementation provides bounded reuse, not a permanent
session. In the recorded revision-2 normal cohort, 75 HTTP operations include
29 actual socket reuses, 42 new-connection events and four failures without a
successful connection/reuse event. A cached client pointer is not counted as
socket reuse. Ingest alone has 53 operations: 29 reused, 22 fresh and two
pre-connection failures. The controlled cohort has 191 operations, with 99
reuses and 92 new connections.

Control contact/config/activation paths explicitly discard the cached ingest
client for their memory requirements and do not retain their own connection.
All 20 successful normal-cohort control connections and all 38 controlled
control connections are fresh. They directly account for 20/42 and 38/92 of
the respective new connections, and also force the next ingest cold.
Separately, the cache permits fewer than eight confirmed uploads, less than
30 s total life and less than 1500 ms idle, subject to active/idle heap guards.
Encoding, radio/control transitions, malformed ACK handling and memory
admission can also release it.

| Ingest timing, normal direct cohort | Fresh connection median | Actual reuse median |
| --- | ---: | ---: |
| Total logged HTTP stages | 4581 ms | 1612 ms |
| Connection + TLS | 2910 ms | 0 ms |
| First response after connection | 1634 ms | 1608 ms |

Reuse removes the handshake cost but leaves substantial response latency.
Six controlled result drops follow seven confirmed uploads, consistent with
the eight-upload cap, but the old captures lack complete cleanup-reason and
canonical-parser logs. Four idle cleanup checks observe 18 KiB largest blocks
against the 20 KiB idle requirement. Other retained-to-cold transitions occur
within 1500 ms; they cannot all be attributed to idle expiry. Numeric cleanup
reason/age diagnostics were added for subsequent runs; these earlier results
do not uniquely assign every eviction.

The uploader's nominal one-second yield also affects request cadence, but
code-derived sleep totals are not measured independent blocked durations and
can overlap control requests. They must not be added to already measured ACK
service rates as another independent percentage penalty. Neither cache limits
nor yields were relaxed to manufacture the capacity result.

## Public-path controls and remaining uncertainty

The same-endpoint Mac A/proxy/B control binds physical `en0`, fixes real
Cloudflare IPv4 addresses and uses TLS 1.2/HTTP 1.1. This explicitly avoids
mistaking `--noproxy` for bypass of Stash's transparent TUN. Authenticated ingest
replays one already-ACKed 1451 B frozen status body, verifies its exact hash and
durable receipt, and creates no synthetic observation. Nine ingest attempts
produce eight verified receipts; one direct attempt times out at about 12 s
during TLS, after TCP completes. All nine health attempts complete.

| Mac sample, three attempts per group | Direct A median | Proxy median | Direct B median |
| --- | ---: | ---: | ---: |
| Health total | 4.386 s | 1.196 s | 5.247 s |
| Health TLS handshake phase | 3.577 s | 0.826 s | 3.817 s |
| Ingest total, successes only | 3.582 s (2/3) | 1.539 s (3/3) | 3.248 s (3/3) |

Direct health responses identify LAX; proxy responses identify LAX/NRT. One
direct health request spends 11.195 s after TLS before the first response and
takes 12.855 s overall. The health handler does not use D1, so D1 processing
alone cannot explain all observed delay. The ingest replay exercises the
duplicate-receipt path, not a fresh insert. Small samples, different routing
and the Mac TCP/TLS stack prevent treating this as an exact C3 counterfactual.

Bounded device socket probes also distinguish waiting from computation. One
failed request observes write readiness by approximately 299 ms, reaches the
connected/TLS event around 11360 ms, and accounts for approximately 1.644 s of
caller CPU before a roughly 12.373 s failure. Readiness is a sampled upper
bound, not an exact TCP-established timestamp. The SDK does not expose usable
TCP_INFO here: RTT, RTO and retransmission counts remain unknown. Profile CPU
accounting excludes the unpaid current task slice and can charge ISR time;
it is not a precise isolated TLS CPU measurement.

These observations support both repeated-handshake overhead and an unstable
public route/response path. They do not prove a specific packet-loss source,
congestion point, Cloudflare CPU delay or D1 wall time. Existing Workers
telemetry discovery returns HTTP 403 with an unexpired token lacking the
observability scope; server CPU/wall values remain unavailable, not zero.
A separate 95 s direct sample ACKs only three batches / 6021 B (63.38 B/s)
amid retries, demonstrating why the older achieved rate is not a service SLA.

## Address count × report frequency × refresh interval

Let `N` be admitted unique identities per window, `f` the already-received
reports/s per identity and `W` the summary window in seconds. Received callback
load is `lambda=N*f`. Increasing `f` mainly changes counter digits and collector
work; increasing `N` adds address summaries and upload requests. Advertisement
frequency is not `f`: the current passive scan duty is 20%, and channel timing,
interference and detection affect delivery. It cannot be converted into a
guaranteed physical-device count by multiplying duty alone.

With six address summaries per batch, one overall window and one status,
journal production is `P=(ceil(N/6)+2)/W` batches/s. The frozen-codec scenarios
below use conservative envelope lengths, raw off and a 1451 B status per window.
They are synthetic byte sizing, not generated radio traffic or a universal
upper bound. Controls are additional work. Current protocol validation accepts
only **W=30 s / bins=5 s**; 10/60 s rows require a protocol change and fresh
acceptance. Capacity 128 is an unsupported host projection, not firmware or
policy support.

| N at W=30 s | Received reports/s at f=1 / 5 / 10 Hz | JSON-body B/s at f=1 / 5 / 10 Hz | Batches per 30 s |
| ---: | --- | --- | ---: |
| 16 | 16 / 80 / 160 | 414 / 420 / 420 | 5 |
| 32 | 32 / 160 / 320 | 751 / 762 / 762 | 8 |
| 64 | 64 / 320 / 640 | 1412 / 1434 / 1434 | 13 |
| 128 projection | 128 / 640 / 1280 | 2747 / 2790 / 2790 | 24 |

The earlier 16-address direct active sample achieves 0.1644 ACK batches/s and
391.85 JSON-body B/s; the controlled sample achieves 0.2534 and 693.76. Both
include backlog, controls, failures and gaps. They are achieved mixed-workload
rates, not physical bandwidth ceilings. No reliable positive body-size/time
slope was established in that sample. Conditional planning should require both
`P < sustainable ACK batches/s` and generation bytes below sustainable payload
service, with headroom, then measure under the new mixture.

The 341-slot journal holds one batch per 12288 B physical slot, even for a small
body. Critical pressure is approximately `ceil(341*.95)=324` slots; eight slots
are reserved from non-control appends. With unchanged service `A`, growth is
`P-A`, and ideal time from queue `Q0` to critical is `(324-Q0)/(P-A)` when
positive. The following is **conditional arithmetic from Q0=90**, not a measured
time-to-failure or promise of continuous operation.

| N | W | Produced batches/s | Direct fixed-service result | Controlled fixed-service result | Fully offline to critical |
| ---: | ---: | ---: | --- | --- | ---: |
| 16 | 10 s* | 0.5000 | Grows; 11.6 min | Grows; 15.8 min | 7.8 min |
| 16 | 30 s | 0.1667 | Grows slightly; 1720 min | Drains | 23.4 min |
| 16 | 60 s* | 0.0833 | Drains | Drains | 46.8 min |
| 32 | 30 s | 0.2667 | Grows; 38.1 min | Grows; 294 min | 14.6 min |
| 32 | 60 s* | 0.1333 | Drains; only 18.9% slot headroom | Drains; 47.4% slot headroom | 29.3 min |
| 64 | 30 s | 0.4333 | Grows; 14.5 min | Grows; 21.7 min | 9.0 min |
| 64 | 60 s* | 0.2167 | Grows; 74.6 min | Drains; only 14.5% slot headroom | 18.0 min |
| 128 projection | 30 s | 0.8000 | Grows; 6.1 min | Grows; 7.1 min | 4.9 min |

`*` Model-only window setting. At 10 s every modeled N=16/32/64/128 grows under
both recorded service rates. Byte constraints or bursts can tighten these
screens; changed payload mixtures and public conditions can change service.
The previously observed 16-address queue 90 -> 90 over five minutes, with one
pending RAM window, does not establish unlimited retention.

The 64-entry callback queue is independent of address capacity and Flash slots.
During a complete collector stall its initially empty coverage is `64/lambda`:
4 s at 16 received reports/s, 0.4 s at 160/s and 0.1 s at 640/s. Under steady
overload it fills at `free_entries/(lambda-collector_service)`; bursts matter.
The actual runs validate roughly 21 received reports/s, not a 160/320/640 Hz
capacity ramp. CPU busy percentage, host codec tests and nominal radio rate
cannot certify the maximum sustainable C3 report rate.

## Evidence and next acceptance boundary

Private numeric artifacts are grouped under `model/`, `reuse-audit/`,
`mac-control/`, `server-timing/`, `run-64/` and `run-64-static/`. The final
static-core figures supersede the earlier dynamic-layout estimates, while
failed trials and their original frozen data remain retained. The static run's
`auto-teardown-safe.json` records successful observation, graceful stop and
default-policy restoration; an older `status-safe.json` describes the earlier
failed trial and is not the final static-run status.

Before increasing the default, acceptance still needs direct-route larger-N
queue balance, sustained report-rate ramps, finite-storage recovery,
disconnect/reconnect and power-loss testing. A transport migration must preserve
exact immutable bodies and require the backend's matching committed receipt
before journal reclamation; broker delivery alone is insufficient. Measure its
actual TLS/client memory alongside BLE, then replace these HTTP service models
with its own explicitly bounded measurements.
