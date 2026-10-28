# Passport debug display and real collection memory

Status: historical first-debug-build functional acceptance, 2026-10-28
(Asia/Shanghai), with a subsequently identified display CPU regression. Current
rendering/performance correction and bounded physical profiles are recorded in
[the integrated evaluation](performance-evaluation.md); final normal-build and
long-run acceptance remain separate. The normal optimized image is installed;
startup, peripheral initialization, BLE and same-boot cloud persistence are
observed; the subsequent [collector decoupling](ble-ingress-decoupling.md) passes
bounded active collection without callback/window loss. Public-path timeouts
and long-run acceptance remain separate from these historical cohorts.

## Actual baseline, before UI changes

The restored original `cp-aa1b3ec36d40` was already running the normal firmware
path: real BLE observation/aggregation, JSON encoding, Flash journal, HTTPS and
verified cloud receipts. This observation did not flash, reset, change network
configuration, change capture policy or send synthetic payloads. USB `idle` is
the provisioning service state and does not imply that collection is stopped.

A180second read-only serial observation excluded the first50ms of buffered UART
history. Same-boot Cloudflare D1 rows independently confirmed six fresh30second
windows containing3473 observed reports; this is not a radio-completeness or
people-count claim. Forty completed HTTP requests succeeded. Thirty were upload
batches with verified batch/hash/count ACKs, confirming108 items. Remaining
requests were normal contact/config/control operations. No crash/reset, explicit
allocation error or memory-pause marker was observed during this interval.
The first post-buffer HTTP completion can belong to a request that began before
the observer attached; these are observed completions, not an exact submission-
window throughput estimate. The six full cloud windows span device uptime
706432–886432ms, offset slightly from the serial observation interval below.

| Metric | Original-firmware observation | Interpretation |
| --- | --- | --- |
| Internal free heap | 40776–42900bytes | Sampled after HTTP client cleanup, not the TLS peak |
| Largest internal block | 16384–22528bytes | Post-request contiguous capacity varies independently from total free heap |
| 8-bit heap historical minimum | 16464bytes | SDK boot-lifetime per-heap low-water sum; not this request's internal-only minimum |
| Upload task stack low-water | 1876bytes | Task lifetime minimum remaining bytes; not current stack or all tasks |
| Collector stack low-water | 2328bytes | Same lifetime semantics for the collector |
| Shared upload journal | 5/341pending slots in all six status samples | Capacity is shared, not341slots per stream |
| Upload/ACK/storage/window failure delta | 0 | Bounded interval only |
| Aggregation-drop delta | 12 | Separate ingress/aggregation loss; exact root cause unresolved |
| Address-table overflow report delta | 1234 | Per-address summary omissions at the policy's bounded table capacity; not1234devices or an OOM |

The cumulative-loss bracket is device uptime707404–888476ms, overlapping the
serial interval711518–891518ms. All six cloud statuses in that interval report
`scan_state=running`, connected Wi-Fi, raw capture off and no pause reason.
The six corresponding fresh windows independently sum to12 aggregation drops.
Address-table saturation still preserves overall report/advertisement/RSSI
aggregates; it omits new per-address summaries once the logical capacity is full.

Conclusion: the full normal path currently works but has limited RAM headroom
and observable collection losses. The isolated no-BLE transport benchmark does
not establish the full application's memory margin. Existing idle guards use
24KiB free/16KiB largest for sustained scan stopping and56KiB/24KiB for restart,
with timing, fresh-policy and lease requirements. Post-request free/contiguous
headroom clears normal upload admission but does not itself establish restart
eligibility. A persistent TLS client also retains heap while idle, so its faster
uploads must not be treated as a proven full-pipeline memory fix.

Evidence remains in ignored `captures/ble-upload-memory-20261028/`:
`original-safe-evidence.json`, `original-results-safe-summary.json`,
`cloud-safe-evidence.json` and private underlying rows. The initial cloud query
labelled `receipts_last_six_minutes` used SQLite space-format time against ISO
timestamps; do not use that field as a six-minute count. The serial counts and
device-uptime-scoped window/status analysis above do not use that field.
`cloud-receipts-corrected-safe.json` separately records a corrected ISO UTC
cutoff and the actual first/last receipt times for each stream.

