# Device v2: control, address metrics and durable upload

Status: implemented server contract and synthetic tests, 2026-10-24. Physical
radio, flash recovery, provisioning and upload acceptance require separate device
checks. The v1 contract remains available with its original policy semantics.
All example identities and measurements below are synthetic.

## Registration and trust

An administrator registers the factory-derived node ID through
`POST /api/v1/admin/devices` with `{id,name,board}`. The existing fresh-session
requirement applies. The response contains `{device,credential}` exactly once;
only a SHA-256 digest is retained server-side. A lost registration response must
be reconciled by reading the device and explicitly rotating its credential;
there is no public MAC enrollment or credential recovery endpoint.

The provisioning transport delivers the credential through its authenticated,
encrypted device session. The node uses `Authorization: Bearer <credential>` on
all `/api/v2/device/*` and `/api/v2/ingest` requests. Disabled nodes fail closed.
The operator token, administrator session and research token are separate scopes.
Never log the provisioning credential, Wi-Fi password or raw payloads.

Existing placement and draft/validate/publish administrator endpoints accept the
v2 policy below. Publishing freezes the policy and atomically records assignment
and the desired policy pointer. Old assigned policies remain available for
already queued batches. A new desired policy does not rewrite old evidence.

## Policy

[Complete policy example](examples/capture-config-v2.fixture.json).

```json
{
  "protocol": "campuspulse/2",
  "capture_profile": "address_metrics",
  "allowed_streams": ["ble_windows", "address_summaries", "node_status"],
  "identity_scheme": "mac",
  "raw_capture": {"mode": "off"},
  "summary": {"window_ms": 30000, "bin_ms": 5000, "max_addresses": 64},
  "control": {"lease_ms": 120000}
}
```

This fragment supplements the required v1 common fields `capture_config_id`,
`node_id`, `placement_id`, `dataset`, `scan`, `accept_until`, and `upload_policy`.
The Passport adapter is `cp-nimble-v2`; the current firmware build identifies as
`campuspulse-passport-v2`. Initial device batches use at most 16 items and 8192
UTF-8 body bytes. The server ceilings remain 128 items / 65536 bytes, and each
policy can impose smaller limits.

The server validates a 1–300 second summary window, 1 second minimum bin size,
exact whole-window divisibility, at most 60 bins and at most 128 addresses. A
partially closed item may be shorter and have `ceil(duration_ms/bin_ms)` bins.
It retains the configured `bin_ms` even when `duration_ms < bin_ms`; that case
has one partial bin. The server still rejects a bin width that differs from the
assigned policy. It does not pad the observation interval or invent scan time.
Control leases are 30–600 seconds. These server bounds are not a claim that every
board supports every combination; the device rejects unsupported settings and
reports failed activation. Scan mode, adapter and memory limits are checked by
the device before activation.

Raw is off by default. Explicit limited sampling additionally permits
`ble_reports` and uses
`{"mode":"sampled","sample_every_n":100,"selection":"seq_mod_n_eq_0","max_reports_per_window":4}`.
The server permits budgets 1–16; the initial Passport supports at most 4. Raw
`all` is rejected in v2. Existing v1 `research_raw` remains a separate policy.
The policy publisher must have private R2 available before enabling sampled raw.
Raw sample sequences retain the v1 preselection report-sequence rule. The sample
budget is checked atomically across batches for each node/boot/window.

## Configuration and independent contact

`GET /api/v2/device/config` returns:

```json
{
  "protocol": "campuspulse/2",
  "config": null,
  "expired": false,
  "reason": "unassigned",
  "server_time": "2026-10-24T00:00:00.000Z",
  "server_limits": {"max_items":128,"max_body_bytes":65536},
  "control": {"lease_ms":120000}
}
```

