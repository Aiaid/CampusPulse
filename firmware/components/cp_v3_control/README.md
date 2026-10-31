# V3 feature trial and small-statistics control core

This is a portable, bounded parser and state machine. It opens no network/radio,
stores no credentials, performs no Flash/TF writes and is not linked to a board
by this component. `cp_v3_evidence` supplies common types/version labels only.

The historical `cp-v3-producer/1` subset remains intentionally narrow: `controlled_test`, passive 1M,
duplicate filtering off, window-scoped all-worker company/Appearance evidence,
at most16identifiers, one item/4096-byte body, raw/sample/archive off, HTTPS and
durable Flash or TF journal with feature/status/control reserves. Both expiry
actions pause collection/upload; local raw stops. No TF or display is required
by shared logic. TF slot overhead and actual recoverability are checked by the
board's real apply callback, not inferred from a capability claim.

Initialization validates the complete explicit capability JSON snapshot, sorts
object keys while preserving array order, and computes SHA-256 over the exact
`campuspulse-v3-canonical-json/1\n` prefix and canonical bytes. Policy parsing
checks every required object/field, type, discriminator, range, reservation sum,
supported feature and capability limit. It recomputes the complete policy hash
and binds node, boot and the complete capability digest. Strict JSON rejects
unknown/duplicate keys, unsafe numbers, nesting/token/byte excess and trailing
input. This controlled subset accepts the server's unescaped ASCII strings and
unsigned decimal integers; escaped/non-ASCII/exponent representations fail
closed rather than being normalized loosely.

Stages are initialized, registering, registered, offered, ACK-pending, applied,
failed and paused. Configuration delivery never marks a device applied.
`cp_v3_control_apply` checks policy/capability time and closed boundaries, invokes
the caller's actual resource/application callback once, then checks its resulting
boundaries for openness/regression. Success means configured/reserved **with the
scanner still paused**. It freezes a terminal ACK; no capture or upload is
permitted before an exact committed server receipt matches it. Failures produce
an immutable failed ACK. Unsupported/untrusted offers produce no guessed ACK.

Registration and terminal ACK retries return their original exact bytes. Server
timestamps on receipt replay cannot change. A new assignment remains unsupported
in the historical feature trial; unknown already-applied server history fails
closed. Reinitializing to manufacture a new boot or application event is not recovery.

`cp-v3-small/1` enables a separate strictly parsed subset: statistics extractor
`cp-v3-stats/1`, rules `unclassified-v1`, passive 1M, 30 or 60 second windows with
5 second bins, at most 12 bins and 512 address/type keys. The normalized
`stats_max_addresses` is uint16; legacy uint8 `evidence.max_identifiers` remains
zero and must never be used for statistics. Use `window_ms`, `max_body_bytes`
(512–4096), `window_reserve_*`, `event_reserve_*`, `status_reserve_*` and
`control_reserve_*`. Small batches contain one item. Fixed/mobile collection and
field/demo/controlled-test datasets are explicit frozen policy fields.

`temporal` independently declares rolling/off history, 1000/2000/5000 ms slices,
up to 10 minutes, bounded tracks/open states and event lifetime, gap, report mode
and revision interval. Events require the candidate-events stream and capability.
`local_raw` independently allows off or supported TF CPRAW with segment/total/free
space/sync bounds; queue media may still be Flash. Raw sampling and archive
uplinks remain off. All capability fields participate in the canonical digest.
The actual apply callback must allocate statistics/history, reserve real durable
queue classes and storage overhead, initialize an enabled local writer, and
leave scanning paused before an applied ACK is frozen. Declared resources alone
do not establish actual free memory or recoverability.

Statistics applied/failed receipts require SHA-256 of the exact ACK body.
Applied receipts additionally bind original server time, lease deadline and
contact sequence zero; failed receipts cannot carry lease fields. Explicit
`cp_v3_control_lease_request` and `_lease_receipt` implement `/api/v3/device/lease`:
strict identity/sequence/uptime/body SHA, committed durability, server timestamp,
deadline, span sequence and contiguous flag. Pending retries freeze exact bytes.
Only a fresh valid contact sequence grants another capture interval. Replayed
ACK/lease receipts, GET/config and status never extend the deadline. A fresh
lease after expiry starts a new authority span; callers must censor/close old
observations and start a new window, never bridge an observed scan gap.

