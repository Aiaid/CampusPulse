# BLE inference results v1 and a future device v3 evidence proposal

Status: **design proposal, 2026-10-30; not a published wire contract.** This
document does not implement an endpoint, a migration, durable inference storage,
a retry worker, a firmware producer or a deployment. Code added alongside this
proposal must document its actual supported subset separately. A pure classifier
or passing synthetic test does not establish durable processing or device
accuracy.

See the [end-to-end design](../design/ble-device-inference.md), [current device
v2](device-v2.md), [ingestion custody rules](ingest-v1.md), and the independent
[CPRAW archive contract](cpraw-archive-v1.md). The latter defines exact TF-file
custody and has a default-off local implementation with synthetic acceptance;
it is not a production upload service. This document
does not redefine its manifests, chunks, receipts or routes.

## 1. Compatibility and actual input boundaries

The current Worker v2 validator permits up to 512 retained addresses per window,
subject to the assigned policy and each device's smaller supported capacity.
The local public vehicle projection now uses the assigned policy's address
budget, up to 512. This local change has synthetic tests; it has not been
deployed or benchmarked in production. An older deployment can still enforce
the former 64-address limit.

V2 accepts strict schemas and rejects unknown fields. Its optional
`vehicle_evidence` uses `radar-compact-v1`; absence means the old producer did not
supply that feature. Its sampled `ble_reports` still uses the v1 `legacy_ad`
record, at most 31 payload bytes, MAC identity, deterministic selection and a
server budget of at most 16 reports per window. The initial Passport producer's
budget is smaller. Raw `all` is not a v2 mode. A sampled report collection is not
classification coverage of all received reports.

The existing compact masks cannot reconstruct original names, arbitrary UUIDs,
full manufacturer data, per-bin RSSI or a ChimeraBLE input. Extended reports from
CPRAW must not be shortened and relabelled as complete legacy reports. An offline
CPRAW analysis can start from a private local file without implying that an
archive upload or cloud receipt exists.

Backend classification using existing inputs needs a new **result schema**, not
necessarily a new device protocol. V1/v2 request validation, original receipts,
policy expiry and retry semantics remain unchanged. Future device v3 is only
needed for new device-produced input and requires an explicit implementation and
acceptance decision.

The local `worker/device-inference.ts` is a pure experimental classifier with
its own `device-inference-result-v1` output; it does not yet implement the
proposed durable `ble-inference-result/1` contract below. It preserves unknown
and conflicting outcomes and currently has no validated phone classification.

## 2. Common value semantics

Proposed schema names are `ble-inference-result/1` and, for a future producer,
`ble-feature-evidence/1`. They are independent from device transport versions.
All object schemas are strict; unknown fields and unsupported schema versions
fail validation rather than being silently discarded.

- Required fields must be present. Optional field omission means that the source
  or schema did not provide that capability; it never means zero or an empty set.
- `null` is allowed only where specified. It means the capability was considered
  but the value is unavailable or inapplicable. A corresponding machine reason
  explains why. It is not an alternative spelling for zero.
- An empty array means the declared extraction scope was examined and contained
  no retained values. If extraction was incomplete, its coverage/overflow fields
  must say so; an empty array alone cannot establish absence from the radio.
- Counters are nonnegative safe integers. Timestamps use the existing monotonic,
  clock-epoch, nullable UTC and uncertainty semantics. Missing UTC never becomes
  server receive time. No numeric probability is inferred from a rule count.
- Identifiers, enums, versions and reason codes are bounded machine labels.
  Error messages never echo observed names, addresses, payloads or credentials.

## 3. Private derived result

A result describes one explicit input scope. Its proposed fields are:

| Field | Required value and meaning |
| --- | --- |
| `schema` | Literal `ble-inference-result/1` |
| `scope` | `window`, `sampled_window` or `offline_segment`; these units are not interchangeable |
| `input` | Source union below, immutable source references and exact input digest |
| `versions` | `parser`, `extractor`, `ruleset`, `dictionary`; each is a bounded version or explicitly nullable with a reason |
| `observed_time` | Original observation interval, nullable UTC, clock epoch and uncertainty; never computation time |
| `computed_at` | Server or offline-analysis computation time, with its provenance |
| `expires_at` | For stored private results, no later than the earliest private input expiry; local-only analysis may use `null` with `local_custody` |
| `coverage` | Scope and counters defined below, including input completeness |
| `identifiers` | Private bounded per-address/type or scoped-token results; never a public DTO |
| `counts` | Mutually exclusive category totals, unknown and conflict counts for precisely the retained identifiers |
| `estimated_total` | `null` in this first proposal; `calibration_unavailable` explains why |
| `limitations` | Bounded, deduplicated machine reason codes |

The `input` union must preserve the real custody path:

