# Continuous V3 control and online scope changes

Status: software delivered in0.5.2; sustained physical acceptance in progress.
The preceding Waveshare 0.4.1 had a 20-minute normal-run boundary. Removing
that boundary alone would leave the existing 30-minute capability and bounded
clock lifetime unresolved; it is not an accepted continuous-runtime fix.

Bounded software evidence so far: the core renewal/negotiation host suites,
actual workerd/D1 transition tests and an isolated real React/Chromium online
binding flow pass. These use synthetic fixtures and establish no physical
continuous-operation, online cutover or new-rule accuracy acceptance.

Subsequent physical evidence establishes a real same-boot generation14→15
webpage cutover to9th/field with vehicle rules and an unchanged grant cutoff.
The0.5.2 saved-profile restart obtained generation17 and multiple real field
windows, including renewed leases after an interruption. At11:11UTC it registered
capability sequence2 and received generation18 applied ACK under the same boot.
Two subsequent epoch2 field windows committed by11:13:51UTC, crossing the old
20-minute stop point. Deliberate post-run power cycling and all-day operation
remain separate acceptance work.
See the [delivery record](../notes/waveshare-continuous-2026-11-06.md).

Known first-release recovery boundary: if an in-flight renewal capability
expires during a prolonged outage, retain its exact registration/candidate and
remain paused. A later exact registration receipt does not renew expired
capability authority. Do not clear the candidate and reuse its sequence or
reboot to hide the failure. Safe progression past this expired candidate needs
an explicit registration-outcome/sequence-floor design and separate acceptance;
the initial delivery does not claim recovery from arbitrarily long outages.

## Required behavior

Normal collection keeps its physical boot identity and network owner. It does
not reboot to renew time, capabilities, policies or leases, or to change a
compatible placement/dataset scope. Explicit operator restart and power control
remain distinct actions. Transient failures pause observation and retry within
actual authority; invalid time, expired authority and storage uncertainty cannot
be bypassed by extending a deadline or manufacturing a successful ACK.

The independent bounded startup acceptance remains valid for its initial setup
and normal restart observations. It does not establish the installed 20-minute
completion/cleanup path: the subsequent operator reported an error after exactly
20 windows, and no fresh registration was seen before a diagnostic USB reset.
The previous terminal console lines were not retained, so that terminal failure
is not attributed to a specific cleanup operation without further evidence.

## Quiescent transition

The network owner stages an authenticated candidate separately from the active
control object. It pauses and censors the old collector, closes any raw segment,
and waits for all old window/event handoffs and pending status bodies to become
durable under their original scope, clock, retention and byte hashes. A storage
drain-and-park handshake is required; collector quiescence alone does not prove
that status serialization is idle. Display state uses a small owner-published
snapshot instead of dereferencing a control object while it is replaced.

Capture rebind is a worker command that reuses existing allocations and never
starts scanning. Same node/boot and increasing policy generation are required;
resource-changing policies remain unsupported until a separately validated
reallocation path exists. Temporal boundaries clear volatile history while
preserving terminal evidence, event IDs and boot-global sequence/loss counters.
No NimBLE deinitialization or second collector preparation occurs.

The new policy is genuinely applied, its exact ACK is durably frozen, and its
committed receipt is matched before observation resumes. Queue pressure or an
uncertain command/ACK leaves the collector paused. Old frozen bodies are never
rewritten or reassigned to the new place or dataset.

## Same-boot time and capability renewal

A credential-free online HTTPS time probe uses the existing network and fixed
production clock endpoint, strict public CA/hostname/date validation, fresh
nonce and the already pinned signing key. It must not initialize, stop or
deinitialize Wi-Fi, EAP or SNTP. A transport-owner API adopts the original
verified midpoint seed at a closed boundary with a strictly advancing epoch;
worker clock snapshots retain that original seed to avoid repeated uncertainty
rounding. No old frozen observation's clock mapping changes.