When assigned, `config` is the full immutable v2 policy, `reason` is omitted,
`control` matches that policy, and `retention` contains `raw_hours`,
`aggregate_days`, `receipt_min_days_after_accept_until:7`. `expired` is evaluated
against server time. A desired v1 policy returns `config:null` and
`reason:"protocol_mismatch"`; it is never silently translated. The optional
`capture_config_id` query fetches only a policy assigned to this device.

`POST /api/v2/device/contact` accepts the strict
[contact example](examples/device-contact-v2.request.json):

```json
{
  "protocol":"campuspulse/2",
  "boot_id":"11111111-1111-4111-8111-111111111111",
  "contact_seq":1,
  "firmware_version":"campuspulse-passport-v2",
  "uptime_ms":30000,
  "wifi_state":"connected",
  "capture_state":"unassigned",
  "applied_config_id":null
}
```

`capture_state` is `unassigned`, `running`, `paused`, `expired` or `failed`.
Contact requires no capture policy or placement. The response echoes `node_id`,
`boot_id`, `contact_seq`, adds `received_at` and `control:{lease_ms:120000}`.
This contact lease is the default control-channel timeout; an applied capture
policy's `control.lease_ms` governs collection. A configuration GET alone does
not count as a heartbeat. The device periodically contacts even while unassigned.

`contact_seq` increases within a boot, and `uptime_ms` cannot decrease. An exact
same-body retry at the current sequence returns the original response; changing
bytes at that sequence conflicts. An unseen boot starts a new session and clears
actual activation. Known retired boots cannot regain control. Only the current
contact is kept; compact boot tombstones are capped at 4096/node, after which new
boots fail closed with an operator-recovery error. This is current server contact
ordering, not a cryptographic proof of hardware restart order. A previously
unseen, delayed authenticated boot is indistinguishable from a new boot.

## Actual activation

`POST /api/v2/device/config/ack` accepts the strict
[activation example](examples/device-activation-v2.request.json):

```json
{
  "capture_config_id":"demo-capture-address-v2",
  "boot_id":"11111111-1111-4111-8111-111111111111",
  "apply_seq":1,
  "state":"applied"
}
```

The device must contact first. `state` is `applied` or `failed`; optional `message`
is a bounded machine label, never arbitrary diagnostics or a secret. `apply_seq`
increases within the current boot. Exact-body current-sequence retries return the
original ACK; older sequences, changed bytes and retired boots conflict.
Only assigned v2 policies can be acknowledged, and expired policies cannot be
newly applied. A failed activation does not erase the last successfully applied
policy. Its failed target remains visible independently.

The response echoes the request plus `node_id` and `received_at`. Administrator
list/detail responses include `desired_config_id`, `reported_config_id` (latest
batch provenance), `applied_config_id` (successful current-boot activation),
`latest_control` and `latest_status`. Contact's claimed `applied_config_id` is
visible inside `latest_control` and never upgrades actual activation by itself.
Fresh contact means the server recently heard from the node, not that scanning
is complete or that the desired config was applied. Activation history retains
30 days; latest actual state persists until the next boot/activation.

## Ingestion

`POST /api/v2/ingest` uses the v1 envelope fields and exact-byte
`X-Body-SHA256` header, with `protocol:"campuspulse/2"`. The four independent
streams are `ble_windows`, `address_summaries`, `node_status`, and explicitly
permitted sampled `ble_reports`. Strict parsing rejects duplicate JSON keys,
unknown fields, malformed UTF-8 and inconsistent counters.

- [Overall-window example](examples/ble-windows-v2.request.json): v1 item format,
  including empty windows. The configured address-table capacity must match.
  These counts describe BLE-visible identifiers and reports, not people.
- [Address-summary example](examples/address-summaries-v2.request.json): one item
  per address/type per closed window; `seq` independently increases in this
  stream and `window_seq` references that boot's overall window. `time` is the
  window end. `first_offset_ms` / `last_offset_ms` are relative to its start and
  in `[0,duration_ms)`. `bins` are report counts starting at offset zero, in
  `bin_ms` slices, sum to `reports`, and cannot place nonzero counts outside
  first/last offsets. These are count bins plus window-level RSSI; per-bin RSSI trajectories
  are not available. `adv_reports + scan_response_reports = reports`.
  Address and `address_type` jointly define the retained identifier. RSSI keeps
  the v1 null/unknown and sample-count rules. No packet payload is fabricated.