- `kind: "device_window"`: device protocol, node, boot, placement, capture config,
  dataset and window sequence; a canonically ordered list of contributing batch
  IDs, exact body digests and relevant item sequences. Include the overall-window
  reference when it exists. Pending overall windows remain pending rather than
  being fabricated. An incomplete list cannot be labelled a complete window.
- `kind: "cpraw_archive"`: committed archive node/upload reference, file digest,
  selected frame/sequence interval and validation version/status. The source is
  admissible only while its archive evidence is retained and authorized. An
  interrupted tail remains explicitly interrupted even when valid-prefix analysis
  is possible.
- `kind: "local_cpraw"`: exact local file digest and selected interval, without a
  cloud receipt claim, filename or host path. Local provenance may carry
  `dataset: "research_unassigned"` and `placement_id: null`; this is an analysis
  provenance value, **not** a new accepted v1/v2 ingest dataset. An explicit import
  policy is required before any cloud persistence of such input.

For device windows, the full `(node, boot, placement, config, dataset, window_seq)`
scope must match before joining independent streams. Equal wall-clock times
alone are insufficient. A policy or placement change cannot be merged into the
same window result. Source references and scope tokens remain private.

### Coverage and counters

`coverage.population` is `retained_address_summaries`, `deterministic_raw_sample`
or `selected_cpraw_interval`. `input_state` is `complete`, `partial`, `pending`
or `invalid`, accompanied by reasons. It states structural input availability,
not complete over-the-air reception.

Report accounting includes `available_reports`, `examined_reports`,
`parsed_reports`, `malformed_reports`, `unsupported_reports` and
`unexamined_reports`, with:

```text
examined_reports = parsed_reports + malformed_reports + unsupported_reports
available_reports = examined_reports + unexamined_reports
```

`unsupported_reports` includes fragments that are intentionally not parsed as a
complete AD structure. Partial data may retain independently safe fields, with
their own provenance, but cannot yield an unqualified complete-record match.
`window_reports_seen` and `window_reports_aggregated` are separately nullable
source claims. They are not inferred from sampled raw. `intentional_skips`,
`pressure_skips`, queue drops, address-table overflow and feature truncation keep
their original scopes and nullability. Overlapping loss counters are not added
into a fictitious distinct-loss total.

At most 512 identifiers and 128 contributing batches may enter one proposed
online window computation. These are proposed application limits, not a claim
that every current route supports them. If a request exceeds the bound, reject
it or split into an explicit non-window research scope; do not silently truncate
and return a complete window. Offline segment analysis uses bounded streaming
and independently declared limits.

### Per-identifier classification

Each retained `(address, address_type)` or policy-scoped token has:

| Field | Semantics |
| --- | --- |
| `state` | `candidate`, `other`, `unknown` or `conflicting` |
| `category` | `phone_related`, `e_bike_related`, `car_related`, `other` or `unknown`; `null` only for `conflicting` |
| `evidence_level` | `protocol_or_model_clue`, `vendor_or_ecosystem_clue` or `none`; no calibrated probability |
| `protocol_families` | Bounded public dictionary IDs; `[]` means no match in the examined evidence |
| `roles` | Bounded hints such as `vehicle_module`, `phone_key`, `independent_key`, `phone` or `unknown`; multiple hints do not establish multiple physical devices |
| `evidence` | Fixed public `rule_id`, source kind, source-record reference and fixed dictionary token/integer; no copied private name/payload |
| `conflicts` | Conflicting rule IDs and reasons, retained instead of majority-voting a physical category |
| `missing_fields` / `limitations` | Explain absent capabilities, unsupported data, incomplete extraction and ambiguous rules |

`state: candidate` requires a related category and a positive rule;
`state: other` requires category `other`; unknown has category `unknown` and
does not imply a known non-target device. Conflicting results have no selected
category. Each retained identifier contributes exactly once:

```text
retained_identifiers = phone_related + e_bike_related + car_related
                    + other + unknown + conflicting
```

ADV and SCAN_RSP for the same identifier share one classification scope while
preserving their report counts and source evidence. Different addresses are not
merged by payload hash, name, RSSI or timing. Token scope is not extended for
cross-window or cross-node association. A chip/address assignee, ecosystem,
terminal brand and possible device role remain separate fields.

## 4. Persistence, reprocessing and failure behavior

The current repository has no durable inference-result/job tables implementing
this proposal. Before introducing them, define migrations, indexed bounded
queries, cleanup, retries and authorization tests together.

The proposed idempotency identity is a server-generated canonical digest of
the source kind, complete scope, ordered immutable source references/digests,
selected interval and all parser/extractor/rules/dictionary/model versions.
Changing sources, an input item or a version creates a new result identity. The
computation time is excluded. Raw JSON formatting is not used as an accidental
semantic ordering rule. The canonicalization algorithm itself is versioned.

