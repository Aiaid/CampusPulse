# Optional Cloudflare MQTT/WSS transport

Status: the isolated gateway is deployed on2026-10-28. The proxy-path C3 run
passes300.730s continuous active collection after the memory changes below;
the installed profiling-off image also passes121.285s active collection.
Direct mainland routing remains a
separate failed acceptance, not established by this proxy result.
This record extends the [capacity/path investigation](address-capacity-and-public-path.md).

## Selected path and acknowledgement

The selected path is device → MQTT3.1.1 over WebSocket/TLS443 → a separate
Cloudflare Worker and per-node Durable Object → the existing ingestion Worker
through a Service Binding → existing D1/R2 durable receipt handling.
The public device endpoint is `wss://pulse-mqtt.anend.net/mqtt`.
The gateway and original `pulse.anend.net` domain were verified through the
authenticated Cloudflare API to share the user's account and zone. The original
API Worker was not redeployed for this experiment.

Contact, configuration, activation and ingest use the same MQTT session. Frozen
batch bytes and their hash remain unchanged. MQTT PUBACK acknowledges transport
only; the existing node/boot/stream/batch/hash/count/committed-receipt validator
still controls journal reclamation. A timeout leaves the frozen batch pending;
an unknown backend result must be retried idempotently.

Cloudflare Queues is not implemented here. The gateway does not claim durable
buffering before the existing backend commits. This is a bounded device RPC
gateway, not a general-purpose MQTT broker or a raw8883 listener.
The full wire contract and resource limits are in
[the gateway README](../../relay/cf-mqtt/README.md).

## Lifetime and resource ownership

The MQTT adapter does not inherit the HTTP cache's8-ACK,30-second lifetime or
1.5-second idle eviction. SDK automatic reconnect and periodic refresh are
disabled; the network owner gates each cold start against actual available RAM.
One request/outbox is outstanding at a time. Healthy connections can survive an
application-reply timeout if PUBACK arrived and the SDK outbox is empty.
Unacknowledged outbox data requires confirmed client stop before encoding.
Failed or unconfirmed stop retains SDK/callback storage and fails admission
closed. A late successful stop can complete cleanup under the owner gate.

The callback performs bounded copy/state/signal work. The BEFORE_CONNECT header
setter has one bounded cold-start allocation because IDF creates the WebSocket
transport at that point. It does not put credentials in URLs or MQTT passwords.
Vendor WebSocket logging is disabled because a failed upgrade can otherwise log
the Authorization header. Tracked source/configuration contains no device token.

The initial fixed-RX IDF5.5.3 C3 design costs included adapter BSS2740B, MQTT task6144B, two1024B IO
buffers, persistent TLS RX17058B, and dynamic TLS TX4437B per write, plus SDK,
TCP/TLS metadata and allocator overhead. Hot admission includes the caller's
frozen body, independent QoS1 outbox copy and bounded reply copy. Small requests
still require a5120B contiguous-block floor for TX; the encoder and BLE retain
their separate memory guards. These are admission estimates, not proof that the
full application fits. Physical free/largest-block and failed-allocation callback
measurements must decide acceptance.

## Verified stages

- Local gateway tests:16 workerd cases plus2 restored partial/pending-state
  harness cases, TypeScript and Wrangler dry run passed. They use synthetic
  credentials and receipts, not physical observations.
- Native firmware tests: RPC fragmentation/correlation/budgets and the actual
  adapter's timeout/reuse/OOM/stop lifecycle pass under ASan/UBSan, alongside the
  existing protocol, exact ACK, clock, cache and pinned transport checks.
- The separate gateway deployment succeeded. No plan upgrade or dedicated paid
  MQTT instance was created; this does not claim Cloudflare usage is free.
- Strict TLS public negative controls returned401 without authorization,400 for
  a wrong WebSocket subprotocol,404 for a query-bearing path and426 for ordinary
  HTTPS. No device payload was sent in those checks.
- Authenticated host configuration-only run: one WSS connection, successful
  CONNECT/SUBSCRIBE, config200 in426ms, then config200 in367ms after40.370s idle,
  followed by PINGRESP. The original16-address policy was returned both times.
  The host used Stash; this is not a direct-device latency result. No historical
  observation replay or ingest was performed in this host run.

