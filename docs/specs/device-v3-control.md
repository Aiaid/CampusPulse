# Device V3 control service

Status: **current production V3 control with bounded two-board native MQTT
acceptance recorded before the 2026-10-31 V3-only retirement.** See the
[production release](../notes/v3-production-release-2026-10-31.md) and
[migration record](../notes/v3-only-migration-2026-10-31.md). Earlier isolated
trial evidence remains historical; this source retirement is not new device
validation. The implementation is
[`worker/device-v3-control.ts`](../../worker/device-v3-control.ts), using the
[v3 policy core](device-v3.md) and additive
[`0014_device_v3_control.sql`](../../migrations/0014_device_v3_control.sql).

The explicit gate remains `DEVICE_V3_CONTROL_ENABLED="true"`. The selected
production release enables it; deployments without it fail closed with
`503 v3_control_disabled`. V1/V2 device routes have been removed, while old
policies, credentials, receipts and collection records remain preserved.
Independent administrator authentication and application APIs keep their
`/api/v1/admin` namespace; that URL version does not imply a V1 device protocol.
Native MQTT uses the same authenticated control semantics as the V3 HTTPS API.

The final default statistics profile adds `DEVICE_V3_STATISTICS_ENABLED="true"`
and [explicit renewable lease spans](v3-small-statistics.md). It accepts compact
window/event data through its separate route, with historical applied-policy
authorization for delayed frozen batches. Default cloud raw is off; TF local
recording and small-statistics uplink can be enabled independently.

## Supported boundary

This service authenticates registered devices, saves immutable capability
claims and policy envelopes, assigns a desired generation and records an actual
device's terminal `applied` or `failed` acknowledgement. A capability is a
**device claim**, not a measurement of the board, a firmware compatibility
certification or authority to register another device. Assignment responses
always say `applied:false` and `requires_device_ack:true`.

Policies with `uplink.enabled:true` require an explicitly supported, enabled
profile and version allowlists. The current production profile uses
[small statistics](v3-small-statistics.md), renewable lease spans and native
MQTT/TLS. The historical [feature/status experiment](device-v3-ingest.md) remains
separately gated and is off in the selected production release. The independent
CPRAW archive policy cannot be enabled by this control service. Supported policy
validation does not establish general board compatibility, collection quality,
long-run retention, arbitrary-power-loss recovery or field calibration.

## Control API shapes

All request bodies require uncompressed `application/json`, are bounded at
32,768 bytes and use the strict duplicate-key/UTF-8 parser before validation.
Unknown object fields fail. v3 IDs, hashes, boot IDs and policy/capability fields
follow the [core specification](device-v3.md). No arbitrary device messages are
stored. Responses use `Cache-Control:no-store`.

| Route | Authentication | Body or query |
| --- | --- | --- |
| `POST /api/v3/device/capabilities` | Existing enabled-device bearer credential | `{protocol:"campuspulse/3",registration_seq,uptime_ms,capabilities}` |
| `GET /api/v3/device/config?boot_id=...` | Same device credential | Exactly one current `boot_id`; unknown query parameters fail |
| `POST /api/v3/device/config/ack` | Same device credential | ACK shape below |
| `POST /api/v1/admin/device-v3/assignments` | Existing administrator session and same-origin mutation | `{policy,expected_generation}`; `policy.assignment_generation` must equal `expected_generation+1` |
| `GET /api/v1/admin/device-v3/nodes/:node_id` | Existing administrator session | Current claim, desired envelope, last applied policy, desired ACK and availability reason |

Registration sequence is 1–2^32−1 and uptime is a nonnegative safe integer.
Within the current boot both sequence and uptime must not regress; sequence
must advance except for an exact-byte retry. New boots reset current applied
state and apply sequence, preserve node-wide desired-generation history and
retire the previous boot. A retired boot cannot become current again.
Reusing a capability ID with a different complete snapshot is forbidden.
Refreshing any capability content creates a new digest and requires a newly
bound assignment. The service does not generate or replace credentials.

The first assignment uses `expected_generation:0`; later assignments use the
previous desired generation. Capability limits, identity and current validity
are validated before freezing and committing an assignment. A future
`not_before` is allowed only if it is strictly earlier than the bound
capability expiry. Boundary readiness is deferred until an actual device ACK.
An assigned dataset requires a currently active placement belonging to the
node; `research_unassigned` keeps the core's null-placement/local-only rules.

ACKs contain all of:

```text
{ protocol:"campuspulse/3", boot_id, policy_id, policy_sha256,
  assignment_generation, apply_seq, state:"applied"|"failed",
  closed_window_seq, closed_segment_seq, window_open, segment_open,
  error_code? }
```

`apply_seq` is 1–2^32−1 and increases within the boot. Closed sequences are
0–2^32−1; open-state flags are booleans. A failed ACK requires one of
`unsupported_config`, `boundary_failed`, `resource_exhausted`, `storage_failed`
or `internal_error`; an applied ACK must omit `error_code`.

A new applied ACK requires the current desired generation, boot, complete
capability snapshot, exact policy ID/digest, active placement, current capability
and policy validity, and closed boundaries meeting both policy sequence floors.
The device reports these boundaries; the server cannot observe radio/storage
state independently. Failed ACKs can record failure after policy expiry and do
not replace the prior last-applied policy. A terminal ACK is immutable: retry
the exact bytes, or issue a new assignment to attempt activation again.

Delivery suppresses configurations after policy/capability expiry, changed
boot/capabilities or placement closure. It may deliver a future policy with
its explicit activation start time. Inspection labels an unavailable desired
policy separately from the historical `last_applied_policy`. A committed
receipt replay reports the original event; it does not restore a retired boot,
change the current desired pointer or renew a lease.

## Transactions and bounded history

D1 batches atomically assert state version, current credentials/enabled state
or administrator session/account version, and relevant placement/time validity,
then store evidence and update pointers. Session expiry is evaluated with the
database clock at commit, including after slow request bodies. Constraint or
state races roll back all writes. Concurrent identical retries return the one
committed result; differing bytes/digests conflict. Unexpected storage failures
remain retryable `503` responses and do not produce ACKs.

Capability snapshots, policy envelopes and ACKs have immutable SQL triggers.
Each node has at most 4,096 boots, capability snapshots and assignments; ACKs
are bounded by assignments. Exhaustion fails closed with `v3_history_full`.
The service does not automatically delete replay tombstones or provide an
operator history-recovery tool. Plan recovery before long-running rollout.

This control service provides no firmware lease heartbeat. The trial firmware
has bounded monotonic/UTC handling; broader clock and recovery acceptance remain
outstanding. Reading or assigning a policy is not evidence of fresh
radio collection, durable raw storage, device application, source cleanup or
upload acceptance. Firmware integration and explicit protocol/lease acceptance
are prerequisites to enabling this outside an isolated experiment.

## Local verification

Synthetic route tests exercise authentication separation, exact retries,
immutable histories, current/retired boots, generation ordering, closed
boundaries, applied/failed semantics, expiration, capability replacement,
placement invalidation, transaction races and rollback. Separate Miniflare
tests execute all migrations and concurrent registration/assignment/ACK
transactions in real local workerd/D1. These tests use no captures or real
device identifiers and do not establish production performance or hardware
support.

```sh
npx vitest run tests/device-v3-config.test.ts tests/device-v3-control.test.ts tests/device-v3-workerd.test.ts
npx tsc --noEmit
```
