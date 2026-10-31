# Device v3 private HTTPS ingestion experiment

**Historical per-identifier feature experiment.** The final normal V3 path is
[compact window statistics and optional observation events](v3-small-statistics.md).
This endpoint and its original receipts remain compatible; they are not the
default long-term per-address database or upload format.

Status: **local experimental server implementation with bounded physical trial
acceptance, 2026-10-30; production default-off.** The implementation is
`worker/device-v3-ingest*.ts` and migration `0015`. A narrow Waveshare producer
passed the [three-window trial](../notes/waveshare-v3-acceptance-2026-10-30.md),
with [independent backend checks](../notes/v3-backend-integration-2026-10-30.md).
This does not establish general firmware support, production acceptance, radio
completeness or a deployed production endpoint.
Existing v1/v2 request bodies,
policies, receipts and public projections keep their existing semantics.

Read with [v3 configuration](device-v3.md), [v3 control](device-v3-control.md)
and [feature evidence](ble-inference-v1.md). The control service permits only the
gated upload subset below; accepting a configuration alone is insufficient
evidence of actual collection or custody.

## 1. Supported policy subset and gates

The proposed gate is `DEVICE_V3_INGEST_ENABLED="true"`, independent of
`DEVICE_V3_CONTROL_ENABLED`. Both must be true for new ingestion and assignment
of upload-enabled policies. Absent gates return `503 v3_ingest_disabled` without
reading or writing evidence. No production configuration enables either gate.

An upload policy must pass the existing complete v3 validator and capability
negotiation, plus all of these narrower conditions:

- `uplink.transport:"https"`, with streams exactly `feature_summaries` and
  `node_status`; raw sampling and archive are off. MQTT, ordinary/address window
  streams, raw reports and CPRAW are unsupported by this experiment.
- Collection and summary windows are enabled; evidence mode is `features`,
  association scope is `window`, and local raw is off. TF is not required.
- Dataset is `field`, `demo` or `controlled_test`, with its exact existing purpose
  and a non-null placement. All received data remains private. Unassigned
  research and segment association are rejected.
- Queue mode is `durable`, with exactly these two stream reserves and the
  existing control reserve. A capability claim is not proof of journal recovery.
- `control.lease.on_uplink_expiry` is `pause`. Post-lease or post-policy draining
  is unsupported: there is no trusted batch-freeze registration or heartbeat in
  this experiment. Collection lease behavior remains governed by the policy.
  Lease duration must exceed the summary window length. Assignment and applied
  ACK require sufficient remaining policy/capability time for one full window.
- Feature fields are a nonempty subset of `service_uuids`, `company_ids` and
  `appearance`. Name-pattern/template IDs are not accepted until a separately
  reviewed public registry is supplied. Producer and extractor versions must
  belong to an explicit server-owned allowlist and match the bound capability.

Allowlists are nonempty JSON arrays in `DEVICE_V3_PRODUCER_VERSIONS` and
`DEVICE_V3_EXTRACTOR_VERSIONS`. Missing/unsupported versions deny new upload
assignments and batches. Removing an entry does not invalidate committed receipt
replay. The two explicit switches remain independent of allowlist contents.

The upload gate must not weaken the existing control-only policy path. A new
assignment cannot expand a historical assignment or change queued request bytes.
The service reports only this supported subset, never generic v3 interoperability.

## 2. Strict request and response shapes

Proposed route: `POST /api/v3/ingest`, over HTTPS with the existing enabled-node
bearer credential. No query parameters are accepted. Require uncompressed
`application/json` and `X-Body-SHA256` containing SHA-256 of the exact request
bytes. Bound streaming input to 65,536 bytes before parsing, then enforce the
possibly smaller policy body limit after immutable policy lookup. Reject
duplicate decoded keys, malformed UTF-8, unknown
fields, unsupported versions and unsafe integers using the strict byte parser.

Every field shown below is required. IDs, lowercase UUID v4 values, digests and
version labels follow the v3 core. `seq` and `window_seq` are 1–2^32−1; timestamps
in milliseconds and counters are nonnegative safe integers. No free-form device
messages, paths, network names, addresses or credentials are accepted.

```text
{
  protocol: "campuspulse/3",
  schema: "device-ingest/3",
  batch_id, node_id, boot_id, placement_id,
  policy_id, policy_sha256, assignment_generation,
  dataset: "field" | "demo" | "controlled_test",
  producer_version,
  stream: "feature_summaries" | "node_status",
  items: [ ... ]
}
```

One request has one stream and one assignment. Feature requests contain 1–128
items, further bounded by `uplink.max_batch_items`; status requests contain
exactly one. Feature items in one batch belong to exactly one window. Items are
strictly increasing by `seq`; gaps are allowed and never presented as complete
capture. A sequence is allocated once per `(node,boot,stream)` and never resets
on policy changes. Exhaustion requires a new boot, not wraparound.