## Direct-path result before the controlled proxy run

The first candidate used a3s SDK transport timeout and failed before collection.
The reviewed revision restores12s per SDK operation and records the public
WebSocket upgrade status. In its726s direct observation,26 session attempts
produced one101 session and one successful contact response. The next config
request timed out with an unacknowledged77B outbox record. No collection started,
no upload occurred, and pending remained225. The allocation-failure callback
count stayed0; one boot and no crash were observed. **This fails complete
transport/collection acceptance. Zero loss counters with a stopped radio are not
successful BLE acceptance.**

An independent review compiled the unmodified SDK MQTT encoder against a host
shim. Its83B CONNECT,73B SUBSCRIBE and77B empty-config PUBLISH were accepted by
the actual gateway parser; the SDK's single-byte SUBACK representation matches
the adapter. The callback header/RX setter path has no MQTT API lock acquisition.
This supports wire compatibility, not reliable delivery over the public path.

The SDK timeout is not a whole-connection deadline: TCP/TLS, HTTP Upgrade IO and
MQTT CONNACK can each consume that timeout. The application's12s connection wait
can expire while the SDK task still holds its API lock. Its stop helper may then
need additional time; a late/failed stop must retain resources safely.
The direct run's normal USB teardown did not complete within its65s gate, so
before changing firmware the preserved safe record was checked to confirm
reports0, collecting0, no upload and pending225. A new full Flash backup and
digest verification preceded the next app-only write.

The user then explicitly selected proxy-first BLE/heap/queue acceptance. Its
measurement image changes only the TCP destination through a linker wrapper for
the exact gateway hostname/port. It keeps the original WSS URL/HTTP Host and
uses the original hostname for both SNI and certificate verification. All trust,
date and buffer options are copied unchanged. A fixed-target local relay forwards
TLS ciphertext through Stash; it never terminates TLS or logs payload/headers.
The91-call wrapper host check and fresh C3 build pass, including strict-TLS
macros and linked-call disassembly. These checks are not physical acceptance.

## First controlled run: memory failure and measured distribution

The measurement-only TCP wrapper image `mqtl-568abcc200bd` was written app-only
after a new full8MiB verified backup; the complete preboot Flash matched the
expected app overlay. It connected on the first opaque-proxy attempt in4235ms,
and contact returned200. The same connection returned config200 in471ms.
Allocation-failure callback counts remained0. These are successful transport
checks, not successful BLE/queue acceptance.

Starting BLE reduced free internal heap to14064B with largest7680B, below the
unchanged24KiB/16KiB protection floors. Collection paused. The static RX design
therefore **fails full-application memory acceptance even on the proxy path**.

| Heap stage | Free bytes | Largest block |
| --- | ---: | ---: |
| Before MQTT | 100088 | 86016 |
| MQTT connected | 66768 | 53248 |
| BLE initialized | 14064 | 7680 |
| Later MQTT disconnected, capture paused | 50260 | 17408 |

The first aborted capture received16 reports across9 address identities in an
interval shorter than the codec's1s minimum. The immutable sealed window waited
for memory admission. Closing the opaque relay allowed MQTT resources to be
reclaimed; the encoder then explicitly rejected that short window, recording
windows_dropped1 and summary_drops9. It did not fabricate duration or upload a
malformed batch. A status batch brought pending225→226; original batches were
not deleted. This is a failed-trial loss, not a zero-loss result. A second normal
USB-stop request after the handoff cleared succeeded in the same boot, before a
new full-Flash backup. The next revision must check actual post-initialization
RAM before enabling acceptance, as well as reduce the transport's residency.