- [Status example](examples/node-status-v2.request.json): v1 fields plus required
  `address_summaries` entries in both queue maps. Optional explicit losses are
  `address_summaries_dropped` counts lost summary **items**;
  `address_table_overflow_reports` counts reports excluded from the finite address
  table. `accounting_overrun_reports` counts callbacks lost when the finite
  per-window loss-accounting buckets collide: scanning stops and these reports
  cannot be assigned to a closed window. `unpersisted_window_reports` counts
  `reports_seen` in windows whose overall metrics could not be saved, including
  suppressed windows shorter than one second; their raw stream may have been
  saved independently. These are different and potentially overlapping loss
  scopes; they must not be added as a count of distinct lost observations.
- Raw report items retain the v1 format and payload bytes. They must carry MAC
  identity, match the sampling divisor and remain within the per-window budget.

A summary may arrive before its independent overall-window batch; there is no
fabricated overall record. Per-window duplicate addresses, contradictory timing
and address capacity are checked transactionally across batches. Firmware must
freeze a batch before retries and never mix boot/config/placement/dataset IDs.
Non-identifier window-budget tombstones survive private-row cleanup until
receipt expiry. Further new records for that window are rejected after its first
private expiry; cleanup cannot reopen its address or sample budget.
The sequence range includes gaps inside the submitted batch and cannot overlap
any accepted range in the same node/boot/stream, including v1 ranges. Batch IDs
share one node namespace across versions.

The committed ACK retains the v1 keys:
`node_id,boot_id,stream,batch_id,body_sha256,accepted_count,durability:"committed",receipt_id,received_at`.
Only exact matching ACKs authorize local reclamation. Receipts commit atomically
with the rows; raw evidence is verified in private R2 before its D1 receipt.
A retry returns the original receipt even after policy expiry or evidence cleanup.
Same batch ID/different bytes and sequence collisions return 409. Policy expiry
returns 410 for new batches. Preserve unacknowledged data on these failures;
never infer ACK from HTTP success with a mismatched body.

## Privacy, research and retention

Address summaries are private. They are never returned by public place/window
queries or administrator device APIs. Those queries read only overall windows,
using the original field-only dataset, clock uncertainty, quality flag and
placement interval checks. Demo and controlled-test records remain separate.

`GET /api/v2/research/batches/{id}?node_id=...` requires the independent research
bearer. Address batches return `stream`, original body hash and parsed stored
`items`; this is not a byte-identical reconstruction of the original request.
Raw batches return their original `batch`, hash and versioned AD derivation after
verifying R2 integrity. Expired evidence returns 410 even before physical cleanup.

Private summaries and sampled raw use the policy's `raw_retention_hours`
(default 24); windows/status use `aggregate_retention_days` (default 7).
Receipts survive at least until seven days after policy acceptance closes and
at least as long as retained evidence. Scheduled cleanup is bounded and
idempotent: at most 100 R2 objects, 500 v2 item rows, 100 v2 receipts and 500 window-budget tombstones and 500 v2
activation events per invocation, independently of v1 limits. Unreferenced R2
objects are not deleted by this cleanup because they may belong to in-flight
uploads; orphan auditing remains a separate operational task.

## Verification boundary

`tests/device-v2*.test.ts` runs production migrations and Worker route/SQL code
against transactional SQLite and a private in-memory R2 adapter. It covers
current-boot ordering, exact retry ACKs, immutable configuration publication,
private/public scope, raw budgets, expiry, malformed data and v1 compatibility.
This is server validation; workerd runtime checks and physical device acceptance
are separately recorded by the integrating task.