A feature item is exactly `{seq,evidence}`. `evidence` has the strict
`FeatureEvidenceV3` shape in `worker/device-v3-evidence.ts`. Its complete scope
must match the envelope and frozen policy; `scope.capture_config_id` equals
`policy_id`. `ruleset` and `dictionary` are omitted in this subset. Lists,
support counts, population/sampling, omission/null/empty distinctions and
extraction-state rules retain that validator's semantics. Only configured
feature lists may appear. Full extraction requires every configured list.

The status item is exactly:

```text
{
  seq, schema: "device-status/3",
  time: {mono_ms, utc_ms, clock_epoch, uncertainty_ms},
  uptime_ms,
  collection_state: "running" | "paused" | "failed",
  queue: {
    feature_summaries: {pending_items, pending_bytes},
    node_status: {pending_items, pending_bytes}
  },
  losses: {
    feature_items_dropped, feature_bytes_dropped,
    status_samples_coalesced, upload_failures, ack_failures
  }
}
```

Status UTC and uncertainty are required non-null; `time.mono_ms===uptime_ms`.
Counters are cumulative within the boot and not added across boots. The queue
objects measure frozen records/body bytes, not radio reports. Their sums must fit
the policy's non-control queue totals. Stream reserves are guaranteed minimum
capacity, not independently imposed maxima. Omitted counters are invalid,
unknown values cannot become zero, and status is a device claim, not a heartbeat
or lease renewal. In increasing status-sequence order, uptime, clock epoch and
each loss counter must not regress; delayed insertion checks both neighboring
retained statuses. Keep compact ordering/counter anchors until receipt expiry
to prevent cleanup from reopening a regressing sequence.

Successful response is exactly:

```text
{
  protocol: "campuspulse/3", schema: "device-ingest-receipt/3",
  node_id, boot_id, stream, batch_id, body_sha256,
  policy_id, policy_sha256, assignment_generation,
  seq_first, seq_last, accepted_count,
  receipt_id, received_at, expires_at, retain_until,
  durability: "committed", custody: "private_source",
  inference: "not_performed", window_completeness: "not_established"
}
```

Receipt ID is a server-generated UUID v4; times are canonical UTC strings.
`expires_at` is this batch's private-source deadline. `retain_until` is the
separate minimal receipt deadline. Never include evidence, tokens or storage
keys. Return `Cache-Control:no-store` and `X-Content-Type-Options:nosniff`.
Only a complete exact matching committed receipt permits device reclamation.

## 3. Historical application and conservative time authorization

Resolve the immutable assignment by `(node,assignment_generation)`, recompute
its policy digest, and require the exact policy ID/hash, boot, capability,
placement, dataset and producer version. Require its immutable terminal ACK to
have `state:"applied"`; a desired assignment, failed ACK or current pointer
alone is insufficient. Validate the historical bound capability snapshot, not a
new snapshot substituted by the device. Authorization remains the currently
enabled node's current credential and is rechecked inside the commit transaction.

Let `A` be that applied ACK's server `received_at`, and let:

```text
D = min(policy.expires_at, custody.accept_until,
        capability.expires_at, A + control.lease.duration_ms)
```

New batches commit only before `D`, using the database clock. No request or
retry renews `A`, `D` or source retention. Exact committed retries may return their
original receipt after `D`; they cannot insert data or extend retention.

Every feature start/end and status point needs UTC with uncertainty 0–5,000 ms.
For a point define `[L,U]=[utc_ms-uncertainty_ms,utc_ms+uncertainty_ms]`.
For a feature window use the start's `L` and end's `U`. Require:

- `L >= max(A, policy.not_before, capability.issued_at, placement.valid_from)`;
- `U < D`, and `U <= database_now` at commit;
- the observation's uncertainty interval lies wholly inside the placement's
  effective half-open validity interval, including a recorded closure;
- feature monotonic duration exactly equals `summary.window_ms`, both endpoints
  share one clock epoch, and UTC-duration discrepancy is no greater than the sum
  of endpoint uncertainties;
- `window_seq` exceeds both the policy activation floor and the actual applied
  ACK's `closed_window_seq`.

UTC and monotonic values remain producer claims. These checks establish only
consistency with authenticated server history, not physical clock accuracy.
Missing UTC, unknown uncertainty, inconsistent clocks or ambiguous history fail
closed; server receive time never substitutes for observation time.

Older successfully applied generations may upload before their own `D` even
after a desired/applied pointer changes. For an older generation within one boot,
the earliest later successful ACK also bounds `U` to be strictly before its
server receipt time, and bounds feature `window_seq` at or below that later
ACK's closed-window sequence. Failed ACKs do not establish replacement.