The linked image places102540B code in internal RAM and72876B static data/BSS.
The SDK reports217752B internal8-bit heap capacity; task stacks and runtime
radio/TLS allocations consume that heap and must not be added as another static
region. ESP32-C3's400KiB SRAM includes16KiB cache, with separate8KiB RTC SRAM
([Espressif datasheet](https://www.espressif.com/sites/default/files/documentation/esp32-c3_datasheet_en.pdf)).
The linked RAM code/data plus reported heap total393168B, approximately384KiB;
this is an accounting cross-check, not a claim that every linker region is a
separately allocatable heap.

The main static consumers include pipeline20883B (address cores8192B,
journal state6200B and upload scheduler4232B), Wi-Fi net80211/pp12444B,
network4577B, display3853B, lwIP3790B and USB3189B. These figures include all
data/BSS for each archive, not that module's dynamic allocations. The application
reserves52224B across its configured task stacks, plus SDK task stacks and a
transient4096B stop helper. Queued payloads live in the4MiB Flash journal;226
pending batches do not mean226 full bodies in RAM.

## Dynamic RX and stack-budget candidate

The current source restores SDK dynamic RX. It uses linker interposition on
public transport read/write calls, matching only the MQTT client's recorded
private TLS parent. A separate static IO mutex serializes new TLS IO allocations
against encoder/frozen-body allocation. SDK APIs, including the locking outbox
getter, run before taking that mutex; no SDK API is called while memory work
holds it. The existing owner gate remains held while an RPC waits for callbacks,
so it cannot also be the background IO mutex. Reads wait for readiness outside
the IO mutex; partial records still have the original SDK timeout.

Native pthread/ASan/UBSan checks cover both lock orders, timeout/stop failures,
non-target passthrough and cold-upgrade waits. Full C3 ELF disassembly verifies
upgrade, WebSocket packet writes and reads call the wrappers, which delegate to
the original public functions. Disabled-MQTT objects add no code/data/BSS.
The IO gate adds101B state before linker alignment.

Hot admission reserves20KiB for the maximum17058B new RX allocation and runtime
slack, plus the body-sized QoS1 copy and2049B response. A3750B body's pre-malloc
floor is30466B with largest17058B. An8192B body needs39170B before malloc and
can defer on this C3. The unchanged encoder floor is24KiB/14KiB. These estimates
and passing tests do not establish that every accepted-policy body fits on board.

The first dynamic-RX board attempt successfully initialized BLE and sent several
verified frozen batches over the reused connection in roughly0.5–0.7s. It later
had30972B free but largest11776B and paused. This is a second failed memory
acceptance, now due to fragmentation. The proxy was closed to release transport
memory, and normal same-boot stop/drain succeeded before a fresh backup.

One old3831B/9-item batch returned422. Its exact SHA-256 matches the previously
preserved historical candidate documented in [memory recovery](memory-queue-recovery.md):
duration1970ms equals last_offset1970ms. Current local validation again rejects
`items[0].last_offset_ms`. The runtime scheduler blocks that frozen slot; it does
not repair/delete its original bytes, and a reboot can attempt it again.

The next candidate reserves8192B for the MQTT control task instead of12288B,
and6144B for the supervisor instead of8192B, saving6144B. Previously measured
peaks leave3208B/1684B estimated margin respectively, subject to new physical
high-water marks. MQTT-disabled budgets remain unchanged. Native runtime/app
tests assert the actual task arguments in both configurations. Bluetooth pools,
scan parameters, other stacks and all memory protection thresholds are retained.
That candidate still paused after289s with37092B free and largest10240B.
It verified119 batches/345187B on one session, with no transport errors or
allocation failures, but it fails sustained-memory acceptance. A normal same-boot
stop/drain completed before the next verified full backup.

## Non-ISR code placement and successful proxy run

The accepted profiling candidate additionally enables the SDK's
`CONFIG_FREERTOS_PLACE_FUNCTIONS_INTO_FLASH=y`. Its ISR variant remains disabled.
The new public/controlled profile images move104 linked FreeRTOS task functions
and helpers: IRAM text102540→90356B, aligned IRAM reservation102912→90624B,
data18564B and BSS54416B unchanged. Static available heap gains12288B.
The normal build moves87 linked functions and gains10240B relative to its old
normal configuration. No Bluetooth pools, radio parameters or protection floors
were reduced. Source/ELF audits retain all defined FromISR functions, critical
and context-switch code in IRAM. The C3 Flash guard suspends before disabling
cache and resumes after restoring it. Journal writes are exercised in the
physical test; this is not a general claim of complete RF reception during Flash
operations.

Use a fresh build with these explicit normal MQTT overrides; the repository's
default transport remains HTTPS:

```text
CONFIG_CP_NETWORK_MQTT_WSS=y
CONFIG_CP_NETWORK_MQTT_WSS_URI="wss://pulse-mqtt.anend.net/mqtt"
CONFIG_FREERTOS_PLACE_FUNCTIONS_INTO_FLASH=y
CONFIG_CP_PERF_PROFILE=n
```

The actual profiling image is `mqil-d170d1d4580e`,1585392B,
SHA-256`28e566585d746d7c888c72245b22f6e2e35493e643c0cdf97cec9cd539d1e03a`.
After a verified fresh full backup, app-only write and full preboot comparison,
the board used an opaque proxy to the deployed Cloudflare gateway with original
strict TLS and original16-address/30s/5s/raw-off policy.

| Measurement | Result / cohort |
| --- | --- |
| Observer span | 335s, one boot, no crash |
| Continuous sampled active interval | 300.730s |
| Reports | 333→6418 in that interval:6085 new;6418 boot total |
| Queue | 144 boot start;133→1 during active interval |
| MQTT sessions / RPCs | 1 /216,215 marked reused,0 transport errors |
| Historical rejection | 1 original3831B batch returned422 and remained blocked/preserved |
| Verified durable uploads | 193 batches /608620B whole span |
| Verified active-interval uploads | 182 batches /580722B;1931.0B/s and0.6052batch/s |
| Warm successful RPC time | Median520.5ms, p95=695ms, max2294ms |
| Allocation failures / memory admission denials | 0 /0 |
| Callback/rejection/window/storage/summary/raw loss counters | All0 for this boot |
| Memory/pressure pause; seal overflow; local ACK failures | All0 |
| Final active sampled internal heap | 49572B free /30720B largest |
| Max seal wait / persistence | 2200ms /263ms |
| Task minimum free stacks | Supervisor1684B, control3208B, network3152B, uploader1544B, collector2364B, USB4012B; MQTT callback3172B |

The final blocked batch is not reclaimed as an ACK. These upload bytes include
preserved prior-boot backlog; they are neither new-radio byte generation nor a
Wi-Fi link-speed measurement. The uploader still intentionally yields1s per
batch, so achieved durable throughput is not a raw MQTT bandwidth ceiling.
The journal-append instrumentation accounts for50 new batches/122947B in the
reported intervals (excluding the later stop tail), matching the active queue
balance133 +50 -182 =1. This is about408.8B/s generated versus1931.0B/s durably
uploaded. A later Flash snapshot omits already-ACKed slots that have been reused;
it must not be presented as the complete generation history.
Zero software losses here exclude intentional16-address detail omission and
unreceived over-the-air advertisements. Software counters from earlier failed
trials, including the16-report short window above, remain separate.

Normal stop/drain and same-boot USB setup passed after the run. A new verified
full8MiB backup preceded app-only installation and full preboot Flash comparison
of the profiling-off proxy image `mqinl-d170d1d4580e`,1580704B,
SHA-256`6da8493acac565bb1cbdc1bca6701cb634fc50aaa1cc5c29b14689f8e36ff3ed`.
It has the same source and strict TLS configuration, with profiling/trace/runtime
statistics disabled. A154s one-boot check passes121.285s continuous sampled active
collection,3001 boot reports,25 verified batches (20 current-boot), one session
and37RPCs/36reused. Actual allocation failures, memory admission denials,
callback/window/storage/summary/raw losses, memory/pressure pause and local ACK
failures all remain0. The original historical batch again returns422 and stays
blocked/preserved; queue6→1. Final sampled free heap53560B, largest32768B.
IRAM code90226B, data18564B, BSS53632B; application stack budgets total45KiB
plus SDK tasks, allocated from heap rather than another static region.

The normal image was left collecting/uploading through the local opaque Stash
relay, with the original16-address policy. This is a temporary proxy-dependent
measurement image, not direct-route field acceptance. The dedicated relay is
limited to6h and is expected to stop around2026-10-28 22:32 Asia/Shanghai; stopping
the Mac/Stash/relay removes this path. No bootloader/partition/NVS/cardid/journal
restore or whole-Flash erase was performed. No source commit/push was requested.

At the observed proxy service rate, the earlier30s-window body-size model gives
the following conditional load comparison. Rows32/64 are modeled, not physical
MQTT acceptance; default16 remains selected.

| Addresses | Generated bytes/s | Generated batches/s | Byte / batch service utilization |
| --- | ---: | ---: | --- |
| 16, this active run | 408.8 | 0.1663 | 21.2% /27.5% |
| 32, prior JSON model | about750 | 0.2667 | 38.8% /44.1% |
| 64, prior JSON model | about1407 | 0.4333 | 72.8% /71.6% |

These ratios do not establish radio capacity, high-report-rate CPU headroom,
larger-policy RAM acceptance, worst-case service or direct mainland reachability.
The1s uploader pacing remains included. Keep the existing finite queue and
explicit loss/overflow diagnostics; this is not unlimited offline retention.

A later read-only same-boot check of the installed normal image observes17188
boot reports, collecting1, queue1,53592B free/largest32768B, and zero callback,
window/storage/summary/raw losses, pause, upload retry or local ACK-failure
counters. It does not restart or reconfigure the device.

## Separate direct TCP/TLS phase

After proxy acceptance, a Mac-only probe tests both public endpoints without
credentials or observation payloads. Direct sockets use real A-record addresses,
`IP_BOUND_IF=en0` and an en0 source-address bind; both bindings are verified.
OpenSSL uses strict CA/SNI/hostname verification, fixed TLS1.2 or1.3 and no session
reuse. Actual Darwin `TCP_CONNECTION_INFO` snapshots accompany monotonic parsed
TLS message times. No packet capture or route/Stash/AP configuration change is
performed. The probe's Mac stack is not the C3 mbedTLS implementation.

Eight sequential direct samples cover both addresses and both TLS versions for
`pulse-mqtt.anend.net/mqtt` and the stateless `pulse.anend.net/api/v1/health`.
All8 establish TCP (238–1301ms, median293ms),6 complete verified TLS, and2 reach
the12s TLS deadline. Four have local send retransmissions; five have received
out-of-order bytes. CPU costs only14–52ms per sample. Three additional samples
complete TLS but do not receive HTTP status before a separate2s HTTP deadline;
these must not be labeled TLS failures or HTTP rejections.

| Selected sample | Parsed-message evidence | Kernel evidence |
| --- | --- | --- |
| MQTT A / TLS1.2 | TCP251ms; ClientHello272ms, ServerHello3450ms, Certificate6489ms, Finished6801ms; TLS6529ms; HTTP426 | 222B /1 packet retransmitted; CPU42.5ms |
| health B / TLS1.2 | Client Finished sent2188ms, then12s handshake timeout | 472B /4 packets retransmitted;85B still in send buffer |
| health A / TLS1.3 | No complete ServerHello callback by12s | 1016B received and1016B out of order; not evidence that the server sent no bytes |

Two proxy CONNECT controls both complete verified TLS and HTTP426: total845ms
(TLS1.2) and804ms (TLS1.3). Their TCP information is only for the localhost Stash
socket, not the proxy's upstream link. Proxy DNS/address/exit path differ from the
direct controls. Timeouts are right-censored and sampling is small/non-randomized.

The evidence establishes network waiting and actual retransmission/reordering
phenomena during this direct test, across several TLS stages. It does not locate
the responsible hop or distinguish provider/GFW/Cloudflare causes. TLS1.3 alone
does not remove all observed failures. TLS stalls before HTTP also rule out
database processing as their cause; separate post-TLS delays remain unassigned.
The device remains on its verified proxy path throughout this phase. Safe probe
results/methods are under `captures/mqtt-wss-20261028/direct-tcp-tls/`; interface
addresses/routes stay in a private file and are not reproduced here.

## Optimized device direct trials and proxy recovery

The user subsequently requested an actual device direct test. The installed
proxy image was stopped normally and its tail saved, then a new verified full
backup preceded each app-only transition. The direct normal image
`mqin-782c8a73941f` uses the same base source/effective SDK configuration as the
verified proxy normal build, with no TCP routing wrapper. The separate dynamic
RX IO wrappers remain. MAC/partition/security checks and full preboot Flash
comparison pass; identity, Wi-Fi, cardid and latest journal are preserved.

The187s first direct trial has7 session attempts,0 complete MQTT sessions and0
RPCs. Two attempts reach HTTP101 but expire before complete MQTT setup under
the12s total owner budget. Actual allocation failures remain0; collection never
starts, and pending stays6. The local opaque relay's accepted/up/down counters
do not change, independently supporting that the trial bypasses it. Normal
same-boot USB stop succeeds.

A single-parameter diagnostic copy, `mqic-0be4f700eabb`, extends only the complete
cold-setup owner wait from12s to30s. SDK IO remains12s, RPC waiting20s, and SDK
configuration is byte-identical. Only the frozen `mqtt_wss.c` copy changes;
the workspace source is not edited/promoted. Native network ASan/UBSan and the
fresh C3 build pass. App1580528B SHA-256
`e7a20caa488a96e8e7087debfaa0dd19be41591f88f5a67bc0f4da00fdb7f09c`.

In339s this copy records8 attempts and4 complete sessions, taking23.692s,
8.408s,5.496s and19.694s. Thus the former total budget can interrupt an otherwise
completable slow setup. It is not the sole problem:18RPCs include5 transport
errors; only7 batches/10176B receive verified durable ACKs. Queue19→34 while
collecting3244 reports. Allocation failures stay0 and no memory pause occurs.
Network/upload waits delay a seal by up to50.409s, producing2 seal overflows,
2 dropped windows and32 unpersisted address summaries. These are overlapping
diagnostics of the two lost windows, not four separate window losses. The
callback-drop counter remains0; this is still a failed collection acceptance.
The trial was stopped after the loss was observed; the remaining handoffs drain,
and same-boot USB setup succeeds. Relay up/down byte deltas again remain0.

The long cold setup, subsequent timeouts/reconnects and independently measured
TCP retransmission/reordering support an unstable direct path. The lost windows
also expose a local limitation: network waits still delay persistence long
enough to exhaust the finite RAM handoff. They must not be attributed only to
network packet loss or dismissed because MQTT has transport acknowledgements.
Separating durable persistence from long network ownership is follow-up work.
Latest direct data and counters are backed up before restoring the previously
verified proxy normal image; recovery confirmation is recorded separately.

Recovery is physically confirmed: a fresh full8MiB backup is verified before
restoring `mqinl-d170d1d4580e` app-only, and full preboot Flash comparison passes.
The restored proxy image then passes121.001s sampled active collection in153s,
with3164 reports,53 verified batches (20 current-boot), one MQTT session,0
transport/allocation failures or memory denials and0 callback/window/storage
losses in this recovery boot. Queue34→1, free53644B/largest32768B at the final
sample. It remains collecting through the original bounded local proxy relay.
This recovery does not undo the two lost direct-trial windows; their counters
and surviving frozen records remain preserved in the fresh backup/history.

## Domestic MQTT provider shortlist, checked2026-10-28

This is documentation research, not a domestic-device acceptance or a purchase.
No new provider account/instance is created. The next low-cost connectivity
candidate is EMQX Cloud Serverless on Alibaba Cloud Hangzhou: its official
[deployment API region table](https://docs.emqx.com/zh/cloud/latest/api/deployment_manage.html)
explicitly supports `cn-hangzhou` for Serverless, and the
[connection guide](https://docs.emqx.com/zh/cloud/latest/deployments/port_guide_serverless.html)
provides native MQTT/TLS8883 and WSS8084. This is a standard authenticated
deployment, not the shared public test broker. Use its deployment hostname/SNI.

| Candidate | Verified commercial/technical facts | Fit for this project |
| --- | --- | --- |
| EMQX Cloud Serverless, Hangzhou | Monthly1M connection minutes,1GiB traffic,1M rule actions; beyond quota CNY8/M minutes,1.5/GiB,1.8/M actions ([pricing](https://docs.emqx.com/zh/cloud/latest/price/pricing.html)) | First connectivity experiment; [zero consumption limit](https://docs.emqx.com/zh/cloud/latest/faq/deploy.html) uses free quotas and stops when connection/traffic quota is exhausted |
| Alibaba ApsaraMQ MQTT Serverless, Hangzhou | CNY2.5/day reserved minimum even idle, plus message/elastic usage;500 connections/5000 subscriptions reserved ([billing](https://help.aliyun.com/zh/apsaramq-for-mqtt/mqtt-upgraded/product-overview/serverless-instance-billing)); public endpoints and TLS8883 supported ([guide](https://help.aliyun.com/en/apsaramq-for-mqtt/mqtt-upgraded/getting-started/use-apsaramq-for-mqtt-sdk-for-java-to-implement-messaging-between-clients-and-applications)) | Good cloud-service integration alternative; roughlyCNY75/30days before additional usage, not a zero-floor trial |
| Tencent TDMQ MQTT | [Mainland regions](https://cloud.tencent.cn/document/product/1778/118008), native TLS8883; current [professional specs start2000TPS](https://cloud.tencent.cn/document/product/1778/112943), basic edition stopped new sales | Technically suitable; specification scale exceeds the present few-device experiment. Exact minimum CNY cost was not verified |

For scale intuition, five continuously connected device clients use216000
connection-minutes in30days, excluding relay clients. The measured409B/s
generation rate is about1.06GB decimal of bare inbound payload per device/month;
outbound copies, ACKs and rule actions add usage. Do not promise an always-free
full chain based only on its connection quota. Broker prices exclude domestic
durable storage/relay and Cloudflare charges.

The proposed path is device → native MQTTS → domestic broker → domestic durable
receiver/queue → asynchronous HTTPS forwarding to existing Cloudflare. Keep
original bytes, batch identity/hash and idempotent retries. A domestic durable
receipt and a Cloudflare committed receipt are distinct; MQTT PUBACK alone must
not be interpreted as Cloudflare persistence. EMQX's
[FAQ](https://docs.emqx.com/zh/cloud/latest/faq/deploy.html) explicitly directs
applications needing stored messages to persistence/data integration. Merely
using a broker or a direct HTTP forward does not establish durable custody.
The device persistence/network decoupling item also remains necessary, including
for local-network or broker outages.

## EMQX Serverless setup and native MQTT trial

The user selected EMQX Serverless and completed account registration, service
terms/deployment submission and creation of two independent MQTT identities.
The console confirms the CampusPulse project, Hangzhou, running Serverless v5,
1000connections/1000TPS and consumption limit CNY0. A device identity and a
separate relay identity have per-username scoped allows and a final per-user
`pubsub` deny on `#`. The proposed All Users fallback was rejected by automatic
approval review as broader than the authorized scope; it was canceled and never
applied. Only these two identities were tightened. MQTT3.1.1 positive flows and
MQTT5 explicit Not Authorized reason135 checks pass for cross-node access and
forged-reply publishing. This is actual broker validation, not only a rule plan.

A new optional `CONFIG_CP_NETWORK_MQTT_NATIVE_TLS` mode retains the existing
MQTT-RPC interface, typed IO gate, lifecycle and full CF receipt validator.
Native URI/username/password come from private external build overrides for this
experiment, with separate broker credentials. The CF token stays in its existing
NVS schema and in the local relay's private node mapping; it is not sent to EMQX.
Native mode does not look up WebSocket transport or create a Bearer header.
Both transports pass native ASan/UBSan and real C3 builds, including disabled
adapter zero-code/state checks. Native linked adapter state is224B smaller;
runtime differences require the separate physical measurements.

The public CA downloaded from the console's official assets URL is DigiCert
Global Root G2, also present in the SDK's full CA bundle. A credential-free
Mac direct probe binds en0 and its source address and verifies TLS1.2 chain/SNI/
hostname on8883: TCP25.015ms, TLS53.232ms, total102.599ms, CPU15.414ms. This is
not device timing. A subsequent authenticated config-only chain test returns
the original16-address configuration through EMQX→local relay→CF in1429ms,
without contact/activation/ingest or synthetic observations being submitted.

[`relay/emqx`](../../relay/emqx/README.md) is newly authored local verification
code, with48 passing host tests after integration, Ruff and format checks. It
preserves exact frozen bytes/hash, fixed API paths, two-byte status envelopes,
old-boot batches, bounded work and fresh config leases. Its0600 SQLite restart
journal is an audit/retry mechanism, not domestic durable custody. It replies
success only with the original CF response. The trial launcher clears implicit
proxy/CA/keylog environment overrides; the CF leg uses the explicit local Stash
proxy while the device connects natively to the mainland broker.

The actual credential-bearing native candidate is `emqn-85e81c46c0cb`,1571424B,
SHA-256`9c7d4ad85dd0432f336736b12278589d34f6b8ff753460c075661a531f0dde67`.
It preserves strict CA/name/date checks and the measured non-ISR Flash layout;
unused WebSocket transport is disabled. All credential-bearing configs/images
stay ignored/private. An initial build with unused WS code still enabled was
retained as a superseded build and was not flashed. A fresh8MiB verified backup
precedes the app-only write; full preboot Flash comparison passes.

The physical native run observes336s of the same boot, including303.560s of
continuous active BLE collection. The device stays collecting after the observer
closes its serial connection. These are bounded acceptance results, not an
unlimited lossless guarantee or an address-capacity stress test:

| Metric | Native EMQX device result |
| --- | --- |
| BLE reports seen |6080 |
| MQTT session / RPCs |1 /79;78 reused;0 transport errors |
| Cold setup |3308ms |
| Warm successful RPC |median1236ms, p95 2100ms, max3448ms; includes local bridge and CF persistence/control |
| Verified durable batches |55 /135007B, including50 current-boot batches |
| Pending queue |6→1; one preserved historical422, no new upload failure |
| Final heap |55180B free,34816B largest contiguous block |
| Allocation failures / admission denials |0 /0 |
| Callback/window/storage/summary/raw losses |0 in each reported counter |
| Memory/pressure pauses / seal overflows / local ACK failures |0 in each reported counter |

The current path is C3→native MQTTS→Hangzhou EMQX→Mac verification bridge→CF
through the explicit local Stash proxy, with the original CF receipt returned
over MQTT. The Mac, bridge and CF proxy must remain available. The local trial
bridge has a six-hour lifetime ending2026-10-29 01:07 Asia/Shanghai; this is not
permanent hosting. The previous opaque LAN TCP forwarder was stopped after the
native run. No domestic durable-custody receipt has been implemented. The earlier
unstable CF-direct persistence losses above remain an open issue.

The offline `cp_emqx_relay.provision` tool generates private per-device auth/ACL
CSV and runtime JSON materials with independent random credentials. It refuses
existing output directories, keeps0700/0600 permissions and never rotates old
keys implicitly. The integration uses per-user denies, not global ACL changes.
The current Serverless public API index documents client/subscription/publish
operations; account/ACL creation by that API has not been tested. Bulk CSV import
is documented by the vendor, but generated materials are not proof of actual
cloud registration. Production NVS credential provisioning and domestic durable
relay deployment remain distinct work.

## Direct EMQX to CF cloud cutover,2026-10-28

The later user-requested removal of the Mac is deployed and physically verified
in [`relay/emqx-cloud`](../../relay/emqx-cloud/README.md). EMQX's scoped HTTP
rule Base64-wraps original bytes and authenticated username, calls the isolated
CF ingress, and receives no custody credit merely for forwarding. CF calls the
unchanged API through a Service Binding and publishes its exact original reply
back through the broker using the scoped relay account. No deployment-wide
EMQX administration API key is used. The user explicitly authorized Worker
secret storage and personally entered/submitted the new browser credential.

The previous local bridge exited normally and its process absence is checked.
One C3 passes303.747s active BLE collection,6310 boot reports, one native MQTT
session,72RPCs/71reused/0transport errors,50 verified CF batches/124679B including
46 current-boot batches. The sampled active queue stays4–6 (first/last5→5).
Final heap54240B/largest34816B; no reported allocation failure, memory denial,
software drop, memory/pressure pause, seal overflow or ACK failure. Warm success
RPC median2767.5ms/p95 5023ms/max7252ms includes the entire cloud return path.
The original historical422 remains preserved and separate from new failures.

USB observer attachment triggers reason11 (`ESP_RST_USB`) once. Count only the
subsequent boot and exclude five buffered old RPCs/four verified uploads; no
later restart/crash is observed. This does not validate uninterrupted capture
across reset or unlimited losslessness on an unstable network. Device collection
continues after observation; there is no longer a local six-hour bridge deadline.
The earlier Mac-only trial above remains historical comparison evidence.

Ignored native evidence lives under `captures/emqx-20261028/`, with the device
Mac-trial summary in `device-test/device/summary-safe.json` and cloud-only
summary in `cloud-direct/device/summary-safe.json`; earlier CF evidence remains
under `captures/mqtt-wss-20261028/`. Actual firmware
images, protected-Flash comparison, sustained BLE activity, allocation failures,
fresh durable receipts and queue balance are separate hardware acceptance gates.