After capture expiry, `permissions.uplink && permissions.frozen_only` permits
draining already frozen small records until the original policy acceptance
deadline, and never grants collection or raw-recording permission. Each historical
queue record still requires its original immutable scope, time and acceptance
checks. `cp_v3_control_match_frozen_receipt` is a stateless strict small-control
verifier for durable queue reclamation. It compares exact body SHA, every request
field, scope and committed receipt, including historical boots/generations; it
cannot mutate live authority. Queue adapters must pass the stored original scope
and bytes, rather than the currently desired policy.

Stage a new same-boot assignment in caller-owned candidate state with
`cp_v3_control_stage`; this does not overwrite the current policy.
`cp_v3_control_activate_staged` requires increasing generation/apply sequence,
closed nonregressing boundaries and the real apply callback before replacing
the active control state with ACK-pending state. Preserve durable old queue
records and boot-global stream counters outside this object. Do not clear/reopen
a queue to simulate a policy change. A failed new assignment retains the last
successful generation for subsequent negotiation without restoring collection.

`cp_v3_control_clock_boundary` accepts an explicitly trusted new UTC mapping only
for small statistics, after scanning has stopped and observations have closed or
been censored. It requires strictly advancing clock epoch, nonregressing monotonic
time and conservative UTC lower bound, and recomputes only the monotonic deadline
for the existing UTC lease. It never renews or resurrects a paused capture lease.
Untrusted or regressing mappings pause collection. The feature trial continues
to reject epoch changes.

Permissions use the earliest policy expiry, custody deadline, capability expiry
and server ACK time plus lease. UTC uncertainty is applied conservatively, and
the remaining deadline is also frozen onto monotonic time. GET and receipt replay
never renew it. Epoch changes, monotonic regression and expiry pause; every
outcome preserves unacknowledged data. The caller must check permissions before
starting a full window and before each upload, allow uncertainty at both window
ends, and never cache a permission beyond its deadline. Capability issuance must
be at/before the trusted interval's lower endpoint.

Small-statistics capabilities select exactly one actual uplink: `https` for
isolated diagnostics or `mqtt_tls` for the formal native production path.
`capability_mqtt_tls` and `policy.mqtt_tls` expose that choice to board adapters;
a new policy must match the selected capability, and the adapter checks its
actual transport again before applying. This adds no MQTT client or credentials
to the pure control core. Historical frozen HTTP-authorized bodies and strict
receipt matching remain unchanged when recovered through the MQTT gateway.

The public header is the integration contract. Keep the caller-owned control and
workspace outside a small task stack. Inputs contain no Wi-Fi or bearer secret.
SHA-256 is supplied by the runtime; host tests use OpenSSL and independently match
the actual TypeScript core's digests. Runtime retention, queue reservation and
daily byte/write accounting, frozen batch transport/reclamation, TLS/clock
bootstrap, single ownership and physical memory/power-loss acceptance remain
adapter responsibilities. The module grants no production/deployment authority.

Run from the repository root:

```sh
UV_CACHE_DIR=/private/tmp/campuspulse-uv-cache uv run --no-project python -m unittest discover -s firmware/components/cp_v3_control/tests -p test_control.py -v
```

Tests generate synthetic complete capabilities/policies with the actual local
TypeScript canonical hashing/negotiation core. They cover TF and no-TF Flash
profiles, reordered keys/arrays, incorrect hashes/binding, unknown fields,
unsupported features, queue budgets, expiry, closed/apply boundaries, failed and
committed ACKs, frozen retries, clock changes and nonrenewable leases. Actual
device operations and server authorization/storage transactions are not executed.
Small-statistics tests include 512/256 capacities, both window durations, optional
history/events/TF raw, exact backend synthetic applied/failed/lease fixtures,
body/scope/hash mutation, replays after expiry, contiguous and gapped renewal,
historical frozen drain, clock changes and staged closed-boundary activation.
