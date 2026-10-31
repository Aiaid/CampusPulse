# Online raw binary segments v1

Status: **historical draft, 2026-10-30; superseded as the default by the user's
small-statistics/local-research-raw decision. No implementation is enabled.**
Retain for optional future research only. This is independent of offline CPRAW
import and historical V3 feature uploads. Producer version: `cp-raw-producer/1`.
Raw means SDK-delivered reports within the declared scan configuration, not all
over-the-air packets. No per-address upload table is part of this protocol.

## Routes and authentication

Device routes use the existing enabled-node bearer credential, HTTPS, no query
parameters except the explicitly listed `boot_id`, and `Cache-Control:no-store`.
Administrative routes reuse the current administrator cookie and same-origin
checks. All JSON rejects duplicate keys, unknown fields and invalid UTF-8.
`RAW_ONLINE_ENABLED="true"` enables only this experiment; production stays off.

| Route | Action |
| --- | --- |
| `POST /api/v1/admin/raw-online/grants` | Admin freezes `{grant,expected_generation}` and assigns it |
| `GET /api/v1/raw-online/grant?boot_id=<uuid>` | Device reads its current grant envelope or an explicit unavailable state |
| `POST /api/v1/raw-online/activate` | Device applies the grant and binds a boot/storage mode |
| `PUT /api/v1/raw-online/segments/<segment_id>` | Commit one bounded binary envelope |
| `GET /api/v1/raw-online/segments/<segment_id>` | Device reads its own immutable receipt/state |
| `GET /api/v1/admin/raw-online/nodes/<node_id>` | Admin inspects bounded grants/receipts/small results; no raw bytes |

JSON request bodies are at most 8192 bytes. Segment PUT is uncompressed
`application/octet-stream`, at most 65,536 bytes, with `X-Body-SHA256` over every
exact request byte. No redirect is followed. IDs named `*_id` below are lowercase
UUID v4 except existing `node_id`/`placement_id`; hashes are lowercase SHA-256.
Integers are nonnegative safe integers; sequence numbers start at one.

## Frozen grant

The strict `grant` object has these fields (all required):

```text
protocol: "campuspulse/raw-online/1", schema: "raw-grant/1",
grant_id, generation, node_id, dataset: "controlled_test", placement_id,
not_before, capture_until, accept_until,                 // canonical UTC ISO
retention: {basis:"first_receipt",raw_hours,summary_hours,receipt_days},
segment: {max_body_bytes:65536,max_metadata_bytes:4096,max_capture_ms:10000},
scan: {mode:"passive",interval_units,window_units,duplicate_filter:false,phy:"1m"},
storage_modes: ["volatile","tf"],                      // either or both, unique
min_buffer_bytes, max_boots,
quota: {max_bytes,max_segments,max_bytes_per_day,max_pending_segments},
analysis: {window_ms:60000,bin_ms:5000,max_identifiers:2048,max_segments_per_window:64},
producer_versions: ["cp-raw-producer/1"]
```

`generation=expected_generation+1`; grant ID and contents are immutable. An exact
retry returns the original assignment; a competing assignment uses generation
CAS. Times satisfy `not_before<capture_until<=accept_until`; first trial limits
capture to one hour and acceptance to at most one additional hour. Raw retention
is 1–24 hours from first server receipt; summary retention is independently
authorized at 1–720 hours; minimal receipts are retained 7–30 days after grant
acceptance closes, and at least through raw expiry. These are application bounds.
Quotas apply atomically; exact retries are never charged twice. Node/day budget
is shared across grants so replacement cannot reset it. Pending-analysis limits
create explicit backpressure rather than unbounded R2 growth.

The returned envelope is exactly `{protocol,schema:"raw-grant-envelope/1",grant,
grant_sha256,server_time}`. `grant_sha256` is SHA-256 of UTF-8
`campuspulse-raw-grant-canonical/1\n` plus recursively key-sorted compact JSON of
the grant; arrays preserve order, null and omitted values differ. `server_time`
is response time and is outside the grant digest. GET never applies or renews it.

## Actual device activation

Strict JSON body (all required):

```text
{protocol:"campuspulse/raw-online/1",schema:"raw-activation/1",
 grant_id,grant_sha256,boot_id,producer_version,
 storage_mode:"volatile"|"tf",buffer_bytes,
 started_mono_us,started_utc_ms:null|integer,uncertainty_ms:null|integer,
 clock_epoch,reboot_loss_unknown:boolean}
```

The mode must be granted, `buffer_bytes>=min_buffer_bytes`, and activation must
occur during the capture interval with an active placement. Volatile mode must
declare `reboot_loss_unknown:true`; it never claims power-loss durability. UTC
and uncertainty are both known or both null. Clock epoch starts at one.
The server records immutable activation identity `(node,grant,boot)` and the
exact activation-body hash. Retries require the same bytes. A grant allows only
its bounded number of boots; a new boot does not rewrite an earlier activation.

Activation receipt is exactly:

```text
{protocol,schema:"raw-activation-receipt/1",node_id,grant_id,grant_sha256,
 boot_id,activation_id,body_sha256,storage_mode,received_at,capture_until,
 accept_until,receipt_id,durability:"committed"}
```

The device must validate this receipt before collecting for the grant. Historical
activations/grants may submit their already captured segments until their frozen
`accept_until`, even after a newer boot/grant becomes current. There is no silent
conversion to the new grant, no extension on retry, and no claim that RAM bytes
survived a reboot. Record any actual losses before discarding a full RAM buffer.

