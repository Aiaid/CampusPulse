# BLE ingress decoupling and actual upload workload

Status: compact implementation, controlled ten-minute active collection and
final normal-image five-minute direct-path collection accepted on one C3,
2026-10-28 (Asia/Shanghai). Public HTTPS timeouts and long-run capacity remain
separate. This follows the [whole-device performance evaluation](performance-evaluation.md).
The acceptance target is bounded loss-free application ingress under the tested
load, not complete reception of all radio advertisements.

## Actual payload audit

An offline aggregate audit reads CRC-valid frozen journal bodies, prior numeric
profiles and the historical research-response dump. Private evidence and scripts
remain in ignored `captures/ble-decouple-20261028/payload-audit/`; no identifiers,
credentials or raw payloads are copied into this report.

| Cohort | Observed size or volume | Boundary |
| --- | --- | --- |
| Current C3 journal snapshots | Largest frozen body 3831 B; a separate older 2026-10-26 snapshot reaches 4109 B | CRC-valid retained records, including ACKed records; not a complete historical upload census |
| Current raw-off, 16-address window | Approximately 12404 B across five ingest requests per 30 s, plus control requests | Three address-summary batches, one overall window and one independently generated status |
| Optimized 606 s profile | 95 append operations / 234244 B; 123 validated upload ACKs / 329428 B | Approximately 23.2 kB/min generated and 32.6 kB/min ACKed; includes earlier-boot backlog; final unreported operation interval excluded |
| Historical sampled raw research response | 146 main-cohort batches / 3532 reports / 1167991 compact logical bytes | Single reconstructed batch median 10316 B, maximum 10692 B; 89/146 exceed 8192 B |

Historical raw compact reserialization does not match the original upload body
hashes. Its sizes are logical payload estimates, not measured original POST
lengths. Item UTC is unknown; within-boot retained spans suggest about 108.6
logical B/s across this sampled cohort, not total-radio generation or upload
wire throughput. That policy selected every 280th report with identity `none`;
it was not an all-report/all-MAC experiment.

The backend permits 65536-byte ingest bodies. The current C3 network and
journal each cap a body at 8192 bytes; address-summary encoding also caps each
batch at six addresses. Consequently an isolated 8 KiB transport experiment
does not represent the earlier larger logical raw batches, nor the current
multi-request cadence and backlog. This work preserves those protocol/policy
limits and tests the real current full pipeline rather than enlarging synthetic
bodies and labeling them normal traffic.

## Blocking boundary and acceptance plan

The existing BLE callback is nonblocking and writes to a 64-entry report queue.
Its consumer previously waited for the shared network memory gate, encoded JSON
and appended Flash when closing a window. One slow TLS request could therefore
stop report consumption for seconds even though collector CPU utilization was
low. Simply enlarging the report queue cannot bound this delay.

The implementation moves sealed-window persistence out of the ingress consumer.
The consumer must keep draining and aggregating while the existing upload worker
handles memory admission, encoding and durable storage. All handoff storage is
bounded; exhaustion, stop/reconfiguration and raw-retention failures must remain
explicit. Frozen journal bytes, identities and verified-ACK reclamation retain
their existing semantics.

Acceptance includes deterministic held-gate tests, original window boundaries,
bounded overflow accounting, stop/reconfiguration, allocation failures and raw
mode regressions. The physical run must include real BLE, display, multi-batch
generation, current backlog and cloud ACKs. Record active collection, queue and
handoff high-water marks, explicit losses/pauses, heap/stack margins, generated
and ACKed bytes and network failures. A stopped scanner or coalesced/dropped
window cannot be counted as successful zero-loss collection. Preserve the
historical rejected batch and all current device data across app-only flashing.

The new pre-change backup contains 341/341 pending slots, 1002539 frozen body
bytes, and no quarantined slots. This is full physical-slot capacity despite
about 1 MB of actual bodies. The old application's late cloud statuses are
backlogged and cannot establish its current live scan state. Clearing the
journal would invalidate the desired preservation/recovery test.

