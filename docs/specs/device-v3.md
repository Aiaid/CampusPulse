# Device v3 configuration and capability core

Status: **current V3 configuration core; bounded two-board native MQTT production
acceptance recorded before the 2026-10-31 V3-only retirement.** See the
[production evidence](../notes/v3-production-release-2026-10-31.md) and
[migration scope](../notes/v3-only-migration-2026-10-31.md). Earlier isolated
trial results retain their original scope; this code cleanup does not establish
new physical acceptance of its resulting images.

The implementation is
[`worker/device-v3-config.ts`](../../worker/device-v3-config.ts), with synthetic
fixtures in [`tests/device-v3-config.test.ts`](../../tests/device-v3-config.test.ts).
The final default profile uses [small statistics and optional candidate events](v3-small-statistics.md).
Its additive statistics/temporal capabilities and explicit lease spans remain
independent of the historical feature experiment. Local TF raw is separately
configurable; normal cloud raw and per-address uploads are off.

The core validates configuration against actual capability snapshots and plans
closed-boundary activation and lease actions. The
[control service](device-v3-control.md) implements capability registration,
immutable assignment and device acknowledgements. Production transport is
[native MQTT](device-v3-mqtt.md); the V3 HTTPS handlers remain authenticated
logical/API contracts. The core alone does not implement firmware, queues or
activation. V1/V2 device control and ingestion are retired rather than parallel
fallbacks; their stored historical records remain intact.

See [BLE inference](ble-inference-v1.md), the
[end-to-end design](../design/ble-device-inference.md) and the separately owned
[CPRAW archive contract](cpraw-archive-v1.md). Configuration compatibility does
not establish inference quality, radio completeness, persistence or hardware
resource sufficiency.

`worker/device-v3-evidence.ts` separately implements a strict **offline subset**
of the proposed feature evidence. It validates window-scoped tokens, frozen
policy binding, coverage and budgets; it does not receive or store uploads.
Its output does not establish window completeness or a total estimate. A
provenance-preserving adapter is still required before feeding these records to
the separate inference core.

## Strict value and hashing rules

Every object rejects unknown fields and missing required fields. Discriminated
off/disabled objects contain only their discriminator; inactive leftover
settings are rejected. All numbers are finite safe integers. Null is permitted
only where listed below. No values are clipped or silently substituted.

IDs use `[a-z0-9][a-z0-9_-]{0,63}`; version/format labels use
`[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}`. Boot IDs are lowercase UUID v4. Times use
valid canonical UTC `YYYY-MM-DDTHH:mm:ss.sssZ`; invalid calendar dates fail.
Digests are 64 lowercase hexadecimal characters. Arrays are bounded and reject
duplicates where they represent choices or keyed entries. Unrecognized enum
values fail; additional future version labels in capability version lists grant
no support to an unrecognized policy schema.

`parseDeviceV3Json(bytes)` limits input to 32,768 bytes and uses the existing
duplicate-key, grammar, nesting and fatal UTF-8 parser. Object validators cannot
detect keys already lost by an upstream `JSON.parse`; a future input adapter
must use this byte parser first. Error paths are fixed schema paths/array indices
and never echo supplied names, payloads or unknown key contents.

`freezeDeviceConfigV3(value)` validates and returns a detached
`{schema:"device-config-envelope/3",policy,policy_sha256}`. It does not publish or
persist that object. Hashing recursively sorts object keys, preserves array order
and omission/null distinctions, then hashes UTF-8 bytes of
`campuspulse-v3-canonical-json/1\n` followed by canonical JSON. The digest is over
the validated policy; it is not an exact HTTP body digest or a signature.
`validateFrozenDeviceConfigV3` recomputes it and rejects mutation. Callers must
still store the frozen bytes immutably before a future assignment or upload.

`capabilityDigestV3` uses the same algorithm over the validated capability
document. A policy binds that complete snapshot and its boot, not merely a model
name or capability ID. Hash equality does not authenticate the source.

## Policy fields

All top-level fields below are required. The TypeScript interfaces and validator
are the executable specification; the fixtures provide complete synthetic
examples rather than presets for actual boards.