## Binary segment envelope

Exact layout: eight bytes `CPONL1\r\n`, uint32 little-endian metadata byte length,
that many UTF-8 strict-JSON bytes, then one complete CPRAW v1 header and complete
frames. Total length, including this wrapper, is at most 65,536 bytes. Metadata
is 1–4096 bytes. No padding or truncated frame is accepted. Header session bytes
must equal the 16 UUID bytes of `boot_id` in textual/network order (strip hyphens,
decode hex). A segment may contain report, stats, event and truthful time-anchor
frames; non-RTC devices must not invent RTC provenance. Online time can remain
in the outer metadata rather than a fake CPRAW anchor.

Strict metadata object (all required):

```text
{protocol:"campuspulse/raw-online/1",schema:"raw-segment/1",
 grant_id,grant_sha256,boot_id,activation_id,segment_id,segment_seq,
 producer_version,format:"cpraw/1",storage_mode:"volatile"|"tf",
 time:{clock_epoch,start_mono_us,end_mono_us,start_utc_ms:null|integer,
       end_utc_ms:null|integer,uncertainty_ms:null|integer,
       source:"server_sync"|"host_seed"|"unknown"},
 quality:{received_reports,enqueued_reports,queue_dropped_reports,
          buffer_dropped_reports,storage_errors,upload_failures,
          reboot_loss_unknown:boolean}}
```

Metadata and raw bytes are bound by the whole-body SHA-256; a body hash is not a
hash of only the CPRAW suffix. Server-derived raw/metadata hashes are in the
receipt too. The path ID equals metadata segment ID. `(node,boot,segment_seq)`
and `(node,segment_id)` are unique across grants. A new body or association under
an existing identity is a 409 conflict. Report sequence ranges cannot overlap
another committed segment of the same boot; retransmission reuses the same ID.

Every CPRAW report/stat/event monotonic time lies within the metadata interval;
`0<=end-start<=max_capture_ms*1000`, and start is not before activation mono.
Intervals of distinct segments of one boot cannot overlap (touching boundaries
are allowed). CPRAW report sequences strictly increase within the segment.
Known UTC uses the declared epoch/uncertainty and fits the capture interval;
unknown time is stored as unknown, never replaced by server receive time.
Online processing may produce only mono-relative results when UTC is unknown.
CPRAW stats preserve producer counter semantics; they do not prove TF sync or
RF completeness. Quality counters are cumulative device claims, not counts of
physical people, and losses remain explicit. AD corruption is retained raw;
invalid binary framing/CRC is rejected before custody.

## Segment custody and immutable receipt

Authenticate and bound input, verify body hash, grant/activation, framing and
quotas, conditionally write the exact envelope to private R2, then atomically
commit its minimal index, receipt and analysis work in D1. Repeat authorization,
deadline and quota checks at transaction completion. R2 success alone is not an
ACK. A losing identical race returns the winner; failed D1 commit is retryable
and leaves no successful receipt. Orphan reconciliation must respect in-flight
writes and retained grant/segment identities.

Receipt is exactly:

```text
{protocol:"campuspulse/raw-online/1",schema:"raw-segment-receipt/1",
 node_id,grant_id,grant_sha256,boot_id,activation_id,segment_id,segment_seq,
 body_sha256,raw_sha256,metadata_sha256,body_bytes,raw_bytes,
 receipt_id,received_at,expires_at,retain_until,
 durability:"committed",custody:"private_raw",analysis:"independent"}
```

Receipt replay does not revalidate against current rule dictionaries or create
deleted evidence. An expired source returns 410 with the original minimal
receipt and `evidence_state:"expired"`; it never resurrects R2 bytes. Only a full
matching committed receipt lets the uploader release that exact queued body.
Local TF retention is a separate policy; a server ACK does not erase TF files.

## Backend analysis and retention

Raw envelopes and detailed parsing/per-identifier evidence stay in private R2.
D1 holds bounded grant/activation/segment/receipt/job indices and one small result
per node/boot/epoch/mono window/rules version. No per-report or per-address D1
row is written. Analysis windows are independent of segment boundaries. Jobs
have persistent pending/leased/retry/failed state; source-hash and version CAS
make replay/retry idempotent. Late segments requeue affected windows, not append
counts to an old total. Bounded segment/identifier limits produce explicit
unavailable/partial quality, never silent truncation or an exact people count.

Small results contain report rate, visible identifiers, candidate/other/unknown/
conflict counts, bins, losses/quality, timing and algorithm versions, and one
private R2 detail reference/hash. Existing conservative AD/vehicle rules can be
used with their limitations; phone/vehicle total estimates remain null without
calibration. No raw result automatically enters public projections.

Cleanup runs independently of intake gates, blocks new reads immediately at
expiry, removes raw and detailed R2 references, and retains only bounded receipt
tombstones and authorized small statistics. It reports backlog/failure and
reconciles late writes. D1 online expiry is not erasure of Time Travel backups;
restores require gates closed, current-clock purge and fresh acceptance.

Before device interoperability, require synthetic exact retries/conflicts,
cross-grant/boot behavior, framing/length/clock errors, R2-success/D1-failure,
quota/deadline races, reprocessing/late-source idempotency, private-only D1/R2
placement, expiry/cleanup and real local workerd/D1 tests. Neither this contract
nor a passing build establishes raw endurance or Wi-Fi/BLE coexistence.
