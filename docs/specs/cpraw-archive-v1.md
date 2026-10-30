# CPRAW archive ingestion, version 1

Status: 2026-10-30. The separate server archive endpoint, migration, private
research read and cleanup have local implementations with synthetic tests,
including a 257-chunk workerd case. The endpoint is disabled by default and is
not deployed. Production resource limits and physical device interoperability
are unverified. A host uploader for already exported files has local synthetic
and workerd tests; USB acquisition and the firmware upload path remain absent. Existing
ingest v1/v2 contracts retain their current behavior.

## Purpose and evidence boundary

Archive the exact bytes of an immutable Waveshare TF segment, including its
original header, report metadata, statistics, events, time anchors and any
interrupted or damaged tail. The archive is private research evidence. Uploading
it does not create a public observation, count people, establish radio
completeness, validate a physical placement or prove the RTC correct.

The source format is [CPRAW v1](../../firmware/waveshare-raw/FORMAT.md). The
current recorder is offline. Its USB export requires the writer to finish before
`FILES`/`READ`/`CLOSE`; reads are bounded to 512 bytes with CRC32. The export view
rejects changed file lengths, exposes at most 128 files and reports truncation.
See [firmware instructions](../../firmware/waveshare-raw/README.md).

Existing `POST /api/v1/ingest` accepts JSON bodies up to 65,536 bytes and legacy
advertisement payloads up to 31 bytes. V2 raw is bounded sampling. Neither accepts
lossless CPRAW files, extended payloads or the complete CPRAW metadata. Reuse their
authentication and durable-receipt principles, not their raw-report schema.

## First delivery and local custody

The first implementation should be a host uploader operating on a stopped
recorder or a safely removed TF card. It must preserve original files and use a
private local spool with restrictive permissions. It must never upload unrelated
card contents, raw serial logs or a Flash backup.

1. Stop safely and obtain a stable export. For USB, verify every response index,
   offset, returned length and CRC before advancing. Read precisely the listed
   file length and verify that no read silently ended early.
2. Save exact bytes to a temporary spool file, sync it, then atomically publish
   the immutable spool entry and sync its directory. Hash and locally decode the
   saved file. Keep validation output free of addresses and payloads by default.
3. Persist the manifest bytes, upload identity and progress journal before the
   first request. Resume using those exact bytes after a crash.
4. Upload missing chunks, request finalization and validate the final receipt.
   Record the receipt durably in the local journal.
5. Preserve TF and spool copies. Version 1 has no automatic local deletion,
   recorder erase command or card-format operation.

USB file indices are stable only within an export view. A later view must
re-identify a file from its bytes/header, size and hash, not a saved numeric index.
If `FILES` reports truncation, report incomplete enumeration; do not claim all
card files were archived. Pagination or an alternative complete inventory is
required before offering an archive-all operation. Do not reset USB control lines
as an incidental part of opening the serial port. If capture is active, obtaining
an export requires an explicit recording-stop decision; an uploader must not
silently stop an ongoing field recording.

Future onboard upload must use a worker task, bounded memory and closed segments.
It must coordinate TF access with the writer, keep BLE callbacks nonblocking,
retain loss counters and preserve capture throughput under network stalls. The
present export API does not allow simultaneous recording/export, so this requires
new storage arbitration and separate hardware acceptance.

## Authentication and frozen policy

All routes use HTTPS, `Cache-Control: no-store`, sanitized errors and the current
same-origin check when an Origin header is supplied. A device upload uses its
registered node bearer credential, checked against enabled server-owned nodes.
No credential, R2 key, address, payload, original filename or host path enters an
error, URL or ordinary log. Do not put bearer credentials in CLI arguments or URLs.

A new server-owned archive policy must explicitly allow `cpraw_archive`, bind a
node, dataset, purpose and retention, and fix an `accept_until` deadline. Existing
v1/v2 capture policies do not implicitly grant archive permission. Historical
offline imports use an explicit import policy; do not pretend that the recorder
received or applied an online capture configuration. Placement is either an
explicit policy association with provenance or unknown. Do not invent one from
the uploader's location. Synthetic acceptance uses a separate test dataset.

Policy acceptance, retention and quotas are checked before the first allocation.
The frozen policy has node byte/file limits and bounds pending uploads to avoid
unbounded private R2 or D1 growth. The default is denied until configured. The
global `RESEARCH_TOKEN` pattern may be reused for restricted reads initially;
per-user research roles remain separate work.

