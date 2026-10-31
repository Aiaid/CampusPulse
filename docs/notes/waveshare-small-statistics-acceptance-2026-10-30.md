# Waveshare small-statistics V3 acceptance — 2026-10-30

Status: bounded normal-profile statistics and simultaneous TF raw validation
passed on 2026-10-31, including historical queue recovery.
Production gates remain off.

This records the user-confirmed small-statistics default. It supersedes the
eight-address feature-JSON trial as an implementation target; the historical
trial's measurements remain valid only for that separate image. The backend
contract is [small statistics](../specs/v3-small-statistics.md), and the board
application is [waveshare-v3](../../firmware/waveshare-v3/README.md).

## Preserved hardware and data

The connected Waveshare ESP32-S3-ePaper-1.54 V2 has its existing 8MiB layout:
NVS at `0x9000` / `0x6000`, PHY at `0xf000`, and a 3MiB application at
`0x10000`. The actual partition bytes match the candidate exactly. The prior
0.2.4 trial application and partition/NVS were backed up in ignored private
captures before flashing. Only the application is written; bootloader, table,
NVS settings and existing TF captures are preserved. The new budget journals
use dedicated NVS namespaces without erasing existing data.

## Software validation

The statistics, temporal history, capture, compact serializer, queue, control,
budget core, NVS provider and local raw writer have host sanitizer checks.
Sixteen board-local tests cover the NVS provider, writer faults, persistent
dual-budget ordering, exact queue ownership, prepaid expiry cleanup and clock/
retention helpers. Production ESP32-S3 compilation and image-boundary checks
are separate from those host checks.

Capture regressions cover an authority deadline crossed inside a worker step,
a report arriving after an idle barrier followed by manual pause, failed
temporal censoring, and pause/resume without resetting the bounded full-window
allowance or reusing a sequence. ACK and lease deadlines reserve 500ppm future
clock drift. Passive scanning negotiates and enables 1M only.

## First physical attempt

The board connected over Wi-Fi to the private LAN HTTPS endpoint using an
explicit CA with certificate, hostname/IP and time checks enabled. Actual
capabilities registration and configuration retrieval succeeded. RTC set/readback
passed. Applying the policy failed resource admission before scanning, and the
board committed its failed ACK, matched the receipt, reclaimed the control
record and safely unmounted TF. No window statistics were claimed.

At that failure, internal free memory was 110267bytes, largest internal block
36864bytes and PSRAM free 5949036bytes. Review identified that the capture
adapter used ordinary PSRAM calloc for portable arenas requiring max_align_t;
IDF TLSF's default allocation alignment is only 4bytes, while the actual S3
compiler requires 8bytes for these arenas. The board probe had used explicit
aligned allocation. The adapter now uses each component's alignment API and
`heap_caps_aligned_calloc`; it retains strict validation and reports numerical
alignment/remainders without addresses. Deliberately misaligned allocator
regressions and the S3 build pass. A subsequent physical run is required to
confirm the initial failure's cause and the corrected startup.

The corrected image is 1513856bytes, SHA-256
`06561d1384961d9b045ad6953fbb345b7896e2d337655133890785bbf7c27926`.
It also separates explicit PWR shutdown from bounded-test completion: after
safe cleanup a completed test stays in USB standby. The host can perform one
safe restart before its fresh nonce/clock exchange. Its first retry was deferred
when the USB serial endpoint disappeared and a LAN service restart lacked direct
approval. On 2026-10-31 the board was awake again: the actual factory identity
matched its private credential, the partition bytes were rechecked, and a fresh
partition/NVS backup was saved before application-only flashing. Esptool verified
the written image hash. The corrected USB HELLO returned the expected identity
and `restart_required=false`; no bootstrap credentials were sent in that check.
The backend owns restoring the subsequently authorized bounded test service.

The subsequent offline control-recovery update adds the transport's explicit
receipt-only API for historical ACK/lease replay. Only those two exact POST
paths accept the mode; it sends `X-Receipt-Only: 1` without changing the frozen
body or hash. A missing original receipt remains a conflict and does not create
authority. Live control exchanges retain their normal path. Host path/response
tests, the complete S3 application build and image checks pass; this new behavior
has not been exercised on the physical board. Backend service preparation is
separate from this board's deferred physical test.

## Normal-profile windows and recovery, 2026-10-31

The next physical run applied its real policy and prepared both arenas with
alignment8/remainder0. It exposed a second boundary bug: the initial window
was admitted using its start-time uncertainty, but the server conservatively
derives the whole window's lower bound from its larger end-time uncertainty.
Its original frozen body was rejected with `v3_statistics_capture_unauthorized`.
The rejected body and identity remain pending on TF at their original expiry.