To create genuine free slots with validated cloud receipts, the first physical
run uses a temporary opaque TCP forwarder through the host's existing Stash
connection. Only the frozen lab build changes its transport destination, sets
the original cloud name for SNI/certificate verification and sends the original
HTTP Host. The device still performs end-to-end TLS with Cloudflare, with the
same trust bundle, name/date checks, immutable bodies and durable ACK validation.
The forwarder neither terminates TLS nor records payloads or credentials. Its
target is fixed and its listener/lifetime are bounded. This route is an explicit
lab control, not a measured improvement to mainland direct connectivity.
The normal source keeps its original route; the final image must restore direct
operation after preserving all queue changes made by the lab run.

## Results

### First implementation and local acceptance

The collector now performs queue drain, aggregation and bounded handoff only.
The existing uploader persists one sealed window and a four-report raw handoff
before starting another upload. There is no new task or report-queue expansion.
Stop retains its final window in the stopped collector's storage until earlier
handoffs finish; policy replacement waits for the entire old-policy drain.
Ready flags have a consistent critical-section snapshot, and stack watermarks
are published by the owning collector rather than queried through a deletable
task handle. Collector task creation succeeds before scan admission opens.

C3 target object sizes are sealed storage 8560 B, raw handoff 272 B, new control
scalars 26 B and health fields 24 B: 8882 B additional symbols, before linker
alignment. Reducing the now non-encoding collector stack from 6144 to 3072 B
makes the net reservation increase 5810 B, without relaxing existing HTTP/TLS
heap floors. Target stack high-water acceptance remains separate from this
static accounting. Pending RAM handoffs are not power-loss-durable; prolonged
blocking beyond their bounded capacity still produces explicit overflow loss.

The full native firmware chain passes, including ASan/UBSan, 69 literal
pipeline batches through real v2 validators, 336 pipeline cJSON OOM sites,
independent codec/status fault injection and local real workerd/D1/R2 receipt
checks. A deterministic approximately 25-second held-network-gate collector
run consumes 2499 reports without callback loss for raw ON and OFF. Tests also
cover multi-window overflow, persistence preemption, final-window retention,
old-policy timeout, raw failure attribution, post-read persistence priority,
immutable retries/BAD_ACK/reclamation and startup task-allocation failure.
The particular raw-publication instruction interleaving was statically reviewed
and fixed, not reproduced with a real preemptive thread scheduler.

### Initial physical recovery boundary

The first lab image `blp-6da467c9dd10` preserves the full original journal and
uses the explicit TCP route control described above. During initial recovery it
briefly started scanning before the journal was below the existing stop
threshold. One report entered a sub-second partial window, which the existing
protocol cannot represent (`duration_ms` must be at least 1000); the firmware
explicitly counted one dropped window/summary and unpersisted report. This is
not reported as zero loss.

The interim normal candidate `bln-3a64f6794856` adds an admission correction: the
same policy stop threshold latches pressure before initial radio admission,
including when the control-slot reserve is still exhausted. It waits for the
existing resume watermark instead of repeatedly making sub-second captures.
Native tests cover full capacity, reserve clearance, above-resume and exact
resume boundaries. No timestamps or server validators are changed to hide the
unrepresentable partial window. Sustained lab results and final normal-image
physical results are pending below.

### First trial: ingress succeeds but the RAM regression fails acceptance

The first lab observer ended after its 1200-second budget (1206 seconds including
startup), including a lengthy
full-journal recovery. It recorded 331 seconds of continuous active sampling,
7532 consumed reports, callback queue high-water 8, zero callback rejection and
zero sealed-slot overflow. The initial one-report/sub-second window omission
above remained visible. Two bounded 9000 ms TCP-forwarding delays were injected;
sealed persistence waited up to 21013 ms without blocking ingress. Actual
persistence work peaked at 263 ms. Minimum remaining stacks were uploader
1560 B and collector 2516 B.

This trial **fails memory acceptance**: failed-allocation monitoring records
19 actual failed allocations during a TLS attempt, including a 4437-byte
internal/8-bit request. The extra full-size snapshot pushes the established
working set beyond the earlier safe margin; unchanged 32/18 KiB admission
floors alone do not guarantee TLS allocation success. No crash occurred, but
retryable upload failure is not an acceptable substitute for callback loss.
The observer therefore did not meet its ten-minute-active target. Later cloud
readback extends beyond that observer's cutoff and must not be used to relabel
it as a successful ten-minute measurement.