## Identities, manifest and bounds

`upload_id` is a client-generated lowercase UUID, durably fixed for one immutable
segment snapshot. Its idempotency namespace is `(authenticated_node, upload_id)`.
Do not use MAC addresses, device serial numbers, filenames or opaque CPRAW session
bytes as public identifiers. A CPRAW session can contain multiple segments; an
upload receipt describes one file and never the whole recording session.

Protocol constants below are proposed application bounds, not Cloudflare product
limits: chunk size 65,536 bytes, maximum file size 16,780,672 bytes
(`16 MiB + 2 * 1728`, matching the current export bound), at most 257 chunks,
manifest body at most 65,536 bytes. Increasing these requires a contract revision
and new runtime/firmware acceptance. All sizes and offsets are nonnegative safe
integers; digests are lowercase 64-character SHA-256 hex strings.

The UTF-8 JSON manifest has exactly these fields:

```json
{
  "protocol": "campuspulse/cpraw-archive/1",
  "upload_id": "11111111-1111-4111-8111-111111111111",
  "archive_policy_id": "explicit-server-import-policy",
  "format": "cpraw/1",
  "file_bytes": 32,
  "file_sha256": "<SHA-256 of the exact original file bytes>",
  "chunk_bytes": 65536,
  "chunks": [
    { "index": 0, "offset": 0, "bytes": 32, "sha256": "<chunk SHA-256>" }
  ],
  "source": "usb_export"
}
```

The example digest placeholders must be replaced with valid hex before use.
`source` is `usb_export` or `tf_card_copy`, an importer claim rather than trusted
device attestation. Unknown fields are rejected. No uploader-supplied timestamp,
capture statistics or decoded report data is necessary. The server extracts
session bytes and time anchors privately during validation. `file_sha256` covers
all original bytes, including an invalid tail. Manifest SHA-256 covers exact JSON
request bytes; clients freeze those bytes instead of regenerating JSON on retry.

Chunks are ordered by consecutive index starting at zero, cover the entire file
without gaps or overlaps and have `offset = index * chunk_bytes`. All except the
last are exactly `chunk_bytes`; the last contains the positive remainder. An
empty original file has no chunks and the SHA-256 of an empty byte sequence; it
can be retained as invalid evidence but never labelled a valid CPRAW file.

## Proposed routes and responses

| Route | Action |
| --- | --- |
| `PUT /api/v1/cpraw/uploads/:upload_id` | Freeze manifest and policy association |
| `GET /api/v1/cpraw/uploads/:upload_id` | Read own upload state, committed chunk indices and final receipt |
| `PUT /api/v1/cpraw/uploads/:upload_id/chunks/:index` | Commit one exact binary chunk |
| `POST /api/v1/cpraw/uploads/:upload_id/commit` | Verify complete file and commit final receipt |
| `GET /api/v1/research/cpraw/:upload_id?node_id=...` | Authorized private metadata/final receipt |
| `GET /api/v1/research/cpraw/:upload_id/chunks/:index?node_id=...` | Authorized retained original chunk bytes |

Manifest PUT uses `application/json` and `X-Body-SHA256`. Chunk PUT uses
`application/octet-stream`, the exact declared chunk bytes, `X-Body-SHA256` and
`X-Manifest-SHA256`.
Reject Content-Encoding and unexpected query parameters. Commit POST has an empty
body and `X-Manifest-SHA256`; it cannot modify the frozen manifest. Server-derived
node ownership governs every lookup; caller-supplied node identity is never
trusted. The research routes separately authorize research access and reject
uncommitted or expired evidence.

Manifest PUT creates a durable `open` intent and returns HTTP 200 with
`scope: "manifest"`, its digest and `state: "open"`. This is not a file ACK.
An exact retry returns the original association and current state (410 if expired);
the same identity with different
manifest bytes returns 409. Manifest allocation alone never means captured bytes
have arrived. Reject a path/body upload-ID mismatch before storage.

A successful chunk PUT returns HTTP 200 with protocol, upload ID, index, offset,
byte count, chunk SHA-256, stable chunk receipt ID, original server receipt time,
`scope: "chunk"` and `durability: "committed"`. It means only that chunk has
durable R2 bytes and its D1 receipt. The client verifies all identity/hash/length
fields before marking the chunk complete. A status GET is also authenticated,
uses a consistent database read and returns the same committed facts; a missing
chunk after an uncertain response can be retried without changing its identity.