Small-statistics admission now reserves the future uncertainty growth plus1ms
rounding (16ms for30s,31ms for60s). Host tests cover8000 rounding/span cases.
Repeated stop at a completed boundary is also idempotent; it cannot create an
extra partial fourth window. Exact-identity backoff selects the next eligible
batch instead of blocking behind one rejected historical body. Known terminal
server errors only defer that body's retries for the boot; they never reclaim,
rewrite or relabel it. Historical ACKs do not contribute to current-boot success.

The corrected physical generation3 then completed three60s/5s windows:

| Window | Full request bytes | SDK reports | Callback/aggregation losses | Address overflow reports | History slices | Scan coverage ms | Quality |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 767 | 5960 | 0 / 0 | 0 | 34 | 59999 | 6 |
| 2 | 768 | 6322 | 0 / 0 | 0 | 64 | 60000 | 2 |
| 3 | 768 | 6220 | 0 / 0 | 0 | 94 | 60000 | 2 |

The first current window was sent twice with identical bytes and returned the
same receipt; the backend retained one unique batch. Three current window ACKs
and three status ACKs456/458/457bytes matched. Explicit lease renewals succeeded.
The rolling history grew across uploads without resetting; its arena was
1883536bytes, with11504bytes for the512-key statistics table. Up to55tracks were
observed locally, which does not demonstrate saturated512-key operation.
Quality6 records clock uncertainty plus the initial1ms scan gap; quality2 still
records clock uncertainty. Zero application-queue losses are not radio completeness.

The earlier valid generation2 windows2/3/4 replayed at768/768/516wire bytes and
received their original-scope committed receipts. The invalid earlier window1
was explicitly rejected and retained. Final current pending was0, historical
pending1, historical ACKs3. Capture/storage/raw/network cleanup and TF unmount
completed with `safe=1`; the board stayed in USB restart standby.

The accepted three-window image is1515808bytes, SHA-256
`3710b93f952f6e510e5fee511738db8eee805d4f94aeb7aa32524842287262df`.
Private serial/runtime evidence is preserved separately for each attempt.
Backend read-only checks corroborated the sequences, report counts, quality,
three unique receipts and zero public projections; source TTLs were not changed.

## Simultaneous local TF raw and small upload

A separate physical boot/generation4 enabled local CPRAW only, with the same
60s/5s statistics,512-key allocation and rolling history. It negotiated1MiB
segments,32MiB managed total,1MiB free reserve,1s sync and64MiB daily logical
write allowance. The cloud streams remained window statistics and node status.

Its current window contained6326SDK reports, with zero callback/aggregation
losses and zero address-overflow reports. Coverage was59999ms, quality6 and
history34slices/44tracks. The full window request was772bytes; its exact retry
returned the same receipt. A487byte status request also received a matched ACK.

After intake stopped and the writer drained, device counters were
`enqueued=written=synced=6326`, with zero queue drops, storage/encoding errors or
quota/space stops. The stopped-file read-only CRC check returned success for
one487877byte file,6326report frames and one verified-RTC anchor. This check
opened the existing TF file after close; it did not write, delete, charge budget,
modify TTL or reset writer error state. Current pending was0; the rejected older
window remained as historical pending1. Storage/network cleanup and TF unmount
again completed with `safe=1`, leaving USB restart standby.

The final installed image is1517392bytes, SHA-256
`9e5ea1ffc986ef0362adaa61f4c5116ac366d4b8798f20004531fe95f2dedfb9`.
The final board-local suite has20passing host tests, in addition to capture and
control regressions and the complete S3 build/image checks. The file totals
and final sync counters above come from the stopped device; an earlier uploaded
status is a snapshot and may legitimately have a smaller synced count.
The backend corroborated one generation4 window receipt and one status receipt,
with zero cloud raw uploads and zero public projections. Its status snapshot
had6326enqueued/written and6243synced before the final device drain; the final
6326synced count is established separately by the stopped device and CRC readback.

## UI scope

The current screen is a temporary three-page English diagnostic UI: collection/
upload, resource/battery, and USB state. The prior Chinese layout and graphs
have not been migrated. Battery voltage and coarse percentage are available;
remaining runtime is still unknown without a validated load/capacity model.

## Evidence limits

Private serial logs, device identifiers, credentials, captures and Flash
backups remain ignored and are not included here. No public tunnel or production
deployment is implied. A successful bounded run would not establish saturated
512-key RF capacity, arbitrary power-loss recovery, TF endurance, long offline
operation, battery runtime, classifier accuracy or elevator waiting time.
`unclassified-v1` retains unknown counts and does not publish a people estimate.