| Field | Exact shape and constraints |
| --- | --- |
| `schema`, `protocol` | `device-config/3`, `campuspulse/3` |
| `policy_id`, `node_id` | Bounded IDs; separate from physical addresses and credentials |
| `revision`, `assignment_generation` | Positive safe integers; a new activation requires generation greater than the caller's last accepted generation |
| `collection` | Required object described below |
| `local_raw` | Independent TF recorder configuration |
| `evidence` | Independent feature extraction configuration |
| `uplink` | Independent network/stream configuration |
| `local_queue` | Explicit durability and bounded reservations |
| `resources` | `working_bytes`, `storage_write_bytes_per_day` |
| `custody` | Dataset, association, retention and acceptance limits |
| `control` | Capability binding, activation boundary and lease actions |

### Collection and local TF recording

`collection` has `enabled:boolean`, `mode:"fixed_point"|"mobile_research"`,
`scan` and `summary`. `scan` has `mode:"passive"|"active"`, `interval_units`,
`window_units`, `duplicate_filter:boolean` and nonempty unique `phys` selected
from `1m` and `coded`. Scan units are 0.625 ms; both integers are 4–16,384 and
the window cannot exceed the interval. A selected PHY or scan mode must be
explicitly declared supported; these enums do not claim current board support.

`summary` is `{enabled:false}` or `{enabled:true,window_ms,bin_ms,max_addresses}`.
Window length is 1,000–300,000 ms, bins are at least 1,000 ms, must divide the
window exactly and number at most 60. Addresses are bounded at 512 independently
from batch limits and the device's potentially lower limit. Raw-only research
can disable summaries and does not need a summary capability.

`local_raw` is `{mode:"off"}` or:

```text
{ mode: "tf_cpraw", format: "cpraw/1", max_segment_bytes, max_total_bytes,
  min_free_bytes, sync_interval_ms, full_behavior: "stop_recording" }
```

Byte limits are positive and at most 2^40; a segment cannot exceed total
reservation. Sync interval is 100–60,000 ms, no faster than the declared device
minimum. Full storage stops recording without overwriting evidence. `min_free_bytes`
is additional space reserved outside raw files. The total raw reservation, free
space reserve and any TF queue reservation must fit the single declared usable
TF pool. These are policy maxima, not evidence of present free space.

Enabling TF does not enable uploads, and enabling uploads does not enable TF.
A local raw writer marked permitted receives no new radio reports while
collection is paused. An offline raw policy can explicitly permit both collection
and recording to continue until the policy expires despite losing contact.

### Features

`evidence` is `{mode:"off"}` or an object containing all these fields:

| Field | Value |
| --- | --- |
| `mode`, `schema` | `features`, `ble-feature-evidence/1` |
| `extractor_version` | Exact declared version label |
| `population` | `all_worker_reports` or `deterministic_sample` |
| `sample_every_n` | `null` for all-worker; integer 1–2^32−1 for deterministic sampling, using report sequence modulo N equal to zero |
| `fields` | 1–5 unique `{kind,max_values_per_identifier}` entries; kinds: `service_uuids`, `company_ids`, `appearance`, `name_pattern_ids`, `template_ids` |
| `max_values_per_identifier` | 1–16 per selected kind, except Appearance 1–8 |
| `max_reports_per_window` | 1–10,000,000, further constrained by the device |
| `max_bytes_per_window` | Positive byte budget, at most 2^40, further constrained by the device |
| `overflow` | `count_and_mark_partial` |

Feature extraction requires enabled summary windows, but does not require TF,
raw sampling or feature uploading. Reaching either processing/output budget must
count skipped work and mark incomplete extraction; `all_worker_reports` describes
the intended population, never an unconditional completeness claim. Neither
feature producer nor feature-batch ingestion is implemented by this module.

### Uplink and buffering

`uplink` is `{enabled:false}` or contains:

| Field | Value |
| --- | --- |
| `enabled`, `transport` | `true`; `https` or `mqtt_tls` with explicit capability support |
| `streams` | Unique nonempty subset of `ble_windows`, `address_summaries`, `feature_summaries`, `node_status`, `ble_reports`; status is required |
| `max_batch_items`, `max_body_bytes` | 1–128 items; 512–65,536 bytes; device may impose lower limits |
| `retry` | `min_delay_ms` 1,000–3,600,000; `max_delay_ms` between the minimum and 86,400,000; `max_attempts` 1–100 |
| `raw_sample` | `{mode:"off"}` or `{mode:"sampled",format:"legacy_ad",every_n,max_reports_per_window,selection:"seq_mod_n_eq_0"}`; N is 1–2^32−1 and budget 1–16 |
| `archive` | `{mode:"off"}` or `{mode:"separate_policy",policy_id}` |

