# Passport memory, rejected batch and queue recovery

Status: original-byte rejection and ten-second regression isolated; local fixes,
two bounded physical profiles and matched HTTPS/MQTT-TLS measurements verified,
2026-10-28 (Asia/Shanghai). The normal image is installed and startup/BLE/cloud
persistence observed; public-path timeout and long-run loss/queue recovery
remain unresolved. See the [integrated performance evaluation](performance-evaluation.md).
The subsequent [collector decoupling and compact memory rerun](ble-ingress-decoupling.md)
records the newer installed image and bounded zero-ingress-loss acceptance;
the original cohorts below remain historical evidence.

## Preserved evidence

The starting device image was `dbg-e075e9efd595`. Its fresh full8MiB backup is
`captures/memory-queue-20261028/backup/full-before.bin` (ignored/private), SHA-256
`3f2f7bff6d813c51d3190bab01418cddc07a59ec0d7b5a5cb14e46982d281e59`.
The341slot journal has234pending and107ACKed records, no CRC-invalid/quarantined
slot, and one semantically invalid batch. The device was held in download mode
after backup while fixes were prepared, preserving the fault/queue state.

## 422: historical half-open boundary

The original pre-UI backup contains one nine-item address-summary candidate
matching the observed cross-boot422: slot13/ordinal370,3831bytes, SHA-256
`303bf0c2bed236b3297c476a9b82a10b19617fc0d939d3aa6b86cded8acf06ec`.
Its first item's `duration_ms=1970` and `last_offset_ms=1970`; the legal last
offset is1969. Exact original bytes, unmodified, return422/`invalid_device_v2`
at `items[0].last_offset_ms` in a real local workerd/D1/R2 run with zero receipt
or item writes. The remaining eight items validate individually. The fresh
backup retains that same body/hash pending, proving the experiment did not
rewrite or silently discard it.

Original UART did not retain a request hash or response JSON, so this is the
unique matching queued candidate and exact local reproduction, not an online
trace of the field-error string. The current encoder already contains the
half-open end fix introduced in `aa1b3ec`; no production-validator relaxation or
mutating retry of the old batch is warranted. The uploader temporarily blocks
the rejected slot and continues other slots; one such slot does not explain
sustained backlog growth. Synthetic regressions cover the nine-item atomic
rejection and a fully legal boundary+1 batch with idempotent ACK.

## Capacity and timing

Live policy is passive100ms/20ms scanning,30second windows/5second bins,
16tracked addresses, raw off, max16items/8192bytes and120second control lease.
The existing conservative encoder emits address groups6+6+4, one window batch
and one status: five ingest requests per30seconds, plus roughly two recurring
contact/config requests. Recent address bodies are3725–3767bytes for six items,
2523–2626for four; window900–954 and status1418–1463bytes. About12.3–12.6kB per
window is therefore carried by seven operations. Fresh4second requests consume
about28seconds before JSON/Flash/yields; fresh10second requests need70seconds.
This is a batch/call capacity calculation, not a measured steady-state SLA.

Same-network Mac controls bound physical `en0`, fixed both real CFIPv4addresses
and used TLS1.2/HTTP1.1 without ALPN. Four direct health requests completed in
0.777–1.192seconds, TCP0.187–0.302 and TLS-complete0.553–0.836seconds. These are
public health controls, not authenticated ingest/D1 latency. `--noproxy` alone
would not have bypassed Stash's TUN; the explicit interface/address binding did.

The diagnostic-vs-production power setting is another concrete confounder:
both isolated benchmark firmwares call `esp_wifi_set_ps(WIFI_PS_NONE)` while
production leaves the pinned SDK's default `WIFI_PS_MIN_MODEM`. The pinned
SDK documentation says modem-sleep receive delay can extend to the AP's DTIM
cycle. This is a hypothesis until controlled device measurements finish.

The temporary `tim-08c4fa1a4cd0` image starts from the exact prior debug source
and changes only network/request timing sources. It preserves transport,
allocator, scheduling and protocol behavior. Six completed requests retain the
original power mode, six disable modem sleep, then six restore the original mode.
Numeric logs separate DNS, connection+TLS, first response, transfer and cleanup;
actual mode/read/set errors and RSSI are recorded without AP identifiers.
Only the app partition is written after full backup/digest checks.

### Power-mode isolation

The eighteen-request power A/B/A experiment completed with strict TLS and the
same original full UI. Six original`MIN_MODEM` requests had median10.662seconds
(DNS0.5ms, connection+TLS8783ms, first-response1783ms). Six`NONE` requests had
median8.728seconds (connection+TLS7228.5ms, first-response1314ms). Restoring
`MIN_MODEM` returned to10.580seconds. Power saving contributes about two seconds
under these conditions but does not explain the full regression. RSSI remained
approximately−28..−30dBm, and body transfer/cleanup took only milliseconds.

### UI A/B/A establishes the main regression

An independent instrument-only`uit-817317371557` run kept power mode`MIN_MODEM`
throughout, without allocator/transport/scheduling fixes. It paused only the
presentation/sampling work for six requests, then restored it:

| UI state | Samples | Median total stages | Median connection+TLS | Median first response |
| --- | ---: | ---: | ---: | ---: |
| Original debug refresh | 6 | 10.558s | 8.7885s | 1.769s |
| Presentation paused | 6 | 4.017s | 2.641s | 1.330s |
| Refresh restored | 6 | 10.5565s | 8.7855s | 1.7735s |