Retired boots are deliberately unsupported for **new** uploads in this first
subset: the existing registry lacks a dedicated immutable retirement event with
the required timing semantics. Require the batch boot to equal the current
registered boot at commit; preserve rejected old frozen bodies for future
operator recovery. Receipt replay for an already committed retired-boot batch
remains supported. Closing a placement does not itself erase a receipt or reject
older, provably in-range observations; ambiguous timing is rejected.
This subset therefore does not support durable-queue drain across reboot; that
needs a later retirement/recovery contract. Successful ACK window/segment
boundaries cannot regress within a boot or close below the greatest committed
feature window. These checks are transactional with ACK commit, so an ingest/ACK
race cannot retract accepted evidence.

## 4. Identity and cross-batch window accounting

`identity.scheme` is `window_token`; token is exactly 16 random bytes encoded as
32 lowercase hex characters. A producer assigns a fresh cryptographically random
token to each `(address,address_type)` per complete window scope, consistently
uses it for that window's ADV/SCAN_RSP, and never uploads the mapping. Tokens must
not derive from MAC, payload, name or a persistent device key. Address type stays
the existing bounded enum. The server cannot prove correct random generation or
non-reuse across windows; it must neither claim unlinkability nor add cross-window
token indexes, deduplication, joins or public exposure.

The window key is `(node,boot,policy_sha256,placement,dataset,window_seq)`.
Prevent one `(node,boot,window_seq)` from binding conflicting assignments/scopes.
Persist the first window's observed-time object, population, sampling,
extractor-version and window-scoped counters; later batches must match exactly
after validated canonicalization. `(window,token,address_type)` is unique, even
when another item sequence or batch ID is supplied. Different tokens are not
merged by feature similarity. No request claims a complete window, including a
request containing zero feature values; empty feature batches are rejected.

In the same transaction as receipt creation, enforce accumulated per-window:

- Identifier count <= `min(summary.max_addresses,512)`.
- Sum of `examined_reports` <= `evidence.max_reports_per_window`.
- If `window_reports_seen` is known, summed available reports cannot exceed it;
  if all identifier-worker counts are known their sum cannot exceed it either.
- Feature bytes <= `evidence.max_bytes_per_window`, defined precisely as
  `2 + sum(UTF8(canonical(evidence)).length) + max(0,identifier_count-1)`.
  Canonical JSON uses the core's sorted-object-key, preserved-array-order rules,
  without its digest domain prefix. Envelope and item-sequence bytes are excluded
  here and counted by the upload quota below.

These counters never reset when a batch ends or private rows are cleaned.
Window tombstones contain no tokens/features. They close the window at its
earliest private expiry and remain until receipt expiry; no new evidence can be
added to a closed window. Partial extraction remains partial, and feature
support counts are never summed into a fabricated distinct-report total.

## 5. Quota, atomic storage and namespaces

Use additive v3 tables for receipts, private items, window budgets, status-order
anchors and node/day quota. Do not point v3 rows at v1/v2 capture_configs or
silently add them to public/admin union views. D1 can hold this bounded normalized
private subset; no R2 raw-object write is needed.

Quota is exact request-body bytes of newly committed batches, shared across both
streams and **all v3 assignments for one node per UTC calendar day of commit**.
Retries contribute zero. At commit require the node/day total plus body length
not to exceed the minimum `max_upload_bytes_per_day` among successfully applied
upload policies whose `[A,D)` intersects that UTC day. Thus changing assignment
does not reset the counter or evade a lower applicable limit. A later lower
limit can block further ingestion but cannot revoke old receipts. Policy history
is bounded by the control service; the query must use indexed node/generation
selection and fail closed on corrupt history. Quota counters live until UTC day
end plus seven days; an old body accepted on a later day uses that later day's
quota only if all its independent validity/retention checks still pass.

Batch IDs are unique per node across retained v1/v2/v3 receipts and replay
tombstones. For shared stream names,
`(node,boot,stream,seq)` and overlapping declared batch sequence ranges are also
exclusive across versions. Enforce both directions in additive SQL triggers:
an old endpoint must not accept a collision after v3 committed first. Gaps in a
batch's min/max sequence interval remain reserved, matching legacy semantics.
The new feature stream has its own sequence namespace. Cleanup cannot remove a
collision tombstone while a corresponding policy can still accept new uploads.

One D1 batch transaction asserts current credentials/enabled status, current
boot/control version, immutable applied assignment and relevant time/placement
history, checks budgets and quota, then commits items, bookkeeping and receipt.
Any assertion/constraint/storage failure rolls back every change. Concurrent
identical requests select one committed winner; differing bytes under one batch
ID conflict. Retry after a lost response returns the same original receipt.
Do not report a receipt after only validation, in-memory buffering or waitUntil.
Recheck authorization, clock, UTC day and placement guards after all item/quota
writes, before commit; a slow write cannot cross a deadline and still ACK.