Before same-boot capability registration, wait until a trusted UTC lower bound
covers the maximum old frozen observation upper bound. The server truncates old
lease spans when the capability digest changes. Generate actual fresh capability
identity/digest, advance registration sequence and uptime, freeze that request
across retries, and validate its real receipt. A typed renewal candidate may
change capability digest only after that receipt and a valid new policy; the
ordinary staged-policy SHA guard remains intact. Existing backend registration
and approved-template renewal support this path; validity periods are not
widened.

## Webpage-only placement/dataset changes

The webpage operation must be reviewed as a single bounded transition. Recording
an intent does not immediately close the old placement, truncate the old capture
span, revoke authority or relabel historical data. The device must acknowledge
its safe paused/frozen boundary before a new placement and policy become active.

The proposed intent is bound to the actual node/boot/capability, desired policy
generation and startup-grant revision, with expiry and cancellation semantics.
Only the exact approved target place/dataset and unchanged resource template
may be used. New scope permissions begin with the actual new device ACK. An
existing renewal grant can move to that generation only after the ACK and under
the recorded administrator revision checks; its original cutoff is preserved.
Concurrent manual changes or revocation end the automatic operation instead of
being overwritten. The firmware cannot grant itself administrator authority.

The current live-binding target is 9号楼 with dataset `field`. Before acceptance,
verify real field-window receipts and the public place-statistics projection;
an administrator placement record or a published assignment alone is insufficient.

## Negotiated wire contract

New firmware declares optional `online_control` with schema `online-control/1`
and explicit `scope_rebind` / `capability_renewal` booleans. Missing or null
does not grant support. Only devices declaring scope rebind receive the optional
`online_transition` descriptor in their ordinary config response; older firmware
retains its strict response shape.

The administrator creates an intent at
`POST /api/v1/admin/device-v3/nodes/:node/transitions`, binding a UUID request ID,
current boot, capability SHA-256, applied generation and startup revision to an
exact target place, dataset and ruleset. This first implementation requires an
existing enabled startup grant and `migrate_startup: true`; it cannot silently
create a new grant. `GET` returns the latest intent and bounded history.
Cancellation at `POST .../transitions/:id/cancel` is limited to pending intents.
Once assignment has committed, cancellation returns a conflict; it is not a
rollback of already published authority.

The safely paused device sends schema `scope-transition-ready/1` through the
existing lease operation (`/api/v3/device/lease`, MQTT operation4). It freezes
transition/boot/source identity, capability digest, closed window/segment
sequences, clock epoch, uptime and maximum old observation upper bound. The
server checks the boundary and commits one database-clock cutover, immutable
new assignment and exact `scope-transition-ready-receipt/1` together. The receipt
includes its node identity, request body digest, assigned generation and policy
digest; it is evidence of a pause, not a device policy ACK. Only the subsequent
real applied ACK can migrate the original grant, without extending its cutoff.

Unknown network outcomes retain the same request identity. The webpage queries
that operation rather than generating another mutation; a published assignment
and a matching device ACK have separate progress states. Frozen Ready receipts
may be recovered exactly after authority changes, without granting new authority.

## Conservative vehicle candidates

The additional compiled ruleset is `cp-v3-vehicle-candidates/1`. It adapts this
repository's existing `cp_vehicle` rules, whose upstream MIT provenance is
recorded in `docs/notes/reuse.md`. Policy must choose a version actually declared
by that device. `unclassified-v1` keeps its previous all-unknown semantics.

Bounded name/advertisement evidence accumulates per visible identifier for one
window. Exclusions and malformed/unsupported evidence override positive clues;
ecosystem-only and phone/peripheral clues do not become positive vehicle counts.
There is no new phone-positive rule, manufacturer-only identity assertion or
cross-window tracking identifier. Counts mean e-bike/car candidates, not observed
physical vehicles or people, and `estimated_total` remains null. Old windows
retain their original ruleset; selecting new rules never reinterprets history.