Original frames took1.26–1.34seconds wall time. The single-core supervisor/UI
has priority5, network/control4 and uploader3. Rendering repeatedly scans all
glyph pixels for each four-row DMA stripe, and the lower-priority TLS caller
cannot run while the UI is runnable. Even hardware MPI completion wakes a
lower-priority task. The identical power/network A/B/A therefore identifies the
new high-frequency debug display as the main request-time regression; network
health timing alone had not established this. The earlier debug acceptance
missed display CPU cost and should not be read as sustained-performance approval.

The renderer now clips text/digit bitmap work to the active stripe before
scanning. A real-font frame's bitmap visits fall6880000→86000, with identical
pixels on all five test pages and unchanged3840byte double DMA buffers. Host
CPU measured8.50–8.54→0.437–0.458ms/frame; C3 physical results after the fix
remain separate evidence. The requested normal refresh interval is2000ms
(0.5FPS), with page/setup/critical-failure changes immediate. A dirty-band
renderer now updates only changed four-row stripes without a framebuffer; native
pixel/navigation tests and the bounded physical profile are recorded in the
[integrated evaluation](performance-evaluation.md).

Evidence is private under`captures/https-10s-20261028/`: the power experiment is
archived separately from UI experiment sources, images, stages and summaries.

## Local implementation checks before physical profiling

- Bounded JSON printing and static schema-key ownership remove overlapping
  growth/final-copy buffers and release the JSON tree before the durable sink.
  Golden fixtures remain byte-identical. Host requested-byte peaks under an
  allocator model that cannot realloc in place fall17929→13874 and34356→26763;
  these are not measured C3 heap improvements.
- Exact-size journal read buffers replace the permanently reserved8193byte
  upload buffer. Allocation-free full-JSON metadata scanning retains complete
  body hashes, validates syntax/identity/count and rejects ambiguous duplicates.
  Actual CRC-protected bodies remain frozen across errors/retries.
- First desired-policy fetch precedes backlog; one control operation per shared
  gate and a bounded handoff give the supervisor/radio initialization a chance.
- A separate bounded HTTPS cache prototype retains only validated-ACK sessions
  subject to explicit free/contiguous RAM reserve, eight completions,1.5second
  idle and30second lifetime. Encoder/radio/control/stop/error paths release it.
  Canonical ACK validation allocates no JSON tree; general/escaped ACK forms
  release the retained TLS client before the allocating compatibility parser.
  Host tests and independent review pass. Subsequent physical profiling below
  verifies bounded reuse; admission may safely fall back to fresh connections.
- A no-allocation failed-allocation callback records saturated counts and
  coherent byte/capability details. Generic X509 fatal code`-0x3000` remains a
  TLS failure, not an invented OOM classification. The previous SDK historical
  8-bit heap minimum reached248bytes, but that sum of per-heap low-water marks
  is not proof of248bytes total free simultaneously.

The requested activity, e-bike evidence and elevator-input pages have native
rendering/navigation tests and are included in the installed normal image;
no people/vehicle ground truth or unimplemented wait estimate is fabricated.


## Bounded physical evaluation after the local checks

Two adjacent 606-second full-application runs retain real BLE, UI, encoding,
Flash and public-cloud ACK handling. Both already contain the display correction;
they are not a controlled one-variable test of each memory/transport change.
Weighted CPU busy falls from 42.430% to 31.113%, upload-task CPU from 25.400% to
13.993%, while the supervisor/UI stays near 1.5%. The second profile completes
158 HTTP operations, including 73 actual socket reuses and 123 verified upload
completions. Reused-request median is 1331 ms versus 3985 ms for new sockets.
One historical rejected slot is preserved without fake ACK or deletion.

Both profiles report zero actual failed-allocation callbacks. SDK historical
8-bit per-heap low-water sums are 12472 and 18956 B respectively; they are not
simultaneous total-free minima or a measured 6484 B transport-allocation saving.
The second run has no observed reset, memory pause or crash. Peer-certificate
copy release after strict chain verification is enabled; full PEAP
reauthentication remains unverified.

The last cloud status inside the second run's 606-second cutoff is at uptime
591845 ms: shared pending 171 (one window, 170 address-summary batches), down
from 195 at 48010 ms and 179 at 380581 ms. It reports running scan, connected
Wi-Fi, 44792 B sampled heap and zero storage/window/upload/ACK failures.
Used/unacknowledged physical-slot bytes fall from 2396160 to 2101248 B. The
same file's whole-boot receipt totals extend beyond the cutoff and must not be
called 606-second throughput.

Collection loss remains: UART at 592142 ms reports 150 callback queue drops,
zero observer rejections, 10390 observed reports and high-water 64/64. The
slightly earlier cloud status reports 138 aggregation drops; its 3821 omitted
address-table reports are a separate capacity metric. Collector window-close
wall time totals 38.810 s across 18 operations, maximum 8.303 s, mainly exposing
blocking admission rather than collector CPU use. This work improves backlog
recovery in a bounded cohort but does not establish sustained zero-loss balance.

See [the integrated evaluation](performance-evaluation.md) for task CPU, stack
margins, operation timing, exact evidence paths and matched HTTPS/MQTT-TLS
latency/CPU/heap comparisons. The final normal image without profiling passes
protected-Flash verification, saved-network boot and peripheral initialization.
It starts BLE after delayed policy fetch; same-boot D1 has two windows and one
status, while several device ACKs time out. This later poor-path observation
reaches 615 callback drops at uptime 332660 ms, without allocation failure or
memory pause. Stable public-path operation, current-boot ACK/reclamation and
loss-free collection remain open; do not apply the earlier good-path queue
trend to this later cohort.