## 6. Retention, private access and failure behavior

Private-source expiry is measured from the **earliest possible observation**,
not upload time: `L + source_retention_hours * 3600000`. A feature window has
one fixed expiry; a status batch uses its own point's `L`. Reject a new batch
whose expiry is at/before the commit clock. Never extend an earlier window
expiry with later batches. Require all items in a feature batch to have the same
window interval, hence the same expiry.

Receipt retention ends at `max(expires_at,custody.accept_until+7 days)`. Until
then the receipt and non-feature replay/budget/order tombstones remain. Exact
retry returns the historical receipt even if private rows were deleted, without
recreating them. After that deadline, reads/retries return `410 receipt_expired`;
the service never treats deletion as permission to ingest again under an expired
assignment. A compact batch-ID tombstone may be needed while another protocol
can still accept that node/batch namespace; it must retain no per-identifier data.

This subset introduces no private evidence-read route and no inference output.
Future research reads require independent research authorization and immediate
expiry denial; device possession or admin login alone grants no such access.
Cleanup deletes expired private item JSON/tokens and then expired replay and
accounting metadata. Purge private data even if receipt cleanup fails. Never log bodies, tokens or unknown
input fields. Any future derived result expires no later than the earliest
source expiry and also obeys `derived_retention_hours`; it cannot renew sources.

Cleanup is independent of the ingestion gate and legacy/R2 cleanup success. It
safely skips a database without migration `0015`, deletes at most four rounds of
5,000 private rows, and reports `deleted_private_rows`, `rounds`,
`expired_backlog` and `oldest_expired_age_ms`; a backlog logs only these
nonidentifying metrics. Deletion is eventual, not guaranteed at the TTL instant.
Production activation remains blocked until admitted traffic, cleanup throughput,
failure recovery and backlog alerting are measured together. Maximum policy
values are validation ceilings, not a proven sustainable retention workload.

**D1 Time Travel backups and recovery:** live-row expiry/deletion does not erase
historical provider backups. D1 Time Travel is always on for production storage
and retains recoverable history according to the account's plan; a restore can
restore deleted rows. See the [official Time Travel and backups documentation](https://developers.cloudflare.com/d1/reference/time-travel/).
No source-retention statement here promises deletion from every backup copy.
Before a restore, disable v3 reception and every private-read surface and keep
them disabled after recovery. Repeatedly purge using the **current clock**, verify
zero expired private backlog, and revalidate schema, authorization, policy/ACK,
replay and quota state. Assess lost committed-receipt history before reopening.
Recovery acceptance and backup-retention disclosure are production prerequisites;
this work performed no production restore or backup-erasure validation.

Errors use `{error:{code,message,retryable}}` with fixed non-echoing text:

| Status | Conditions | Retry behavior |
| --- | --- | --- |
| 400 / 415 / 422 | Bad hash/JSON, media type, schema, unsupported subset, missing time evidence | Preserve body; no blind retry |
| 401 / 403 | Invalid/revoked credential, wrong node or unassigned policy | Preserve body; operator/configuration action |
| 409 | Batch/sequence/window conflict, missing applied ACK, retired boot, ordering or budget violation | Preserve body; no mutation/re-ID workaround |
| 410 | New-upload deadline, source expiry, or receipt retention elapsed | Preserve body; no retry that recreates evidence |
| 429 | Node/day quota exhausted | Retry exact body only while independent deadlines permit; use bounded backoff |
| 503 | Gate disabled, corrupt registry, unavailable storage, or a control-state race before a commit | Retry exact body with bounded backoff; never assume commitment |

An exact committed receipt is checked after authentication, bounded parsing and
body-hash verification, but before current policy/time/budget rejection. It does
not require the current dictionary/feature validator to reclassify old evidence.
Credential revocation still denies replay. After a failed transaction, verify a
concurrent winner and authorization before returning its original receipt.

## 7. Required acceptance before enabling

Use synthetic fixtures for server-only regression. Test strict/null/unknown-field semantics, exact
receipt retry, changed-byte conflicts, bidirectional cross-version namespaces,
historical applied versus desired/failed states, retired boots, uncertainty and
half-open deadlines, placement closure, status ordering, split-window budgets,
quota concurrency, transactional rollback, expiry denial, cleanup and replay
without resurrection. Use real local workerd/D1 for races and constraints.
Verify all v1/v2 fixtures unchanged and prove no private v3 record reaches public
field, demo, replay or administrator evidence views. A passing server suite is
not a firmware queue, token-generation, clock or physical-device acceptance.
The separate physical trial above covers its declared eight-identifier subset,
same-boot retries, clean queue reopen and safe stop; it does not close production
capacity, unacknowledged cross-boot drain, endurance or broader hardware tests.