## Requested display

The normal device screen exposes associated SSID, RSSI and actual readable
PHY/bandwidth information; negotiated Mbps remains unknown unless a real source
exists. Upload goodput derives from measured bytes/time and is distinct from
Wi-Fi PHY speed. Memory and shared journal utilization bars must retain exact
units, unknown state and historical/current distinctions. Upload status must
distinguish in-flight, HTTP completion and a validated durable batch ACK, with
last age and errors. No network credentials enter display snapshots or logs.

Display legend:

- `SSID`, RSSI in dBm and negotiated PHY (for example `11n HT20`) come from the
  associated station APIs. `Link -- Mb/s` is explicitly unknown; mode, bandwidth,
  AP capability and RSSI are not converted into a fabricated negotiated speed.
- `Heap` is internal free/total KiB with a utilization bar. `Blk` is the current
  largest internal contiguous block. `BootMin` is the SDK boot-lifetime8-bit
  heap low-water measure; it is neither a request-local nor sampled minimum.
- `Q` shows pending/shared capacity in journal slots, with a utilization bar.
 341 is the total shared capacity, not one allocation per stream.
- `UP` distinguishes sending, verified ACK, retry/auth/policy/bad-ACK/rejected
  results and no sample. `Last` goodput is payload KiB/s from the latest
  validated ingest ACK, including this attempt's DNS/TLS/HTTP/cleanup/ACK check;
  it excludes mutex wait, journal read and earlier retries. Failure clears the
  displayed speed. Age, old/offline state, HTTP status and numeric error remain
  separate, and HTTP200 alone does not establish an ACK.
- BLE state and `A/S/R` show separate aggregation/summary/raw drop counters,
  without summing overlapping categories or mixing report/item/window units.
  Auth and collection state remain visible at the bottom.

Setup/PIN/password screens keep their existing explicit provisioning behavior.
The new normal screen must not expose setup passwords. Rendering remains owned
by the existing UI supervisor, with bounded snapshots and no additional heap-
allocating chart/task buffers. Existing unknown clock/recovery WIP stays in the
working tree and must be excluded from a selected debug-UI hardware build.

In this first debug build, all display snapshots are bounded. Sampling and
rendering run at most once per second with unchanged-frame suppression; there is no new application task,
dynamic chart buffer or renderer service call. Fixed telemetry storage adds
approximately448bytes on the measured host layouts; target image/map and task
watermarks are separate evidence. Native tests use the real20px font metrics,
cover unavailable/extreme values, stale/offline/failed uploads, counter units,
clipping and unchanged setup flows. Actual C stripe-renderer previews use only
synthetic telemetry; final PNG metadata inspection found only image structure,
with no EXIF/GPS/XMP/IPTC/MakerNotes/thumbnails/comments or identifying fields.

The hardware build exports committed firmware plus the20 selected UI/telemetry
paths into an ignored immutable source snapshot. It removes only the pre-existing
clock and uploader-yield changes in that copy; the working tree is preserved.
The selected export passed the complete Passport native checks, network and
ACK/goodput/async transport checks, ASan/UBSan cases, and ESP-IDF5.5.3 C3 build.
All238 frozen source file hashes remained unchanged through build. The app
`dbg-e075e9efd595` is1537216bytes (4688bytes above the original image), SHA-256
`1ab32f8091ae82b17ccdcab860c377164362309b486bfbe7e37e78b48fc170e0`.
Separate-image and3MiB application boundary guards passed.

A fresh full8MiB backup was verified before writing only the app at `0x10000`.
ROM digest verification confirmed the complete expected Flash image before
boot; bootloader, partitions, NVS, `cardid` and the just-collected queue were
unchanged. The new UI is retained for the user's requested debugging. No commit,
push, server deployment or cloud configuration change was performed for this UI.