`ble_reports` is present exactly when raw sampling is enabled. Sample format is
the bounded legacy AD format, not extended CPRAW data. Features must be enabled
before allowing `feature_summaries`; any stream beyond status requires summaries.
Retry exhaustion preserves frozen unacknowledged bodies and reports the failure.

An archive reference is insufficient authorization: negotiation always rejects
`archive.mode="separate_policy"` with `separate_archive_policy_required` in this
local core. A future service must independently resolve, authorize and validate
that archive policy. Merely claiming archive support never opens this path.

`local_queue` is `{mode:"disabled"}` or an object with `mode`, `medium`,
`max_bytes`, `max_items`, `control_reserve_bytes`, `control_reserve_items`,
`stream_reserves`, `high_water_percent`, `full_behavior`, `recovery`:

- `durable` requires `flash_journal` or `tf_journal`,
  `recovery:"exact_frozen_batches"`, and `full_behavior:"pause_collection"`.
  The medium must explicitly claim power-loss recovery. Physical Flash capacity
  alone does not establish a usable, reserved and recoverable journal.
- `best_effort_research` requires `ram`, `recovery:"none"` and
  `full_behavior:"drop_new_counted"`. It is allowed only for `controlled_test`
  or offline `research_unassigned`. RAM/PSRAM cannot satisfy durable buffering.
- Item limits are 1–1,000,000. Control reserves require at least 512 bytes and
  one item. `stream_reserves` has 1–5 unique `{stream,bytes,items}` entries, each
  at least 512 bytes/one item, and must include status. Sums including control
  must fit totals. When uploading, entries exactly cover allowed streams and
  each stream's byte reserve fits at least one permitted maximum-size body.
- `high_water_percent` is 1–99. The declared full behavior must preserve existing
  frozen bodies; drop counters distinguish new loss from reclamation by ACK.
  Counts here describe stored frozen queue records/bodies, not radio reports.

Uploading requires a queue. Enabled field collection requires a durable queue
even while uploads are disabled. Offline TF research can disable the queue.
The module validates these requirements but does not implement any journal.

### Resources, custody and control

`resources.working_bytes` is a positive explicit reservation up to 2^40;
`storage_write_bytes_per_day` is 0–2^40 and must be positive for durable queue or
TF recording. RAM queue capacity must fit the working reservation. Both budgets
must fit device-declared maxima. This is a bounded preflight, not an allocator:
the firmware must still validate combined scanner, address/bin, extraction,
network and queue memory and write costs under load. The module has no measured
per-record allocation model and cannot guarantee that a proposed memory budget
is sufficient. Runtime quotas/retention enforcement remain unimplemented.

`custody` requires `dataset`, `purpose`, nullable `placement_id`,
`association_scope`, `source_retention_hours`, `derived_retention_hours`,
`accept_until`, `max_upload_bytes_per_day`:

- Exact dataset/purpose pairs are `field/site_observation`,
  `demo/demonstration`, `controlled_test/controlled_test` and
  `research_unassigned/research`.
- Field uses fixed-point collection, a placement and `association_scope:"window"`.
  All other assigned datasets also require a placement. The alternative
  association scope is `segment`; it grants no cross-address or cross-node link.
- Unassigned research requires mobile mode, null placement and disabled uplink.
  This local-only policy value does not restore a retired V1/V2 ingestion dataset.
- Both retentions are 1–168 hours, and derived retention cannot exceed source
  retention. Source retention applies to private local evidence as well as any
  future cloud copy; enforcement and authorized cleanup need implementation.
- Upload quota is 0–2^40 bytes/day, zero when disabled and at least one maximum
  body when enabled. It is a configured limit, not a running quota counter.

`control.capability_sha256` binds the snapshot. `control.activation` requires
`boot_id`, `boundary:"closed_window_and_segment"`, `after_window_seq`,
`after_segment_seq`, `not_before`, `expires_at`. Sequence lower bounds are
0–2^32−1; zero allows an initially idle channel. Activation must occur with no
open window or segment and both closed sequences at or beyond their bounds.
Validity is half-open `[not_before,expires_at)`, with
`not_before < expires_at <= custody.accept_until`. Old queues/segments retain
their old policy and original bytes.