Only committed source evidence can create a committed cloud result. Persist a
job/input snapshot durably before acknowledging an explicitly requested
reprocessing task; atomically select a single result winner for identical work.
Exact retries return that result. A later arriving summary changes the input
identity and creates a new revision; it does not mutate an earlier input snapshot
or increment an existing total. Select a revision by its declared completeness
and version policy, never simply by latest computation time.

Source ingestion ACKs remain independent. A classifier failure cannot revoke a
source receipt, and source custody cannot claim classification success. A failed
or retriable computation records bounded status/reason/attempt metadata. A
`waitUntil` promise or process-global map alone is not a durable retry mechanism.
On-demand pure analysis may return an explicitly ephemeral result without a job
or a persistence claim. No durable-completion ACK is issued for that path.

Private result expiry is bounded by the earliest contributing private source
expiry. Reads deny expired results immediately, even before physical deletion.
Reprocessing never extends source or derived retention, recreates deleted
evidence, or bypasses a closed policy. Cleanup removes per-identifier features,
tokens, input associations and private result artifacts; a minimal nonidentifying
receipt/tombstone may remain only under an explicit receipt policy. Public
aggregates with longer retention require a separately reviewed unlinking and
retention design; this proposal grants no such extension.

## 5. Public projection and interpretation

Public output can expose only aggregate candidate-identifier counts, the
unknown/conflict partition, observed time, freshness, versions, usable scope and
quality reasons. It must not expose addresses, names, payloads, templates,
individual rule traces, private source references, scoped tokens or storage keys.
Research and administrator scopes are distinct; possession of a device or admin
credential does not automatically authorize private research reads.

An unavailable/pending/expired result has nullable counts and a reason. A valid
zero refers only to the specified examined scope. Delayed replay preserves the
original observed time and cannot refresh a live map. Field, demo, controlled
test and unassigned research are kept separate. The public field projection also
requires the existing placement, purpose, clock, freshness and quality checks.

Candidate identifiers are not people, phones or vehicles counted physically.
No total estimate is enabled here. A later calibration contract must name its
training/validation split, supported site/configuration/density, background term,
model version, prediction interval and unavailable reasons before non-null totals
are permitted. Different receivers and brand estimates cannot simply be added.

## 6. Future device v3 evidence upload — independent proposal

The following is a design boundary for a future `campuspulse/3`, not a supported
protocol enum or route. Do not change assigned v2 policies in place, translate
frozen v2 bodies, or infer v3 support from a firmware name. Capability negotiation,
an immutable v3 policy and separate strict validation must precede activation.
Historical queued v1/v2 batches and receipts remain supported.

### V3 configuration framework and board roles

The intended primary collection node is T-Energy without TF storage or a screen.
Waveshare is primarily a debugging/research recorder. Neither role is a hardware
capability proof. The v3 configuration is a fresh design and need not copy the
v2 configuration shape. TF and display are optional capabilities; they cannot be
prerequisites for collection, local buffering, provisioning or uploading.

Keep these policy dimensions independent:

| Proposed policy group | Required distinctions |
| --- | --- |
| `collection` | Enabled/paused; fixed-point versus mobile-research mode; passive/active scanning, interval/window, duplicate filtering, selected PHYs and bounded address/window/bin settings |
| `local_raw` | `off` or `tf_cpraw`; segment/space/sync limits and explicit full-card behavior. This controls TF recording independently from networking |
| `evidence` | Feature schema/extractor and permitted lists, all-worker versus declared sampled coverage, per-window budgets and feature-overflow behavior |
| `uplink` | Enabled/disabled, allowed summary/feature/status/sample streams, accepted transport, bounded batch/body sizes, retry/backoff and independent CPRAW archive permission |
| `local_queue` | Durable medium capability, byte/item reserves per stream, high-water behavior and reboot recovery requirements; no assumption that PSRAM survives power loss |
| `custody` | Private source/derived retention, permitted identity scope, purpose/dataset, node quotas, server acceptance deadline and separate archive policy reference if authorized |
| `control` | Policy schema/revision/hash, assignment generation, activation boundary, lease behavior and server-owned capability requirements |

A Waveshare policy may enable offline TF raw with `uplink.enabled=false`.
Another may upload summaries while TF raw is disabled. Turning on either option
does not turn on the other or grant permission to upload historical card files.
No TF capability means `local_raw=tf_cpraw` is rejected; it does not disable
ordinary summaries or require a dummy card. Display settings, if introduced,
are optional presentation settings and do not establish collection health.