Commit returns HTTP 200 only after complete verification and final receipt
transaction. A final receipt includes:

```text
protocol, node_id, upload_id, archive_policy_id, manifest_sha256,
file_sha256, file_bytes, chunk_count, scope="file",
durability="committed", receipt_id, received_at, expires_at,
validation={status, parser_version, valid_bytes, truncated_offset, reports}
```

`reports` is null when corruption prevents a trustworthy full count. Validation
statuses are `valid`, `interrupted_tail` or `invalid`. A receipt with the latter
two statuses means exact bytes were archived, not that every frame was valid.
`valid` means structural/CRC validation, not RF capture completeness. An original
file without a time anchor remains without absolute capture time. Server receipt
time is not capture time.

If bounded background verification is needed, commit returns HTTP 202 with
`state: "verifying"`, no `durability: "committed"` and no final receipt. The
client retains everything and polls status/retries commit. Background work must
have a durable job and restart strategy; a floating promise is insufficient.
Exact commit retries return the same final receipt, including its first timestamp.

## Storage order, races and finalization

Private R2 objects use server-derived namespace and content hashes, for example
`cpraw/<node>/<upload_id>/<manifest_hash>/chunks/<index>/<chunk_hash>.bin`.
Keys are never accepted from callers or returned to public APIs. Store bounded
binary chunks, not a JSON-hex re-encoding. No per-report D1 row is required.

For each chunk:

1. Authenticate, read the frozen manifest, validate index/size/body SHA-256 and
   require the expected manifest digest. A prior identical receipt wins before
   policy-expiry checks; it never recreates expired bytes.
2. Conditionally create the immutable private R2 object with its SHA-256 checksum.
   If it already exists, verify size and exact-byte SHA-256 before reuse; an ETag
   or HEAD existence check alone is insufficient.
3. Atomically commit the D1 chunk index and receipt, conditional on the upload
   remaining open, accepted and unexpired. Unique constraints select one winner.
4. If a concurrent request won, return its receipt only for identical content.
   Conflicting content returns 409. R2 success followed by D1 failure returns 503,
   preserves the source and creates no successful chunk ACK.

For file finalization, verify every expected committed chunk, read its actual R2
bytes, recheck each hash, stream the concatenation through a full-file SHA-256
and the CPRAW parser, and compare total bytes/digest with the manifest. Do not
load an entire segment into device RAM or assume a digest of chunk digests equals
the digest of concatenated bytes. Frame boundaries may cross chunk boundaries;
the parser needs bounded carry-over. Use a vetted incremental hash implementation
or a bounded background validator; Web Crypto's one-shot digest must not silently
turn the design into an unbounded allocation.

Persist a versioned validation result and final receipt in one D1 transaction
conditional on the unchanged manifest and the still-retained chunks. Concurrent
commit requests select one receipt and return the winning result. R2+D1 have no
cross-product transaction. Never send a file ACK merely because all individual
chunk requests were queued or a validation job was scheduled.

Minimum schema consists of an archive-policy registry, upload intents with frozen
manifest digest/bytes and state, unique chunk receipts `(node,upload_id,index)`,
and one immutable final receipt `(node,upload_id)`. Validation can be a separate
versioned record; future parser improvements do not rewrite original receipt
meaning. Keep receipt operations on the primary/consistent D1 path; replica lag
must not produce false missing receipts or authorize cleanup.

## Interrupted files and integrity failure

Use the current CPRAW decoder's CRC, lengths, reserved-field and type checks as
the semantic baseline, with a versioned server parser and shared fixtures. Its
short final-frame indication is `interrupted_tail`; a partial header, bad full
frame CRC, malformed frame or invalid framing is `invalid`. A later valid frame
after a purported interrupted length is corruption. A tail indication does not
prove power loss caused it.

Preserve the full original bytes for all statuses. Do not trim, repair, renumber,
reassemble extended advertisements, synthesize anchors or overwrite evidence
during import. If a recovered prefix is useful, create a separately identified
derived artifact with source hash and transformation provenance. Unknown or
malformed originals may be retained in quarantine within the same explicit
private policy; they never become public activity or valid-report statistics.

Transport integrity failure is different: a received chunk/file digest that does
not match the manifest yields no final receipt. Retry the original bytes; do not
change a frozen manifest to make the mismatch disappear.