`control.lease` contains `duration_ms` 30,000–86,400,000 and independent actions:
`on_collection_expiry` is `pause` or `continue_until_policy_expiry`;
`on_raw_expiry` is `stop_recording` or `continue_until_policy_expiry`;
`on_uplink_expiry` is `pause` or `drain_frozen_until_accept_until`. The last action
also allows old frozen bodies to drain after policy expiry, only before the
acceptance deadline. Policy expiry stops new collection and recording. Neither
lease nor policy expiry silently purges unacknowledged evidence.

## Capability document and negotiation

Required capability fields are `schema:"device-capabilities/1"`, `capability_id`,
`node_id`, `boot_id`, `producer_version`, `policy_schemas`, `issued_at`,
`expires_at`, with a nonempty validity interval. Version lists are unique and
bounded to 16 labels. The following blocks are optional and nullable: omitted
means **undeclared**, null means **explicitly unsupported**. A required block in
either state rejects the policy with a distinct reason. No model-name lookup or
display/TF assumption fills missing information.

| Block | Fields |
| --- | --- |
| `scanner` | `modes`, `phys`, `duplicate_filter` lists; `min_interval_units`, `max_interval_units` within 4–16,384 |
| `summary` | `max_addresses` 1–512, `max_bins` 1–60, `max_window_ms` 1,000–300,000 |
| `features` | `schemas`, `extractor_versions`, `fields`, `populations`, `max_reports_per_window`, `max_bytes_per_window` |
| `local_raw` | `formats`, `max_segment_bytes`, `min_sync_interval_ms` |
| `uplink` | `transports`, `streams`, `max_batch_items`, `max_body_bytes`, `max_sample_reports_per_window` 0–16, `cpraw_archive:boolean` |
| `queue` | `media`: up to three unique `{medium,usable_bytes,max_items,power_loss_recovery}` entries; RAM cannot claim recovery |
| `resources` | `max_working_bytes`, `max_storage_write_bytes_per_day`, `tf_usable_bytes:number|null`; null cannot authorize TF allocation |

Limits use the same byte/integer and enum bounds as the corresponding policy.
Empty supported-choice arrays are allowed and authorize no choices. Actual
firmware must advertise only implemented combinations, verified partition/card
capacity and available resources, and independently reject configurations it
cannot safely apply. These documents remain device claims until separately
validated. Tests use synthetic claims, not either board's actual capabilities.

`negotiateDeviceConfigV3(envelope,capabilities,context)` requires a strict context:
`node_id`, `boot_id`, `now`, `last_assignment_generation`, `closed_window_seq`,
`closed_segment_seq`, `window_open`, `segment_open`. It validates the hash,
identity/boot, current capability validity, policy validity, generation, boundary
and enabled capability/resource requirements. The result is:

```text
{ state: "compatible" | "rejected", applied: false, requires_device_ack: true,
  policy_sha256, issues: [{code,path}, ...] }
```

Malformed schemas throw `DeviceV3ConfigError` with code `invalid_device_v3`.
Negotiation reasons are `undeclared_capability`, `unsupported_capability`,
`resource_limit`, `identity_mismatch`, `capability_digest_mismatch`,
`capabilities_not_current`, `policy_not_yet_valid`, `policy_expired`,
`stale_assignment`, `boundary_not_ready`, `separate_archive_policy_required`.

This function trusts caller-supplied current state only for offline comparison.
It does not prevent races, authenticate devices or make generations durable.
`evaluateDeviceV3Lease(policy,now,elapsed_since_contact_ms)` likewise returns only
permission labels plus `preserve_unacknowledged:true`; it never changes applied
state. Elapsed contact time must eventually come from a monotonic clock.

## Verification and work still required

The 37 synthetic tests cover a no-TF/no-screen primary collector shape and
offline TF-only recording, strict fields/versions/JSON, omission versus null,
snapshot/policy hashes, unsupported settings, queue/memory/TF quotas, sample and
feature bounds, custody, stale generations, closed boundaries and lease expiry.
`npx vitest run tests/device-v3-config.test.ts` and `npx tsc --noEmit` passed.

Before direct integration, implement an authenticated immutable assignment store,
current-boot ordering, transactional activation/failed ACK handling and retries;
firmware capability production, validation, committed-policy recovery and
independent bounded worker queues; strict v3 batch schemas and receipts; source
and derived retention/quota enforcement; and physical power-loss, exhaustion,
coexistence and resource acceptance. A policy compatibility result must never be
shown as the desired configuration already having taken effect on the device.