The device was then stopped through its ordinary physical USB setup transition,
which drains the old policy before stopping network/radio. A new full backup
under `revision-2/pre-change-backup/` preserves all ACK changes and new batches.
The next implementation uses a small codec view and policy-sized address bank
instead of the always-resident 64-address sealed copy. Subsequent measurements
must independently pass both ingress-loss and failed-allocation criteria.

### Compact second implementation

The replacement keeps a read-only 104-byte codec window view and borrowed
address/raw pointers. Its sealed structure is 384 B on C3; the four-report raw
handoff remains 272 B. A policy-sized bank is allocated once during guarded
apply, after the previous policy drains. Sixteen addresses reserve 2048 B;
64-address policies still reserve all 8192 B without reducing the advertised
capacity. No allocator, encoder, Flash operation or HTTP wait runs in the
collector. Failed allocation, partial startup and failed stop retain ownership
for a safe retry; successful drain/teardown permits release.

For the actual 16-address policy, new resident storage is 2754 B including the
small control/health fields. The 3072-byte collector stack reduction therefore
makes the net reservation 318 B smaller than the original synchronous baseline,
for the handoff/state and collector-stack group, before allocator metadata,
other telemetry state and linker alignment. It recovers 6128 B compared with
the failed full-snapshot trial. The target codec/collector frames contain no
complete 8.5 KiB window copy.

ASan/UBSan and original literal fixtures remain byte-identical across all 69
pipeline batches. Additional tests exercise view immutability/legacy wrapper
side effects, first allocation failure, retaining an old bank on OOM, retry,
16→64→16 apply/start/stop, capacity overflow, post-allocation start admission,
collector/host/deinit stop failures and final-window drain before freeing.
Independent lifecycle review and full SDK 5.5.3 C3 builds pass. The second lab
image is `blp-2a362f6fb95e`; the normal direct-route, profiling-disabled candidate
is `bln-f0cb978615bb`. Both include the pressure-start correction. Physical
acceptance follows separately; larger-policy native support is not a 64-address
C3 field-performance claim.

### Compact lab rerun: passed within its measured scope

The second run observes 639 seconds in one boot, including 603752 ms of
continuously active sampled collection after startup. Counters at the first
active sample and last state rise from 296 to 13166 reports, a delta of 12870;
13166 is the cumulative count, not an exact 600-second RF reception census.
The existing raw-off/16-address policy and 64-entry ingress queue are unchanged.

| Measurement | Compact lab result |
| --- | ---: |
| Callback queue loss / collector rejections | 0 / 0 |
| Ingress queue high-water | 10 / 64 |
| Dropped windows / storage / summaries / raw | 0 / 0 / 0 / 0 |
| Sealed overflow / memory pause / crash or reboot | 0 / 0 / 0 |
| Actual failed-allocation callbacks | 0 |
| Verified upload ACKs | 154 batches / 419761 body bytes, including backlog |
| Current-boot ACKs | 40 batches / 46548 B; newer address batches can still be queued behind old stream heads |
| Appends in active periodic reports | 100 / 246436 B |
| HTTP completions / actual socket reuses | 191 / 99 |
| Pending slots | 143 before boot → 90 at the final state |
| Maximum collector seal wall time | 1277 microseconds |
| Maximum sealed wait / persistence wall time | 7454 ms / 243 ms |
| Minimum remaining collector / uploader stack | 2396 B / 1560 B |
| Weighted active CPU busy | 32.176% |

The two 9000 ms opaque-TCP delays were both consumed. One upload timed out and
remained retryable; ACK failure count stayed zero. The original historical
3831-byte/9-item body again received HTTP422 and stayed preserved rather than
being rewritten or fake-ACKed. These outcomes are separate from ingress loss.
The unchanged heap floors, actual failed-allocation callback and live collection
state make this a pass of both memory and ingress criteria, unlike the first
trial. CPU shares are measured on this controlled route, not a causal CPU
comparison with earlier public-path runs.