## Retention, expiry and deletion

At manifest allocation, freeze `expires_at = server_accept_time + raw_retention`
and a policy deadline. New chunks/finalization require both deadlines to remain
open. Incomplete uploads expire too, so partial upload traffic cannot create
permanent evidence. Existing receipts can be returned after expiry, but must not
recreate deleted objects or make them readable. Use HTTP 410 plus
`evidence_state: "expired"` when reporting expired custody; retained receipt
history is not current availability.

Keep minimal deduplication receipts/tombstones through at least the later of
evidence expiry and seven days after policy acceptance closes. A retired
upload ID remains non-reusable within the frozen policy. After minimal receipts
are eligible for cleanup, policy expiry must still prevent reimport under that
policy. A deliberate new import uses a new policy/identity and does not modify
old evidence history.

Research reads deny expired bytes immediately. Cleanup first atomically marks
an upload expired/deleting and blocks new writes/finalization, then deletes its
R2 objects, then removes evidence references while retaining minimal receipts.
Finalization and cleanup race through D1 conditions, not timing assumptions.
An R2 object deleted while an in-flight PUT later succeeds remains unreachable;
retry cleanup against the tombstone until reconciled. Do not assert physical
deletion solely from one list/HEAD check. Automatic orphan cleanup is disabled
initially; a reviewed reconciler must respect active intents, deadlines and
in-flight writes before deleting unreferenced objects.

No bucket lifecycle rule may delete retained evidence before the registered
policy. R2 public access, public object URLs and CDN caching remain disabled for
archive objects. Research responses use no-store and attachment/binary handling
as appropriate; raw advertising content is never executed as HTML.

There is no DELETE route for device custody in version 1. A final cloud receipt,
broker ACK, HTTP 202, local sync count or successful build never authorizes TF or
spool erasure. Explicit later cleanup needs a separate retention decision and
must verify current cloud readability/digest before releasing the last local
copy. Archive retention expiry must not automatically delete a local original.

## Errors and required acceptance

Use the existing sanitized `{error:{code,message,retryable}}` shape. Expected
statuses include 401/403 for authorization, 409 for identity/content/state
conflict, 410 for expired policy/evidence, 413 for bounds, 415 for encoding/type,
422 for manifest/shape mismatch, 429 with Retry-After for quotas, and 503 for
unconfirmed storage/verification. A corrupt CPRAW file with correct transport
hashes is archived as `invalid`, not misreported as a transport failure. Clients
retry retryable failures with bounded backoff/jitter, preserving exact bytes and
allowing explicit operator attention for terminal failures.

Before deployment, require local workerd D1/R2 tests and controlled synthetic
files covering: exact/concurrent retries; changed manifest/chunk identity; wrong
node/policy/dataset; index/length/hash/encoding/body limits; empty files; frames
crossing chunks; legacy and extended payloads; metadata/events/time anchors;
missing/bad headers; CRC corruption; interrupted tails and hidden later frames;
R2 failure; R2 success/D1 failure; ACK loss; uploader restart; partial enumeration;
finalization races; primary/replica consistency; expiry/deletion/in-flight PUT
races; research authorization and expiry; redacted logs. Verify retry receipts
after evidence deletion never resurrect bytes. Verify archive imports do not
alter public activity projections. Benchmark worst-case 257-chunk validation,
CPU, memory, subrequests and database work before fixing synchronous versus
background execution. Physical USB/TF tests are separate from these software
checks and must demonstrate that no source file was erased or altered.

## Owning sources and platform references

Repository behavior was inspected in `worker/ingest.ts`,
`worker/ingest-validation.ts`, `worker/ingest-store.ts`,
`worker/device-v2-validation.ts`, `firmware/waveshare-raw/main/raw_export.c`,
`firmware/waveshare-raw/main/main.c` and
`firmware/waveshare-raw/tools/decode.py`. Existing durable-ingest behavior is
documented in [backend ingestion](../notes/backend-ingestion.md) and
[ingest v1](ingest-v1.md). These implementations do not supply the proposed
archive authorization/schema/routes automatically.

Cloudflare references checked while drafting:
[R2 Workers API and conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/),
[D1 database batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
and [D1 read replication consistency](https://developers.cloudflare.com/d1/best-practices/read-replication/).
R2 consistency does not provide a transaction spanning R2 and D1.