A headless T-Energy policy must have a bounded persistent queue on a verified
supported medium, such as a reserved Flash region with a validated journal. The
policy must fit the real partition and write-endurance budget. RAM/PSRAM may
stage data but cannot satisfy a durable-queue requirement. Reserve control and
status capacity, report losses separately, define behavior at high/full capacity
and preserve frozen unacknowledged bodies across reconnect/reboot. When no valid
durable medium is available, reject durable activation or explicitly select a
separately named best-effort research mode; never silently downgrade durability.
This document does not implement a journal, alter partitions or authorize
protected-data erasure.

The device reports a versioned bounded capability document: supported policy
schemas, producer/extractor versions, streams/transports, scanner/PHY modes,
address/bin/body/queue limits, durable-media type and capacity, TF-raw support
and optional display support. Values are device claims until separately tested.
The server publishes a fully frozen policy only after checking that document;
the device independently validates the whole policy and reports a precise
applied/failed acknowledgment with revision/hash, current boot and activation
sequence. Do not partially activate unsupported fields or substitute defaults.

Activation occurs at a declared closed-window/segment boundary; old queued data
retains its old policy, schema and identity scope. A policy change does not
rewrite a CPRAW segment, purge an unacknowledged queue or reclassify a historical
batch in place. Specify lease expiry independently for collection, local TF raw
and uplink; a control timeout does not silently erase any evidence. Recovery
checks the last fully committed policy and journal rather than trusting a
half-written update. Credential/bootstrap recovery and future firmware rollout
remain separate explicitly scoped contracts.

### Proposed feature stream

The proposed extra stream is `feature_summaries`, independent from sampled raw
and ordinary address summaries. One item binds the existing full source scope,
window sequence and `(address,address_type)` to:

- `schema: "ble-feature-evidence/1"`, extractor version and optional fixed device
  ruleset/dictionary versions; missing capability is explicit.
- `population: "all_worker_reports"` or `"deterministic_sample"`, examined and
  skipped counters, parser failures, unsupported fragments and feature overflow.
  Sampling includes its immutable selection rule and budget.
- Bounded normalized service UUIDs, manufacturer company IDs, Appearance values,
  fixed public name-pattern IDs and protocol/template IDs. Omission means not
  extracted; `[]` means no retained value from the declared extraction scope.
  Each list carries an overflow count or explicit unknown-overflow status.
- Evidence support counts, source report kinds and conflict flags. Per-feature
  counts may overlap because one report can match several features; their sum is
  not a report total. Device rule hits remain claims with producer versions.

Proposed per-item limits are 16 UUIDs, 16 company IDs, 8 Appearance values,
16 name-pattern IDs and 16 protocol/template IDs, with at most 512 identifiers
per window. IDs are registered bounded labels, not arbitrary observed strings.
These initial limits need board memory, body-size and replay acceptance before
publication. Keep the current 128-item/65,536-byte request ceilings unless a
separately tested revision changes them; splitting batches does not reset a
window budget. Excess evidence is counted and marks partial extraction.

Do not include raw names, manufacturer-specific variable bytes, serials,
MAC echoes or individual payload hashes in this feature stream. A template ID
refers to a reviewed shared structural template after individual fields are
masked; it cannot be a stable unique-device fingerprint. Scoped MAC/token access,
purposes and retention require an explicit v3 policy. A feature stream cannot
implicitly authorize whole raw capture or broader address association.

New feature custody would follow the existing principles: freeze exact bytes and
batch identity before retries; authenticate enabled-node ownership; transactionally
enforce per-window uniqueness, scope consistency and budgets across batches;
commit rows and the receipt atomically; require an exact matching committed ACK
before device reclamation. A new stream needs its own queue/loss counters and
sequence namespace. Shared batch identities and cross-version sequence collision
rules must be explicitly migrated and tested, not assumed from endpoint names.

An extended **raw report** stream would need a different, separately specified
format with PHY, SID, report/data status, reported versus retained length,
fragment/truncation semantics and strict payload bounds. This proposal does not
define or enable that stream. For exact Waveshare TF evidence, use the separate
CPRAW archive proposal; do not duplicate its chunk protocol or treat a feature
receipt as an archive receipt. Neither path can claim RF completeness.

## 7. Acceptance before publication

Freeze machine-readable schemas and synthetic fixtures; test omission/null/empty
semantics, version rejection, category/count conservation, malformed/fragment
handling, delayed inputs, conflicting rules, expiry and strict privacy. Compare
old v1/v2 fixtures unchanged. Test limits at 64, 128 and 512 independently from
device capacity; never silently drop excess input.

Durable processing additionally requires transactional race/retry tests, failure
between storage steps, replay idempotency, late-summary revisions, source-expiry
denial and cleanup. Public tests must prove that per-identifier evidence and
unassigned/research/demo data cannot enter public field results. Physical device
and known-device classification accuracy need separate observed acceptance.