Same-boot D1 readback restricted to device monotonic time at or below 638850 ms
contains 20 full windows / 12763 reports with zero aggregation drops. They have
their own window-boundary interval, which differs from the sampled active-state
interval above. The unbounded query includes a 21st window after the observer
cutoff; it is not added to the timed result. Periodic operation reports also
have interval boundaries, so append/ACK byte totals are not precise request
submission rates. There are no storage failures in the append cohort.

The address table still has the policy's 16-entry limit. Its last timed cloud
status reports 5112 per-address overflow reports; these are omitted individual
address summaries, while global report/RSSI aggregates continue. They are not
zeroed or mislabeled as callback loss. This run is not raw/all-address/radio-
complete capture, and a pending RAM handoff is not power-loss-durable.

The run was gracefully stopped and its latest Flash verified before switching
images: 90 pending slots / 296000 body bytes, 251 ACKed slots. Bootloader,
partition table and `cardid` remain identical across the run. New queued data
and receipt states are retained. The temporary forwarder is stopped; final
direct-route acceptance follows.

### Final normal direct-route run

The final installed image is `bln-f0cb978615bb`, 1556848 B, SHA-256
`917ff6868ded75f9b18c92b26afa599510fb44d3a796440a1c1e2ef202fe4ad8`.
App-only write and complete expected-Flash verification pass against the latest
backup; saved settings, current ACK states, all queued batches and protected
device data are retained. The route override and profiling are disabled, and
the temporary forwarder is stopped. The device is left running this image.

| Measurement | Normal direct result |
| --- | ---: |
| Observation / continuous active sample span | 368 s / 304137 ms |
| Cumulative reports / active-sample counter delta | 6925 / 6303 |
| Callback / collector / window / storage / raw / seal losses | All 0 |
| Ingress queue high-water | 5 / 64 |
| Actual failed-allocation callbacks / memory pause / reset | 0 / 0 / 0 |
| Validated upload ACKs | 50 batches / 119176 body bytes, including backlog |
| Current-boot ACKs | 20 batches / 23244 B |
| HTTP completions / actual socket reuse | 75 / 29 |
| Retryable uploads / ACK failures | 2 / 0 |
| Maximum sealed wait / persistence | 23558 ms / 216 ms |
| Collector's self-published remaining stack minimum | 2400 B |
| Flash pending slots at first/last active sample | 90 / 90 |

The direct path has actual approximately 12-second TLS/response timeouts; they
are not represented as successful delivery. Collection continues while a
sealed window waits up to 23.558 seconds. At the last state, one sealed RAM
window is still pending; it is separate from the 90 Flash slots. No callbacks,
windows or storage are dropped in this bounded observation. The old HTTP422
batch remains frozen and is rejected once again rather than deleted.

Same-boot cloud items filtered to uptime at or below 367981 ms independently
confirm 11 windows / 6851 reports, zero aggregation loss and current statuses.
Their full-window interval includes time before the first active-state sample;
they are not substituted for its 304.137-second counter delta. Readback can
include server-committed data whose ACK timed out on-device. Normal profiling is
off, so no CPU percentage is inferred from this phase. Both direct and control
phases pass the ingress/memory criteria; direct Internet stability, complete
backlog drain, arbitrary outages, power loss and all-address/raw capture remain
outside that bounded conclusion.

## Reproduction and retained evidence

Ignored `captures/ble-decouple-20261028/` retains the aggregate workload audit,
first failed physical trial and original full-journal backup. `revision-2/`
contains both 281-file source manifests, SDK build logs/configuration, separate
images, protected-image Flash checks, two latest full backups, numeric serial
events, summaries and device-uptime-scoped cloud evidence. Credentials,
identities, original observations and private build-route values remain there;
none belong in tracked report files.

Local checks: set `IDF_PATH` to the installed ESP-IDF 5.5.3 tree, then run
`UV_CACHE_DIR=/tmp/campuspulse-uv-cache bash firmware/tools/check-chain.sh`.
Use `firmware/tools/build-passport.sh` for a fresh normal image and
`--profile` for explicitly instrumented evaluation. Neither build command flashes
hardware. Any hardware rerun requires the actual target/layout check, a fresh
verified backup, app-only flashing, explicit real collection and loss accounting,
and retaining all data produced during temporary tests when restoring normal
firmware. The transient routing control is an experiment, not a production
endpoint or checked-in device setting.