## Post-update physical acceptance

The246second boot observation saw the expected `dbg-e075e9efd595` version,
display/input/battery initialization success, retained saved credentials and
one unchanged boot ID. There was one intentional initial hardware reset and no
subsequent reset, crash, explicit allocation/TLS memory error or memory-pause
marker. The supervisor reported4252bytes minimum remaining stack, uploader1884
and collector2432bytes. The historical8-bit heap minimum was16880bytes. After
collection started, HTTP-end snapshots had41248–43796bytes internal free and
16384–29696bytes largest internal block. These are not instantaneous TLS minima
and the differing baseline conditions do not establish a memory improvement.

Nine observed upload attempts received validated ACKs: five for preserved
previous-boot batches and four for the current UI boot. One additional
previous-boot address batch (nine items) received HTTP422 and a rejected result,
with zero confirmed items. Its root cause was not established; it must not be
counted as success or attributed to the new renderer without evidence.
Twenty observed HTTP operations returned200 and one returned422.

Cloud readback a little after the serial interval independently confirmed three
fresh BLE windows containing2051observed reports, three status receipts and one
address-summary batch with six items in the current boot. All three statuses
showed running BLE and connected Wi-Fi. The three full windows had zero
aggregation drops; the latest status retained913address-table overflow reports,
one upload failure and zero ACK/storage/window failures. It is a short different
cohort, not proof that the original twelve-drop condition was fixed.

Collection was first confirmed around134seconds after boot during initial
backlog/control traffic. This run's successful fresh HTTP requests took roughly
ten seconds rather than the earlier cohort's approximately four. The shared
pending journal increased from5 to12slots (341capacity) in the cloud statuses;
thus the new UI passes bounded functional acceptance but sustained throughput,
backlog/startup starvation and long-run capacity remain unresolved. The UI does
not change the production TLS connection lifecycle or memory guard policy.

Evidence is under ignored `captures/passport-debug-ui-20261028/`: frozen source
manifest, separate-image manifest, backup/flash summaries, device and cloud safe
evidence, `device-results-safe-summary.json` and
`hardware-cloud-comparison-safe-summary.json`. The synthetic preview was visually
checked using the actual C renderer; it is not a physical LCD photograph.


## Subsequent display correction and performance acceptance

The first debug build above passed bounded functional checks but its renderer
scanned full glyphs for every four-row stripe, costing 1.26–1.34 s wall time per
frame and preempting lower-priority TLS work. The original/pause/restore UI
experiment gives median request times 10.558/4.017/10.5565 s at unchanged power
mode. It identifies the main ten-second regression; the earlier receipt/UI
checks alone did not establish sustained performance.

The corrected renderer clips glyph/digit work to the active stripe and submits
only changed four-row stripes, preserving pixels and the 3840-byte double DMA
buffers. Native real-font work falls 80-fold in bitmap visits and approximately
19-fold in host full-frame CPU time. Normal refresh is now 2000 ms (0.5 FPS),
with immediate page/setup/critical-state changes. This supersedes the original
one-second normal-screen cadence described above.

Two subsequent 606-second full-application profiles show supervisor/UI CPU near
1.5%. The second profile observes 266 renders totaling 6.829 s wall time, maximum
44.090 ms, and 11569920 submitted LCD bytes over 6026 stripes. Rendering wall
and transfer bytes are not exclusive CPU or synchronous SPI duration. Updated
activity, e-bike evidence and elevator-input pages preserve unknown/unsupported
states; native rendering and navigation checks are separate from final LCD
interaction acceptance. [The full evaluation](performance-evaluation.md) records
CPU, heap, remaining callback queue losses, cloud backlog drain and HTTPS/MQTT
comparison. The historical 422's unique exact-byte candidate is locally
reproduced in the [recovery record](memory-queue-recovery.md); it remains pending
and is not a renderer-induced error or an ACKed batch.
